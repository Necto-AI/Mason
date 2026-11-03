# The superagent — what an application looks like when the harness is this pluggable

> Research note, 2026-11-03. Read from `deepseek-ai/dsh-superagent-prototype` at `main`: `docs/000`–`008`,
> `cordis.patch.yml`, `package.json`, and `src/` (≈15,200 lines). Line references are from that checkout.
> `[judgement]` marks my reasoning.

## 1. The shape

Two agent sessions and one domain model between them. A long-lived **main Session** ("the orchestrator") talks to
people, judges whether an event asks for work, and routes; it holds no Authority and writes no code. Each unit of work
gets an **Executor Session** named `worker-<ticket id>` in its own directory, with the tools the work needs and nothing
else. Messages are the only channel between them: the Executor reports, the main Session delivers.

Everything else in the bundle is bookkeeping for that split: who is allowed to ask (Policy), what a piece of work is
allowed to include (Mandate), which conversation goes on to which worker (Subscription), and how a result comes back
(Channel).

## 2. The domain, in one table

Ten concepts, and the doc gives each a *rule it keeps* rather than a description — which is the difference between a
glossary and a design (`docs/001-domain.md`):

| Concept | What it is | The rule that makes it worth having |
|---|---|---|
| Source | A stream of events (GitHub, Feishu) | Holds its read position and identity, so a restart does not replay events |
| Trigger | One immutable event | Accepting it twice creates one Ticket — the unit of audit and of idempotence |
| Thread | Triggers in time order | At most one Eval at a time; gives the judgement a consistent view |
| Correlation | Threads related to one Trigger | Adds context; never routes |
| Channel | The write side of a Thread | A Ticket holds a set of them; ack, reply, PR and review all write through one |
| Policy | Versioned rules + each Source's admission table | A change that bears on live work is delivered to it; it does not revoke Mandates |
| Eval | Judgement on a batch: gate, then assessment | Holds no state: input is the batch, the Thread, the Tickets and the Policy |
| Mandate | What an accept grants: policy version, scope, strength, matched rules, sender | Immutable; a wider scope needs a new one; revalidated before an ended Ticket resumes |
| Ticket | A unit of authorized work | Only Eval creates one; it defines its own state rather than following the Executor's |
| Assignment | Ticket bound to one Executor instance | Several over time; only its final report may end the Ticket on the Executor's side |
| Subscription | Many-to-many between Tickets and Threads | Fans an event out to every subscribed Ticket with no check of who sent it — and grants no authority |

Two things in that document are worth copying without any of the machinery:

- **A "Rejected concepts" table.** Eleven ideas that were considered and dropped, each with the reason: "Principal or
  Membership as an entity → a person is Trigger metadata"; "At most one live Ticket per Thread → one Thread can carry
  several independent pieces of work"; "Ticket state that follows the DSH Session → a Ticket can be handed off, resumed,
  or run by several Executors". A design record that says what lost, and why, is what stops the same argument from
  happening twice. mason's ADRs record decisions taken; nothing records the small ones dropped.
- **One vocabulary, enforced by use.** "The code, the tools the agents call, the panel and the other documents use these
  terms and no others" (`docs/001-domain.md:3`).

## 2b. Where the state lives, and what makes a hop idempotent

One SQLite file, `<stateDir>/orchestrator.sqlite`, is the only domain store: `trigger`, `disposition`, `trigger_thread`,
`thread`, `ticket`, `decision`, `effect`, `outbox`, `kv`. WAL with `synchronous=FULL`, file `0600`, directory `0700`.
Generated columns hold the working sets (`ticket.open`, `ticket.active`, `thread.subscribed`, `outbox.pending`) so a pass
reads only active work (`src/app/store.ts:30-87`). The agent conversations themselves are *not* here — they are harness
sessions, read back to dedupe deliveries.

`Engine` methods are synchronous and each command is one transaction; ports only *enqueue* external work inside the
transaction, and adapters perform it after commit. Every hop has a key, and the keys are the design:

| Hop | Key |
|---|---|
| A trigger is ingested once | `Trigger.id`, derived by the Source from a native id |
| One Eval per thread state | `key('eval', threadKey, policyVersion, at, ...pending)` |
| One decision per Eval | `key('decision', evalId)` |
| One ticket per Eval | `key('ticket', evalId)` — structurally at most one |
| One assignment per slot | `key('assignment', ticketId, index)` |
| One input per (ticket, trigger) | `key('input', ticketId, 'trigger', triggerId)` |
| One acknowledgement per trigger | outbox id `key('ack', triggerId)` |
| One message into a session | `dsh-superagent:<key(requestId)>`, checked against the live inbox and persisted history |

That table is the most directly copyable artifact in the bundle. mason already does this for hook fires
(`explicitRequestId`/`scheduledRequestId`/`gestureRequestId`); what it does not have is the same discipline *inside* the
pipeline — one key per hop, so a retry at any layer collapses instead of duplicating. `[judgement]`

## 3. Authorization: gate, strength, mandate, revalidation

Two paths into work, and they are separated by *who decides*:

- **Eval** decides whether new work starts. A deterministic gate first (sender on the list? does the message address the
  agent? which admission cell does the scope fall in?), then a model assessment against the enabled policy rules.
- **Subscription** continues existing work. A message on a subscribed Thread reaches its Tickets as context with no gate
  and no new authority; the Ticket stays inside its Mandate.

The gate produces a **strength**: `explicit` (an allowed person addressing the agent), `inferred` (a candidate a rule may
promote), or `not admitted` (`docs/002-authorization.md`, "Strength"). The admission table is per Source and per receiving
scope: three cells deciding what an on-list/unlisted sender, addressing or not, may originate. A bot may only ever
produce an inferred candidate.

The Mandate is the piece mason has no equivalent of: it records the policy version, the scope, the strength, the matched
rules and the sender's identity, is immutable, and is **revalidated against the current Policy before an ended Ticket
resumes**. A policy that no longer holds it revokes it. Deliberately, a policy change does *not* cancel running work:
"a cancelled change leaves half-finished work; the change is recorded and delivered instead" (`docs/001-domain.md`,
Rejected concepts).

The design article says why this layer is where the money is: an agent that can act for a whole team can also waste a
whole team's attention, so the admission decision has to be cheap, deterministic and auditable before a model is called
at all (Fast Path / Slow Path, §3.1).

## 4. Execution: a stage per ticket, a slot per worker

The stage table is the operational heart, and it is written as "read from top to bottom; the first matching row wins"
(`docs/003-execution.md`, "Ticket stages"):

| Stage | Condition |
|---|---|
| person / delivery | delivering an input to the Executor failed, retried with backoff to a minute |
| person / answer | the Ticket has an Attention |
| person / review | the latest Report is `ready` |
| person / blocked, failed | the latest Report is `blocked`/`failed` and no person has written since |
| working / queued | no Assignment, or a pending one |
| idle | the latest Report is `waiting`, or the Assignment ended |
| working | everything else |

Every `person` stage means the Ticket cannot continue without a human, which is also the panel's sort order. Two details
that make it survive contact with real work:

- **A busy turn keeps its slot.** "When a turn ends with shell jobs or subagents still running, the Ticket keeps its worker
  slot and stays working… A completed job or subagent wakes the Executor with its result in the same slot." Background
  work gets 30 minutes, then shell jobs are killed and the Ticket reports waiting with the Executor's last words.
- **A person gets a slot of their own.** The concurrency limit applies to worker slots "with one extra slot for a person's
  message or a status request… New work therefore cannot prevent a person from continuing an existing Ticket."

The 5-second rule is the other load-bearing number: a foreground shell command becomes a background job after 5 seconds
in both presets, and a job wait ends after 5 seconds too, so a worker can take a person's message at its next step
instead of blocking. That is the full-duplex behaviour the design article describes as "not yet enabled by default" in
the harness, turned on through configuration rather than forked code.

Recovery is a sentence, not a subsystem: "An Assignment interrupted while busy restarts with a recovery note." Plus:
inputs not yet taken into history are retained; shutdown waits up to 10 seconds per worker's background work.

## 5. The panel

Three questions in order (`docs/005-panel.md`): does anything need me now; is the system healthy and doing the right
things; what happened to one piece of work. Six tabs follow the workflow (Overview, Source, Trigger, Eval, Execution,
Settings), and seven principles govern it. The ones worth stealing:

1. "Every element answers one of the three questions, or it is removed. A number appears only when it changes what the
   supervisor does."
2. "A label says whom a row waits for and what it needs, not an internal status code."
3. "Healthy states take no extra space."
4. "A count equals the length of the list it links to, and no state contradicts another fact."

mason's panel already follows the fourth rule in spirit (`src/server/admin.ts` builds state per grant, and an ungranted
area is absent rather than empty — `docs/SPEC.md:949-953`). The first and third are the ones it does not: mason's Overview
is a dashboard of what exists, not a queue of what waits.

## 6. What it costs to be a bundle

The whole application attaches through three rows and two presets. `cordis.patch.yml` inserts:

- `dsh-superagent` (the plugin: state directory, engine, routes, panel),
- `dsh-superagent/github-watch` (one Source), and `dsh-superagent/feishu-watch` (another, `disabled: true`),
- `@deepseek-ai/dsh-agent-preset` twice — `dsh-superagent-worker` and `dsh-superagent-router` — each a nested tree of
  plugin rows with config, `isolate` realms and platform-conditional `!!js` expressions.

The presets are where the "composable" claim pays off, and they are readable: the worker preset lists exactly the tools a
worker gets (`tool-bash`, `tool-fs`, `tool-fs-search`, `tool-jobs`, `tool-skill`, compaction, subagent, todo, web) with
`timeoutMs: 5000` on the shell and `waitTimeoutMs: 5000` on jobs; the router preset lists a smaller set and no
write/edit (`tool-fs` with `write: false, edit: false`). A comment above each row explains what is deliberately absent and
why. `package.json` declares the bundle in a `dsh` field and 18 `@deepseek-ai/*` packages as peer dependencies.

So the harness contract is: *a bundle declares composition as data and code as an ordinary npm package.* The bundle's
own `src/` is ~15,200 lines, of which the domain is `src/core/` (Engine and its five parts: Intake, Evals, Tickets,
Assignments, Replies, each with one-directional dependencies), and everything else is glue to Sources, Sessions, routes
and cards.

That split is the thing worth naming: **the domain is code, the composition is data.** The superagent never forks the
harness; it patches rows and ships a package. `[judgement]` That is what "extensible" actually bought them.

## 7. What the design admits

- **Isolation is defaults, not a boundary.** "These wrappers and directories establish defaults, not a security
  boundary. A worker can still execute a program by absolute path" (`docs/003-execution.md`). The deployment doc tells
  operators to use a dedicated OS account.
- **Workers run without approval.** "Executor Sessions run commands without approval as the operator's OS user", under
  the `danger-full-access` preset (`src/app/sessions.ts:152`).
- **The Mandate's scope is text, not a capability.** `scope` is a string the model writes, capped at 1,500 characters
  (`src/app/assessment.ts:29`); nothing compares an action to it. It reaches the worker as a prompt paragraph when the
  strength is `inferred` (`src/executor/dsh.ts:91-95`). The doc says it "states why the work may be done, and how far it
  may go" — the first half is true, the second is a sentence. `[judgement]`
- **The agent can edit its own policy.** Settings blocks carry an origin guard (`panel` / `tool` / `sync`), but only the
  executor block and the source's setup fields have one; the `policy` block does not (`src/app/settings.ts:32-51`). So the
  main Session can rewrite the rules, the accept mode and the allowlists, and the guard's own comment says it is "a
  guardrail against prompt-injected tool calls, not an OS security boundary".
- **Two of the strongest rules are prompt-only.** "Avoiding code reads is a prompt rule, not a tool restriction"
  (`docs/007-architecture.md`), and "Auto-merge is governed by the **Delivery requirements** prompt. The host has no
  merge-specific decision logic" (`docs/003-execution.md`). The router's *tool allow list* is code; its *reading habits*
  are not.
- **One process-wide side effect is documented rather than fixed.** The plugin "changes process-wide `PATH` and git
  settings", which is why the deployment guide tells you to keep it in its own profile.
- **The numbers are synthetic.** The only measurements anywhere are the design article's: ~300 generated messages per
  run, coding work "simulated by a tool that simply consumes time", so the experiment "measures the system's scheduling
  and coordination, not its ability to execute individual tasks". The README's own warning is stronger: research code,
  much of it written by coding agents, possibly with bugs, not production software. Any claim that this design *works* is
  a claim about scheduling under a simulated load — not about code quality, not about real users. `[judgement]`
