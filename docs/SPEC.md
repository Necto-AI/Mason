# mason — Technical Specification

## 1. Product Goal

Build a durable, proactive personal agent ("Muse"-style) on `pi-durable`:
1. **Durable Agent Harness + `pi-env` Split:** Runs a persistent `Harness` on SQLite (`@earendil-works/pi-durable`), executes `CodingTools` (`read`, `write`, `edit`, `bash`) through `@earendil-works/pi-env` (`RemoteExecutionEnv` over a `Connection` to the `pi-env` Rust daemon), and supports **event hooks** (cron/interval timers, webhooks, manual triggers) so the agent can proactively message the user first.
2. **Chord Client-Server Transport:** Uses `@earendil-works/chord` (`createHost`, `remote`, `acceptWebSockets`, `webSocketLink`) to replicate the durable `ConversationView` and hook status to browser clients in real time.
3. **Mobile-Ready Web UI + OpenIntelligentUI Superset:**
   - **Stage 1 (Milestone 2):** Clean, mobile-responsive web client over `@earendil-works/chord` with **explicit text status indicators** for connection state, run state (`idle` / `generating` / `running_tools` / `retrying` / `compacting`), the names of running tools (never their arguments or output), the inbox queue (`steer` / `followUp` + withdraw button), and proactive event hook triggers. The client is sent the reader's transcript only — see §4.1a.
   - **Stage 2 (Milestone 3):** Integrates `CopilotKit/OpenIntelligentUI` (`vendor/open-intelligent-ui`) components directly into the web client — including its design system (`@repo/design-system`), markdown reveal renderer, and the `generateSandboxedUi` streaming `Websandbox` iframe renderer.
   - **Always-Registered Widget Tool:** The web UI always knows how to render a `generateSandboxedUi` artifact (both live-streaming and settled): the server maps the call's arguments to widget content, and only that content crosses the wire. On the backend, `generateSandboxedUi` is a `pi-durable` extension (`GenerateSandboxedUiExtension`) in `BASE_EXTENSIONS`, so every conversation is offered the tool from its first turn and on every turn after it: there is no toggle, and therefore no tool that appears mid-conversation (§3.5). The manual the model needs — parameter order, design system, sandbox limits — lives in `skills/generative-ui/SKILL.md`, which it reads when it decides to build a widget.

---

## 2. Repository Structure

```text
/home/denis/dev/mason/
├── AGENTS.md
├── docs/
│   └── SPEC.md                        # This specification
├── vendor/
│   ├── pi/                            # Local clone of upstream earendil-works/pi (v1.2.0, built)
│   └── open-intelligent-ui/           # Local clone of CopilotKit/OpenIntelligentUI
├── scripts/
│   ├── link-vendor.mjs                # Symlinks vendor packages into node_modules/
│   └── build-web.mjs                  # esbuild bundler for src/web -> dist/web
├── skills/
│   └── generative-ui/SKILL.md         # The widget manual: the prompt carries only the pointer (§3.5)
├── src/
│   ├── shared/
│   │   └── contract.ts                # Shared @earendil-works/chord remote contract (AgentService)
│   ├── server/
│   │   ├── env.ts                     # pi-env Connection + RemoteExecutionEnv factory
│   │   ├── admission.ts               # Where a submission came from, and where it waits (hook vs. user)
│   │   ├── house.ts                   # The agent's home: ~/.mason paths, soul/profile reads, log, git
│   │   ├── prompt.ts                  # The whole system prompt: every section, in order, with its source
│   │   ├── status.ts                  # Pure AgentStatus derivation from the committed view, and the cache report
│   │   ├── extensions/
│   │   │   ├── skills.ts              # The skills index (pi's loadSkills): shipped <repo>/skills + personal ~/.mason/skills
│   │   │   ├── memory.ts              # The `remember` tool: one dated fact in ~/.mason/log/
│   │   │   ├── delivery.ts            # The send_to_user tool: the one channel that reaches the user
│   │   │   └── sandboxed-ui.ts        # generateSandboxedUi tool + the pointer to its skill
│   │   ├── hooks.ts                   # Proactive event hooks (timers, HTTP webhook trigger, proactive submit)
│   │   ├── projection.ts              # The wire boundary: what the reader sees, derived from the conversation
│   │   ├── runtime.ts                 # Durable Harness bootstrap (SQLite, ModelRuntime/faux, extensions)
│   │   └── main.ts                    # HTTP + WebSocket server + Chord host serving AgentService
│   └── web/
│       ├── index.html                 # Mobile-first HTML shell (viewport-fit=cover, dvh layout)
│       ├── main.tsx                   # React root + Chord browser host connection
│       ├── client.ts                  # Chord webSocketLink wrapper + reconnect state
│       ├── lib/                        # Pure helpers + renderers (see docs/UI-PLAN.md)
│       │   ├── working.ts              # The one line that says what the agent is doing
│       │   ├── markdown.ts             # marked + link hardening (apiary's markdown.ts, verbatim)
│       │   ├── stream-text.tsx         # Settled markdown + fading tail reveal (apiary's stream.ts)
│       │   ├── follower.ts             # Scroll pinning: pinnedAfterScroll + useFollower (apiary's scroll.ts)
│       │   ├── frame-content.ts        # CSP, importmap, design-system styles, preview morph, measurement
│       │   ├── process-partial-html.ts # Incomplete-tag-tolerant streaming markup
│       │   ├── websandbox-loader.ts    # @jetbrains/websandbox UMD loader + widget bridge type
│       │   └── idiomorph-inline.ts     # Idiomorph IIFE, inlined for the sandbox (no network)
│       ├── components/
│       │   ├── SessionBar.tsx         # Wordmark + overflow menu (compact, reset, model)
│       │   ├── Transcript.tsx         # The projected rows, then the queue
│       │   ├── MessageRow.tsx         # User, hook banner, delivered message, failed-run notice
│       │   ├── WidgetCard.tsx         # Places a `generateSandboxedUi` card at its call's position (bare)
│       │   ├── SandboxedUiCard.tsx    # Adapted from vendor/open-intelligent-ui renderer.tsx
│       │   ├── QueuedRows.tsx         # Queued steers/follow-ups: faded bubbles, mode tag, withdraw
│       │   ├── JumpPill.tsx           # Jump-to-latest pill, shown only while scrolled away from the end
│       │   └── Composer.tsx           # Pill that grows/caps; Send when idle, Steer + Follow-up when busy
│       └── styles/
│           ├── tokens.css             # apiary's design tokens (light + dark), app/main column
│           └── chat.css               # Chat sheet: session bar, transcript, messages, composer
└── test/
    ├── harness-env.test.ts            # Tests Milestone 1: pi-durable + pi-env daemon + proactive hooks
    ├── house.test.ts                  # ~/.mason: paths, the log, the caps, the git repository
    ├── prompt.test.ts                 # The resident prompt: soul, profile, skills index, the widget pointer
    ├── cache-telemetry.test.ts        # The [cache] line of a finished run
    ├── chord-e2e.test.ts              # Tests Milestone 2 & 3: Chord WS client <-> server, steer, abort, UI tool
    ├── projection.test.ts             # The wire boundary: what the reader is sent, and what stays behind
    ├── admission.test.ts              # Which origin an input is placed as, and where it waits
    └── delivery.test.ts               # The send_to_user tool's registration facts
```

---

## 3. Milestone 1 Specification: Durable Agent Harness + `pi-env` + Proactive Hooks

### 3.1 `src/server/env.ts` — Split Execution Environment (`@earendil-works/pi-env`)

The harness never touches the host filesystem or child processes directly. All tool calls go through `@earendil-works/pi-env`:

```ts
import { Connection, RemoteExecutionEnv, localDaemon, sshConnection, type SshTarget } from "@earendil-works/pi-env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export interface RuntimeEnvManager {
  envForConversation(input: { conversationId: string; cwd?: string }): ExecutionEnv;
  close(): Promise<void>;
}
```

- **Local mode (default):**
  - Spawns `new Connection({ command: [localDaemon()] })` using `vendor/pi/packages/env/bin/pi-env-linux-x64/pi-env`.
  - Returns `new RemoteExecutionEnv({ connection, id: "pi-env:local", cwd: input.cwd ?? defaultWorkspaceDir })`.
  - Note: Using `RemoteExecutionEnv` over `Connection({ command: [localDaemon()] })` runs every `read`, `write`, `edit`, `bash`, and `listFiles` call through the framed `pi-env` Rust daemon protocol on stdin/stdout — exercising the exact remote boundary we will use in containers.
- **SSH / Container mode (when `PI_ENV_SSH_HOST` is set):**
  - Uses `sshConnection(target)` and returns `new RemoteExecutionEnv({ connection: lazy.connection, id: `pi-env:${target.host}`, cwd })`.

### 3.2 `src/server/prompt.ts` — The Whole System Prompt

`prompt.ts` is the single registry: every section the model receives is declared there, in order, by key and by source.
No other extension contributes a section, and the root agent carries no `instructions`, so reading that one file tells
you everything the agent is told. A test fails if another base extension grows a section (§6).

| key | tag | source |
|---|---|---|
| `preamble` | none (the prompt's opening) | `~/.mason/soul.md`, else `DEFAULT_SOUL` |
| `cwd` | `<cwd>` | `input.env?.cwd` |
| `proactive_guidelines` | `<proactive_guidelines>` | plain text: how to handle `[EVENT HOOK: …]`, act and report once |
| `delivery` | `<delivery>` | plain text: only `send_to_user` reaches the reader |
| `skills` | `<skills>` | pi's `loadSkills` over the two roots, rendered by `formatSkillsForPrompt`; omitted when empty |
| `profile` | `<profile>` | `~/.mason/profile.md` capped, or the first-run interview instruction |
| `generative_ui` | `<generative_ui>` | plain text: a pointer to the `generative-ui` skill |

Section text is one of three kinds, and nothing else is allowed: a **file** the person can edit (`soul.md`,
`profile.md`), a **computation** over the filesystem (`skills`), or a **constant** in `prompt.ts` (the guidelines, the
delivery invariant, the widget pointer).

There is deliberately **no `docs` section**. pi's own default prompt points a coding agent at its README and `docs/`
tree so it can change its own extensions, themes and skills; mason's agent is not meant to have that. A test asserts
the rendered prompt names no path into pi, no documentation tree, and no `docs` section key (§6). `Prompt = defineExtension({ name: "prompt", sections: PROMPT_SECTIONS })` is
what the runtime installs.

2. **`GenerateSandboxedUiExtension` (`sandboxed-ui.ts`):**
   - Defines the `generateSandboxedUi` tool using `defineTool` from `@earendil-works/pi-durable` and `Type` from `typebox`:
     ```ts
     export const GenerateSandboxedUiParams = Type.Object({
       initialHeight: Type.Optional(Type.Number({ description: "Estimated height in pixels" })),
       placeholderMessages: Type.Optional(Type.Array(Type.String())),
       css: Type.String({ description: "Complete CSS for the widget" }),
       html: Type.Array(Type.String({ description: "HTML chunks for body content" })),
       jsFunctions: Type.Optional(Type.String({ description: "Named JS function declarations" })),
       jsExpressions: Type.Optional(Type.Array(Type.String({ description: "Synchronous JS statements" }))),
     });
     ```
   - `execute: async (args) => ({ output: [{ type: "text", text: "UI generated" }], details: args })`.
   - The prompt's `generative_ui` section (§3.2) is a **pointer**, not the manual: it says the model can answer with a live widget and names the `generative-ui` skill. The parameter order (`initialHeight` → `placeholderMessages` → `css` → `html` → `jsFunctions` → `jsExpressions`), the design-system tokens and the `Websandbox.connection.remote.sendPrompt({ text })` bridge live in `skills/generative-ui/SKILL.md`, which the agent reads when it decides to build something.
   - **Always registered.** `GenerateSandboxedUiExtension` is a base extension (§3.4), so it is in the tool list of the first turn and of every turn after it. There is no per-conversation toggle and no `ENABLE_SANDBOXED_UI`: the client renders a widget whenever one arrives, and a tool list that changes mid-conversation would invalidate the provider's prompt cache (§3.5).

### 3.3 `src/server/hooks.ts` — Proactive Event Hooks Engine

Allows the agent to message the user first when events occur (timers, webhooks, or external triggers):

```ts
export interface EventHookConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  intervalMs?: number; // If set, runs periodically when enabled
  identify?: "request" | "body"; // How this hook's senders name a fire, when they all do
  promptTemplate: string;
  lastFiredAt?: string;
  fireCount: number;
}
```

- **How a hook fires (`fire(id, { payload?, requestId? })`):**
  1. Formats the prompt from `promptTemplate` and optional `payload`.
  2. Submits to the root conversation using a custom entry kind so the UI can distinguish proactive hook triggers from human user messages:
     ```ts
     await root.submit(
       {
         type: "input",
         content: `[EVENT HOOK: ${hook.name}]\n${promptText}`,
         entry: {
           kind: "app.hook",
           data: {
             hookId: hook.id,
             hookName: hook.name,
             payload: payload ?? null,
             firedAt: new Date().toISOString(),
           },
         },
         whenBusy: "followUp",
         requestId,
       },
       context,
     );
     ```
  3. Because `entry.kind === "app.hook"` carries `model: [{ role: "user", content: ... }]` under the hood (per `pi-durable` custom input entries), `pi-durable` immediately starts a generation run! Every connected web client watching the conversation sees the `app.hook` entry appear and the assistant proactively stream its message.
  4. **The fire's identity is the caller's**, because only the caller knows what "the same event" means: `pi-durable` admits one submission per `requestId` and never forgets one. The key builders, one per kind of caller, each exported from `src/server/hooks.ts`:
     - `explicitRequestId(hookId, senderId)` → `hook:<id>:request:<sender>`: a sender that names its delivery. Exact, and permanent.
     - `bodyRequestId(hookId, body, nowMs)` → `hook:<id>:body:<hash>:<bucket>`: a sender that cannot. One event per body per identity bucket (**T = 60s**, `IDENTITY_WINDOW_MS`), bucketed by time rather than hashed forever, so a redelivery inside the bucket collapses while tomorrow's identical digest still fires. The bucket is a division of the clock, not a span of time: a redelivery that crosses a bucket boundary is a new event, however close it is.
     - `scheduledRequestId(hook, nowMs)` → `hook:<id>:slot:<n>`: a timer. One fire per interval slot, so re-arming a timer cannot double-fire.
     - Anything else is a **gesture** — the Retry control, the run supervisor, a chord `fireHook` without a `requestId` — and `gestureRequestId()` gives each its own random key: a click is an intent, so two clicks are two fires, and a fire after a restart cannot collide with one from before it.
     `define()` warns when an interval is shorter than the identity window (a body-identified fire would land in the same bucket twice); a hook whose senders always name their fires says so in `identify` and is not warned about.
  5. A hook trigger never steers: `whenBusyFor("hook")` places it as a follow-up, because only the user may interrupt a running turn (`src/server/admission.ts`).
- **Built-in hooks:**
  - `morning-brief` (manual or scheduled check-in)
  - `workspace-check` (inspects workspace git status / tasks and reports anything needing attention)
  - Custom webhook (`POST /api/hooks/:id/fire` with JSON body `{ message?, data? }`) so external scripts/cron/systemd timers can wake the agent at any time. The delivery's id is the `x-request-id` header or a `requestId` in the body (the explicit tier); a sender that gives none is deduplicated by its body per bucket.

### 3.4 `src/server/runtime.ts` — Durable Harness Bootstrap

- Opens SQLite storage at `.data/agent.sqlite` via `openNodeSqliteStorage` from `@earendil-works/pi-durable/storage/sqlite/node` (or `MemoryStorage` in tests).
- Model configuration:
  - Uses `ModelRuntime.create({ allowModelNetwork: false })` from `@earendil-works/pi-coding-agent/src/core/model-runtime.ts` so `~/.pi/agent/auth.json` and `~/.pi/agent/models.json` work out of the box (defaults to `settings.json`'s `defaultProvider`/`defaultModel`, e.g. `opencode-go` / `glm-5.3-flash`, or env `PI_PROVIDER` / `PI_MODEL`).
  - Also supports `PI_FAUX_MODEL=1` (using `fauxProvider` from `@earendil-works/pi-ai/providers/faux`) for deterministic offline testing and UI verification.
- Calls `harness.resume()` on startup so any run interrupted by a crash or restart resumes automatically.
- **The extension selection.** `BASE_EXTENSIONS` — `coding-tools`, `prompt`, `memory`, `delivery`, `sandboxed-ui` — is what every conversation gets. `prompt` is the only one with sections (§3.2). `delivery` is unconditional: it is the only way the agent reaches the reader, so no conversation may be without it. `sandboxed-ui` is unconditional too: the client renders a widget whenever one arrives, and a tool list that changes between turns is exactly the cache break this design removes (§3.5).
- **The startup repair.** A stored selection that is an explicit list of names is used verbatim by `pi-durable` (`selectExtensions`), so a `pi.agent` doc written before a base extension existed leaves the conversation without it — and without `delivery` the model has no way to reach the reader at all. On every open, `openAgentRuntime` therefore appends the missing base names to a stored list, in base order, in one commit, before `hooks.start()` and `harness.resume()`, so nothing can run against the stale selection. The stored order is kept and nothing is pruned; a selection stored as an edit (`{ add, remove }`) or left unset already unions with the base selection and is left exactly as it is; a selection that is already complete is not written to. The repair cannot tell a legacy doc from a deliberate narrowing of the selection, so it silently rewrites user state — that is the price of `delivery` being unconditional.
- **The harness settings.** `followUpMode: "all"`: queued follow-ups drain as one turn, because the model prioritises between them and nothing here can rank a fired hook against a wish the reader typed. `steeringMode: "one-at-a-time"`: only the user's own steer cuts in, and a trigger source that asks to steer is downgraded to a follow-up. `stream.cacheRetention: "long"`: an always-on agent idles past the provider's five-minute cache window constantly, and the long retention is what stops every wake-up from re-paying for the whole prefix (§3.5).
- **The agent's home.** `housePaths()` resolves a home from an explicit path, else `MASON_HOME`, else `~/.mason`; `openAgentRuntime` resolves it once from `houseHome` and configures it for the prompt sections, which are installed at import time and cannot be handed arguments (§3.5).

### 3.5 `~/.mason/` — The Agent's Home

Everything the agent is made of is a file Denis can read, diff and revert, in one directory:

```text
~/.mason/
├── soul.md                 # The first section of the system prompt: the agent's own voice
├── profile.md              # Who Denis is: agent-managed, resident, capped
├── log/2026-10-20.md       # Dated facts, one per line, read on demand
└── skills/<name>/SKILL.md  # Denis's own skills; they shadow the shipped ones
```

`src/server/house.ts` owns the layout and every read and write; nothing else builds a path by hand. Opening the runtime
creates the home if it is missing — `log/`, `skills/`, and `soul.md` from `DEFAULT_SOUL`, written once and never
overwritten — and initialises it as a git repository, so a memory write is a commit Denis can revert. A runtime takes
`houseHome`, else `MASON_HOME`, else `~/.mason`, and configures that home for every section that reads it; tests pass
`houseHome` (or set `MASON_HOME` for sections rendered outside a runtime) and no test touches the real one.

**The resident prompt.** Every turn renders these sections, in this order. The prefix is byte-stable: an unchanged turn
and the one after it render the same text, in the same order, with the same tool list. A file edit is a prompt edit —
the next turn patches that section — which is why `soul.md` is written by a person and `profile.md` is rewritten rather
than appended to per turn.

| Section | What it holds | Budget |
|---|---|---|
| `soul` (tag-less: the prompt's opening) | `~/.mason/soul.md`, or `DEFAULT_SOUL` on a fresh install | none enforced — it is Denis's own voice, ~480 characters by default |
| `cwd` | the workspace the tools run in | one path |
| `proactive_guidelines` | how to answer an `[EVENT HOOK: ...]` input | a fixed ~550-character constant |
| `delivery` | only `send_to_user` reaches the reader | one line |
| `profile` | `profile.md` under a header saying it is data, not instructions | 4,800 characters (~1,200 tokens), cut on a line boundary with a `(truncated …)` marker |
| `skills` | the index: `name — description` and the `SKILL.md` path, per skill | no cap; one entry per skill, never a body |
| `generative_ui` | the pointer: widgets exist, read the skill | ~300 characters |

**The tool list does not change.** `generateSandboxedUi` is in `BASE_EXTENSIONS` (§3.4), so it is offered on the first
turn and on every turn after it. The per-conversation toggle, the `setSandboxedUiEnabled` method and
`ENABLE_SANDBOXED_UI` are gone: the client renders a widget whenever one arrives, so hiding the tool protected nothing,
and a tool that appears mid-conversation invalidates the provider's prompt cache.

**Skills.** Two roots, one index. Mason ships `<repo>/skills/`; Denis keeps `~/.mason/skills/`. Both are walked
recursively for `SKILL.md` — nesting is allowed (`engineering/pr/SKILL.md`), because grouping skills is how a person
keeps them — and a personal skill whose name matches a shipped one shadows it, so a default can be changed without
forking it and no install step is involved. A `SKILL.md` is YAML frontmatter (`name`, `description`) then markdown; a
missing `name` falls back to the directory name. The prompt carries the index only, and the agent reads the file when a
task matches, so a large skill library costs nothing until it is used. `skills/generative-ui/SKILL.md` — the parameter
order, the design system, the sandbox limits — is why the widget manual left the resident prompt.

**Profile.** `profile.md` is the agent's own description of who it works for: resident every turn, and maintained by the
agent with `write`. On a fresh install the section says the file does not exist and asks the agent to interview Denis in
the next conversation — what to call him, what he wants done, his hours and channels, how he wants to be spoken to —
then write the answers, under a page at a time, rewriting as it learns. The header is not decoration: a profile can
quote text the agent did not write, so it is declared data about the user, and what he asks in a conversation always
wins over it.

**The `remember` tool and the log.** `~/.mason/log/YYYY-MM-DD.md` holds facts, one per line, appended as
`- HH:MM — <fact>` under a `# YYYY-MM-DD` heading. The home is a git repository, so each append is committed —
best-effort: a fact that lands but does not commit is still a memory. `remember(fact)` is the only tool that appends to the log
(and the only one that grows memory), and it only accumulates, one sentence per call; it is replay-unsafe, because the same fact recorded twice is
noise in a file a person reads. Nothing is recalled through a search tool: the agent reads the log with `read` when it
needs history, which is the reason it is plain markdown.

**The cache policy.** The harness sets `stream.cacheRetention: "long"`, because an always-on agent idles past the
provider's five-minute window constantly and would otherwise re-pay for the whole prefix on every wake-up. What makes
the retention pay off is that the prefix does not move: the resident sections render in a fixed order, and the tool list
is identical on every turn. Each finished run writes one line to the server log, from the `pi.usage` counters that run
spent:

```text
[cache] run=<runId> in=<prompt tokens> cacheRead=<n> hit=<percent> miss=<n>
```

`in` is the whole prompt the run sent (`input + cacheRead + cacheWrite`), `hit` is the share the provider served from
its cache, and `miss` is the prompt the provider had to take uncached (`input + cacheWrite`). A run that sent no prompt
tokens writes no line.

---

## 4. Milestone 2 Specification: Chord Contract & Stage 1 Web Client

### 4.1 `src/shared/contract.ts` — Shared `@earendil-works/chord` Contract

Browser and server share one TypeBox contract:

```ts
import { hostNamed, method, remote } from "@earendil-works/chord";
import { Type, type Static } from "typebox";

export const HookSummarySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  enabled: Type.Boolean(),
  intervalMs: Type.Optional(Type.Number()),
  lastFiredAt: Type.Optional(Type.String()),
  fireCount: Type.Number(),
});

export const AgentStatusSchema = Type.Object({
  runStatus: Type.Union([
    Type.Literal("idle"),
    Type.Literal("generating"),
    Type.Literal("running_tools"),
    Type.Literal("retrying"),
    Type.Literal("compacting"),
  ]),
  busy: Type.Boolean(),
  activeRunTaskId: Type.Optional(Type.String()),
  // Names only: no arguments, no output. What runs is not what the reader reads.
  runningTools: Type.Array(Type.String()),
  model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
  cwd: Type.Optional(Type.String()),
  hooks: Type.Array(HookSummarySchema),
});

export const AgentService = remote("personal.agent", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed("server"),
  variants: {
    owner: {
      state: {
        // The reader's transcript: their words, the messages the agent sent, widgets, triggers, coarse notices.
        // Never the raw conversation: reasoning, tool calls, tool arguments and tool output stay on the server.
        transcript: Type.Array(TranscriptItemSchema),
        // The queue behind the running turn, labelled for the reader.
        queued: Type.Array(QueuedItemSchema),
        // Not `status`: Chord reserves that name on references (`RESERVED_MEMBERS`), so the status cell is `agentStatus`.
        agentStatus: AgentStatusSchema,
      },
      methods: {
        submit: method(
          Type.Object({
            content: Type.String(),
            whenBusy: Type.Optional(
              Type.Union([Type.Literal("followUp"), Type.Literal("steer"), Type.Literal("reject")]),
            ),
          }),
          Type.Object({ submissionId: Type.Number() }),
        ),
        withdrawSubmission: method(Type.Object({ submissionId: Type.Number() })),
        abort: method(),
        reset: method(Type.Optional(Type.Object({ handoff: Type.Optional(Type.String()) }))),
        compact: method(Type.Optional(Type.Object({ instructions: Type.Optional(Type.String()) }))),
        fireHook: method(
          Type.Object({
            hookId: Type.String(),
            payload: Type.Optional(Type.String()),
            // Idempotency key; omit for a gesture such as pressing the transcript's Retry control.
            requestId: Type.Optional(Type.String()),
          }),
          Type.Object({ submissionId: Type.Number() }),
        ),
        toggleHook: method(Type.Object({ hookId: Type.String(), enabled: Type.Boolean() })),
      },
    },
  },
});
```

### 4.1a What the client is sent — the wire boundary

The client never receives the conversation. `src/server/projection.ts` derives three cells from the durable view, and
they are the whole contract:

| Cell | Holds | Never holds |
|---|---|---|
| `transcript` | `user`, `delivered` (`send_to_user`), `widget` (`generateSandboxedUi`), `notice` | entries, reasoning, tool calls, tool arguments, tool output, usage, hook triggers |
| `queued` | the inbox, labelled: the reader's text, or `hook: <name>` | submission records, entry kinds, modes beyond a display tag |
| `agentStatus` | run status, busy, the **names** of running tools, model, hooks, cwd | per-tool arguments or output, usage, provider payloads |

Two rules keep it honest:

- **A whitelist, not a filter.** A transcript item exists only because `projection.ts` names its kind and reads its
  fields. A new entry kind or a new tool is invisible until that file says otherwise, so nothing leaks by default.
- **The machine's shape never survives.** A `send_to_user` call crosses as `{ kind: "delivered", text }` — the call's
  id, name and result are not forwarded, only the message. A widget crosses as its mapped content (`OpenGenUIContent`),
  never as the call that built it. A failed run crosses as one coarse notice, never as the provider's error text. A hook
  trigger crosses as nothing at all: a proactive turn is the message it sent, and the schedule, its payload and the
  prompt it built are the schedule's business, not the conversation's.

Consequences, deliberately accepted: the chat cannot show a trace, a tool row, reasoning, usage or an error's cause.
The raw view stays available server-side (the run supervisor reads it), and a trace endpoint can expose it later —
separately, deliberately, and with its own access rules.

### 4.2 Bridging `Conversation.viewState()` to Chord State on the Server

In `src/server/main.ts`, inside `server.serve(AgentService, (_input, _principal, self) => ...)`:
```ts
const viewResource = self.resource("viewState", {
  version: 1,
  open: async ({ signal }) => {
    return await rootConversation.viewState(withAbortSignal(BACKGROUND_CONTEXT, signal));
  },
  close: (vs) => vs.dispose(),
});

// The projection, not the view: three cells a reader can be sent (see 4.1a).
const transcript = self.state("transcript", Type.Array(TranscriptItemSchema), {
  init: () => projectTranscript(viewResource.value.value),
});
const queued = self.state("queued", Type.Array(QueuedItemSchema), {
  init: () => projectQueued(viewResource.value.value),
});

self.on("viewSync", viewResource, (nextView, ctx) => {
  transcript.replace(ctx, projectTranscript(nextView));
  queued.replace(ctx, projectQueued(nextView));
  agentStatus.replace(ctx, statusFor(nextView));
});
```
`projectTranscript()` / `projectQueued()` are pure functions in `src/server/projection.ts`; `statusFor()` is
`deriveAgentStatus()` from `src/server/status.ts`: a pure function of the committed view
(`pi.live`, `pi.inbox`, `pi.agent`), the hook list and the model reference.
This streams exact Chord structural diffs to every connected browser tab over
`acceptWebSockets(wss, host, { principal: () => ({ kind: "owner" }) })`.

### 4.3 Chat Area (apiary look)

**The shell does not narrate itself.** `SessionBar` is a wordmark plus one overflow menu (compact, reset, and the
run/model facts as text inside it): a personal agent is assumed to work, so there is no status dot, model pill or
connection badge to read. A run's progress is one line under the transcript — `working: bash` — and `Stop` sits in the
composer where the send action is; a lost connection is announced once — above
the composer, after a 1.2s grace period, so a reload does not flash a warning (`Composer` → `connection`).

The browser client is the chat area of apiary (`DenisSud/apiary` → `packages/web`) re-implemented in React on our
Chord subscription; `docs/UI-PLAN.md` is the porting plan and the decisions log. One transcript, and it is the
reader's:

**The transcript is the conversation, not the trace.** Rows arrive already projected (see 4.1a) and render in order:
the reader's messages, the messages the agent sent (`data-testid="msg-user"`, `data-testid="msg-delivered"`), widget
cards, and one coarse notice when a run died (`data-testid="msg-notice"`). A proactive turn shows no trigger banner:
the message stands on its own, and nothing tells the reader which schedule woke the agent or what payload it carried. Nothing renders reasoning, a tool row, a tool's arguments or its output, because none of
it arrives. A delivered message keeps its text when the call that sent it failed, and says it may not have arrived.

**The working line is the whole of the machine.** While a turn runs, one line under the transcript says what it is
doing — `working`, `working: bash`, `compacting context`, `retrying` (`data-testid="working"`, from
`src/web/lib/working.ts`). A tool name is all the reader is told: it makes work visible without exposing what the work
touches. The session bar carries the run status in words inside its menu, plus `connecting` and `disconnected` when the
socket is not live.

Queued submissions render as faded user bubbles at the very end of the chat, each carrying its boundary
(`steering` / `follow-up`) and a withdraw button (`data-testid="inbox-item"`, `data-testid="withdraw-<id>"`). The queue
renders whenever the inbox holds items, busy or dead: a provider error leaves the submissions displayed where they wait
to be processed once the run (or process) comes back, and every submission that is still plain user text in the queue
can be withdrawn through the durable backend until the moment it is placed.

**A widget can take the screen** (`data-testid="widget-fullscreen"`): a quiet icon in the card's corner, revealed on hover
and always visible where there is no hover. The wrapper becomes a fixed, viewport-filling overlay (`data-fullscreen="true"`)
and the sandbox fills it, so the widget's own scrolling takes over; the browser's fullscreen is requested on top of that
where available. The card is never re-mounted, so state inside the widget survives the switch, and the transcript's bottom
fade (a mask, which would clip the overlay) is dropped while it is up. Exit is the button, `Esc`, or leaving the browser's
fullscreen. Widgets are therefore authored to be fluid — the sandbox instruction tells the model to fill the available
height and re-render on `resize`.

**No debug mode, no trace panel.** `?debug=1`, the diagnostics sheet, the usage ledger and the raw `pi.live` /
`pi.inbox` / `pi.agent` inspector were removed with the raw view: they existed to browse state the client no longer
receives. Inspecting a run's trace is a server-side concern now, and a future endpoint can expose it deliberately.

---

### 4.4 Failure handling: the run supervisor and the Retry control

Three layers, because a provider outage has three different timescales.

1. **Inside a run, pi-ai retries the model call.** One attempt plus a bounded number of retries with exponential
   backoff. A transcript reading `terminated` followed by several `Connection error.` entries *is* that budget being
   spent: the provider was unreachable for longer than a few seconds.
2. **After a run, the server re-arms it.** A failed run is otherwise a dead end: pi-durable settles the input as
   `unanswered` (`reason: "model_error"`) and waits for new work, so nothing resumes it. `src/server/run-retry.ts`
   holds the whole policy, split so it is testable without a clock:

   - `readRunOutcome(view)` — the newest assistant entry that ended in `stopReason: "error"`, its message, and whether
     an answer followed it (the failure was made good).
   - `planRunRetry(input)` — pure: nothing while the run is still going, nothing for an error already handled,
     nothing once the budget is spent; otherwise `wait(delayMs, attempt, error)`.
   - `RunRetrySupervisor` — owns the attempt counter and the timer. It observes the committed view on every sync and
     fires the built-in `retry-failed-run` hook, so a retry is a **hook event** — visible in the transcript as
     `triggered Retry a failed run` — and never a message the user did not write.

   The schedule is deliberately slower than the in-run retries: **15s, 60s, 5min, 15min** (four attempts, ~20 minutes
   in total), overridable with `PDA_RUN_RETRY_DELAYS_MS` and `PDA_RUN_RETRY_ATTEMPTS`. The budget resets the moment an
   answer succeeds, and a pending re-fire is dropped as soon as the reader submits anything — their input leads.
3. **On demand, the reader retries.** `hooks.ts` ships `retry-failed-run` disabled and without an interval, so nothing
   schedules it; the prompt tells the agent to resume from where it stopped instead of starting over, with the failure
   text appended as the payload. The client's **Retry** control (`data-testid="retry-run"`) fires the same hook with
   the error lines it shows, and disappears once anything follows the failed turn. Its prompt explains the durable
   promise in the terms the reader needs: *the task is still open*.

What durability does and does not promise, in one line: the conversation, the run, the subscriptions and the hook
state survive a **process** restart — kill the server mid-tool and it resumes the run in place — while a provider
outage that outlasts every retry budget leaves a failed turn, which the supervisor and the Retry control now pick up
again.

## 5. Milestone 3 Specification: OpenIntelligentUI Integration

### 5.1 Why We Adapt Components Instead of Forking the Next.js Shell
Inspecting `vendor/open-intelligent-ui`:
- `apps/app/src/app/page.tsx` delegates the chat list to `<CopilotChat>` from `@copilotkit/react-core/v2`, which requires `@copilotkit/runtime` + Python `LangGraphHttpAgent` and has no support for `pi-durable` state (`pi.live`, `pi.inbox`, proactive hooks, tool output streaming).
- However, the actual **OpenIntelligentUI generative UI engine and design system** in `vendor/open-intelligent-ui` are clean, standalone modules:
  1. `@repo/design-system` (`vendor/open-intelligent-ui/packages/design-system/src/index.ts`): `THEME_CSS`, `SVG_CLASSES_CSS`, `FORM_STYLES_CSS`, `IMPORT_MAP`, `CDN_URLS`.
  2. `vendor/open-intelligent-ui/apps/app/src/components/generative-ui/open-generative-ui/`:
     - `schema.ts` (`OpenGenUIContent`)
     - `frame-content.ts` (`PREVIEW_FRAME_CONTENT`, `buildPreviewHeadContent`, `buildPreviewBodyMorph`, `buildFinalFrameContent`, `MEASUREMENT_JS`, `RESIZE_MESSAGE_TYPE`)
     - `process-partial-html.ts` (`processPartialHtml`, `extractCompleteStyles`)
     - `websandbox-loader.ts` (`loadWebsandbox`)
     - `idiomorph-inline.ts` (`IDIOMORPH_JS`)
     - `renderer.tsx` (`OpenGenUIActivityRenderer`)

### 5.2 How `generateSandboxedUi` Streams from `pi-durable` into `SandboxedUiCard.tsx`
1. **While the model is streaming the tool call** (`docs["pi.live"].generation.message.content` has a `toolCall` with `name === "generateSandboxedUi"`):
   - `pi-ai` parses partial JSON arguments into `toolCall.arguments` on every chunk (`partialIntervalMs: 100`).
   - We map the partial `toolCall.arguments` directly to `OpenGenUIContent`:
     - `cssComplete`: `Array.isArray(args.html)` (since `html` is emitted after `css` in the strict parameter order!)
     - `htmlComplete`: `typeof args.jsFunctions === "string" || Array.isArray(args.jsExpressions)` (or tool call finished)
     - `generating`: `true` while streaming, `false` once settled.
2. **Once settled** (assistant entry committed in `view.entries`):
   - `cssComplete: true`, `htmlComplete: true`, `generating: false`.
   - `jsFunctions` / `jsExpressions` reach the sandbox only now: a half-streamed function declaration would throw
     inside the iframe, so the preview shows markup and the behavior runs once the call is complete.
   - The frame element carries `data-sandbox-state="idle | creating | ready | failed"`, so a test (or a human)
     can tell whether the sandbox finished loading rather than guessing from pixels.
3. **Host Bridge (`Websandbox` localApi):**
   - `sendPrompt: async ({ text }) => { await agentService.submit({ content: `[WIDGET ${callId}] ${text}`, whenBusy: "followUp" }); }`
     (the `[WIDGET <callId>]` tag tells the agent which widget spoke; `followUp` keeps a click from interrupting a run)
   - `openLink: async ({ url }) => { window.open(url, "_blank", "noopener,noreferrer"); }`
   - Any interactive button inside a generated widget that calls `Websandbox.connection.remote.sendPrompt({ text })` submits directly back into our `pi-durable` conversation!

---

**The card has three phases, and the frame's height is a policy, not a measurement** (`src/web/lib/frame-height.ts`):

| Phase | What renders | Height |
| --- | --- | --- |
| `placeholder` | shimmering skeleton + the model's `placeholderMessages`, cycling | the model's `initialHeight`, clamped to 96–480 |
| `preview` | a second sandbox that morphs the partial body (Idiomorph); `PREVIEW_MEASUREMENT_JS` measures it | grows only, from the estimate as a floor, capped at 80% of the viewport |
| `settled` | the complete document (CSP, importmap, design-system styles) with the host bridge | the document's own measurement, shrink included |

The preview is not destroyed when the final document is built: both sandboxes are on screen through a 200ms crossfade,
so the card never blanks. Behavior (`jsFunctions`, `jsExpressions`) is still withheld until the call settles — a
half-streamed declaration would throw inside the iframe.

Height reports are clamped (`CONTENT_MAX` 4000px, 50px floor), sub-2px changes are ignored so the CSS transition is not
restarted on every report, and the height the settled document reported is cached per call id: the settled turn is a
different React subtree, and since an iframe cannot be re-parented without reloading, the widget is mounted a second
time. That mount starts at the cached height and skips the skeleton, which reduces the artifact to one repaint of the
widget's own content.
## 6. Verification & Acceptance Criteria

1. **`test/harness-env.test.ts`:**
   - Starts `Harness` on SQLite with `RemoteExecutionEnv` connected to `localDaemon()`.
   - Verifies `bash`, `write`, `read`, `edit` execute through the `pi-env` daemon.
   - Verifies firing an event hook (`fireHook`) appends an `app.hook` entry and triggers a proactive assistant response.
   - Verifies crash/reopen recovery (`harness.close()` -> `Harness.open()` -> `harness.resume()`).
2. **`test/house.test.ts`, `test/prompt.test.ts`, `test/cache-telemetry.test.ts`:** the home — its layout, the dated
   log line, the caps, the git repository; the resident prompt — `soul.md` or `DEFAULT_SOUL`, the first-run profile
   interview, the skills index (shipped + personal, shadowing, nesting) and the pointer-only widget section; and the
   `[cache]` line's arithmetic. Every test uses a temporary `houseHome` and never the real `~/.mason`.
3. **`test/chord-e2e.test.ts`:**
   - Starts the HTTP + WebSocket server and connects a real Chord browser-mode `Host` over `webSocketLink`.
   - Verifies initial `view` and `status` hydration.
   - Verifies `submit`, live streaming updates (`status.runStatus`), tool execution status transitions, `steer` / `followUp` inbox queueing + withdrawal, `abort`, and proactive hook firing pushing updates to the connected client.
   - Verifies `generateSandboxedUi` is in the first turn's tool list and that a second turn's list is identical, and that a widget streams and settles with no toggle to open.
   - Verifies the resident prompt carries the `generative-ui` pointer and not the manual (no parameter-order block).
   - Verifies a threshold compaction: with a small context window and `compaction: { reserveTokens: 1, keepRecentTokens: 1 }`,
     the second turn writes a `pi.compaction` entry (reason `threshold`) and still answers.
4. **Browser / Mobile Verification:**
   - `npm run build:web && npm run dev` serves the mobile-responsive web app on `http://127.0.0.1:8787`.

### 6.1 Behaviour evals (`npm run eval`)

The suites above pin mechanisms; `evals/` pins the behaviour they are meant to produce. Six scenarios run the real
prompt, the real harness and the real projection against one model and check what a reader would have seen: a fired
hook acted on and reported once, a quiet check-in that stays quiet and invents nothing, a question answered without a
tool call, a file read before its number is claimed, a preference written to the log and read back the next turn, a
chart delivered as a widget with `css` before `html`. `bash`, `read`, `write` and `edit` are stubs that answer from the
scenario, and each run gets a throwaway temp home and workspace, so the only variable is the model.

`npm run eval` runs all six against `opencode-go/deepseek-v4.1-flash` for about a cent, writes traces to
`.data/evals/` and exits non-zero on a failed check; `npm run eval:judge -- .data/evals/<run>` scores stored traces
on message quality against `evals/rubric.md`. Scenario shape, flags, trace fields and how to add a scenario:
[`evals/README.md`](../evals/README.md).

---

## 7. Notes from building this (Chord behaviour worth knowing)

1. **A reference created before the host has an upstream never binds.** `createHost()` (client) + `host.get()`
   + `host.connect()` leaves the reference in `loading` forever: the re-hold pass in `connect()` only visits
   references that already lost a link. The browser client therefore connects first and takes the reference
   afterwards (`src/web/client.ts`); later reconnects re-hold that same reference.
2. **A remote state hydrates only while subscribed.** `ref.member.value` is `undefined` until something
   subscribes, and the first delivery to a new subscriber is `undefined` before the snapshot arrives. Every
   client keeps its `view` / `agentStatus` subscriptions (and its last snapshot) for the lifetime of the page.
3. **The reference has `status` and `ready`.** `ref.status` is `loading | live | released | gone`, `ref.ready`
   resolves when the reference is live; `ref.onStatus()` reports "gone" with the error, which is what the UI
   surfaces as the error banner.
4. **A sandbox holds stable dependencies.** The widget bridge is rebuilt on every render; handing that object
   straight to `Websandbox.create`'s `localApi` (through `useMemo`) tore the iframe down and up on every
   transcript update and lost the widget's own state. `SandboxedUiCard` keeps a stable forwarder and reads the
   current bridge through a ref instead.
5. **`WebSocketServer.close()` waits for clients.** Server shutdown terminated open WebSocket clients first;
   otherwise `close()` never calls back and `npm run dev` survives SIGTERM while a browser is connected
   (`server.closeAllConnections()` releases lingering HTTP keep-alives too).
6. **Tests must not inherit ambient state.** Suites used to pass `enableSandboxedUi: false` explicitly so an ambient
   `ENABLE_SANDBOXED_UI=1` could not flip a default under test; the toggle is gone, and what a test now isolates is the
   agent's home. Every place that opens a runtime passes `houseHome` (and `MASON_HOME`) pointed at a fresh temporary
   directory, so no test creates or reads the real `~/.mason`.
