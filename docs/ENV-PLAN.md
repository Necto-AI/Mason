# The agent's computer — real machine, snapshots, spin down and up

> Written 2026-10-26, from a research run over Firecracker, Cloud Hypervisor, Kata, gVisor, libkrun/microsandbox, QEMU
> microvm, Lima, nspawn and the managed sandbox products (`docs/research/` has no copy of that run yet; the numbers below
> are cited inline). The question: what would it take for every mason agent to have a computer that is really a computer,
> and to be switched off when idle and back on in a fraction of a second.

## What the tool machine is today

A container (`mason-env`) running `pi-env`'s daemon, reached over SSH by the harness. It shares the host kernel, has no
init, no `sudo`, no package manager worth the name, and a `/proc` that belongs to the whole host. It is fast to start and
impossible to snapshot as a *machine*: a checkpoint of a process tree inside somebody else's kernel is not a computer,
it is a suspended conversation with the host's kernel state.

That is enough for `rg`, `git` and `gh`. It stops being enough the moment an agent is expected to install a tool,
configure a service, reproduce a bug in a clean userland, or come back tomorrow to exactly the machine it left.

## What "as real a computer as we can" means, as a checklist

| Requirement | Today | Target |
|---|---|---|
| Its own kernel | no | yes |
| `systemd` and real service management | no | yes |
| `sudo` inside, root only inside | no | yes |
| Package manager, installable toolchain | partial | yes, and a snapshot to undo it |
| Persistent home across restarts | yes (volume) | yes (block device + shared dirs) |
| Live host directories (`~/dev/clinical-compass`, the Obsidian vault) | yes (binds) | **the hard requirement** — see below |
| Ordinary internet egress | yes | yes |
| Cannot reach the host's own services | yes (network topology) | yes |
| Snapshot and restore | no | yes |
| Off when idle, on in < 1 s | no | yes |
| Cost of an idle agent | a container's memory | a disk image |

The one line that decides the architecture is **live host directories**. Not because a filesystem is interesting, but
because Denis edits the vault in Obsidian while the agent reads it, and because `git` in the repo and `git` in the agent
have to be the same working tree. A copy is not a share.

## Firecracker is the best snapshot engine and the wrong filesystem

From the research, with sources in Firecracker's own docs:

- **What it is good at.** Full snapshots are GA since 1.13, `PUT /snapshot/create` + `PUT /snapshot/load` + UFFD, boot
  `≤125 ms` to init on a minimal image (the project's own CI-enforced claim), full restore measured third-party at
  150–200 ms end to end (spawn, TAP, NAT, load, resume, readiness), with the load call itself at 25–49 ms.
- **Blocker 1: no shared filesystem.** Virtio-fs is not supported and never will be — the maintainers closed the
  request in 2020 ("not a path we need to take Firecracker on"), 9p was rejected for security, and `microvm.nix`'s own
  hypervisor table records the restriction as "firecracker — no 9p/virtiofs shares". A host *directory* can only be
  reached over the network (NFS/SMB on the TAP), over vsock (a file service we would write), or by not sharing at all.
- **Blocker 2: rootless is not a story.** KVM, block and vsock work unprivileged; the jailer effectively does not (cgroup
  creation is not namespaced, `setns` wants `CAP_SYS_ADMIN`), and the only netdev backend is TAP, which needs
  `CAP_NET_ADMIN` in whichever namespace owns it. There is an open issue asking for a userspace backend (passt/slirp) and
  it is not implemented. "Works in a rootless container" is a PoC recipe, not a supported configuration.
- **Blocker 3, subtler: a snapshot is a secret and a clone is a fork of a person.** Every snapshot contains the guest's
  keys and tokens, and Firecracker says plainly that resuming the same snapshot twice replicates "unique identifiers,
  cached random numbers, cryptographic tokens". One snapshot per agent-life, or a per-restore credential injection.

So: Firecracker gives snapshots and nothing else on the list that the container does not already give.

## The recommendation

**Cloud Hypervisor, not Firecracker**, as the primary, with two references kept on the bench.

| | Cloud Hypervisor | Firecracker | microsandbox (libkrun) |
|---|---|---|---|
| Live host dir | **virtiofs via virtiofsd** | no | virtiofs, rootless |
| Snapshot / restore | yes (`ch-remote`, ondemand restore via uffd) | yes, the best documented | yes, disk + full, local only for full |
| Rootless | yes — `clh-runtime-rs` is one of Kata's two rootless VMMs; CH self-sandboxes with seccomp + Landlock | no clean path | yes, designed for it |
| Maturity | high and rising | very high (Lambda, Fargate) | young, one vendor |
| Cost to us | a new supervisor to write | a filesystem to give up | someone else's supervisor, young |

Cloud Hypervisor is the only one of the three that meets every row of the checklist above. microsandbox is the reference
to measure against — it is what "an agent's computer" looks like when somebody builds it as a product — and Firecracker
stays on the table for one scenario only: a deployment where the repo and the vault are *copied in* rather than shared
(a hosted mason for a customer, where the customer's data is not on the host anyway).

## Snapshot discipline

Getting this order right is the whole of the durability story:

1. `pause` the VM (vCPUs and devices stopped, guest does not know).
2. `snapshot-create` — which drains and `fsync`s the block devices before it returns.
3. Copy or `cp --reflink=always` the disk file(s). **Block devices are not part of a snapshot**; every project says so,
   and a memory snapshot without its disk is a machine that wakes up with somebody else's files.
4. `resume`.

Rules that follow, and that the code must encode rather than remember:

- **A snapshot is a secret.** It holds the guest's tokens, keys and cookies. Same handling as `service/data`: `0600`,
  never in a backup archive that leaves the host without being named as a secret.
- **Same binary creates and loads.** The snapshot format is versioned per Firecracker/CH release; a snapshot is not a
  portable artefact and an upgrade means re-creating them.
- **Credentials are reissued on restore, not carried in the snapshot**, unless a snapshot is used once. This is where the
  link-based sign-in from [`BACKEND-PLAN.md`](BACKEND-PLAN.md) pays off: a credential that lives in a container's `/data`
  and can be re-minted is a credential a snapshot can be careless about.
- **What is stale after a resume** is a list, not a surprise: network connections (dead), vsock sessions (reset), the
  clock (jumped, so the guest's timers fired late), mounts (need a remount), and any service that was mid-request. The
  guest gets a first-run-after-resume hook that repairs exactly these, and the supervisor tells the agent in one line
  that it was asleep.

## Spin down and up

**When to sleep.** The supervisor watches for turns, not for CPU: an agent with no turn in flight and no queued
submission for N minutes is a candidate (start with 15, tune later). Sleeping is snapshot-then-stop, and it must be safe
to interrupt: a turn that begins while the snapshot is being taken cancels it.

**When to wake.** On the first thing that needs the machine: a submission, a hook that owns a tool, an ssh from the
harness. Not on a timer, and not speculatively — a fleet that wakes itself is a fleet that never sleeps.

**The budget.** Restore call 25–50 ms; whole pipeline, realistically, 150–250 ms; then whatever the guest needs to have
its agent daemon listening again. Design target: **p95 under 400 ms from "a turn needs the machine" to "the first tool
call is executing"**, and the first tool call of a woken agent may be slower than a warm one — say so rather than hide
it. The dominant term after that is the model, so this is the right order of magnitude and no better.

**What the person sees.** Nothing: a chat message that wakes an agent waits the extra 200 ms. What the log sees is one
line per transition (`slept 8.1 GiB in 412 ms`, `woke in 178 ms`), because a supervisor that sleeps machines and does not
say so is indistinguishable from one that crashes them.

## Prerequisites on the host, measured today

- **Disk.** The pc host has **12 GB free on `/` (99 % full)**. One snapshot is memory + disk + slack per agent, so this
  is the first thing to fix; nothing in this plan fits before it does.
- **`/dev/kvm`.** Present on both hosts (`crw-rw-rw-`, `svm`, 12 cores / 30 GB on pc, 16 / 22 on g14). Rootless podman
  needs the device node bind-mounted (`-v /dev/kvm:/dev/kvm`), because `--device` with a group-owned node can be dropped
  silently.
- **cgroup v2** (Firecracker's own restore-latency advice; CH does not need it but nothing is worse for having it).
- **No swap** for snapshot fidelity; the host has 30 GB and a 17 GB page cache, so this is a config line, not a purchase.
- **A guest image to build.** Debian or Ubuntu userland with `systemd`, `sshd`, `git`, `gh`, `jq`, `ripgrep`, `curl`,
  `python3`, Node 22 — and `pi-env` **built inside the image** for the guest's architecture, which is also the fix for
  issue #57 and the arm64 blocker on the rpi.

## Milestones

Each one is useful if the next is never done.

| # | Milestone | What changes | Exit criteria |
|---|---|---|---|
| 0 | **A real computer without a VM** | The env image becomes a proper Debian userland: `systemd` as PID 1 under `podman --init` or a full `/sbin/init`, `sudo` for the agent user, a package manager that works, `pi-env` built in the image | the agent installs a tool, uses it, and the machine survives a restart with it |
| 1 | **The supervisor** | A small service that owns VM lifecycle: create from image, start, stop, snapshot, restore, and the state file that says which agent owns which image | one agent's machine is created, snapshotted and restored from a CLI, by hand, reproducibly |
| 2 | **Live host directories** | virtiofs for the repo and the vault, read-write where it should be, with the coherence questions (Obsidian, SQLite plugins) written down as known limits | editing a note on the host is visible in the guest in under a second, and `git status` agrees in both |
| 3 | **Sleep and wake** | Idle detection, snapshot-then-stop, wake on submission, the resume hook, the two log lines | a week of use with the machine asleep most of the time, and no turn waiting more than 400 ms to be woken |
| 4 | **In the stack** | `mason-env` becomes `mason-vm` in `deploy/`: the supervisor beside the server, one image per agent, the volumes as block devices | `deploy/deploy.sh` brings up a stack whose tool machine is a VM, and the same test suite passes |
| 5 | **Per-arch** | Build the guest image and `pi-env` for aarch64, so the rpi is a target | the stack runs on the rpi, asleep most of the day |

Milestone 0 is worth doing regardless of the rest: it is a week of work and it turns "a container with a shell" into "a
Linux machine", which is most of what "as real as we can" means in practice.

## Risks, named before the work starts

1. **Cloud Hypervisor's snapshot maturity is less documented than Firecracker's.** There is no CI-enforced latency or
   compatibility policy to point at. Milestone 1 exists to measure it, and the fallback is Firecracker with a copied
   repository and no live vault.
2. **virtiofs and Obsidian may not agree.** Two writers on a directory with SQLite-backed plugins and a rewrite-happy
   `workspace.json` is a coherence question the research could not settle from primary sources. Milestone 2 measures it;
   if it fails, the vault becomes agent-owned with a sync daemon, and the plan says so rather than pretending.
3. **Snapshot storage is unbounded by default.** One image per agent-life is a few GiB; a snapshot per turn is not. The
   supervisor keeps one snapshot per machine and deletes the previous one in the same operation that creates the next.
4. **A VM per agent multiplies what `deploy/` has to know.** [`APIARY-PLAN.md`](APIARY-PLAN.md) open question 1 is the
   same question from the other side, and both answers have to match.
