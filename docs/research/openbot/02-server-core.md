# Server core — backend logic

## What it is

One Hono process (`server/src/app.ts:221`) mounting a CopilotKit runtime at `/api/copilotkit`
(`server/src/copilot.ts:1695`, mounted last so it cannot shadow product routes, `server/src/app.ts:1361-1367`)
beside roughly thirty feature routers, all against one PostgreSQL database. A "coworker" is a row: a
profile plus the built-in model path or a customer's AG-UI endpoint
(`server/src/agents/profile-types.ts:9-24`). Every unattended turn — routine, responsibility, research,
follow-up, hop — is the same headless AG-UI turn from one shared `work_items` queue.

## How it works

### A message becomes a run

```
app --POST /api/route (untagged)--> routing/service.ts --model--> agentId
app --POST /api/copilotkit/agent/:id/run--> createRequestAgents
       -> createActorAgentResolver -> loader (SQL visibility, vault keys) -> buildAgent
    CopilotRuntime --AG-UI POST--> agent (guarded fetch: SSRF, stall)
    agent --tool call--> browser tool | /api/agent-tools/call (signed assertion)
app --POST /api/channels/:id/activity--> roster moves, unread dot
```

**Routing.** `POST /api/route` (`server/src/routing/routes.ts:24`) is the only routing door; the
composer calls it only when nothing was addressed. The service reads the roster filtered by
`canAccessAgent` (`server/src/routing/service.ts:407-411`), honours an explicit picker selection, then
matches an *addressed* name (opening, `@`, "ask X") rather than any mention
(`server/src/routing/service.ts:290`, `:323`). Otherwise the model decides from name, role description
and the systems each coworker can reach (`server/src/routing/classify.ts:11-30`); every failure lands
on the default coworker and names which failure: `unreachable`, `unparsed`, `off-roster`,
`unconfident`, `one-candidate`, confidence floor 0.6 (`server/src/routing/classify.ts:44-58`, `:84`).

**Agent resolution.** The runtime takes an agent *factory*, not a map, so a Bot created a moment ago is
reachable on the next request (`server/src/copilot.ts:1680-1693`); visibility is filtered in SQL, not
JavaScript (`server/src/agents/runtime-agents.ts:110-137`), and an unauthenticated request resolves to
an actor who owns nothing (`server/src/index.ts:318-325`).

**Auth header.** The agent row holds `{header, credentialId}`, never the key; the secret is a vault row,
rotated on edit and revoked on replacement (`server/src/agents/auth-header.ts:24-45`, `:134-173`). A
revoked credential sends *no* header, so the run fails at the agent with its own 401 (`:176-192`).

**Callback tokens.** A per-agent bearer (`obot_agt_`, stored as a SHA-256 hash,
`server/src/agents/callback-token.ts:36-56`) says which agent; a signed run assertion says which bot,
person, run, thread, depth and initiator (`:71-125`), 10-minute TTL (`:57`), carried in
`forwardedProps` so customer code receives it (`:126-133`). `/api/agent-tools/call` requires both and
checks them against each other (`server/src/app.ts:1767-1798`); a refusal is audited (`:1798-1830`).
All server-to-agent HTTP goes through `createAgentFetch`, which checks every redirect hop and drops
both credentials on a cross-host hop (`server/src/agents/endpoint.ts:234-350`).

**Two adapter shapes, not fifteen:** `remote_ag_ui` is `HttpAgent`; `remote_mastra` is a `MastraClient`
with the right agent picked off its roster (`server/src/copilot.ts:1130-1200`).

### State and memory

Everything durable except conversations is Postgres: profiles, grants, approvals, routines with their
run ledgers, responsibilities, memories, delivery bindings, audit. Conversations and their memory live
in CopilotKit Intelligence, keyed by the person `identifyUser` returns
(`server/src/copilot.ts:1776-1780`).

Memory is rows with a review state, not files: content, provenance, `review_state`, who formed it
(`person|import|bot|intelligence`), the source app and the tool it was read with
(`server/src/db/schema/memory.ts:49-100`). A Bot-formed memory reaches only the Bot that formed it,
while that Bot still holds the app it came from (`:67-82`). Confirmed memories mirror to Intelligence
with a content digest so one edit mirrors once
(`server/src/memory/store.ts:53-56`); memory *sources* re-import from a connected app on a schedule
(`server/src/db/schema/memory.ts:34`).

### Approvals and delivery

Approval is a gate inside the action corridor, not a model decision: the connector call path
(`server/src/plugins/plugin-store/calls.ts:446`), the computer gateway
(`server/src/computer/gateway.ts:668`) and the handoff tool (`server/src/agents/handoff-tool.ts:136`)
each ask one `ApprovalGate` (`server/src/approvals/types.ts:195-197`) which ranks four layers — safety
requirements, team rules, personal rules, auto-review — and records the layer that decided
(`server/src/approvals/policy.ts:17-70`, `server/src/approvals/service.ts:155-190`). "Ask" suspends the
turn; the answer writes an `approval.resume` item whose sweep re-runs it
(`server/src/approvals/store.ts:181`, `server/src/approvals/resume-sweep.ts:57`). Actions are
fingerprinted with volatile fields removed, so a retry is recognised as the same act
(`server/src/approvals/service.ts:50-72`).

Delivery is a router over three queue kinds (`delivery.inbound|outbound|push-receipt`,
`server/src/delivery/router.ts:40-46`) reaching Slack/Teams through a pairing front, SMS via Twilio,
Expo push. Text never picks an owner; the binding does (`server/src/delivery/types.ts:8-20`). An
approval raised in a paired chat turn is shown there rather than sent twice
(`server/src/delivery/router.ts:116-125`).

### Proactive, routines, scheduling

`routines` are a five-field cron plus an instruction, minimum 15 minutes apart
(`server/src/routines/schedule.ts:6`), at most 20 enabled per person (`server/src/routines/store.ts:66`).
A sweep offers a `routine.fire` item keyed on the ISO minute it was due — that string *is* the
idempotence across replicas (`server/src/routines/sweep.ts:105-135`) — then POSTs claimed work to
`/internal/routines/run` with a worker bearer secret (`server/src/app.ts:1289-1350`). The runner owns
outcomes: skipped (paused bot, gone channel), waiting (tool suspension), failed, plus a fatigue rule
that switches a routine off after ten consecutive failures
(`server/src/routines/runner.ts:42-48`, `:175-190`).

`responsibilities` are the same turn with a job attached: instruction, success criteria, event
subscriptions, a run ledger (`server/src/db/schema/responsibilities.ts:16-58`). Ingress verifies a
vendor signature, applies the trigger filter, and commits event + run row + queue entry in one
transaction (`server/src/responsibilities/triggers.ts:1-14`); the engine claims `responsibility.run`
(`server/src/responsibilities/engine.ts:6`, `:35-60`).

`proactive` is read-only research on the same queue (`proactive.run`, `proactive.task`,
`server/src/proactive/engine.ts:33-34`), restricted by *initiator*, not by a separate tool set
(`server/src/proactive/restriction.ts:1-20`).

`work/` is none of the three: it is the queue primitive — claim, lease, renew, finish, release, purge —
`for update skip locked`, timestamps computed in SQL because two clocks let two replicas run one item
(`server/src/work/queue.ts:1-20`, `:268-300`). `work/loop.ts` schedules the next pass after the
last ends, so a slow pass does not fan out (`server/src/work/loop.ts:1-20`). `work/culler.ts` suspends
idle computers, judging idleness from the audit trail because dialling a computer wakes it
(`server/src/work/culler.ts:1-16`).

### In-process versus queued

| Per request | Per replica loop |
| --- | --- |
| run at `/api/copilotkit` | delivery ×3, 2s (`server/src/index.ts:2168-2181`) |
| routing, approval gate | group 1s (`:2184`), approval resume 2s (`:1941-1955`), person response 2s (`:2198`) |
| tool callbacks | wake-ups 5s, summaries 10s (`:2149`, `:2309`) |
| | memory, responsibility, proactive sweeps (`:1322`, `:1806`, `:2098`) |

Queued kinds: `routine.fire` (dispatched over HTTP), `bot.wakeup`, `bot.message`,
`responsibility.run`, `proactive.run|task`, `delivery.*`, `group.turn`, `channel.summary`,
`approval.resume`, `person.response`, `computer.suspend`. Every offer also `pg_notify`s
(`server/src/work/queue.ts:30-36`), but only the handoff loop listens
(`server/src/agents/handoff-wiring.ts:179-186`).

### Computer and host

The computer is one governed module: resolve the target from a server-held snapshot, check policy,
write the audit row, *then* act (`server/src/computer/gateway.ts:1-20`). Providers are a Docker
supervisor or a Kubernetes `agent-sandbox` CRD (`server/src/computer/sandbox.ts:1-16`). Host access is
an in-memory broker of leases and grants, its command policy capped by the team's
(`server/src/host-access/broker.ts:13-50`).

### Multi-tenancy seams

One deployment is one organisation, structurally: a single `deployment_packages` row with a unique
`tenantId` (`server/src/db/schema/core.ts:262-269`), a tenant package (branding, roster, default model)
loaded at boot (`server/src/index.ts:416`, `:459`), Better Auth with `admin | user`
(`server/src/auth/roles.ts:5`), and an actor of exactly `{id, role}`
(`server/src/agents/profile-types.ts:3-6`). The seam that does exist is `owner_user_id` everywhere plus
capability gates at the HTTP edge (`server/src/app.ts:632`, `server/src/admin/gate.ts:1-12`): a second
tenant is a second database, not a column. One control the name promises is not kept: `channels.groups`
is written by `synchronizeTenantPackage` and read by nothing (`server/src/db/schema/core.ts:283-296`,
#82).

## Decisions and their reasons

- **One runtime, many entry points.** Headless work reuses the interactive runner
  (`server/src/proactive/engine.ts:1-12`, `server/src/responsibilities/triggers.ts:1-10`). Bought:
  governance, approvals, audit and learning unchanged. Cost: each headless path re-supplies what a
  browser supplied, and grew its own skip and retry rules.
- **Postgres is the queue, leases on the database's clock.** No broker, no leader election, a replica
  added is throughput added (`server/src/work/queue.ts:1-20`). Cost: a sweep, a lease policy and an
  attempt cap per feature.
- **The run ends before a frontend tool runs** (`server/src/channels/turn-watchdog.ts:30`). That
  explains the suspension/resume machinery, the callback route, and every "waiting" status.
- **Fails closed on wiring:** an unbuilt store unmounts its routes rather than mounting a permanently
  refusing door (`server/src/app.ts:1286-1289`, `:1575-1580`); pause answers "paused" when it cannot
  read state (`server/src/agents/lifecycle.ts:11-13`).
- **Docs disagree with code twice.** `docs/architecture.md:30-37` says the server "streams results back
  to the app and Intelligence thread"; in Intelligence mode the run route answers a JSON envelope in
  about a second and events reach the browser over the gateway WebSocket
  (`server/src/channels/turn-watchdog.ts:19-30`). `docs/architecture.md:7` has every tool call
  returning through the gateway; connector, file and component calls do, a browser snapshot does not.

## Mason-relevant

| openbot module | mason answer |
| --- | --- |
| `routing/*` | no answer: mason has one bot |
| `agents/{profile-store,runtime-agents,agent-resolver}` | no answer; the *seam* is worth copying |
| `agents/{auth-header,endpoint,callback-token}` | partial: mason's tools are in-process, no callback identity |
| `agents/handoff*` | no answer (`GLOSSARY.md` rejects teams) |
| `agents/wake-up` | no answer: mason's hooks are configured |
| `agents/lifecycle` | reset ≈ wiping agent-owned files; pause has no equivalent |
| `work/*` | no answer: SPEC §3.3 uses pi-durable submission + `requestId` |
| `routines/*` | **routine**, a direct equivalent |
| `responsibilities/*` | trigger + hook, plus a ledger mason has no term for |
| `proactive/*`, `approvals/*` | no answer: no background research; the boundary is the tool machine |
| `delivery/*` | **delivery**, plus the telegram integration's tool face |
| `memory/*` | nearest word is **profile**, but mason's is files, not rows |
| `components/*`, `dictation/*`, `voice/*` | no answer / UI-PLAN territory |
| `computer/*`, `host-access/*` | no answer: mason's tool machine, no policy engine |
| `team-bots/*`, `demonstrations/*`, `activity/*` | no answer |
| `tenant-package`, `auth/*` | one home per bot; no answer |

- **Worth copying:** the queue shape (`for update skip locked`, leases on the DB clock, `attempts`
  meaning "this may already have had an effect"); the routing failure vocabulary for naming *why* a
  hook did not fire; the fatigue rule instead of an alert nobody reads; "a refusal is a row at the
  boundary" (`server/src/app.ts:1305-1320`).
- **Worth avoiding:** a dozen polling loops per process as the price of one queue; and letting a bot
  author its own future turns, bounded only by caps (`server/src/agents/wake-up.ts:33-38`) — a problem
  mason's person-configured hooks do not have.
- **Already right in mason:** one generic adapter plus per-integration config
  (`docs/adr/0003-integrations-are-services.md`) reaches openbot's "16 frameworks, one AG-UI contract"
  conclusion and goes further; mason's split home (`docs/adr/0002-split-home.md`) has no counterpart —
  agent secrets here share Postgres with everything else.

## Open questions

- Whether two replicas can run one thread at once: `ThreadBusyError` implies a lock
  (`server/src/agents/handoff-delivery.ts:30-36`) that lives inside the CopilotKit client.
- What `/api/copilotkit` does without Intelligence. One file says Intelligence is the only mode
  (`server/src/channels/turn-watchdog.ts:22`); the runtime takes an optional `intelligence` client
  (`server/src/copilot.ts:1773-1786`).
- Whether the per-replica loops stop when the routines worker runs separately;
  `worker/src/index.ts:1-22` claims only routines.
- Which vendor backs voice and dictation: both are configured by shape, not by name
  (`server/src/dictation/provider.ts:12-30`).
