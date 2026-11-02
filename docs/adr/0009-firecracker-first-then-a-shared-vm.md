# Firecracker first, then a shared VM on purpose

**Status:** Accepted — decided by Denis, 2026-11-02

**Date:** 2026-11-02

**Revisited if:** the file service Firecracker forces costs more than changing VMM, or the single-bot stage cannot get
the host privileges it needs on a real machine. The alternative the research preferred (Cloud Hypervisor with virtiofs)
is not deleted by this decision; it is what to return to if both stages fail.

`docs/research/agent-computers.md` and [`../ENV-PLAN.md`](../ENV-PLAN.md) recommended Cloud Hypervisor, and the
reasoning is sound: Cloud Hypervisor is the only VMM in the run that combines a live host directory (virtiofs), full
snapshot/restore and a rootless path somebody already exercises. Firecracker fails two of the three. Choosing it anyway
is a product decision, and it supersedes the recommendation without rewriting the findings — they stay as written, with
a note saying what was chosen.

## Decision

**Firecracker is the VMM.** It is the snapshot engine, it is what Lambda and Fargate run at scale, and its restore
latency is the one several independent third parties have measured (boot ≤125 ms; restore 150–200 ms end to end). The requirement
that gave Cloud Hypervisor the edge — a *live* host directory — is real, and it becomes a thing to build rather than a
reason to change hypervisor.

**The migration is two stages, in this order.**

1. **One bot, one VM.** A single mason container gets a Firecracker execution environment: the supervisor, the guest
   image with the `pi-env` daemon, and the target document that records which machine a conversation runs on. This
   stage is one deployment and one bot; nothing here is about a fleet.
2. **The target becomes configurable.** After stage 1 works, the execution target is a choice, so a deployment may give
   a bot its own VM **or** place several mason containers in one shared Firecracker VM. Sharing is configurable, not
   mandatory, and it is the second stage because it is only worth anything once a second bot exists.

**A shared VM is one operating-system trust domain.** Separate bot homes, separate conversations and separate
credentials remain logically distinct, but two processes in one guest kernel are not isolated from each other: a kernel
bug, a root escape inside the guest, or a tool that reads another bot's mounted path is possible in a way it is not
between two VMs. That is the trade the operator accepted for cheaper infrastructure, it is stated where the sharing is
configured, and it changes nothing about the existing execution boundary — `service/` stays out of the guest, and
credentials and service-owned state never enter it (`docs/adr/0002-split-home.md`).

**A2A does not care which topology is in use.** Bots use the same peer protocol whether they share a VM or have one
each; the protocol is the deployment's boundary, the VM is the isolation boundary, and the two are independent
(`docs/FLEET-PLAN.md`).

## What this costs, named before the work

- **No virtiofs, no 9p.** A host directory can only reach the guest over the network (NFS/SMB on the TAP) or over
  vsock (a file service we write), or not at all. `ENV-PLAN.md` milestone 2 is that file service, and it is now the
  load-bearing piece of the plan rather than a detail.
- **Root is not optional.** The jailer wants cgroup creation and `CAP_SYS_ADMIN`, and the only netdev backend is TAP,
  which wants `CAP_NET_ADMIN` in whichever namespace owns it. The supervisor therefore needs a privileged position on
  the host; it does not get to be a rootless container.
- **A snapshot is a secret.** Every snapshot holds the guest's keys and tokens, and Firecracker's own documentation says
  resuming one twice replicates identifiers and cached random tokens. One snapshot per bot-life, or credentials
  reissued on restore — the discipline in `ENV-PLAN.md` §"Snapshot discipline" is inherited unchanged.
- **The guest image is built, not borrowed.** Debian/Ubuntu userland with `systemd`, `sshd` and the tooling, with
  `pi-env` built inside the image for the guest's architecture — which is also the fix for the arm64 target.
- **A shared VM multiplies the blast radius of a restart.** Stopping the supervisor stops every bot in that VM. The
  configuration has to say which bots share one, and the operator is the one who decides.

## Consequences

- `docs/ENV-PLAN.md` is retargeted: Firecracker in the checklist and the milestones, Cloud Hypervisor's comparison kept
  as the reason the constraints are what they are.
- `docs/EXECUTION-TARGETS.md` gains the second stage: the target is per conversation today, and becomes a configurable
  choice of VM membership once sharing exists.
- `docs/research/agent-computers.md` and `docs/research/README.md` keep their findings and gain one dated line saying
  which way the decision went.
- `docs/FLEET-PLAN.md` is where the deployment shape lives: one container per bot, A2A between them, an optional shared
  VM named in one manifest.
- No code changes here. There is no Firecracker code, no supervisor and no guest image in the tree.
  [#20](https://github.com/DenisSud/mason/issues/20) is the execution-target seam, [#65](https://github.com/DenisSud/mason/issues/65)
  is milestone 0 (a real userland before any VM), and milestones 1–6 have no tracker entry yet apart from
  [#57](https://github.com/DenisSud/mason/issues/57), which covers the guest image milestone 6 needs.
