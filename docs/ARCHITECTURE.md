# mason's architecture — the current state, and where a change goes

This file is the map, not the argument. It says how mason is assembled today and which file owns which kind of
behaviour, so that a stranger can find the place a change belongs before knowing why it belongs there. The product goal
and the milestone specifications are [`docs/SPEC.md`](SPEC.md), the reasons behind the shape are in
[`docs/adr/`](adr/), and the catalogs that can be generated — the routes and their grants, the extensions, the budgets —
are [`docs/SURFACE.md`](SURFACE.md). Nothing here repeats those.

## The assembly

One process is one bot: started by `npm run dev` in a checkout, or by `mason up` from the installed package
(`mason-agent`; the checkout's README holds the install).

- **`src/server/main.ts`** is the process: an HTTP server with three doors and the WebSocket upgrade that turns into a
  connector's socket. Everything a request can reach is routed here.
- **The durable Harness and SQLite** (`src/server/runtime.ts`) hold the conversation. The transcript is the truth: every
  answer, every delivery is an entry, and a restart resumes from the log rather than from
  memory.
- **`@earendil-works/pi-env` is the execution split** (`src/server/env.ts`): the model and the harness run here, and the
  tools that touch files run on the tool machine, which is the only place `~/.mason/agent/` is mounted.
- **Connectors are the out-of-process edge** (`src/server/connector.ts`, `packages/protocol`): one Chord socket at
  `/api/connector`, opened by a service that carries a *user* face, an *events* face, or both. An integration's *MCP
  server* is the other direction: mason calls it with that server's credential.
- **The home is `~/.mason/<bot>/`** (`src/server/house.ts`): `agent/`, which the tool machine mounts — `profile.md`, the
  dated `log/`, `skills/`, `workspace/`, and the git history of all of it — and `service/`, which the tool machine never
  sees. `~/.mason` itself is the root (`src/server/root.ts`): `common/` and one directory per bot.
- **The prompt** is `src/server/prompt.ts` and only that file: every section, in reading order.
- **Tools** are extensions (`src/server/extensions/`) plus the two per-boot ones, `mcp` and `codemode`.
- **Hooks** (`src/server/hooks.ts`) are the ways a turn starts without a person: a timer, a fire, and the run
  supervisor's retry.

The file-by-file tree is [`docs/SPEC.md` §2](SPEC.md#2-repository-structure); this file answers the other question.

## Where new behaviour goes

One row per goal. "Owner" decides the thing; a change that edits another file to change that behaviour is in the wrong
place. "Pinned by" is the test that fails when the mechanism is removed, or a note that none exists.

| Goal | Owner | Mechanism | Pinned by |
|---|---|---|---|
| A new agent capability (a tool) | `src/server/extensions/<name>.ts`, then the array in `src/server/runtime.ts` | `defineTool` + `defineExtension`, added to `BASE_EXTENSIONS`. A tool that a script may also call is `callers: ["tools"]`. Nothing a service offers may become a tool: it is asked for through `mcp_search` / `mcp_describe` / `mcp_call` | `test/delivery.test.ts` (the registration facts of `send`), `test/mcp.test.ts` (a connected server moves no tool in the list). No test fails when an extension is merely added to `BASE_EXTENSIONS` — the extensions line in `docs/SURFACE.md` is what shows it |
| A new prompt section | `src/server/prompt.ts` | `section(key, render)` in `PROMPT_SECTIONS`, in reading order. A section renders from files on the tool machine and must render byte-identically while nothing changed | `test/prompt.test.ts` — "every section renders byte-identically in the next turn" |
| A new way for words to arrive (a connector face) | `src/server/connector.ts`, plus the entry's `connector.user` grant in `service/integrations.json` | The face is advertised at the handshake from the grant; `admission.ts` decides where the submission waits. The credential is minted by `npm run connector` and is the entry's, never a person's | `test/connector.test.ts` (submissions, actors, rooms, capabilities), `test/admission.test.ts` |
| A new service the agent reaches | `service/integrations.json`; `src/server/integrations.ts` for the file, `src/server/mcp.ts` for the MCP server | `npm run integration -- add` writes `mcp` (a Streamable HTTP endpoint and its one line for the model); the entry's `connector` block is edited in the file. Read once at boot, so a change is a restart | `test/integrations.test.ts` (the file, the refusals), `test/mcp.test.ts` (a live catalog, reconnection, the required-vs-optional boot) |
| Something that wakes the agent | `src/server/hooks.ts` for the hook; the caller's grant for the fire | The agent's own routine, from `agent/routines.json`, fired on a timer; a connector's `mason/fire` mapped through `connector.events.hooks`; or `RunRetrySupervisor`. A fire has a request id, and the same id never runs twice | `test/hooks.test.ts` (fire identity, arming), `test/connector.test.ts` (a fire is a hook entry, deduplicated on its `fireId`), `test/run-retry.test.ts` |
| A new HTTP route | `src/server/main.ts`, then a row in `DOORS` in `scripts/surface.ts` | `authenticateConnector` on the connector's door; `/api/health` is the one public path. A route is unauthenticated until it is classified | `npm run gen:surface:check`: a route literal in no `DOORS` row stops the render and names the route |
| A new thing a reader may see | `src/server/projection.ts` first, then the shape in `src/shared/contract.ts` | The projection is a whitelist: an entry kind is invisible until a `project*` function names it, and reasoning, tool calls, arguments and output never cross. | `test/projection.test.ts` (both halves of every case) |
| A new fact the agent keeps | `agent/log/YYYY-MM-DD.md`, or `profile.md` beside it | The agent writes it with `write`, and `agent/` is a git repository, so a fact is a file the person can read and revert. There is no memory tool: the log is markdown, read back with `read` | `test/harness-env.test.ts` — "writes through the tool machine, and the next turn's prompt carries what was written there" |
| A new skill | `skills/<name>/SKILL.md` in the repository, or `<home>/agent/skills/<name>/SKILL.md` for a personal one | A directory with a `SKILL.md` is one skill; the index is rendered into the prompt with the path to read, never the body. Shipped skills are seeded into the home at boot, and a personal skill of the same name wins | `test/prompt.test.ts` (`discoverSkills`, the one root, the shadowing), `test/capability-wiring.test.ts` (what the repository says it ships) |
| A connector a first run can offer | `catalog/connectors.json` for the list, `src/server/catalog.ts` for the parse, `scripts/setup.ts` for the flow | An entry names the image and its tag, the env a person answers, the face it may claim and its controls. The parse is closed: an unknown key is a refusal, because a typo in `optional` reads as its opposite. Setup writes the grant through the same writer the boot reads, mints one credential, renders the project and starts it | `test/catalog.test.ts` (the shipped entries, every refusal), `test/setup.test.ts` (a first run, a second one, a connector that is already granted) |
| The container a connector runs in | `src/server/connector-compose.ts` for the project, `src/server/podman.ts` for the four verbs | One compose project per connector, `service/connectors/<name>/compose.yaml`: `restart: always`, a project name carrying eight hex of the home path so two homes cannot collide, and no published port. The boot half of that policy is `podman-restart.service`, which no file here can enable, so setup reports it and names both commands. `podman compose` sits behind a command runner that is a parameter | `test/connector-compose.test.ts` (the golden project, the escaping, rewrite-or-no-op), `test/podman.test.ts` (the argv, and both refusals) |
| The root a fleet lives in | `src/server/root.ts` | `MASON_ROOT`, else `~/.mason`: `common/` plus one directory per bot, each today's home. `-b` over `MASON_BOT` over the only bot over a refusal that names them; halves at the root are refused with the manual move; `MASON_HOME` still names one home directly | `test/root.test.ts` |
| The store every bot shares | `src/server/common.ts` | `common/settings.json` (tolerant read-merge), `common/auth.json` (strict, whole-file, under a lock), `common/runtime.json` (strict kind). A version other than `0.1` is refused; every write is staged with a timestamped copy beside it | `test/common.test.ts` |
| A first run, and day-2 configuration | `scripts/init.ts`, `scripts/new.ts`, `scripts/onboard.ts`, `scripts/bots.ts`, `scripts/status.ts` | Skins over the same functions: `init` once per root (one real completion before anything is written), `new` per bot, `onboard` the dispatcher. `bin/mason.ts` turns `-b` into `MASON_BOT` for every verb | `test/init.test.ts`, `test/new.test.ts`, `test/onboard.test.ts` |
| A screen a first run shows | `src/tui/` for the primitives, `scripts/onboarding.ts` for the flow | `Screen` is the seam: a second implementation answers from a table, so navigation and failures run with no terminal. The plan reaches the commands as their own flags, so `--yes` and the wizard cannot drift | `test/tui.test.ts`, `test/onboarding.test.ts`, `test/onboarding-live.test.ts` |
| Proving a configuration | `src/server/doctor.ts` | Nine read-only checks, one repair command per failure, exit 1 on any failure, no `--fix`; a server nobody started passes | `test/doctor.test.ts` |
| Talking to the bot with no connector deployed | `scripts/chat.ts` | The console connector is built in: it mints its own credential for the `console` entry, opens the same `/api/connector` socket every connector opens, prints each delivery and maps `/stop`, `/status`, `/compact`, `/clear` onto the protocol's controls | `test/chat.test.ts` (a real server and a real socket: the answer, the missing server, a stop mid-turn) |
| A new control a connector may send | `src/server/commands.ts` and the closed set in `packages/protocol` | `connector.commands` in the grant decides which that connector may say; a word the entry does not declare spends nothing | `test/connector.test.ts` — "runs a declared command once per request id, and an undeclared word spends nothing" |

## The three invariants

A change that breaks one is not a trade-off to weigh, it is the wrong change.

1. **Every way in is authenticated.** One credential class: the connector's own, on its socket and its attachment
   paths (`src/server/connectors.ts`), read on every connection so a revoke lands immediately; `/api/health` outside it, by
   decision. Pinned by `test/connector.test.ts` and `npm run gen:surface:check`.
2. **Nothing reaches a reader before the projection.** `src/server/projection.ts` derives `transcript`, `queued` and
   `agentStatus` from the committed view, and reasoning, tool calls, arguments and output are in none of them. Nothing
   consumes it yet: a reply reaches its connector through the outbox. Pinned by `test/projection.test.ts`.
3. **The prompt prefix is stable.** The prompt is `PROMPT_SECTIONS` and the extensions installed at boot; a tool schema
   that arrived mid-conversation would re-price every later turn, which is why an integration's tools are a catalog
   (`docs/SPEC.md` §4.1e). Pinned by `test/prompt.test.ts` (a section renders byte-identically twice) and
   `test/mcp.test.ts` (the tool list does not move when a server connects).

## What can be generated, is generated

`docs/SURFACE.md` holds the tables a hand cannot keep honest — the doors and what opens each, the extensions a boot
installs, and every exported budget in `src/server/limits.ts`. `scripts/surface.ts` renders it and
`npm run gen:surface:check` fails a stale copy, so hand-editing it is a failing check: the diff that adds a route without
a grant is the diff that says so. The word budgets in `docs/doc-budgets.json`, and which document owns which kind of
fact, are in [`docs/AGENTS.md`](AGENTS.md).
