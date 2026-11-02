# The bot's computer — a Firecracker VM, snapshots, spin down and up, and later a shared VM

> Written 2026-10-26, from a research run over Firecracker, Cloud Hypervisor, Kata, gVisor, libkrun/microsandbox, QEMU
> microvm, Lima, nspawn and the managed sandbox products; the run itself is
> [`research/agent-computers.md`](research/agent-computers.md), with versions, the snapshot API and the latency figures
> with their provenance. The question: what would it take for each bot to have a computer that is really a computer, and
> to be switched off when idle and back on in a fraction of a second.
>
> **Retargeted 2026-11-02.** The research recommended Cloud Hypervisor, because Firecracker cannot share a host directory
> and has no clean rootless story. The VMM is now **Firecracker**, and that is a product decision, not a re-reading of
> the evidence: [`adr/0009-firecracker-first-then-a-shared-vm.md`](adr/0009-firecracker-first-then-a-shared-vm.md) records
> it, the research keeps its findings, and this plan is how the constraints become work. The migration is two stages —
> one bot's machine first, a configurable shared VM second — and nothing in stage 2 is worth building before a second bot
> exists.

## What the tool machine is today

A container (`mason-env`) running `pi-env`'s daemon, reached over SSH by the harness. It shares the host kernel, has no
init, no `sudo`, no package manager worth the name, and a `/proc` that belongs to the whole host. It is fast to start and
impossible to snapshot as a *machine*: a checkpoint of a process tree inside somebody else's kernel is not a computer,
it is a suspended conversation with the host's kernel state.

That is enough for `rg`, `git` and `gh`. It stops being enough the moment a bot is expected to install a tool, configure
a service, reproduce a bug in a clean userland, or come back tomorrow to exactly the machine it left.

## What "as real a computer as we can" means, as a checklist

| Requirement | Today | Target |
|---|---|---|
| Its own kernel | no | yes |
| `systemd` and real service management | no | yes |
| `sudo` inside, root only inside | no | yes |
| Package manager, installable toolchain | partial | yes, and a snapshot to undo it |
| Persistent home across restarts | yes (volume) | yes (block device + shared dirs) |
| Live host directories (the repositories the bot works with, the Obsidian vault) | yes (binds) | **the hard requirement** — and the one Firecracker makes expensive, see below |
| Ordinary internet egress | yes | yes |
| Cannot reach the host's own services | yes (network topology) | yes |
| Snapshot and restore | no | yes |
| Off when idle, on in < 1 s | no | yes |
| Cost of an idle bot | a container's memory | a disk image |

The one line that decides the architecture is **live host directories**. Not because a filesystem is interesting, but
because Denis edits the vault in Obsidian while the bot reads it, and because `git` in the repo and `git` on the bot have
to be the same working tree. A copy is not a share.

## Firecracker: the best snapshot engine, and the filesystem is the work

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
  cached random numbers, cryptographic tokens". One snapshot per bot-life, or a per-restore credential injection.

So Firecracker gives snapshots and one of the other rows on the checklist — its own kernel and a real userland — and
leaves two of them (live host directories, rootless) to be built or accepted. That is the trade the decision takes:
**firecracker for the machine, a file service for the share, a privileged supervisor for the host.** Cloud Hypervisor,
which meets all three rows, stays the fallback if the file service turns out to cost more than changing VMM
([`adr/0009`](adr/0009-firecracker-first-then-a-shared-vm.md)).

## The two stages

**Stage 1 — one bot, one VM.** A single mason deployment gets a Firecracker execution environment: a supervisor that owns
VM lifecycle, a guest image with the `pi-env` daemon, a transport (vsock or SSH over the TAP), and the target document
that says which machine a conversation runs on (`docs/EXECUTION-TARGETS.md`). This is the whole of the first stage and it
is complete when `deploy/deploy.sh` brings up a stack whose tool machine is a VM and the same test suite passes.

**Stage 2 — the target is configurable, and a group may share one VM.** Once one bot works, the execution target becomes
a choice: a bot gets its own VM, or a named group of mason containers is placed in one shared Firecracker VM. The
supervisor learns groups, the manifest says which bots share one, and nothing else about the protocol or the harness
changes.

**A shared VM is one operating-system trust domain.** Separate bot homes, conversations and credentials stay logically
distinct, but the bots share a kernel, a root filesystem and a mount table. A kernel defect, a root escape or a tool that
reads a mounted path is shared with the neighbours in a way it is not between two VMs. The configuration says so in one
line, and the existing execution boundary is unchanged: `service/` never enters any guest, shared or not
(`docs/adr/0002-split-home.md`, [`FLEET-PLAN.md`](FLEET-PLAN.md)).

**A2A is independent of this.** Two bots use the same peer protocol whether they share a VM or have their own; the VM is
the isolation boundary and A2A is the communication boundary, and neither changes the other
([`FLEET-PLAN.md`](FLEET-PLAN.md)).

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
- **Same binary creates and loads.** The snapshot format is versioned per Firecracker release; a snapshot is not a
  portable artefact and an upgrade means re-creating them.
- **Credentials are reissued on restore, not carried in the snapshot**, unless a snapshot is used once. This is where the
  link-based sign-in from [`BACKEND-PLAN.md`](BACKEND-PLAN.md) pays off: a credential that lives in a container's `/data`
  and can be re-minted is a credential a snapshot can be careless about.
- **What is stale after a resume** is a list, not a surprise: network connections (dead), vsock sessions (reset), the
  clock (jumped, so the guest's timers fired late), mounts (need a remount), and any service that was mid-request. The
  guest gets a first-run-after-resume hook that repairs exactly these, and the supervisor tells the bot in one line that
  it was asleep.
- **One snapshot per machine.** The supervisor deletes the previous snapshot in the same operation that creates the next.
  A snapshot per turn is a disk filling up.

## Spin down and up

**When to sleep.** The supervisor watches for turns, not for CPU: a bot with no turn in flight and no queued submission
for N minutes is a candidate (start with 15, tune later). Sleeping is snapshot-then-stop, and it must be safe to
interrupt: a turn that begins while the snapshot is being taken cancels it.

**When to wake.** On the first thing that needs the machine: a submission, a hook that owns a tool, an ssh from the
harness. Not on a timer, and not speculatively — a fleet that wakes itself is a fleet that never sleeps.

**The budget.** Restore call 25–50 ms; whole pipeline, realistically, 150–250 ms; then whatever the guest needs to have
its agent daemon listening again. Design target: **p95 under 400 ms from "a turn needs the machine" to "the first tool
call is executing"**, and the first tool call of a woken bot may be slower than a warm one — say so rather than hide
it. The dominant term after that is the model, so this is the right order of magnitude and no better.

**What the person sees.** Nothing: a chat message that wakes a bot waits the extra 200 ms. What the log sees is one line
per transition (`slept 8.1 GiB in 412 ms`, `woke in 178 ms`), because a supervisor that sleeps machines and does not say
so is indistinguishable from one that crashes them.

## Prerequisites on the host, measured today

- **Disk.** The pc host has **12 GB free on `/` (99 % full)**. One snapshot is memory + disk + slack per bot, so this is
  the first thing to fix; nothing in this plan fits before it does. A shared VM makes the arithmetic better, not free.
- **`/dev/kvm`.** Present on both hosts (`crw-rw-rw-`, `svm`, 12 cores / 30 GB on pc, 16 / 22 on g14). The supervisor
  needs the device node and the privileges Firecracker's jailer and TAP want — this is where the container boundary
  stops being enough, and it is a host configuration, not a compose line.
- **cgroup v2** (Firecracker's own restore-latency advice).
- **No swap** for snapshot fidelity; the host has 30 GB and a 17 GB page cache, so this is a config line, not a
  purchase.
- **A guest image to build.** Debian or Ubuntu userland with `systemd`, `sshd`, `git`, `gh`, `jq`, `ripgrep`, `curl`,
  `python3`, Node 22 — and `pi-env` **built inside the image** for the guest's architecture, which is also the fix for
  issue #57 and the arm64 blocker on the rpi.
- **A file service for the shares.** Firecracker has no virtiofs and no 9p, so live host directories need either
  NFS/SMB served on the TAP address or a vsock file service. The choice is milestone 2, and the research's coherence
  questions about Obsidian and SQLite-backed plugins apply to either one.

## Milestones

Each one is useful if the next is never done. Milestones 0–4 are stage 1 (one bot's VM); 5 is stage 2 and waits for a
second bot to be worth it.

| # | Milestone | What changes | Exit criteria |
|---|---|---|---|
| 0 | **A real computer without a VM** | The env image becomes a proper Debian userland: `systemd` as PID 1 under `podman --init` or a full `/sbin/init`, `sudo` for the bot's user, a package manager that works, `pi-env` built in the image | the bot installs a tool, uses it, and the machine survives a restart with it |
| 1 | **The supervisor** | A small privileged service that owns Firecracker lifecycle: create from image, start, stop, snapshot, restore, and the state file that says which bot owns which machine | one bot's machine is created, snapshotted and restored from a CLI, by hand, reproducibly |
| 2 | **Live host directories** | The file service for the repositories and the vault — NFS/SMB on the TAP or a vsock service — read-write where it should be, with the coherence questions (Obsidian, SQLite plugins) written down as known limits | editing a note on the host is visible in the guest in under a second, and `git status` agrees in both |
| 3 | **Sleep and wake** | Idle detection, snapshot-then-stop, wake on submission, the resume hook, the two log lines | a week of use with the machine asleep most of the time, and no turn waiting more than 400 ms to be woken |
| 4 | **In the stack** | `mason-env` becomes `mason-vm` in `deploy/`: the supervisor beside the server, one image per bot, the volumes as block devices | `deploy/deploy.sh` brings up a stack whose tool machine is a VM, and the same test suite passes |
| 5 | **A configurable shared VM** | The target becomes a choice: per-bot VM or a named group in one VM; the supervisor owns groups; the manifest says which bots share one and what that means | two bots run in one VM, each with its own home and A2A address, and moving one back to its own VM is a configuration change |
| 6 | **Per-arch** | Build the guest image and `pi-env` for aarch64, so the rpi is a target | the stack runs on the rpi, asleep most of the day |

Milestone 0 is worth doing regardless of the rest: it is a week of work and it turns "a container with a shell" into "a
Linux machine", which is most of what "as real as we can" means in practice. Milestone 5 is deliberately last: sharing a
VM only pays when there is a second bot to share it with.

## Risks, named before the work starts

1. **The file service may cost more than changing VMM.** Firecracker forces either NFS/SMB on the TAP (a network
   filesystem with its own coherence and credential story) or a vsock service we write and own. Milestone 2 measures it,
   and the fallback is the research's original recommendation — Cloud Hypervisor with virtiofs — rather than pretending
   the share is free.
2. **The supervisor needs privileges the rest of the stack does not have.** Jailer cgroups, TAP creation and KVM access
   put it outside a rootless container, so it becomes the one privileged piece on the host. It must be a small, separate
   service with a state file, not code grafted onto the server.
3. **virtiofs and Obsidian may not agree — and now it is a file service and Obsidian.** Two writers on a directory with
   SQLite-backed plugins and a rewrite-happy `workspace.json` is a coherence question the research could not settle from
   primary sources, and a network or vsock service has the same problem plus its own. Milestone 2 measures it; if it
   fails, the vault becomes bot-owned with a sync daemon, and the plan says so rather than pretending.
4. **Snapshot storage is unbounded by default.** One image per bot-life is a few GiB; a snapshot per turn is not. The
   supervisor keeps one snapshot per machine and deletes the previous one in the same operation that creates the next.
5. **A shared VM multiplies the blast radius.** Stopping the supervisor stops every bot in that VM, and one bot's kernel
   behaviour is its neighbours' environment. The configuration says which bots share one, and the default is one VM per
   bot.
6. **A VM per bot multiplies what `deploy/` has to know.** [`FLEET-PLAN.md`](FLEET-PLAN.md) is the same question from the
   other side, and the two answers have to match.
