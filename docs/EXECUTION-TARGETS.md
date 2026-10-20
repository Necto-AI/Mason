# Execution targets: from a local directory to the agent's own machine

Status: design note, 2026-10-20. Not implemented beyond step 1 (the workspace default).

The question: pi's coding agent starts in a local directory and treats that directory as the boundary. In a Firecracker
microVM the agent has a whole machine of its own, so "do not leave this directory" is no longer the shape of the
restriction. How does the directory-based setup transfer?

Short answer: the directory does not disappear, it changes meaning. `cwd` stops being *the boundary* and becomes *where
inside the agent's machine a conversation works*. The boundary moves to the VM, and the one genuinely new thing is the
machine's lifecycle, which pi's local-directory model has nowhere to put.

## What pi already gives us

- **`agent.cwd`** is one value with two readings: the directory tool calls run in, and the text the model is told
  (`section("cwd", (input) => input.env?.cwd)`). In a VM it survives unchanged; only its value changes (`/root`, `/work`).
- **`HarnessOptions.env(target, context)`** builds a conversation's environment from `{conversationId, cwd, read}` and is
  never called on the Session line. Durable's spec sketches exactly this case (`spec.md` §3.3, `app.container`):
  *"Absent: the conversation runs locally. Only conversations with this document run in a container."*
- **pi-env's `Connection`** is transport-agnostic: the daemon speaks framed requests over a duplex stream. Today
  `localDaemon()` spawns it on stdin/stdout; `sshConnection()` reaches it over SSH. Firecracker adds a third transport
  (virtio-vsock, or SSH over the guest's TAP address) and nothing above it changes.
- **Every tool** (`read`, `write`, `edit`, `bash`, `listFiles`) goes through `RemoteExecutionEnv`, so the boundary is
  already in the right place: no tool knows whether it runs on this host or another machine.

## What a VM adds that a directory does not

1. **Lifecycle.** A directory exists. A VM is created, paused, snapshotted, restored, destroyed. Something must own that,
   and it must survive a mason restart.
2. **Transport.** A stream to the guest instead of a child process; the guest must already be running it at boot.
3. **Flow across the boundary.** Artifacts out (screenshots, generated files), secrets in (provider keys, credentials),
   and egress policy. A directory shares all of this by virtue of being the same machine.

## Design

### The target is a document, not a setting

Conversations are durable; the machine a conversation runs on must be too, or a restart forgets which VM held the work.

```ts
type ExecutionTarget =
  | { kind: "local"; cwd: string }
  | { kind: "microvm"; vm: string; cwd: string; snapshot?: string };

const TargetDoc = defineDoc<ExecutionTarget>({
  kind: "app.target", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ kind: "local", cwd: currentHouse().workspaceDir }),
});
```

`openAgentRuntime`'s `env` factory reads the doc and builds the environment; an absent doc means local. That is the
spec's own pattern, not an invention. Forks inherit the target because the doc's fork rule says so; a conversation that
needs a different machine rewrites the doc, and the next prepare picks it up.

### Lifecycle: pause, do not destroy

mason is an always-on assistant: it wakes on a hook, does one thing, sleeps for an hour. A VM per run would pay a cold
boot for every wake-up, and would lose every long-lived process the agent started.

- Cold boot of a Firecracker microVM is ~1s; restore from a snapshot is ~30ms (E2B reports ~150ms end-to-end for a
  sandbox, and ships snapshot restore for exactly this reason).
- So: create on first use, **pause-snapshot when idle**, restore on the next generation prepare. The snapshot id lives in
  `TargetDoc`; `env()` restoring on demand is the reconnect point, and it is called once per turn, which is the right
  frequency.
- Isolation unit = durable conversation. One VM per conversation, cloned from a template snapshot; "fork a conversation"
  becomes "restore its snapshot under a new id" (copy-on-write disk).

### Memory stays on the host; the workspace is the guest

This falls out of the current code and is worth making explicit, because it removes the hardest question ("does
`~/.mason` live in the VM?"):

- `soul.md`, `profile.md`, `log/` and `skills/` are read and written by **host** code: the sections render in the server
  process, and `remember` appends with `node:fs`. The model never touches those files with a tool.
- Therefore memory **never needs to enter the guest**. Prompt text is assembled on the host from host files; only
  tool-visible files live in the VM.
- The exception is the **skills index**: it hands the model absolute paths to `SKILL.md` files, and the model reads them
  with its own `read` tool — inside the guest. Today those paths are host paths
  (`/home/denis/dev/mason/skills/generative-ui/SKILL.md`); in a VM they do not exist. Two options:
  - **sync the skill roots into the guest** at a fixed path (`/opt/mason/skills`, `~/skills`) and render locations from
    the target; simplest, keeps `read` as the only skill-reading tool;
  - or keep skills host-side and serve them through a tool — more machinery, no benefit.

  Take the first. The rule behind it: **any path a section prints must be valid where the tool runs**, which means path
  rendering belongs to the target, not to the process that happens to be running.

### Artifacts and secrets

- Artifacts out: tool results are the only channel today (bounded text + images). Real files (a screenshot the browser
  helper took, a PDF it generated) need either a host→guest pull or a guest HTTP server behind the host. Defer until
  browser use (#8); widgets are model output and need nothing.
- Secrets in: injected into the guest at boot, not into tool calls and not into the prompt. The host keeps provider keys;
  the guest gets only what a task needs.
- Egress: the VM's TAP interface with an allowlist. This is the part that replaces "writable roots" from #3: with a
  microVM the filesystem boundary is the machine, so the interesting policy moves to network and to what the host proxy
  exposes.

### What does not change

The harness, the durable transcript, hooks, the inbox, projection, delivery, the wire boundary. A microVM is one
implementation of `ExecutionEnv`; `send_to_user` still runs on the host and still reaches the reader.

## Migration path

1. **Workspace default** `~/.mason/workspace`, created by `ensureHouse`, `workspaceDir` no longer defaults to
   `process.cwd()`. *(Done.)* The agent stops being able to edit the program that runs it.
2. **`app.target` doc and an `ExecutionTarget` seam**: `env()` reads it, local-only target, no behaviour change. This is
   the point where "where do tools run" becomes an explicit value instead of a constant.
3. **Target-rendered paths**: the skills index (and any future section) prints locations from the target.
4. **`microvmEnv`**: vsock transport, guest image with the pi-env daemon, create/pause/restore lifecycle, doc kind
   flipped per conversation. Only this step is Firecracker-specific.

Steps 2 and 3 are worth doing before any VM exists: they are what make step 4 a small change instead of a prompt
rewrite.

## Open questions

- **Snapshot blast radius**: a guest kernel/host mismatch invalidates snapshots (Firecracker requires matching versions);
  an upgrade means recreating VMs. Does a conversation then get a fresh machine and lose `/tmp` state? Probably yes, and
  the answer must be "the workspace is source of truth, not the VM".
- **What initialises a workspace**: empty directory, a template with a checkout, or `git clone` on first use? A personal
  assistant probably wants a cloned set of repos plus a scratch dir.
- **Where the guest's own logs go**: pi-env streams tool output, but a daemon crash inside the guest needs a route to the
  host log.
- **Cost of always-on VMs**: paused Firecracker VMs still hold memory unless snapshotted to disk; snapshot/restore
  latency vs disk use is a tuning question, not a design one.
- **Browser inside or outside**: browser use (#8) either runs in the guest (needs a display, more image) or on the host
  against pages the guest can reach. The VM boundary wants it inside; the helper-owned model (#8) makes it a separate
  conversation either way.
