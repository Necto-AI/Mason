# Agent engines and how each bot runs

## What it is

Sixteen `agent-*` packages: fifteen engine adapters and one browser service. An engine adapter is a
small HTTP process wrapping somebody else's agent framework and speaking AG-UI. Its identity never
reaches the server, which holds a URL, a token and a grant list. `README.md:57`: a Bot is any
endpoint speaking AG-UI, so "the governance rides the protocol rather than the framework".

## How it works

### The contract each adapter implements

Four things:

1. Serve AG-UI runs on the port and path its catalogue row names (`runPath` in
   `shared/harnesses.json`).
2. Answer `GET /health`, exempt from auth because Compose polls it before a token exists
   (`agent-agno/src/main.py:67`).
3. Refuse everything else without `x-openbot-agent-token` matching `MANAGED_AGENT_TOKEN` in constant
   time, treating an unset token as unconfigured rather than open (`agent-adk/src/main.py:74`). This
   middleware appears identically in twelve files.
4. Read `BOT_PROVIDER`/`BOT_MODEL` and spell the model string its own framework wants
   (`shared/model_providers.py:128`).

The adapter publishes no tools: everything callable arrives per run in `input.tools`
(`agent-bot/src/index.ts:9-13`), and `agent-crewai/src/main.py:6` names the rule — we do not write
adapters.

### What the server puts around every remote run

The interesting half is `remoteAgentWithStandingRole` (`server/src/copilot.ts:1230`). Per run, for
every remote Bot, it injects the standing-role system message, a "holdings" message describing only
the tools offered this turn, the Bot's grants on top of the surface's, a signed run assertion in
`forwardedProps.openbotRun`, and `openbotDeploymentTools` naming what the deployment executes
itself (`:1344`). It also sanitises dangling tool calls, inlines attachments, and wraps the run in
`HeadlessToolsMiddleware` so governed tools execute inside the stream
(`toolkit/src/headless-tools.ts:36`).

```
app (frontend tools: computer_*, components)      server (gateway, policy, audit)
        |                                              |
        +--- CopilotKit runtime --> AbstractAgent <----+
                                       |
                 +---------------------+---------------------+
                 |                                           |
         BuiltInAgent (in-process,                  HttpAgent -> AG-UI endpoint,
         toolkit/src/run-turn.ts)                    or @ag-ui/mastra bridge
                                                           |
                                              agent-<framework> image: own loop,
                                              no tools of its own
```

Two transports only (`server/src/copilot.ts:1144`): `HttpAgent` for AG-UI, and a Mastra client
through `@ag-ui/mastra` for a server that serves a roster — hence Mastra Bots carry a
`remoteAgentId` (`server/src/agents/profile-store.ts:297`).

### Where the engines actually differ

Most adapters are a handful of wiring lines. The differences are framework and provider quirks, not
product features.

| Engine | Loop owner | Notable difference |
|---|---|---|
| `agent-bot` | surface | AG-UI by hand over chat completions; buffers tool-call fragments by index (`agent-bot/src/index.ts:156`); refuses a model it cannot drive |
| `agent-langgraph` | itself, for deployment tools | Own graph loop; calls `/api/agent-tools/call` with the signed assertion (`agent-langgraph/src/index.ts:258`); ends the run on a surface tool (`:386`) |
| `agent-langgraph-agui` | same | Shim for upstream single-slot tool streaming (`agent-langgraph-agui/src/parallel_tools.py:1`), `ContextVar` for run tools (`tool_runtime.py:1`) |
| `agent-claude-sdk` | Claude CLI | One SDK query kept alive across HTTP runs, client tools resolved by a `PostToolUse` hook (`agent-claude-sdk/src/adapter.py:87`); a second `/model` endpoint with built-in tools stripped (`adapter.py:96-97`, `main.py:71`) |
| `agent-adk` | surface | Filters partial `FunctionCall` chunks AG-UI would treat as complete (`agent-adk/src/main.py:26`) |
| `agent-ag2`, `agent-microsoft` | surface | Pick Anthropic vs OpenAI client classes; repair empty base URLs |
| `agent-agno` | surface | In-memory DB on purpose, `drop_params` for reasoning models (`agent-agno/src/main.py:50-55`) |
| `agent-llamaindex`, `agent-strands`, `agent-pydantic-ai` | surface | Model-string spelling (`provider/model` vs `provider:model`), function-calling registration |
| `agent-langroid` | surface | Overrides the agent: `ag-ui-langroid` 0.1.1 forwards only tool names and the last user turn (`agent-langroid/src/frontend_tools.py:67`) |
| `agent-crewai` | surface | Patches `crewai_prepare_inputs` for a leading system message and provider-shaped messages (`agent-crewai/src/main.py:155`) |
| `agent-antigravity` | surface | Gemini-only and pinned: its bundled Go harness needs a Gemini key (`agent-antigravity/src/main.py:3-10`) |
| `agent-mastra` | surface | No AG-UI route; a plain Mastra server, translated server-side (`agent-mastra/src/mastra/index.ts:1-13`) |

Streaming differs the same way: each adapter emits AG-UI SSE through its own encoder, and where two
agree the upstream integration does. `agent-langgraph/src/stream.ts:1` and
`agent-bot/src/history.ts:1` were split out so translation is testable without binding a port.

### Choosing and configuring an engine

Chosen once at deployment, not per Bot. `desktop/src-tauri/src/harness.rs:1-17` holds the rule: a
row earns a place only when an AG-UI integration already exists and somebody other than OpenBot
maintains it — Codex and Gemini CLI are absent for that reason. A pick resolves to an image
reference, port and run path (`harness.rs:271`), written to `.env` as `PICKED_HARNESS_IMAGE` and
`_PORT`. Compose runs one `agent-harness` service behind a profile, "one service rather than
twelve" (`docker-compose.yml:297`); the server learns it as a second self-run endpoint, `alsoRun`,
sharing the managed token (`server/src/config.ts:145-152`), and registers it as `picked-harness`
(`server/src/routing/service.ts:12`).

Per Bot there is no engine field. The web dialog names frameworks for recognition only — "every
framework is reached the same way and stored the same way — an AG-UI address — so the server never
hears which was picked" (`app/src/components/agents/new-bot-sheet.tsx:100-104`). `webCreate: false`
(Mastra alone) marks where that promise is false (`shared/harnesses.ts:51-58`).

### agent-bot and agent-computer

`agent-bot` is a reference: 266 lines of hand-written AG-UI, proving the protocol is the only
requirement, and called "a reference rather than something to build a deployment on"
(`docs/coworkers.md`, *Default endpoint*).

`agent-computer` is not an engine. It is one long-lived Playwright process per Bot with a
`/snapshot` then `/click|/type|/key|/scroll` element-ref contract (`agent-computer/src/index.ts:71-99`),
a workspace volume, a shell, egress filtering, and a control state machine. Its loop is an admission
gate, not a model loop: eleven paths are declared acting (`agent-computer/src/authorisation.ts:58-78`)
and refused while a person holds the wheel (`index.ts:789`). Handback invalidates refs, so the Bot
must snapshot again (`control.ts:28`); the barrier drains in-flight work and never queues or replays
(`action-barrier.ts:1`).

### supervisor and worker

`supervisor` holds the Docker socket so the API server does not, exposing four verbs expressed in
Bots — ensure, stop, reset, list (`supervisor/src/index.ts:16-40`). "The shared secret is not the
boundary; the vocabulary is" (`:35`). `worker` is a thirty-second loop running the same routine
sweep the CronJob runs, handing each claimed run to `POST /internal/routines/run` with its own
secret (`worker/src/index.ts:24`, `worker/src/env.ts:73`). Neither touches an engine.

## Decisions and their reasons

**No adapters, ever.** Stated twice (`agent-crewai/src/main.py:6`,
`desktop/src-tauri/src/harness.rs:15`) and it holds: protocol code is confined to `agent-bot` and
`agent-langgraph`, which predate the rule. The cost is that every quirk above becomes an OpenBot
defect with an upstream fix — the LangGraph tool-stream slot, the Langroid truncation and the ADK
partial calls are all workarounds, each a pin waiting to rot.

**One image per framework anyway.** Each framework is a Python or TypeScript library in its own
process, so a "plugin" cannot be a config entry; it is a container image. Hence a data catalogue and
one parameterised compose service.

**Two loop owners, chosen per framework.** The surface executes what it registered; the server
executes governed tools through `HeadlessToolsMiddleware`; a framework Bot may execute deployment
tools only by calling back with the signed assertion (`server/src/app.ts:1767`,
`server/src/agents/callback-token.ts:1`). The reasoning is explicit: a Bot that runs its own loop is
"the honest shape … what it must not have is a route to a vendor that goes around this deployment"
(`server/src/app.ts:1753-1760`).

**Approvals ride AG-UI interrupts.** A governed action needing a person suspends the run, the
waiting details ride on the interrupt (`toolkit/src/headless-tools.ts:31`), and the continuation —
messages, state, context, `forwardedProps` — is stored so the answer resumes that call
(`toolkit/src/continuation.ts:9`, `server/src/approvals/service.ts:1`).

**One doc disagrees with the code.** `docs/architecture.md` puts `agent-harness` on 4202; the
catalogue gives each framework its own port (4202-4214) and compose binds `PICKED_HARNESS_PORT`,
4202 being the default only.

### What one adapter plus a plugin would avoid

Measured: 2,225 lines of Python across eighteen adapter files, plus 906 lines of TypeScript,
plus **6,035 lines of Python tests** — 2.7 test lines per source line, because every harness carries
its own mock provider, model-spec test and tool-continuation test.

The avoidable part is the perimeter: token check, health, port handling, the `botSettings` call and
model-string spelling — twenty-five to forty lines per harness, call it 250-450 lines with their
tests, factorable into a shared Python package the way `shared/model_providers.py` already is. The
rest is not duplication: the CrewAI patch, the Langroid override, the ADK filter, the Claude query
segments and the Mastra translation are per-framework facts a generic adapter would rediscover at
runtime.

What a single plugin adapter costs is the thing being sold. It needs a
lowest-common-denominator lifecycle that the three hardest cases — Claude's multi-request query,
LangGraph's own loop, Mastra's roster — do not fit. The current shape buys zero protocol code and
per-framework images at the price of 6,000 lines of contract tests. Keep the shape; factor the
perimeter.

## Mason-relevant

- **Worth copying:** one middleware wrapping every outside agent — standing role, holdings, grants,
  signed run assertion, tool execution — is the right seam, and where a second mason engine would
  attach. Copy the short-lived signed run assertion (`server/src/agents/callback-token.ts:26`): it
  makes the audit trail unforgeable even by a compromised adapter.
- **Worth copying:** `shared/model-providers.json` plus `botSettings` — one file every language
  reads, environment over file over default, refusing at import. That is how the model choice stays
  out of code when a second engine appears.
- **Worth avoiding:** fifteen images and six thousand test lines to prove fifteen frameworks answer
  the same four requests. Mason's "integration is a service with two halves" (`GLOSSARY.md`) is the
  stronger abstraction: it also decides credentials, triggers and boot-time resolution.
- **Worth avoiding:** two loop owners. OpenBot needs both because tool effects are visible in a
  browser; mason's tools run in `pi-env`, so one loop leaves no second place for an invented result.
- **Already right in mason:** the computer is not an engine. `agent-computer` is a browser plus an
  admission gate with no policy of its own (`agent-computer/src/index.ts:74-79`), the same split as
  `service/` vs `agent/` in `docs/adr/0002-split-home.md`. The run-scoped assertion also mirrors
  mason's signed integration trigger.

## Open questions

- Whether every catalogue row is exercised in CI. The per-harness pytest suites exist and
  `tests/learning_harness_contract.py` is shared, but not which workflow gates them.
- Whether the twelve token middlewares have diverged (Antigravity's is reformatted, Mastra's
  compares length then XORs inline). A diff would settle it; I did not run one.
- The real cost per new harness: `CHANGELOG.md` records one fix per harness, and whether any recurs
  is not determinable from the log. Related: nothing in the server forbids a deployment registering
  several frameworks, so the cost of running many engines is unknown.