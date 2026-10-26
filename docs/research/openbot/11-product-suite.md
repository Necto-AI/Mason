# The product suite, as one system

## 1. What it is

OpenBot is a self-hosted chat product whose participants are agents: "the AI assistant your company can actually own"
(report 01 §What it is). The user is an organisation: an administrator who registers connectors, grants tools and sets
policy, and the people who talk to the Bots. A **Bot** (also *coworker*) is a durable profile — name, title, role,
visibility — backed by a built-in prompt in the server or any endpoint speaking AG-UI; the framework behind it is never
stored, only an address, a token and a grant list (report 04 §What it is). CopilotKit Intelligence is a hard runtime
dependency: the config refuses to boot without three `INTELLIGENCE_*` values (report 01 §What it is).

## 2. The whole suite

```
  ┌─ identity (OSS) ──────┐   ┌─ clients (OSS) ────────────────────────────┐
  │ Better Auth           │   │ app/     React 19 SPA · REST + socket      │
  │ cookie · SSO/SAML     │   │ desktop/ Tauri: wizard, engine, host poller│
  │ admin | user          │   │ mobile/  Expo, 10 screens, 10 s polling    │
  └─────────┬─────────────┘   └─────────────┬──────────────────────────────┘
            │ cookie                        │ /api/* · socket · push
            ▼                               ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │ SERVER server/ :3001 — Hono, ~30 routers, CopilotKit runtime last     │
  │ gates: capability → policy (CEL) → approval → audit-before-act        │
  └───┬─────────────┬─────────────┬─────────────────┬─────────────────────┘
      │ work_items  │ AG-UI run   │ governed act    │ delivery
      ▼             ▼             ▼                 ▼
  ┌─queue (OSS)┐ ┌engines (OSS)┐ ┌computer (OSS)┐ ┌─channels──────────┐
  │ Postgres   │ │ 15 engine   │ │ Playwright,  │ │ Slack/Teams       │
  │ skip locked│ │ images, 2   │ │ shell, egress│ │   via OpenTag     │
  │ + lease    │ │ adapters    │ │ 1 per Bot    │ │ SMS · Expo push   │
  └────────────┘ └─────────────┘ └──────────────┘ └───────────────────┘
      │             │             │                 │
      └──────┬──────┴──────┬──────┴─────────────────┘
             ▼             ▼
  ┌─storage ─────────────────────────────────────────────────────────────┐
  │ Postgres (OSS) 92 tables / 61 migrations · vault (OSS) AES-GCM       │
  │ CopilotKit Intelligence (VENDOR): threads, memory mirror, learning   │
  └───────────────────────────┬──────────────────────────────────────────┘
                              ▼
  ┌─telemetry ───────────────────────────────────────────────────────────┐
  │ audit_events (append-only) → optional OTLP mirror                    │
  └──────────────────────────────────────────────────────────────────────┘
```

## 3. The backend in five layers

**The edge and its gates.** One Hono process mounts ~30 routers and the CopilotKit runtime at `/api/copilotkit`, last,
so it cannot shadow a product route (report 02 §What it is). In comes one actor, `{id, role}`: a Better Auth cookie
read with `disableCookieCache` so revocation lands next call, nine capability switches resolved organisation → role →
group (a group may only widen), and one gate over `/api/*` (report 10 §Approvals), repeated at the computer boundary
and in the stores because CopilotKit does not anchor its routes: an anchored pattern would have leaked
`/api/copilotkit/x/agent/<id>/run`.

**The work substrate.** Every deferred thing is a `work_items` row — `routine.fire`, `delivery.*`, `approval.resume` —
claimed `select … for update skip locked` under a lease, timestamps computed in SQL because two clocks let two replicas
run one item (report 02 §In-process versus queued). No broker: a replica added is throughput added, at the price of a
lease policy per feature and a dozen polling loops per process.

**The engine boundary.** AG-UI is the only seam — "the governance rides the protocol rather than the framework" (report
01 §Decisions). Two adapter shapes, not fifteen: `HttpAgent` and `MastraClient` (report 02 §Two adapter shapes).
Fifteen images implement four requests each: runs, an unauthenticated `/health`, a shared token check, the model string
their framework wants (report 04 §The contract each adapter implements). Out goes a run with messages, frontend tools,
the standing role, grants and a signed assertion; back comes events, governed tools run server-side by
`HeadlessToolsMiddleware` (report 04 §What the server puts around every remote run). Both reports describe one shape,
not two: the loop that decides a call runs at the endpoint — in the image, or in-process through
`toolkit/src/run-turn.ts` for a built-in Bot — while the governed call itself is executed server-side; report 01 counts
mason's server-owned loop among the things it already does right (report 01 §How it works, §Mason-relevant).

**The tool corridor.** Grants are per Bot, keyed `(kind, ref, agent_id)`; a missing row is the refusal, with no
`enabled` column to be wrong (report 03 §The data model). A call takes one ordered path — grant → access → policy →
content inspection of outgoing arguments → approval → vendor → outcome row — refusals audited *before* the throw,
`access.ts` the only module naming a broker (report 10 §The call corridor).

**Persistence and the vault.** One Postgres holds everything but conversation content: 92 tables, 61 migrations, applied
under an advisory lock that first proves every file is still *reachable*, because drizzle's migrator reads one row and a
renumbered branch makes it skip silently (report 03 §Migrations). Credentials are AES-GCM envelopes behind a partial
unique index that makes racing rotations impossible; everything else is a pointer, and revocation is a column (report 10
§The credential vault).

## 4. The frontend and the apps

The **web app** is one React 19 SPA and the whole product surface: channels, chat, live screen, settings, admin.
TanStack Router with file routes, TanStack Query for server state, CopilotKit `react-core` for the conversation (report
06 §What it is). Data arrives four ways: REST with a per-call envelope key, a roster WebSocket that is never a source of
truth, the runtime's run transport, and a history endpoint with a 1500 ms deadline (report 06 §Streaming and chat
state).

The **desktop** is Tauri: a wizard that installs a container engine, raises the stack and proves it answers with a real
model call, then navigates the webview into the same web build (report 08 §What it is). Its substantive half is 42.6k
lines of Rust and 36 commands: provider OAuth with PKCE and device flow, plan sign-in via Anthropic's CLI, a
keystore-or-DPAPI vault, and the host-access bridge — an outbound poll with a per-run bearer, every operation in a fresh
`--network none` container, nothing approved without a native folder picker (report 08 §The local bridge).

The **mobile** app is 2,440 lines of Expo over the same HTTP API: ten screens, one stack, its own package outside the
workspaces. It polls every 10 s and re-injects a stored cookie by hand, and exists for one capability the web build
lacks: arrive as a notification, answer an approval without a laptop (report 09 §What it is). Push is one delivery
transport, not a separate system. Its screens state what it refuses: no new conversation, no new Bot, no tool
connection, no schedule editing, no admin (report 09 §What it deliberately does not do).

Web and desktop share the bundle: one renderer, one design system; mobile shares nothing and restates a dozen wire types
by hand. Report 09 calls the desktop "a webview of the web build" and infers mobile declined the cheap pattern; report
08 shows the shell owns the container engine, provider sign-in and the host-access broker. I take report 08.

## 5. Deployment reality

The **all-in-one image** runs six s6 services on one port — token generator, postgres-init, optional embedded Postgres,
optional migrate, API, optional computer — behind three `EMBEDDED_*` switches (report 05 §The image). It buys one
artifact for a laptop install, an API replica or a computer-only pod; it costs a container that may be six processes
and s6 as root, which is why the chart's `runAsNonRoot` is false.

**Compose on a host** splits those and adds a supervisor holding the Docker socket, so each Bot gets its own computer
behind four verbs (ensure, stop, reset, list); a `data` network keeps the audit database off the Bot's network (report
05 §Compose). It buys per-Bot isolation on one host at the price of a root-equivalent process.

**Kubernetes** runs the same image as an API Deployment at two replicas with the computer off, and switches the computer
tier three ways: `shared` (one StatefulSet), `sandbox` (an `agent-sandbox` pod per Bot, namespaced RBAC), `external`
(report 05 §Kubernetes). It buys replica throughput and a sandbox boundary, at the price of 732 value, 829 helper and
400 validation lines of chart, a warm pool the chart refuses to render, and two server images.

## 6. The bets

Openbot bets that **AG-UI is a sufficient seam** — governance rides the protocol, so no per-framework tool code exists;
the price is authorization resting on the endpoint's honesty plus a signed assertion. That **Postgres is everything** —
queue, blobs, audit, one backup unit; the price is the largest table written by every action. That **configuration is a
package, not a screen** — roster and model are YAML, refused at boot with the fix named. That **one corridor with
deny-by-absence is the security model** — grant, policy, approval, audit-before-act; the price is 176 audit event types,
nine switches and four ranked decision layers, the first of them three mandatory safety categories — credentials,
security settings, payments — that no rule may waive (report 10 §Approvals; report 02 §Approvals and delivery). And that
**a computer per Bot is the work surface** — a browser and shell behind four verbs and a swappable provider; the price
is a supervisor or CRD, a culler, and a shared browser when the supervisor is absent, "not fine as a boundary between
tenants" (report 01 §Decisions).

The bet mason makes that openbot does not: **the bot's memory is files on the machine its tools run on, and the split
between what the bot may edit and what the server owns is a mount boundary** (docs/adr/0002-split-home.md; GLOSSARY.md,
*agent-owned files* / *service-owned files*). Openbot reaches the same goal with rows — a `personal_memories` row
carries content, provenance and `review_state` locally, mirrored to Intelligence with a content digest (report 02
§State and memory) — narrowed per query; mason never mounts `service/` into the tool machine, so a prompt bug cannot
leak a token the way a forgotten `where` clause can.

## 7. What this costs

**Duplication.** Fifteen engine images for four requests each: 2,225 lines of Python across eighteen adapter files, 906
of TypeScript, 6,035 of Python tests — 2.7 test lines per source line, with 250–450 lines factorable
(report 04 §What one adapter plus a plugin would avoid). Three clients: ~112k lines of app, 51k desktop, 2.4k mobile,
the last sharing nothing. And 92 tables, 61 migrations, one organisation.

**Vendor coupling.** Intelligence is not optional at boot (report 01 §What it is); learning needs a container created
through a browser session or CLI login before it does anything (report 03 §Learning); Composio and Arcade keys are
environment-only (report 10 §The credential vault); voice reaches a vendor realtime socket from the browser (report 06
§Streaming and chat state). Report 01 calls it "MIT code, a proprietary hinge"; report 02 asks whether it could run
without Intelligence. I take report 01: the config refuses to boot.

**Operational surface.** Three deployment shapes, six s6 services, three switches, two server images, three CronJobs, a
root-equivalent supervisor, a static `/health` that never touches the database (report 05 §Secrets, migrations, crons,
health, scaling), a dozen polling loops per replica, 36 Rust commands, four delivery transports. Report 03 says
`users.groups` and `channels.allowed_groups` read as access control and are not; report 10 finds SCIM writing
`users.groups` and capability rows reading it. I split it — report 10 is right about `users.groups` (a call site beats
a stale docblock), report 03 about `channels.allowed_groups` (read by nothing).

What transfers: one shape per line; one door (src/server/events.ts:23), one MCP client at boot
(src/server/mcp.ts:302), limits per sender (src/server/limits.ts:15).
