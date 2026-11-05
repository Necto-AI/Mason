# mason's architecture — the current state, and where a change goes

This file is the map, not the argument. It says how mason is assembled today and which file owns which kind of
behaviour, so that a stranger can find the place a change belongs before knowing why it belongs there. The product goal
and the milestone specifications are [`docs/SPEC.md`](SPEC.md), the reasons behind the shape are in
[`docs/adr/`](adr/), and the catalogs that can be generated — the routes and their grants, the extensions, the budgets —
are [`docs/SURFACE.md`](SURFACE.md). Nothing here repeats those.

## The assembly

One process, started by `npm run dev`, is one bot.

- **`src/server/main.ts`** is the process: an HTTP server, the static shell of the panel, and the WebSocket upgrade that
  turns into a connector's socket. Everything a request can reach is routed here or in `admin.ts`.
- **The durable Harness and SQLite** (`src/server/runtime.ts`) hold the conversation. The transcript is the truth: every
  answer, every delivery, every permission question is an entry, and a restart resumes from the log rather than from
  memory.
- **`@earendil-works/pi-env` is the execution split** (`src/server/env.ts`): the model and the harness run here, and the
  tools that touch files run on the tool machine, which is the only place `~/.mason/agent/` is mounted.
- **Connectors are the out-of-process edge** (`src/server/connector.ts`, `packages/protocol`): one JSON-RPC socket at
  `/api/connector`, opened by a service that carries a *user* face, a *tools* face, an *events* face, or some of them.
- **The panel is a control plane** (`src/server/admin.ts`, `src/web/admin/`): a browser application mason serves, which
  reads `GET /api/admin/state` and administers the deployment. It cannot speak — a person's words arrive through a
  connector, never through the panel ([ADR 0011](adr/0011-the-panel-is-a-control-plane.md)).
- **The home is `~/.mason/`** (`src/server/house.ts`): `agent/`, which the tool machine mounts — `profile.md`, the dated
  `log/`, `skills/`, `workspace/`, and the git history of all of it — and `service/`, which the tool machine never sees.
- **The prompt** is `src/server/prompt.ts` and only that file: every section, in the order the model reads them.
- **Tools** are extensions (`src/server/extensions/`) plus the three per-boot ones — `mcp`, `codemode`, `permissions` —
  and every call to any of them passes the gateway in `src/server/permissions.ts`.
- **Hooks** (`src/server/hooks.ts`) are the ways a turn starts without a person: a timer, a connector's fire, and the run
  supervisor's retry.

The file-by-file tree is [`docs/SPEC.md` §2](SPEC.md#2-repository-structure); this file answers the other question.

## Where new behaviour goes

One row per goal. "Owner" is the file that decides the thing; a change that edits a different file to change that
behaviour is in the wrong place. "Pinned by" is the test that fails if the mechanism is removed — where there is none,
this table says so rather than implying a test exists.

| Goal | Owner | Mechanism | Pinned by |
|---|---|---|---|
| A new agent capability (a tool) | `src/server/extensions/<name>.ts`, then the array in `src/server/runtime.ts` | `defineTool` + `defineExtension`, added to `BASE_EXTENSIONS`. A tool that a script may also call is `callers: ["tools"]`. Nothing a service offers may become a tool: it is asked for through `mcp_search` / `mcp_describe` / `mcp_call` | `test/delivery.test.ts` (the registration facts of `reply`), `test/mcp.test.ts` (a connected server moves no tool in the list). No test fails when an extension is merely added to `BASE_EXTENSIONS` — `docs/SURFACE.md` Table B is what shows it |
| A new prompt section | `src/server/prompt.ts` | `section(key, render)` in `PROMPT_SECTIONS`, in reading order. A section renders from files on the tool machine and must render byte-identically while nothing changed | `test/prompt.test.ts` — "every section renders byte-identically in the next turn" |
| A new way for words to arrive (a connector face) | `src/server/connector.ts`, plus the entry's `connector.user` grant in `service/integrations.json` | The face is advertised at the handshake from the grant; `admission.ts` decides where the submission waits. The credential is minted by `npm run connector` and is the entry's, never a person's | `test/connector.test.ts` (submissions, actors, rooms, capabilities), `test/admission.test.ts` |
| A new service the agent reaches | `service/integrations.json`; `src/server/integrations.ts` for the file, `src/server/mcp.ts` for the tools face | `npm run integration -- add` writes a tools face (an MCP endpoint over Streamable HTTP and the one line the model is told about it); the panel edits the same entry's `connector` block. Read once at boot, so a change is a restart | `test/integrations.test.ts` (the file, the refusals, the route), `test/mcp.test.ts` (a live catalog, reconnection, the required-vs-optional boot) |
| Something that wakes the agent | `src/server/hooks.ts` for the hook; the caller's grant for the fire | A defined hook (`builtinHooks` seeds five) fired by a timer (`intervalMs`), by a connector's `mason/fire` mapped through `connector.events.hooks`, by the panel's Hooks page, or by `RunRetrySupervisor`. A fire has a request id, and the same id never runs twice | `test/hooks.test.ts` (fire identity, arming), `test/connector.test.ts` (a fire is a hook entry, deduplicated on its `fireId`), `test/run-retry.test.ts` |
| A new permission decision | `src/server/permissions.ts` (`decide`), the tool's `dev.mason/approval` marker, and the connector's `policy` in its grant | One `beforeTool` hook decides from the marker inside the operator's ceiling: a required tool asks whatever the rules say, `ask` and `deny` beat a trusted marker, and a marker never waives a rule. The question is an entry (`app.permission`) and the first answer is final | `test/permissions.test.ts` (the decision matrix, the question, the restart), `test/connector-approvals.test.ts` |
| A new area of the panel | `src/web/admin/sections/<area>.tsx`, a route in `src/server/admin.ts`, a grant in `src/shared/admin.ts`, and the key it reads in `PanelState` | `requireGrant(grants, "…")` in the area's branch of `handleAdmin`; the state carries the key only for a device that holds the grant, so the browser never filters what it should not have been sent | `test/panel.test.ts` — "decides which areas of the state exist, and what a write answers" |
| A new HTTP route | `src/server/main.ts` for the door, `src/server/admin.ts` for the panel's API, and a grant in `src/shared/admin.ts` | `authenticate` on the owner's door and `requireGrant` in the handler. A route outside the gate is a deliberate entry in the generator's `PUBLIC_ROUTES`, with its reason | `test/surface.test.ts` and `npm run gen:surface:check`: a route literal with no guard stops the generator and names the route |
| A new thing a reader may see | `src/server/projection.ts` first, then the shape in `src/shared/contract.ts` | The projection is a whitelist: an entry kind is invisible until a `project*` function names it, and reasoning, tool calls, arguments and output never cross. The raw view is `src/server/trace.ts`, for a device granted `trace` | `test/projection.test.ts` (both halves of every case), `test/panel.test.ts` — "sends the conversation and never the machine behind it" |
| A new fact the agent keeps | `agent/log/YYYY-MM-DD.md`, or `profile.md` beside it | The agent writes it with `write`, and `agent/` is a git repository, so a fact is a file the person can read and revert. There is no memory tool: the log is markdown, read back with `read` | `test/harness-env.test.ts` — "writes through the tool machine, and the next turn's prompt carries what was written there" |
| A new skill | `skills/<name>/SKILL.md` in the repository, or `<home>/agent/skills/<name>/SKILL.md` for a personal one | A directory with a `SKILL.md` is one skill; the index is rendered into the prompt with the path to read, never the body. Shipped skills are seeded into the home at boot, and a personal skill of the same name wins | `test/prompt.test.ts` (`discoverSkills`, the one root, the shadowing), `test/capability-wiring.test.ts` (what the repository says it ships) |
| A new control a connector may send | `src/server/commands.ts` and the closed set in `packages/protocol` | `connector.commands` in the entry's grant decides which of them that connector may say; a word the entry does not declare spends nothing | `test/connector.test.ts` — "runs a declared command once per request id, and an undeclared word spends nothing" |

## The four invariants

A change that breaks one of these is not a trade-off to weigh, it is the wrong change.

1. **Every way in is authenticated.** A token or the cookie it is spent into, plus an Origin that is ours or absent
   (`src/server/auth.ts`); a connector's own credential on its socket and its attachment paths
   (`src/server/connectors.ts`), read on every request so a revoke lands immediately; `/api/health` and the static shell
   outside both, by decision. Pinned by `test/auth.test.ts`, `test/connector.test.ts` and `test/surface.test.ts`.
2. **Nothing reaches a device before the projection.** `src/server/projection.ts` derives `transcript`, `queued` and
   `agentStatus` from the committed view, and `src/server/trace.ts` is the only other reader, behind the `trace` grant.
   Pinned by `test/projection.test.ts` and the refusal in `test/panel.test.ts`.
3. **Every tool call passes the permission gateway.** A model's own call and a script's nested one go through the same
   `beforeTool` hook (`src/server/permissions.ts`); a new tool is gated by existing rather than by being wrapped. Pinned
   by `test/permissions.test.ts`.
4. **The prompt prefix is stable.** The prompt is `PROMPT_SECTIONS` and the extensions installed at boot; a tool schema
   that arrived mid-conversation would re-price every later turn, which is why a service's tools are a catalog
   ([ADR 0010](adr/0010-tools-are-live-and-every-call-is-gated.md)). Pinned by `test/prompt.test.ts` (a section renders
   byte-identically twice) and `test/mcp.test.ts` (the tool list does not move when a server connects).

## What can be generated, is generated

`docs/SURFACE.md` holds the tables a hand cannot keep honest — every HTTP route and the grant that guards it, the
extensions a boot installs with their tools and prompt sections, and every exported budget in `src/server/limits.ts`. It
is rendered by `scripts/gen-surface.ts`, written by `npm run gen:surface`, and checked in CI by
`npm run gen:surface:check`. Hand-editing it is a failing check, which is the point: the diff that adds a route without a
grant is the diff that says so. The word budgets in `docs/doc-budgets.json`, and which document owns which kind of fact,
are in [`docs/AGENTS.md`](AGENTS.md).
