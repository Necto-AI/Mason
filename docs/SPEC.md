# Personal Durable Agent — Technical Specification

## 1. Product Goal

Build a durable, proactive personal agent ("Muse"-style) on `pi-durable`:
1. **Durable Agent Harness + `pi-env` Split:** Runs a persistent `Harness` on SQLite (`@earendil-works/pi-durable`), executes `CodingTools` (`read`, `write`, `edit`, `bash`) through `@earendil-works/pi-env` (`RemoteExecutionEnv` over a `Connection` to the `pi-env` Rust daemon), and supports **event hooks** (cron/interval timers, webhooks, manual triggers) so the agent can proactively message the user first.
2. **Chord Client-Server Transport:** Uses `@earendil-works/chord` (`createHost`, `remote`, `acceptWebSockets`, `webSocketLink`) to replicate the durable `ConversationView` and hook status to browser clients in real time.
3. **Mobile-Ready Web UI + OpenIntelligentUI Superset:**
   - **Stage 1 (Milestone 2):** Clean, mobile-responsive web client over `@earendil-works/chord` with **explicit text status indicators** for connection state, run state (`idle` / `generating` / `running_tools` / `retrying` / `compacting`), message states, tool call statuses (`pending` / `running` / `done` / `error` + live output), inbox queue (`steer` / `followUp` + withdraw button), and proactive event hook triggers.
   - **Stage 2 (Milestone 3):** Integrates `CopilotKit/OpenIntelligentUI` (`vendor/open-intelligent-ui`) components directly into the web client — including its design system (`@repo/design-system`), markdown reveal renderer, and the `generateSandboxedUi` streaming `Websandbox` iframe renderer.
   - **Decoupled Tool Activation:** The web UI always knows how to render `generateSandboxedUi` tool calls (both live-streaming and settled). On the backend, `generateSandboxedUi` is packaged as an optional `pi-durable` extension (`GenerateSandboxedUiExtension`, toggled via env/config or UI toggle). When not enabled on the agent, the UI behaves as a standard chat + tool-trace interface; when enabled, the agent can stream interactive HTML/CSS/JS widgets inline.

---

## 2. Repository Structure

```text
/home/user/dev/personal-durable-agent/
├── AGENTS.md
├── docs/
│   └── SPEC.md                        # This specification
├── vendor/
│   ├── pi/                            # Local clone of upstream earendil-works/pi (v1.2.0, built)
│   └── open-intelligent-ui/           # Local clone of CopilotKit/OpenIntelligentUI
├── scripts/
│   ├── link-vendor.mjs                # Symlinks vendor packages into node_modules/
│   └── build-web.mjs                  # esbuild bundler for src/web -> dist/web
├── src/
│   ├── shared/
│   │   └── contract.ts                # Shared @earendil-works/chord remote contract (AgentService)
│   ├── server/
│   │   ├── env.ts                     # pi-env Connection + RemoteExecutionEnv factory
│   │   ├── status.ts                  # Pure AgentStatus derivation from the committed view
│   │   ├── extensions/
│   │   │   ├── agent-identity.ts      # Preamble / SOUL.md / cwd prompt sections
│   │   │   └── sandboxed-ui.ts        # generateSandboxedUi tool + OpenIntelligentUI prompt section
│   │   ├── hooks.ts                   # Proactive event hooks (timers, HTTP webhook trigger, proactive submit)
│   │   ├── runtime.ts                 # Durable Harness bootstrap (SQLite, ModelRuntime/faux, extensions)
│   │   └── main.ts                    # HTTP + WebSocket server + Chord host serving AgentService
│   └── web/
│       ├── index.html                 # Mobile-first HTML shell (viewport-fit=cover, dvh layout)
│       ├── main.tsx                   # React root + Chord browser host connection
│       ├── client.ts                  # Chord webSocketLink wrapper + reconnect state
│       ├── view-types.ts              # JSON shapes the client reads out of ConversationView
│       ├── lib/                       # Adapted from vendor/open-intelligent-ui
│       │   ├── frame-content.ts        # CSP, importmap, design-system styles, preview morph, measurement
│       │   ├── process-partial-html.ts # Incomplete-tag-tolerant streaming markup
│       │   ├── open-genui-content.ts   # Partial tool arguments -> OpenGenUIContent
│       │   ├── websandbox-loader.ts    # @jetbrains/websandbox UMD loader + widget bridge type
│       │   └── idiomorph-inline.ts     # Idiomorph IIFE, inlined for the sandbox (no network)
│       ├── components/
│       │   ├── StatusBanner.tsx       # Explicit text indicators (connection, run, tools, inbox, hooks)
│       │   ├── TranscriptView.tsx     # Entries + live generation + tool slots + proactive hook badges
│       │   ├── ToolRow.tsx            # Explicit tool status (pending/running/done/error) + live output
│       │   ├── SandboxedUiCard.tsx    # Adapted from vendor/open-intelligent-ui renderer.tsx
│       │   ├── InboxBar.tsx           # Queued steers/follow-ups with withdraw button
│       │   ├── HooksPanel.tsx         # List registered event hooks, fire test hook, toggle schedules
│       │   └── Composer.tsx           # Mobile-friendly input: Send, Steer (when busy), Follow-up, Stop
│       └── styles/
│           └── app.css                # Combines @repo/design-system tokens + chat.css + mobile status styles
└── test/
    ├── harness-env.test.ts            # Tests Milestone 1: pi-durable + pi-env daemon + proactive hooks
    └── chord-e2e.test.ts              # Tests Milestone 2 & 3: Chord WS client <-> server, steer, abort, UI tool
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

### 3.2 `src/server/extensions/agent-identity.ts` & `src/server/extensions/sandboxed-ui.ts`

1. **`AgentIdentity` extension (`agent-identity.ts`):**
   - Uses `defineExtension` and `section` from `@earendil-works/pi-durable`.
   - Renders `preamble` (reads `SOUL.md` if present in workspace/agent dir, or a default proactive personal assistant preamble) with `{ tag: false }`.
   - Renders `cwd` section (`(input) => input.env?.cwd`).
   - Renders `proactive_guidelines` section explaining how to handle `[EVENT HOOK: ...]` inputs: when woken by an event hook, act autonomously using tools if needed and message the user clearly with what happened and why you are reaching out.

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
   - Includes a prompt section `generative_ui` (adapted from `vendor/open-intelligent-ui/apps/agent/src/prompt.py` — parameter order `initialHeight` → `placeholderMessages` → `css` → `html` → `jsFunctions` → `jsExpressions`, design-system CSS tokens, and `Websandbox.connection.remote.sendPrompt({ text })`).
   - **Important:** By default in Stage 1, `GenerateSandboxedUiExtension` is installed in the `Registry`, and can be toggled on/off per conversation via `conversation.configure({ extensions: ... })` (defaulting to **off** in Stage 1 unless `ENABLE_SANDBOXED_UI=1` or toggled in the UI).

### 3.3 `src/server/hooks.ts` — Proactive Event Hooks Engine

Allows the agent to message the user first when events occur (timers, webhooks, or external triggers):

```ts
export interface EventHookConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  intervalMs?: number; // If set, runs periodically when enabled
  promptTemplate: string;
  lastFiredAt?: string;
  fireCount: number;
}
```

- **How a hook fires (`fireHook(hookId, payload?)`):**
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
         requestId: `hook:${hook.id}:${Date.now()}`,
       },
       context,
     );
     ```
  3. Because `entry.kind === "app.hook"` carries `model: [{ role: "user", content: ... }]` under the hood (per `pi-durable` custom input entries), `pi-durable` immediately starts a generation run! Every connected web client watching the conversation sees the `app.hook` entry appear and the assistant proactively stream its message.
- **Built-in hooks:**
  - `morning-brief` (manual or scheduled check-in)
  - `workspace-check` (inspects workspace git status / tasks and reports anything needing attention)
  - Custom webhook (`POST /api/hooks/:id/fire` with JSON body `{ message?, data? }`) so external scripts/cron/systemd timers can wake the agent at any time.

### 3.4 `src/server/runtime.ts` — Durable Harness Bootstrap

- Opens SQLite storage at `.data/agent.sqlite` via `openNodeSqliteStorage` from `@earendil-works/pi-durable/storage/sqlite/node` (or `MemoryStorage` in tests).
- Model configuration:
  - Uses `ModelRuntime.create({ allowModelNetwork: false })` from `@earendil-works/pi-coding-agent/src/core/model-runtime.ts` so `~/.pi/agent/auth.json` and `~/.pi/agent/models.json` work out of the box (defaults to `settings.json`'s `defaultProvider`/`defaultModel`, e.g. `opencode-go` / `glm-5.3-flash`, or env `PI_PROVIDER` / `PI_MODEL`).
  - Also supports `PI_FAUX_MODEL=1` (using `fauxProvider` from `@earendil-works/pi-ai/providers/faux`) for deterministic offline testing and UI verification.
- Calls `harness.resume()` on startup so any run interrupted by a crash or restart resumes automatically.

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
  sandboxedUiEnabled: Type.Boolean(),
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
        // Raw ConversationView from pi-durable (entries + docs["pi.live"], docs["pi.inbox"], docs["pi.usage"], docs["pi.agent"])
        view: Type.Unknown(),
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
          Type.Object({ hookId: Type.String(), payload: Type.Optional(Type.String()) }),
          Type.Object({ submissionId: Type.Number() }),
        ),
        toggleHook: method(Type.Object({ hookId: Type.String(), enabled: Type.Boolean() })),
        setSandboxedUiEnabled: method(Type.Object({ enabled: Type.Boolean() })),
      },
    },
  },
});
```

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

const view = self.state("view", Type.Unknown(), {
  init: () => viewResource.value.value,
});

self.on("viewSync", viewResource, (nextView, ctx) => {
  view.replace(ctx, nextView);
  agentStatus.replace(ctx, statusFor(nextView));
});
```
`statusFor()` is `deriveAgentStatus()` from `src/server/status.ts`: a pure function of the committed view
(`pi.live`, `pi.inbox`, `pi.agent`), the hook list, the sandboxed-UI flag and the model reference.
This streams exact Chord structural diffs to every connected browser tab over
`acceptWebSockets(wss, host, { principal: () => ({ kind: "owner" }) })`.

### 4.3 Stage 1 Explicit Status Indicators (Required for Testing & Mobile Clarity)

The Web UI must render explicit, machine-and-human-readable status badges (`data-testid` attributes included):
1. **Header / Status Banner (`StatusBanner.tsx`):**
   - `CONN: <connected | connecting | disconnected>` (`data-testid="status-connection"`)
   - `RUN: <idle | generating | running_tools | retrying | compacting>` (`data-testid="status-run"`)
   - `TOOLS: <N running / M total>` (`data-testid="status-tools"`)
   - `INBOX: <N queued>` (`data-testid="status-inbox"`)
   - `GEN-UI: <enabled | disabled>` toggle button (`data-testid="toggle-gen-ui"`)
2. **Per-Message Status (`TranscriptView.tsx`):**
   - User entry (`pi.user`): `[USER • settled]`
   - Proactive Hook entry (`app.hook`): `[PROACTIVE HOOK: <hookName> • <firedAt>]` highlighted distinctly so proactive agent initiation is immediately obvious.
   - Assistant entry (`pi.assistant`): `[ASSISTANT • settled • stopReason=<stopReason>]`
   - Live streaming assistant (`docs["pi.live"].generation.message`): `[ASSISTANT • STREAMING (attempt N)]` with live text & thinking blocks.
3. **Per-Tool Status (`ToolRow.tsx`):**
   - Pairs tool calls from assistant messages with `docs["pi.live"].tools` (while running) and `pi.tool-result` entries (when settled).
   - Shows explicit badge: `[TOOL: <name> • status=<pending | running | done | error>]` (`data-testid="tool-status-<name>"`).
   - Streams live `slot.output` in real time while `status === "running"`, and shows final output when `done`.
4. **Inbox Queue Bar (`InboxBar.tsx`):**
   - Lists items from `docs["pi.inbox"].items` showing `[QUEUED: <steer | followUp>] <content>` and a `Withdraw` button calling `withdrawSubmission({ submissionId })`.
5. **Proactive Hooks Drawer/Bar (`HooksPanel.tsx`):**
   - Shows each configured hook with its `enabled` toggle, `fireCount`, `lastFiredAt`, and a **`Fire Now`** button (`fireHook({ hookId })`) so you can trigger a proactive agent message with one tap on mobile or desktop.

---

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

## 6. Verification & Acceptance Criteria

1. **`test/harness-env.test.ts`:**
   - Starts `Harness` on SQLite with `RemoteExecutionEnv` connected to `localDaemon()`.
   - Verifies `bash`, `write`, `read`, `edit` execute through the `pi-env` daemon.
   - Verifies firing an event hook (`fireHook`) appends an `app.hook` entry and triggers a proactive assistant response.
   - Verifies crash/reopen recovery (`harness.close()` -> `Harness.open()` -> `harness.resume()`).
2. **`test/chord-e2e.test.ts`:**
   - Starts the HTTP + WebSocket server and connects a real Chord browser-mode `Host` over `webSocketLink`.
   - Verifies initial `view` and `status` hydration.
   - Verifies `submit`, live streaming updates (`status.runStatus`), tool execution status transitions, `steer` / `followUp` inbox queueing + withdrawal, `abort`, and proactive hook firing pushing updates to the connected client.
   - Verifies `generateSandboxedUi` tool call streaming and settlement when `setSandboxedUiEnabled({ enabled: true })` is called.
   - Verifies a threshold compaction: with a small context window and `compaction: { reserveTokens: 1, keepRecentTokens: 1 }`,
     the second turn writes a `pi.compaction` entry (reason `threshold`) and still answers.
3. **Browser / Mobile Verification:**
   - `npm run build:web && npm run dev` serves the mobile-responsive web app on `http://127.0.0.1:8787`.

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
6. **Tests must not inherit ambient flags.** `ENABLE_SANDBOXED_UI=1` in the environment made the "disabled by
   default" assertions fail under `npm test`; the server suite now passes `enableSandboxedUi: false` explicitly.
