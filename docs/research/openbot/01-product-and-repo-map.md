# Product and repo topology

## What it is

OpenBot is a self-hosted, multi-user chat product whose participants are agents: "the AI assistant your company can actually own" (`README.md:3-6`). A **Bot** (also called a *coworker*) is a durable profile — name, title, role description, visibility — backed by a *built-in* system prompt run in the server or by any endpoint speaking AG-UI (`docs/coworkers.md:5-16`, `server/src/agents/registry.ts:1-17`). The user is a company: an administrator who registers connectors, grants tools and sets policy, and the people who talk to the Bots. A single-user laptop mode ships too (`OPENBOT_SINGLE_USER`, `README.md:36`).

It is deliberately not a hosted service: "A template, not a product … every workspace in this repository is private" (`README.md:32`), status alpha (`README.md:34`), version `0.2.0` (`package.json:3`). The visible commercial layer is CopilotKit's: the README's primary links are "Talk to an engineer" / "Have us build it with you" (`README.md:9`, `README.md:38-40`), and — the part that matters — **CopilotKit Intelligence is a hard runtime dependency with no fallback**: `server/src/config.ts:973-985` refuses to start without `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL` and `INTELLIGENCE_API_KEY`, and the only mode the config returns is `"intelligence"` (`server/src/config.ts:24`, `:994`). Licensed features, memory first, are gated by Intelligence's entitlement (`server/src/intelligence-entitlement-check.ts:1-25`), and `OPENBOT_SELF_HOST_BANNER` advertises CopilotKit's help bar inside the product (`README.md:304`). So: MIT code, proprietary hinge.

## How it works

**Packages.** The Bun workspace is five packages (`package.json:7-12`); everything else is infrastructure or outside it.

| Path | Role | Depends on | Size (code lines) |
| --- | --- | --- | --- |
| `server/` | Hono API, CopilotKit runtime, auth, policy, audit, connectors, channels, routines, triggers | `shared`, `toolkit` (`server/package.json:29-30`) | ~271k |
| `app/` | React/Vite SPA: channels, Bot pages, admin | `@openbot/shared` (`app/package.json:23`); branded at build time from the tenant package through `scripts/generate-app-config.ts:3-21` | ~112k |
| `toolkit/` | The CopilotKit/AG-UI glue the server drives turns with: `run-turn.ts`, `headless-tools.ts`, `granted-tool.ts`, `continuation.ts` | `@ag-ui/client`, `@copilotkit/runtime` (`toolkit/package.json:12-19`) | 3.5k |
| `shared/` | Cross-language data as JSON (`harnesses.json`, `model-providers.json`) plus pure TS helpers imported across app, server and adapters | nothing | 3k |
| `worker/` | Routines sweeper for a laptop; loops the same sweep the CronJob runs | deep-imports `server/src/db/client` (`worker/src/index.ts:20`) | 362 |

`desktop/` (Tauri, 51k), `mobile/` (Expo, 2.4k) and all 16 `agent-*` directories sit outside the workspace, each with its own lockfile and image.

**Dependency shape:**

```
app ──(build script)──► server/src/tenant-package ──► examples/fintech
 │                          ▲
 └──► shared ◄── server ────┘
                │  ▲
        toolkit ┘  └── worker (source-level import of server internals)
```

**Runtime topology.** `docker-compose.yml` defines `postgres` (`:2`), one-shot `migrate` (`:46`), `agent-computer` (`:78`), `supervisor` (`:188`), `agent-bot` (`:265`), a profile-gated `agent-harness` (`:307`) and `agent-langgraph` (`:350`); optional SPIRE services (`:140-165`). Compose splits networks: `postgres` and `migrate` on `data`, everything else on `default`, because a Bot has a shell and would otherwise reach the audit database (`docker-compose.yml:3-20`, `:395-403`). Every published port is loopback-bound. The server, the routines worker and the app are **host processes**, not compose services (`desktop/src-tauri/src/stack.rs:3-10`; `scripts/start.sh:252-270`).

```
                       ┌───────────── host ─────────────┐
browser ──► app :3010 ──► server :3001 ──┬──► PostgreSQL :5432 (container, data net)
                       │                 ├──► Intelligence (external)
                       │                 ├──► agent-bot :4200 / agent-langgraph :4201 / agent-harness
                       │                 └──► supervisor :4500 ──► one computer per Bot :4100
                       └── worker ───────────► server /internal/routines/run
```

Three shapes ship from one tree: the laptop stack above; a single image with app + API + Chromium on port 3001 and no supervisor (`Dockerfile:1-18`, `docs/deployment.md:23-33`); and a Helm chart adding per-Bot computer pods, a routines CronJob and a multi-replica API.

**How a Bot is created and run.** Two paths, both landing in the same tables (`agents` = runtime identity, `agent_profiles` = name/title/role/owner/visibility — `docs/architecture.md:161-171`):

1. *Declarative.* The tenant package under `TENANT_PACKAGE_DIR` defaults to `../examples/fintech` and is validated then synced at boot (`docs/architecture.md:363-380`; `server/src/index.ts:416`, `:459`). `agents.yaml` declares `built-in` (needs `system_prompt`) or `remote-ag-ui` / `remote-mastra` (needs `endpoint`); a row whose endpoint interpolates to empty is dropped rather than refused (`docs/configuration.md:1066-1072`, `examples/fintech/agents.yaml:64-92`).
2. *Imperative.* `/bots` → `POST /api/agents` with name, title, role, visibility, optional endpoint and optional write-only auth header (`server/src/agents/routes.ts:518-544`), validated through `POST /api/agents/test-connection` (`:435-473`).

A turn goes app → CopilotKit runtime mounted at the root (`server/src/app.ts:1361-1368`) → the Bot's endpoint, as an AG-UI `HttpAgent` or through the `@ag-ui/mastra` bridge, both normalised to an `AbstractAgent` (`server/src/copilot.ts:1117-1165`). The **tool loop runs at the Bot's endpoint**, not in the server: browser/file/MCP tools are handed in per run as frontend tools, the model decides, and each acting call is streamed back to the server gateway, which resolves the target, evaluates CEL policy, writes the audit row, and only then calls `agent-computer` (`docs/architecture.md:30-39`, `:41-47`). A built-in Bot runs the same shape in-process via `toolkit/src/run-turn.ts`.

**The adapters.** Of the 16 `agent-*` directories, `agent-computer` (8.4k lines) is not an adapter: it is the Chromium/workspace/shell container (`agent-computer/src/index.ts:746-1475`). Two others predate the project's own rule and write the protocol by hand, three carry real logic, ten are FastAPI shims over a vendor-maintained AG-UI package:

| Tier | Directories | Evidence |
| --- | --- | --- |
| Hand-written protocol (legacy) | `agent-bot` (427), `agent-langgraph` (1,091) | `agent-langgraph-agui/src/main.py:1-5`: "`agent-langgraph`… predates the rule against writing adapters" |
| Own protocol logic | `agent-langgraph-agui` (730), `agent-claude-sdk` (525), `agent-mastra` (735, incl. 535 test lines) | `agent-claude-sdk/src/adapter.py:1-6` replaces a placeholder tool result; `agent-mastra/src/mastra/index.ts:1-14` argues why it serves no AG-UI route |
| Thin wrapper (80–225 lines) | `adk`, `ag2`, `agno`, `antigravity`, `crewai`, `langroid`, `llamaindex`, `microsoft`, `pydantic-ai`, `strands` | `agent-crewai/src/main.py:3-9`: "imports `ag_ui_crewai` and stops"; `agent-agno/src/main.py:60` is three lines of mounting |

`shared/harnesses.json` is the single catalogue both the desktop installer (via Rust `include_str!`) and the web "new Bot" sheet read (`shared/harnesses.ts:1-15`); it holds 13 framework rows plus a `byo-url` row (`:187`).

## Decisions and their reasons

**AG-UI as the only seam.** "Governance rides the protocol rather than the framework" (`README.md:57-60`): tools arrive as front-end tools, so the deployment never needs per-framework tool code. Cost: the model loop lives outside the server, so authorization depends on the Bot's honesty plus a signed run assertion and a nonce-bound callback (`docs/architecture.md:117-122`, `:230-236`).

**No adapters of our own.** `agent-crewai` states the rule: a harness earns a row only if a third-party AG-UI integration exists (`desktop/src-tauri/src/harness.rs:1-12`). Cost: 13 near-duplicate images to build, pin and keep current, each with a copied token check and `/health` route.

**A computer per Bot behind four verbs.** The Docker socket lives only in the supervisor, which exposes ensure/stop/reset/list and derives container names from Bot ids (`supervisor/src/index.ts:21-41`). Cost: another process to run; the single image omits it, so every Bot shares one browser — "not fine as a boundary between tenants" (`docs/deployment.md:51-53`).

**Configuration is a package, not a screen.** Channels, skills, model and coworkers are YAML in a directory the deployment points at (`docs/configuration.md:1000-1015`), so white-labelling is a diff. Cost: startup refusals replace runtime errors (`docs/configuration.md:3`, `:1070-1076`); `examples/fintech/catalog/README.md:3-5` records that ten "ready" coworkers in front of every new deployment was the wrong default.

**One queue in Postgres for everything deferred.** Routines, the idle-computer culler and Bot-to-Bot handoffs are rows in `work_items` claimed with `select … for update skip locked` and leases, never in-process timers (`docs/architecture.md:181-200`, `:256-265`). Cost: a worker to deploy and watch, with a documented silent-failure mode (`docs/routines.md:65-96`).

**Where docs and code disagree.**
- `docs/architecture.md:21` gives `agent-harness` one port (4202); the catalogue assigns a port per framework, 4202–4214 (`shared/harnesses.json:10`, `:52`, `:122`), and compose templates only one (`docker-compose.yml:307-317`).
- Two LangGraph adapters exist: `docs/coworkers.md:70-76` names `agent-langgraph` on 4201 as the managed default, while the pickable LangGraph row is `agent-langgraph-agui` on 4206 (`shared/harnesses.json:47-59`). No page says which one a clone runs.
- `docs/configuration.md:37-42` says a coworker created without an endpoint is refused when `MANAGED_AGENT_AG_UI_URL` is unset; `server/src/agents/routes.ts:524-534` says the opposite in as many words: it now falls back to the role description as a built-in Bot, because the refusal broke the one-container image.
- `README.md:45-53` says a deployment starts with two coworkers (plus Risk Analyst when configured); `examples/fintech/agents.yaml:84-92` adds a fourth `picked-harness` row, and the app prefers it once setup has run (`app/src/lib/agents/default-agent.ts:3-13`).
- `prompt.txt:15` says there is no released desktop app; the README documents desktop organisation sign-in at length (`README.md:389-405`), CI builds `.dmg/.exe/.AppImage` (`.github/workflows/desktop.yml:171-175`), and no release attaches them (`publish-release.yml` has none). The code is ahead of the release, the README ahead of both.

## Mason-relevant

- **Worth copying:** the gateway as a single action boundary with audit-before-act and a fail-closed CEL policy (`docs/architecture.md:41-47`); the `initiator.kind` column that separates an unattended run from a person's (`docs/architecture.md:89-130`) — this is a better answer to "who caused this turn" than mason's log currently gives; one shared catalogue file in JSON, read by TypeScript, Python and Rust (`shared/harnesses.json:2`), which is how mason could ship `integrations/` metadata; skills that declare tool refs and grant nothing (`examples/fintech/skills.yaml:1-21`) as a way to narrow a large tool surface per turn; and refusals at boot with the fix named in the message (`server/src/config.ts:986-991`).
- **Worth avoiding:** the whole multi-Bot layer — groups, `message_bot` handoffs with depth caps, cross-Bot threads (`docs/architecture.md:211-301`) — which is exactly what mason's ADR-0001 puts out of scope; per-vendor connector code, which contradicts mason's ADR-0003 head-on: `server/src/plugins/` is 14.9k lines, of which Composio alone is 2,118 + 1,906 and Arcade 693 + 1,806, against mason's one MCP client and one event door. Also avoid: the ~100-table schema (61 migrations under `server/drizzle/`), and a mandatory hosted dependency in a tree advertised as ownable.
- **Already right in mason:** one bot, not a roster (ADR-0001) — OpenBot's own docs concede that a "person" seam in `ask_person` is a template's honest answer (`docs/architecture.md:297-300`), not a rota; a trigger door with a generic envelope, where OpenBot still hand-codes each source (`server/src/responsibilities/`); and a server-owned tool loop, which keeps authorization inside the process that holds the policy instead of trusting an endpoint to relay its own tool calls.

## Open questions

- What Intelligence does on the wire is not in this repo, so whether threads, memory and the realtime gateway could be replaced by local storage is unanswerable from the tree.
- Whether the "no adapters" rule holds across 13 images: each has tests (`agent-adk/tests/`), but nothing pins the upstream `ag_ui_*` packages to shared versions or exercises them from the server.
- Where the commercial line sits is unstated beyond the banner and the entitlement gate.
