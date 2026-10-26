# Making mason a capable backend — the plan

> Written 2026-10-26, after the first real deployment (pc host, Telegram, clinical-compass). This is the technical plan
> for mason itself: what it does today, what is missing between here and "an agent that is genuinely useful when nobody
> is watching", and the order to build it in. The other three plans lean on this one:
> [`ENV-PLAN.md`](ENV-PLAN.md) is the computer the agent works on, [`APIARY-PLAN.md`](APIARY-PLAN.md) is how a person
> manages a fleet of them, [`MVP-PLAN.md`](MVP-PLAN.md) is how we prove the first use case.

## Where mason is today

Verified on the deployed instance, not remembered:

| Piece | State |
|---|---|
| Durable agent | `@earendil-works/pi-durable` with a log-backed conversation, submissions with idempotency, `whenBusy` (`followUp` / `steer` / `reject`), abort, reset, compact |
| Triggers | Five builtin hooks (`team-chat`, `retry`, …) plus an HMAC-signed event door that fires the hook its trigger names, or issues one of the commands its entry declares |
| Integrations | ADR-0003: a service with a tools face (MCP over Streamable HTTP), a trigger face (HMAC), or both. Telegram is the first one, with auto-reconnect, a per-chat send queue and a typing indicator |
| Surfaces | Chord over WebSocket for live replication and methods; the operator console (frozen) reads a projection of the transcript and never the conversation |
| Tool machine | `pi-env` daemon in a second container, reached over SSH, `RemoteExecutionEnv` on the harness side |
| Auth | Owner token → `HttpOnly` session cookie; `Origin` checked; `/api/health` and the signed event door are the only paths outside it |
| Deployment | `deploy/`: compose files, an env image, a per-deployment `.env`, `deploy.sh` with image-id verification |

That is a working single-agent backend with one interface. It is not yet an agent that is *good* at being an agent.

## The seven gaps

Each gap is stated as the thing that is missing, then the smallest design that closes it. The milestones at the end put
them in order.

### 1. An interface cannot say what it is

Today the model is told "this chat renders words, not widgets" by a sentence in the `team-chat` hook prompt. That
sentence is a patch over a structural hole: **capability is a property of the interface, and no interface declares it.**

Design: `integrations.json` gains a `capabilities` block per integration, and the hook prompt is built from it.

```json
{ "capabilities": { "render": ["text", "image", "file"], "interact": ["reply"], "live": false, "verbatim": false } }
```

Consequences that are worth the work:

- The prompt stops carrying per-interface prose. `render` tells it a chart is not an option and a 40-line answer is.
- `interact` decides whether the agent may ask a question and wait, or must act and report. Today every interface is
  assumed to be a chat that answers immediately.
- `live` says whether a long task can stream progress. Telegram cannot; a console can.
- The projection has a mirrored whitelist (`src/server/projection.ts`), so a capability declared here is also what a new
  surface is allowed to receive. One declaration, two readers.

Exit: a second interface (the console) and the first (Telegram) get different prompts from the same hook, with no
interface's name in `src/server/`.

### 2. There was no vocabulary for control

`abort`, `reset` and `compact` existed as Chord methods, so the console had them and a chat did not. A person talking to
the bot needed at least `/stop`, `/compact`, `/clear`, `/status` and `/help`, and the bot needed them to mean the same
thing everywhere.

**Shipped as the first option.** Mason owns the vocabulary and an interface forwards it. A signed
`POST /api/events/<integration>` gained one more thing it may say, `{"v":1,"id":…,"kind":"command","payload":"stop"}`,
and the route acts only on what the entry declares (`"commands": ["stop","compact","clear","status"]`, empty by
default, written with `npm run integration -- commands`). A declared command calls the same conversation method the
console calls and answers `{handled:true, reply:"stopped"}`; a word the integration does not declare answers
`{handled:false}`, and the relay sends the message it was already holding. An existing trigger secret opened nothing new:
no declaration, no command. The envelope id claims the command in the durable log, so a redelivery answers instead of
stopping a turn twice, and the claim is a display-only entry, so `/stop` is not queued behind the turn it stops. Telegram
forwards a `/word` as a command, answers `/help` itself, and posts the reply through its per-chat send queue; the same
list sets Telegram's own bot command menu.

The second option is still the way in for a service that needs to *read*: an approval inbox or a status panel would
become a principal with its own token and a Chord link, and the command route is the first method it is allowed to call.

Why not the agent's own tools: `/stop` has to work while the model is busy, and a tool cannot interrupt the turn that is
calling it.

Exit, as it stands: `/stop` from Telegram reaches `conversation.abort()` without queueing for anything, a declared
`/compact` leaves a summary the next message can use, and an undeclared `/word` arrives as the message it was, with no
error to interpret.

### 3. Nothing is proactive

Every wake today is an inbound event. "Proactive" needs three things mason does not have:

- **Time.** A scheduler with named routines (`morning-brief`, `weekly-review`, `watch-<thing>`), each a hook plus a
  schedule, in the durable log so a restart does not lose a firing. Not cron: the routine is a record with a last-run,
  a budget and an owner.
- **Conditions.** A wake rule that is not a clock: "if the inbox has an unread mail from X", "if the build went red",
  "if a note has been untouched for 30 days". Each is a poller in an integration that fires the same event door.
- **A reason to speak.** The hardest one and the one that decides whether this product is loved or muted: a proactive
  turn must justify itself. Design: every proactive turn ends in a *decision* — one thing to look at, one thing done, or
  silence recorded as an outcome — and the log keeps the rate so the agent can see it is becoming noise.

Exit: a week of unattended running produces at most a handful of messages, each of which Denis acted on.

### 4. Memory is a folder with no recall

`agent/log/YYYY-MM-DD.md`, `profile.md`, `skills/`, a git history. There is no way to ask "what did we decide about
pricing in August", and the log grows without curation.

Design: an index over the memory and the transcript (SQLite FTS5 — the transcript is already SQLite), refreshed on
write, exposed as a `recall` tool with the same progressive-disclosure discipline the skills index uses: a title and one
line first, the body only when asked. Plus a curator: a nightly hook that folds the log into `profile.md` and a topic
file when a fact is repeated, and marks entries it folded. Forgetting is a feature: an entry that has been folded and is
older than N days leaves the daily file.

Exit: "what did we decide about X" answers from memory with a citation to the file or the turn, in one tool call.

### 5. Tools are flat and unbudgeted

`tools.*` is discovered by search, which works, but nothing bounds a turn: no per-turn tool budget, no cost ceiling, no
way to say "this integration may only be called twice an hour". A long agent run is currently able to spend without
limit, which is fine for a demo and not fine for a bot on a subscription.

Design: limits live beside the integration (`"tools": {"maxPerHour": 60}`) and in the harness (a turn budget in tokens
and in wall clock, with a graceful "here is what I got done" ending rather than a truncation).

Exit: a runaway turn stops itself and says why, and the transcript shows the budget it hit.

### 6. Nothing is durable at the level of a *task*

Submissions are durable; a piece of work that spans a day — "get the pricing page reviewed" — lives in the chat log and
in Denis's head. That is what makes the difference between a chatbot and a colleague, and it is also what the
chief-of-staff bot in [`APIARY-PLAN.md`](APIARY-PLAN.md) needs to exist at all.

Design: a `task` object in the durable store — title, state, owner (person or agent), the turns and events that touched
it, a next action and a due hint. Tools to open, update and close one; the transcript's projection shows the ones a turn
touched; a nightly hook reports the ones going stale.

Exit: "where is X" is answerable from tasks, not from scrolling a chat.

### 7. Operations are guessed at

One `/api/health` that answers 200. There is no trace of what fired what, no per-turn cost or latency, no way to see
that an integration has been failing for a day. The deploy script's own history (a restart that loses a race with a
listener) is the shape of the problem: the system can be broken in ways nobody can see.

Design: structured events on one channel — turn started/finished (duration, tokens, model), hook fired (id, payload id,
submission id), integration connected/absent, budget hit. Ring buffer in memory plus a JSONL file in `service/data/`;
`/api/status` returns the last N for the console and for a chat `/status` command.

Exit: after a wrong answer, the cause is visible in one request.

## Milestones

Sequenced by what unblocks the most, and by what the MVP in [`MVP-PLAN.md`](MVP-PLAN.md) needs to be worth running.

| # | Milestone | Contents | Exit criteria |
|---|---|---|---|
| 1 | **The interface contract** | capabilities in `integrations.json`; prompt built from it; command route with a declared vocabulary; `/stop`, `/compact`, `/clear`, `/status` from Telegram | two interfaces, two prompts, no interface name in the server; `/stop` mid-turn < 1 s |
| 2 | **Seeing** | structured event channel; `/api/status`; per-turn cost and latency; a chat `/status` that reports the last hour | one request answers "what happened and what is broken" |
| 3 | **Memory with recall** | FTS5 index over memory and transcript; `recall` tool; nightly curator hook | a decision from three months ago is quoted with its source |
| 4 | **Proactive with a reason** | routines + schedules in the durable store; wake rules from integrations; proactive-turn contract (one actionable thing or silence) | a week unattended, every message acted on, none muted |
| 5 | **Budget and trust** | per-turn and per-integration budgets; approval gate for consequential actions (send, publish, spend, delete) with a one-tap approve in chat | a runaway turn stops; an approval is asked once and remembered |
| 6 | **Tasks** | the task object, its tools, its projection, the stale report | "where is X" answers from tasks |

Milestones 1–2 are small and unblock everything else. 3–4 are what make it feel alive. 5–6 are what make it safe to
leave alone, and 6 is the precondition for the chief-of-staff design.

## What this plan deliberately does not do

- **No second agent framework.** Every capability here is a record in the durable log plus a tool. The moment mason
  grows its own planner loop it stops being testable.
- **No plugin API for hooks.** Hooks stay builtin and versioned with the code; a hook is a prompt and a policy, and the
  place operators customise is `soul.md`, skills and integrations.
- **No agent-authored shell in the server process.** Everything the agent runs, runs on its own machine
  ([`ENV-PLAN.md`](ENV-PLAN.md)); the server holds the door, not the tools.
- **No widget rendering.** The console is frozen (ADR-0004) and chat is words. A generative-UI surface is a separate
  product decision, and `skills/generative-ui` already holds the manual for when it is made.

## Open questions this plan does not answer

1. **One mason per person or per agent?** Today: one per person, with one identity. The chief-of-staff design wants
   several agents that can talk; [`APIARY-PLAN.md`](APIARY-PLAN.md) assumes the unit of deployment is an agent, and says
   what that costs in the home layout.
2. **How much of the prompt is per-interface?** Capabilities replace prose, but a chat and a console still differ in
   length and in how much a person can interrupt. Milestone 1 will show whether the hook prompt can stay one paragraph.
3. **Whose budget is a proactive turn?** If the agent may spend on its own initiative, someone sets a number. That is an
   operator setting mason does not have yet.
