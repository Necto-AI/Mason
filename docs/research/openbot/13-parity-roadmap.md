# Parity roadmap: Telegram-first, single bot

*mason is a headless, always-on agent backend: a durable engine plus a small set of deliberate contracts, and an
interface is a thing that attaches to them. Telegram is the first interface, not the definition. This document is
about the contracts.*

## 1. What parity means now

mason stays a **single-bot system**, and it is a **headless backend before it is anything else**. **Telegram is the
first interface** — the cheapest way to test the backend where the person already is — not the product definition.
Multi-bot routing, orchestration, agent-to-agent protocol and every rich client — web, desktop, mobile — belong to
a separate client, which consumes Mason through the connector contract
(`docs/adr/0004-mason-is-a-headless-backend.md`). Mason's investment therefore goes to the contract and its guarantees:
security, identity and attribution, approvals, schedules, memory, the integration framework, delivery, backup and
recovery, evaluation.

The web client is not deleted. It is **frozen as a reference operator console**: transcript inspection, debugging,
and the fallback when Telegram or the tunnel is down. It receives maintenance fixes only, never features. A fix that
keeps the console truthful is in scope — a rendering bug, a wire kind that no longer projects, a pairing that stopped
working. A panel, a manifest, a push subscription, or a second route for a person to answer something is not.
Everything that would have been a screen has moved to §6.

Parity with openbot now means that the backend's contracts hold, for one agent in one home on one host used by Denis
and about five other people:

1. **Inbound is one signed event.** A delivery wakes exactly one fire, a redelivery is that same fire however late it
   arrives, and an envelope mason cannot read is refused by name rather than guessed at.
2. **Identity is the server's.** The agent knows which person said it by an id the server mapped, and an answer is
   addressed to a person, not to a name the sender typed.
3. **A turn can be held for a decision.** An action that spends money, sends something outward or edits mason's own
   instructions can be stopped; the question is asked where the turn was raised, the answer is a record, and the turn
   resumes after a restart.
4. **Control is durable.** A routine is a row with a next fire and a last outcome, a conversation survives a restart,
   and a missed slot fires once — not never, not twice.
5. **A delivery is committed before it is sent, and sent once.** Nothing is lost while Telegram or mason is down.
6. **Memory is files.** What the agent remembers is readable, dated and attributable, and a failure worth keeping
   becomes one of them.
7. **An integration is one config entry, one container, one secret and one hook**, and a second channel proves the
   pattern twice rather than once.
8. **The trail is a contract too.** Every fire and every refusal names the integration and the person, and the room can
   ask for it.
9. **Recovery is a command.** The home backs up and restores, and an eval run guards the behaviour a change might break.

Read those nine as contracts rather than as chat features, because they are what sibling and every later interface
inherit — eight surfaces: **inbound** (a signed event), **outbound** (a delivery, and the transcript stream),
**control** (a session, a routine, an approval, a memory), **identity and attribution**, **observability**, **the
integration framework** (a container, a config entry, a secret and a hook, proved twice — A0-1, A0-2, C2-1),
**recovery** (a command — A0-4), and a **version** on each of them. Four guarantees decide the milestones:
**idempotency** — a redelivery is the same fire and a schedule fires a slot once; **attribution** — an id the server
mapped, and a row that says who; **no loss** — a message is committed before it is sent, and sent once; **recovery** —
a restart resumes a turn, and a home restores with one command. A capability that strengthens none of those contract
items — neither a surface nor one of the four guarantees — is not in this roadmap, however visible it would be.

One rule follows from the interface being an attachment, and it is a rule about this document as much as about the
code: **a message is a trigger, never a new API.** A turn is woken by a delivery or by a person typing; the agent
answers in the same chat. No command endpoint, no slash-command grammar mason owns, no second token surface, no third
door — and no interface that grows a private contract beside the backend's. Anything the agent can do from a chat it
does as a turn; anything a person must answer, they answer as a message or a button in the chat they were already in.

Everything below slices to those nine. A capability openbot has that serves none of them is not a gap in mason; it is
openbot's business model showing through, and §6 and §7 say where each one goes.

Citations are `(report NN §heading)` for the reports in this package and `path:line` for mason. Where a report's
material is a bold lead rather than a heading — a bullet under *Mason-relevant*, a phrase under a section — the lead is
cited with the heading above it.

## 2. The four decisions this roadmap rests on

**D1 — deferred work: a queue, or the durable log?** Report 02 §"In-process versus queued" recommends openbot's queue
shape (`for update skip locked`, leases on the database clock, `attempts`); report 03 §"Mason-relevant" says SQLite is
right because pi-durable already gives durable submissions and mason is one process. **Take 03.** A lease prevents two
replicas running one item; mason has one writer. Two *semantics* from 02 come along without the table: the fatigue rule
(a routine that fails ten consecutive times switches itself off, `server/src/routines/runner.ts:175-190`) and
`attempts` meaning "this may already have had an effect".

**D2 — attribution: a column, or the envelope?** Report 01 §"Mason-relevant" calls openbot's `initiator.kind` "a better
answer to who caused this turn than mason's log currently gives"; report 10 §"Mason-relevant" says reserve identity on
the envelope before it is needed, and notes mason's v1 has no actor (`src/server/events.ts:50-55`). **Take 10, and take
it early.** mason's transcript is derived from durable entries (`src/server/projection.ts:1-14`), so a column would be a
second ledger beside the one pi-durable keeps. An envelope field is a contract with every integration that will ever
ship, which is why it is M0's job and not a later cleanup (§3, A0-3): an optional additive field costs nothing to add
while the only sender is one we wrote, and stays cheap when an operator writes a second, because it lands in `v1`
rather than behind a second version (`docs/adr/0004-mason-is-a-headless-backend.md`). The rows that *record* the actor
are M1's (§4, B1-3) — a field nothing writes down is still a log line.

**D3 — approvals: how much gate?** Report 02 §"Mason-relevant" lists `approvals/*` as a gap mason has no answer to;
report 10 §"Worth avoiding" calls openbot's nine capability switches, three approval layers, a policy expression
language and a model reviewer "a large surface for a personal agent". **Take 10's ceiling with 02's floor:** one gate,
two tiers, the decision written into the durable log. Report 09 §"Mason-relevant" adds the half that makes it usable —
openbot's approval inbox is a push target separate from the conversation, so a Bot that asks while you are chatting
gets no answer there. mason asks in the chat.

**D4 — a widget catalogue?** Report 06 §"Mason-relevant" holds both sides in one section: a catalogue for
`generateSandboxedUi` is "a middle ground mason lacks", with publication and grants server-side; and the component
volume — `components/ui` plus the gallery — is "tens of thousands of lines of chrome for a chat that is one column".
**This is no longer mason's question to settle.** A catalogue is a client surface, so it goes to sibling with the rest of
the client work (§6), and mason keeps what it already has: one generic sandboxed widget and a skill that documents it
(`docs/SPEC.md` §5, `skills/generative-ui/SKILL.md`), which the frozen console renders as it does today.

## 3. M0 — alpha on pc: days

M0 is about four days of work and one week of calendar, and it ends when a clone of `main` boots the sidecar and a bot,
five people can type into the chat and be answered as themselves, the home can be backed up and restored, and someone
who is not Denis has used it for a week. Nothing here is a screen.

| ID | Slice | What it delivers | Depends on | Size | Risk | Milestone |
|---|---|---|---|---|---|---|
| A0-1 | **Slice: the stack lands on `main`**<br>*report 05 §"Compose: two networks, everything on loopback"; `deploy/compose.yaml:1-30`, `integrations/telegram/README.md`* | The four merged PRs land as one stack on `main`: #46's MCP client, #48's trigger door, #49's GitHub connector dropped so the trigger is the one door, #51's Telegram container. Today they sit stacked — `main` carries #46, and #48, #49 and #51 each landed on the branch before it — so a clone of `main` still boots a stack with no integration face at all | — | S | low — a review surface, not new code | M0 |
| A0-2 | **Slice: the sidecar, and the bot in the room**<br>*report 05 §"Compose: two networks, everything on loopback"; report 09 §"Mason-relevant" (Already right in mason); `deploy/compose.yaml:180-223` (mason-telegram), `:225-250` (vpn), `deploy/vpn/config.example.json`, `integrations/telegram/README.md` (§"Privacy mode")* | The `vpn` sidecar uncommented and given the owner's own Happ config once (`deploy/vpn/config.json`, gitignored), the `mason-telegram` service uncommented with its token, allowlist and minted secret, and a live bot in the team chat with BotFather's privacy mode off: a message a person types becomes a fire, and the answer comes back in that chat | A0-1 | S | medium — privacy mode and the reply path are the two things that silently do nothing, and a proxy that is down looks like a bot that is not there | M0 |
| A0-3 | **Slice: a Telegram user id is a person**<br>*report 10 §"Mason-relevant" (reserve identity on the envelope), §"Audit trail" (`unattributed`); report 12 §"Where mason's decisions look wrong" (the roster is claimable); `src/server/roster.ts:1-14`, `src/server/events.ts:49-55`, `integrations/telegram/src/envelope.ts:44-85`, `scripts/team.ts:17-31`, `docs/ROOM-IDENTITY.md`* | An optional additive `actor` on the `v1` envelope — the sender's provider id and name — inside the signed body, which report 10 said to reserve while it was cheap. It stays `v1`, and the version rule is the ADR's: an older reader already ignores a key it does not know (`src/server/events.ts:49-55`) and an older sender simply omits the field, so additive optional fields stay in `v1`, anything incompatible is a `v2`, and `v1` is read forever (`docs/adr/0004-mason-is-a-headless-backend.md`). The `actor` is an assertion by the integration that signs the body, and never an authorization input; this slice's acceptance is that the field is actually read at the door and recorded in the fire entry, covered by a test that reads it back from there — an `actor` the door parses and then drops is not attribution. The roster gains the ids a person speaks with (`npm run team -- add "Ilya" --id telegram:8811`), the door resolves an id to a person before the fire, and the fire's entry carries that person, so "who said this" is a value the server chose. An id the roster does not know is recorded as `unattributed` and the turn is told so; whether such a fire should happen at all is the input gate's question (#14), not this slice's | A0-1, A0-2 | M | high — the one place a sender's string could become an author, and a wrong answer makes the transcript lie | M0 |
| A0-4 | **Slice: one command backs the home up, one restores it**<br>*report 03 §"What a self-hoster must back up", §"Mason-relevant" (no single command that restores it); `scripts/doctor.ts:17-31`, `docs/adr/0002-split-home.md`, `src/server/house.ts:9-30`* | `npm run doctor -- backup` and `npm run doctor -- restore <file>`: `agent/` with its `.git`, `service/` with its `ssh/` key, `soul.md`, `roster.json`, `config.json`, `integrations.json` and `data/agent.sqlite`, and not the provider credential, which boot copies from the operator's own directory. A restore into a fresh host brings back a home that answers a message and whose memory the agent can still read, and the slice is graded by that restore performed against a fresh host — a test or a documented dry run — rather than by the trial week noticing it a week later. It lives in `doctor` because that is the command that operates on a home, next to `migrate` | A0-1 | M | high — a restore that half-works is worse than none, because the failure surfaces a week later | M0 |
| A0-5 | **Slice: the trial week** (#38)<br>*report 12 §"Where mason's decisions look wrong"; issue #38, `deploy/README.md`, `docs/agents/issue-tracker.md`* | Five people, one host, one week, the transcript kept; every defect it produces is an issue, triaged; a stranger's fresh install from `deploy/README.md` takes under an hour. It is also where the five defects report 12 names get graded by someone who is not Denis | A0-1…A0-4 | L | high — this is where the invisible failures surface | M0 |

## 4. M1 — fundamentals, no clients

M1 is the fundamentals with no client in them: the six slices that make an always-on agent trustworthy rather than
impressive. It is weeks, and this roadmap's critical path runs through it. Each slice is a guarantee first and a
surface second — idempotency in B1-1, attribution in B1-3, no loss in B1-4, recovery and the reviewed self-edit in B1-2
and B1-5, and B1-6 is the proof. The surface is the chat because Telegram is the first interface: a schedule is a
question you can ask, an approval a question you answer, a trail a question you can ask, and a memory a file the agent
reads back to you.

| ID | Slice | What it delivers | Depends on | Size | Risk | Milestone |
|---|---|---|---|---|---|---|
| B1-1 | **Slice: a schedule survives a restart, and a failing routine switches itself off** (#7, #17)<br>*report 02 §"Proactive, routines, scheduling"; report 12 §"Where mason's decisions look wrong" (timers in the process); `src/server/hooks.ts:210-220`, `:350-402`, `src/shared/contract.ts:184-209`, issues #7, #17* | The in-process `setInterval` becomes a durable schedule with `nextFireAt` and a catch-up that fires a missed slot once, keyed on the slot rather than the wall clock (#17); openbot's fatigue rule (ten consecutive failures and the routine switches itself off) with a last-run outcome; and a `schedule` tool so the room can ask what is scheduled, when it last fired and what came of it, and change or cancel it. The chat is the surface; there is no routines panel | A0-1 | M | medium — a schedule that double-fires after downtime spends money, and one that silently never fires is not a schedule | M1 |
| B1-2 | **Slice: an approval is asked and answered in the chat** (#9)<br>*report 02 §"Approvals and delivery"; report 10 §"Approvals"; report 09 §"Mason-relevant" (Worth avoiding: an approval you cannot answer where it was raised); `src/server/extensions/`, `src/shared/contract.ts:184-209`, `integrations/telegram/src/telegram.ts`, `integrations/telegram/src/filter.ts:36-47`* | One gate before a tool runs, two tiers: ask before an outward effect (a message to a person, a spend) or a self-modifying one (a skill, the profile, a schedule); never before `bash`, which is the agent's own machine. The question is sent into the chat the turn was raised in, as a message with two inline buttons; the answer arrives through the same signed door as an event, writes the decision into the durable log, and resumes the suspended turn — after a restart too, because a decision is a record and the resume is an item, not a callback in memory. No second token surface: a press is a delivery, not a new API | A0-3 | L | high — a fail-closed gate on the wrong side of a tool is a dead agent, and an approval nobody can find is a turn that never ends | M1 |
| B1-3 | **Slice: a fire and a refusal name who caused it, and the chat can read them**<br>*report 10 §"Mason-relevant" (a refusal row next to the permission); report 02 §"Mason-relevant" (a refusal is a row at the boundary); report 03 §"Activity" (a derived read, not a second ledger); `src/server/main.ts:380-445`, `src/server/events.ts:50-55`, `src/server/extensions/`, `src/server/house.ts:9-30`* | Every answer the door gives is recorded. The accept keeps the entry it already writes; each refusal — a path naming no integration, no enabled trigger face, the budget, the body cap, a bad signature, an envelope mason cannot read — becomes a row naming the integration, the delivery id, and the person from A0-3 or `unattributed`. An `activity` tool answers "what fired, what was refused, and who caused it" from those rows and the existing durable entries, so the trail is a question in the chat rather than a `docker compose logs` | A0-3 | M | medium — the temptation to add a second ledger is the whole risk; fires already have one | M1 |
| B1-4 | **Slice: nothing is lost while Telegram or mason is down**<br>*report 02 §"In-process versus queued"; report 09 §"Push, and what it wakes" (one message, deduped per binding); `integrations/telegram/src/queue.ts:1-30`, `integrations/telegram/src/door.ts`, `src/server/limits.ts:26-33`, `src/shared/contract.ts:184-209`* | The outbound queue becomes durable and bounded on the integration's own volume, so a container restart does not swallow a reply; a send that fails says so in words the model can act on, and the message stays in mason's transcript because `send_to_user` is the delivery. The door's six-a-minute budget is reconciled with a room that can type faster than that — one fire per batch, or a wider budget for a chat integration, stated rather than discovered — and the queue behind a busy turn gets a bound and a refusal. Tests pin a batch re-posted across a mason restart as one fire, and a send queued across a container restart as one message | A0-2 | M | medium — this is the slice where a duplicate is found by a person, not by a test | M1 |
| B1-5 | **Slice: memory and the learning loop** (#16)<br>*report 03 §"Demonstrations", §"Mason-relevant" (Worth avoiding: a vendor-owned learning loop); `src/server/extensions/memory.ts:33-47`, `src/server/extensions/skills.ts:1-30`, `src/server/house.ts:11-23`, issue #16* | A failure worth keeping becomes a dated line in `log/`; a day's log becomes `journal/YYYY-MM-DD.md`; the agent proposes a `skills/` file and a person approves it through B1-2's gate. A published skill grants nothing — the firewall is at the tool call, not the prose — so the loop adds no capability, only judgement. It is files the agent reads, which is the thing openbot delegates to a vendor, and the proposal is the only step that needs a person | B1-2 | L | medium — self-edit is the one loop that can quietly make the agent worse | M1 |
| B1-6 | **Slice: the eval harness guards the behaviour**<br>*report 04 §"What one adapter plus a plugin would avoid" (6,035 test lines to prove fifteen frameworks answer the same four requests); `evals/README.md:1-10`, `evals/scenarios/`, `evals/lib/runner.ts`* | Scenarios that pin what M1 adds: an approval asked, answered and resumed across a restart; a schedule that fires once after a day of downtime; a refusal that names its actor, and the accepted fire's attribution row as well — the accept and the refusal are one trail, and pinning only the half that refuses lets the half that records drift; a message that survives the integration restarting. `npm run eval` becomes the gate on a prompt, skill or gate change, so the loop above cannot drift a behaviour nobody re-read — behaviour coverage bought in six cheap scenarios rather than openbot's six thousand lines | B1-2, B1-3 | S | low | M1 |

## 5. M2 — reach and capability

M2 is what the fundamentals are for: the integration pattern proven twice, a browser the agent may drive under a
worker, voice and media, and a question about the stack answered in the chat.

| ID | Slice | What it delivers | Depends on | Size | Risk | Milestone |
|---|---|---|---|---|---|---|
| C2-1 | **Slice: a second channel**<br>*report 10 §"Channels" (each transport beside the others, one router); report 02 §"Approvals and delivery"; `docs/adr/0003-integrations-are-services.md`, `deploy/compose.yaml:172-220`, `src/server/integrations.ts:1-40`* | Email or RSS — whichever the room will actually use — as a second package under `integrations/`: one container, one config entry, one trigger secret, one tools face and one hook, with no route, table or entry kind in the server — the hook's prompt template is the only place the channel's own words live (`docs/adr/0004-mason-is-a-headless-backend.md`). It proves ADR-0003 twice, which is the only way to know the pattern is a pattern, and it is where "an integration is a service, not a plugin" stops being a claim | A0-3, B1-3 | M | medium — the second one is where a pattern's missing half shows up | M2 |
| C2-2 | **Slice: browser use, worker-owned** (#8)<br>*report 04 §"agent-bot and agent-computer" (a browser plus an admission gate, not an engine), §"supervisor and worker"; ADR-0001 (a worker is one of the bot's tools); `docs/adr/0002-split-home.md`, `src/server/house.ts:118-123`, issue #8* | A worker definition under `agent/agents/` and a skill addressed to workers: the ladder for reading a page, observation caps, and a wall where a person must act, surfaced to the main agent as something it can say. The persistent profile is a browser's own state and lives under `agent/` or on a volume of its own — never in `service/data`, because ADR-0002 keeps `service/` out of the tool machine and a logged-in browser profile is a credential. The main agent gets no browser tool | A0-3, B1-5 | L | high — credential-adjacent, and a wall nobody can see is a hang | M2 |
| C2-3 | **Slice: voice notes in, media out**<br>*report 10 §"Channels" (voice is a provider, chosen by shape); report 02 §"Mason-relevant" (`dictation/*, voice/*`); `integrations/telegram/src/filter.ts:36-47` (non-text is dropped today), `asr/README.md`* | A voice note in the chat is fetched, transcribed by the dictation service this repo already runs (`asr/`, JSON over HTTP, nothing imported from the agent stack), and relayed as text labelled as a transcript — so a person can talk to the agent from a phone. A picture or a file goes out over the same tools face | A0-2 | M | medium — a transcript is the model's input, so a misheard number becomes an action on the wrong number | M2 |
| C2-4 | **Slice: what mason can reach, answered in the chat**<br>*report 10 §"Mason-relevant" (a capability matrix that outruns the code checking it); `src/server/integration-status.ts:1-65`, `src/server/main.ts:491-495`, `src/server/mcp.ts:1-40`* | An `integrations` tool over the boot's own registry: what each integration lends, whether the boot reached it, and why not — answered in the chat, because a person debugging a bot should not need a browser and the console is frozen. Enable and disable stay a config change and a restart, and the answer says so rather than implying live editing | A0-1 | S | low | M2 |

## 6. Outside Mason's scope

The capabilities below belong to client applications or product-level orchestration, not to the agent runtime. Mason
provides contracts that clients can consume; their absence here is not a runtime gap.

| Capability | Where it lives in openbot | Why it is outside Mason |
|---|---|---|
| Every rich client surface: the web app's product half, the desktop shell, the mobile app | report 06 §"Routing model", report 08 §"What it is", report 09 §"What it is" | A client is a rendering of one transcript, and a client can render several bots and transcripts. mason's two transports (Chord state, `/api/*`) and its projection whitelist are the seam a client attaches to; building the client here would build it twice |
| Push notifications, device rows, an installable client | report 09 §"Push, and what it wakes", §"Mason-relevant" (Device identity that can be revoked) | Push exists because a client does: openbot needed an app for the iOS prerequisite and then carried a device lifecycle for it. mason's ambient channel is the chat, which already has its own lock screen, its own notifications and its own answers (report 09 §"Mason-relevant", Already right in mason) |
| The generative-UI gallery: components declaring model-facing metadata, publication, grants | report 06 §"Mason-relevant" (Worth copying: a widget catalogue; Worth avoiding: the component volume) | It is a build pipeline and a browse surface. mason keeps one generic sandboxed widget and a skill that documents it; a catalogue is a client-level feature, and it can reuse the sandbox (D4) |
| Multi-agent orchestration: routing, groups, per-bot profiles, handoffs with depth caps | report 02 §"Mason-relevant" (no answer: mason has one bot), report 01 §"Mason-relevant" (Worth avoiding: the multi-Bot layer) | ADR-0001. openbot's own docs concede `ask_person` is a template's honest answer, not a rota. A second bot is a second identity, home and transcript — a product-level unit of work |
| Agent-to-agent protocol: an AG-UI runtime seam, signed run assertions, a supervisor that speaks in bots | report 04 §"The contract each adapter implements", §"supervisor and worker" | It is the protocol between orchestrator and worker, and mason has no orchestrator. An external orchestrator that runs several bots defines that seam; Mason's loop stays server-owned |
| Orgs, roles and tenancy: an org table, per-row tenant ids, capability switches | report 03 §"The data model", report 10 §"Identity: one deployment, one organisation, two roles" | One bot, one home, one conversation (ADR-0001, ADR-0002). openbot is single-tenant wearing the shape; a second tenant is a second deployment |
| Per-tenant packages and build-time branding | report 01 §"Decisions and their reasons" (Configuration is a package, not a screen) | mason's branding is `service/soul.md` and a wordmark, read at boot. A package per customer is for a company that ships per customer |

**The console, and the bar for touching it.** It reads what the projection already names — the reader's own words, the
agent's delivered messages, widgets, notices, the queued items and the agent's status — over one Chord socket and one
`/api/*`; it holds the Retry control, and it is where a stuck turn is inspected. Its rules do not change: the projection
is a whitelist, so a new entry kind stays invisible until `src/server/projection.ts` says otherwise, and
`test/projection.test.ts` keeps arguments and tool output off the wire. `docs/SPEC.md:681-685` states the same freeze
in the client's own spec, where a future reader will meet it first. What it may receive is a maintenance fix: a
build that stops bundling, a header the CSP drops, a transcript row that renders nothing. What it may not receive is a
feature — including one that would make a slice above easier to ship.

## 7. Never built, here or there

| Capability | Where it lives in openbot | Why nobody builds it |
|---|---|---|
| One image and one adapter per engine, on an AG-UI seam | report 04 §"What one adapter plus a plugin would avoid" | Sixteen `agent-*` packages — fifteen engine adapters and one browser service — with 6,035 Python test lines to prove they answer the same four requests, and two owners of one loop. mason has one loop, and a tool runs in the tool machine (ADR-0003) |
| Per-vendor connectors and a plugin store | report 01 §"Mason-relevant" (Worth avoiding), report 10 §"The credential vault" | ~6,500 lines of per-vendor connection lifecycle against one MCP client and one signed door. The vendor's credential belongs in the vendor's container |
| Helm chart, HPA/PDB, warm pools, SPIRE, s6 with `EMBEDDED_*` switches | report 05 §"Kubernetes: one image, three computer modes" | 732 value lines and 829 helper lines for a topology mason does not have: two containers on one host, one loopback port, and a mount boundary that is cheaper than a NetworkPolicy |
| A vendor learning loop as the only path to improvement | report 03 §"Learning", §"Mason-relevant" | It needs a container, a CLI login and a browser sign-in before it does anything. mason's loop is files the agent reads; that is the asset, not the gap |
| A Postgres work queue with leases and a polling loop per feature | report 02 §"In-process versus queued" (D1) | pi-durable already gives durable submissions and mason has one writer; a lease prevents a failure mason cannot have. The mechanics that do not need a table still come along: `attempts` and the fatigue rule |
| A `/health` that checks the database | report 05 §"Secrets, migrations, crons, health, scaling" | The rule keeps it one word: a monitor that needs a credential is a monitor nobody runs. It is also the one route outside the door on purpose, and it stays that way |

## 8. Timeline

Two scales, because the two milestones are not the same size. M0 is days; M1 and M2 are weeks. `##` is on the
critical path, `--` is work that can slip without moving the end date, blank is nothing.

```
M0, day by day                        d1   d2   d3   d4
A0-1 stack on main                    ##
A0-2 sidecar and bot                       ##
A0-3 an id is a person                          ##   ##
A0-4 backup and restore                    --   --
```

M0's code is four days. The trial week is calendar, not work, and it is the second column of the grid below — the
first is the week the four days above sit in.

```
slice                                 W1   W2   W3   W4   W5   W6   W7   W8
A0-1…A0-4 the alpha (grid above)      ##
A0-5 the trial week (#38)                  ##
B1-1 schedules survive a restart           ##   ##
B1-2 approvals in the chat                      --   ##   ##   ##
B1-3 a fire names its actor                          --   ##
B1-4 delivery hardening                              --   ##
B1-5 memory and the learning loop                              --   ##
B1-6 the eval harness, a gate                                  --   --
C2-4 integrations in the chat                                  --
C2-1 a second channel                                               --   --
C2-3 voice notes and media                                               --
C2-2 browser use, worker-owned                                           --
```

The critical path is **A0-1 → A0-2 → A0-3 → B1-2 → B1-5**. It is the chain because each link removes a reason the next
one cannot be trusted: the stack has to boot before a bot can be live, a live bot needs a person it can name before an
approval means anything (a press with no name is a yes from whoever), an approval is the only thing that makes a
self-edit safe, and the learning loop is a self-edit. Everything else has slack: B1-1, B1-3, B1-4 and C2-4 start after
the door exists and none is a prerequisite for another, and nothing at all depends on C2-2 or C2-3.

Three honest caveats. M1 is six weeks of one person working flat out, which is the number that slips. The trial
week is calendar time and its defect list trumps planned work for as long as it keeps growing (#38 leaves that open).
And if the weeks do slip, the two slices to move are **C2-2** and **C2-3**: nothing depends on either, and voice in is
a convenience next to an identity mapping that is not.

## 9. If you only do five things

1. **A0-1 — the stack lands on `main`.** Without it `main` boots a server with no integration face, and every alpha
   claim is a claim about a branch.
2. **A0-2 — the sidecar, and a bot in the room.** This is the first interface, and the only exercise the inbound and
   outbound contracts get that is not a test: nothing else in this document is reachable until a message arrives and an
   answer leaves.
3. **A0-3 — a Telegram user id is a person.** The security fundamental, and the one thing that cannot be retrofitted:
   an envelope without an actor, an approval with no name, and a log that guesses are all the same defect.
4. **A0-4 — backup and restore.** Five people's week of memory is one volume and one SQLite file. A home that cannot be
   restored is a home nobody can be asked to use for a month.
5. **B1-2 — approvals asked and answered in the chat.** The one capability whose absence can spend money or delete a
   file, and the prerequisite for the agent editing itself.

Deliberately not in the five: durable schedules (B1-1), the refusal rows (B1-3), delivery hardening (B1-4), the
learning loop (B1-5) and the eval gate (B1-6). They are what turns a working alpha into an agent you can leave running,
and §8 still runs the chain through B1-5, because the loop is the thing the approval gate exists to make safe. But none
of them is worth a week until the five above exist: without those, the room is talking to an agent that cannot say who
they are, cannot be stopped, and cannot be put back.

## 10. What this version drops

- **The TLS and reachability slice.** With Telegram as the first interface, nobody reaches the console over the internet by
  choice, and `docs/SPEC.md:549-552` already says an SSH tunnel or a TLS proxy is the honest answer for a phone on an
  untrusted network. `deploy/README.md:296-301` keeps the two headers a proxy has to preserve. That is a deployment note,
  not a milestone.
- **The four console slices.** A routines panel, a memory browser, a tool catalogue and an installable client with push
  were M1 and M2 of the previous version. They are §6 now, and their content survives as contract surfaces reached by
  asking (B1-1's `schedule` tool, B1-5's files, C2-4's `integrations` tool) or as nothing at all.
- **Attribution per device.** The slice that made a *token* record the person who claimed it. It is dropped because the
  console's attribution already ships without it: `POST /api/join` seals the roster name into the session cookie
  (`src/server/main.ts:457-479`, `src/server/auth.ts:220-245`), `/api/session` returns it as `person`, and every
  message a browser submits is stored with a `[from Name]` prefix the server writes rather than the client
  (`src/shared/contract.ts:104-118`). What is dropped is the device half only: a token record stays an id and a label,
  the name lives in the session and anyone holding the token can re-claim another, and a person is ultimately known by
  the id their interface maps (A0-3).
- **Ten weeks.** The estimate was a quarter because half of it was client work. What is left is four days and six
  weeks, and the trial week is the only part of it that cannot be compressed.
