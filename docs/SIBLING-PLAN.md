# Sibling as the control plane — managing a fleet of bots

> Written 2026-10-26. Sibling is the app; mason is the backend (ADR-0004). This is the plan for what sibling has to become
> to make a *fleet* of mason bots intuitive to set up, organise and run — and what mason has to expose for that to be
> possible. **Revised 2026-11-02:** the peer-to-peer contract below was a custom envelope over Chord, with A2A later;
> that is superseded. Bots speak A2A, and sibling observes without routing ([`FLEET-PLAN.md`](FLEET-PLAN.md),
> the amendment to [`adr/0001-mason-defines-one-bot.md`](adr/0001-mason-defines-one-bot.md)). The rest stands.

## The problem, stated honestly

Today, standing up one bot is: copy `deploy/.env`, mint a token, mint a trigger secret, paste five variables, run a
script, and know that `integrations.json` is read once at boot. That is a developer's ritual, not a product. And the
second bot is worse: there is no notion of a bot as an object, so there is nothing to copy, to compare, or to stop.

Sibling's job is to make those sentences false. Concretely, three things a person must be able to do without reading a
README:

1. **Create** a bot: a name, what it is for, which services it may reach, which person speaks to it, and a link that
   pairs the interface.
2. **See** it: what it is doing, what it did, what it cost, what is broken.
3. **Organise** several of them: who delegates to whom, which one is in charge, and what a person is expected to answer.

## What sibling needs from mason

Mason's job is to be a backend with a machine-readable boundary. Five surfaces, in build order:

| Surface | Shape | Why sibling cannot exist without it |
|---|---|---|
| **Manifest** | `GET /api/manifest` — name, version, identity, roster, integrations with their capabilities, hooks with their state, schedules | The UI must be derived from the backend, not hardcoded. A console that guesses is a console that lies |
| **Status** | `GET /api/status` — last N structured events: turns, firings, integration connects, budget hits, errors | [`BACKEND-PLAN.md`](BACKEND-PLAN.md) §7. "What is broken" is the first question anyone asks a fleet view |
| **Manage** | Chord methods that already exist (`fireHook`, `toggleHook`, `reset`, `compact`, `submit`) plus roster, integrations, schedules, tokens | Sibling is the console that replaced the frozen one; it needs the same verbs and more |
| **Tasks** | the `task` object from BACKEND-PLAN §6, with a projection | A board is only worth drawing if the things on it are real records |
| **Fleet** | each bot's A2A status: who it may talk to, what it was asked, what answered, what it spent — read from mason, or from the deployment's A2A bridge through the same surface | A fleet view is only worth drawing if delegations are visible, and sibling is where a person sees them |

All of it sits behind `src/server/auth.ts`. An sibling instance is a client with a token, not a privileged backdoor: if a
surface is not reachable by a token-holding client, it is not reachable by sibling either.

## Peers: A2A, and sibling does not route

The question that decides everything else is **who addresses whom**. Two bots talking is not two chat sessions: one of
them is asking for work and the other has to accept it, be paid for it, and answer once. The answer is the
Agent2Agent Protocol (A2A), carried by the deployments ([`FLEET-PLAN.md`](FLEET-PLAN.md)), not a protocol mason invents
and not a message sibling relays.

### What stays from the earlier design

The shape of a delegation was right even though its wire was not, and A2A carries the same rules:

- **A delegation is a task, not a conversation.** It lands in the receiving bot's task store (BACKEND-PLAN §6) and
  produces at most one answer per request, so a fleet of three bots cannot drown itself in chatter.
- **A budget is part of the request.** The receiver may spend up to it and no more; a delegation without a budget is
  refused, and that is what makes a chief of staff safe to leave running.
- **Idempotent by request id**, like an event fire: a re-delivery after a restart is the same task, not a second one.
- **Default: no peers.** A bot accepts a message from a bot in its peer list, and from nothing else; nothing discovers
  another bot. The list is a file a person wrote (`FLEET-PLAN.md`), not a registry.

### What is A2A's, and therefore not designed here

Identity and its authorisation, the message and task schemas, streaming and status, and which SDK implements them are
A2A's specification, not mason's ([#96](https://github.com/DenisSud/mason/issues/96) open question 1). Mason's job is to be a bot that can hold its
side of the exchange; sibling's job is to show it happening.

### What sibling shows without being in the path

A bot reports what it asked and what it was asked: a delegation is a durable record in both bots, and the record is
what sibling reads. That keeps the control plane a reader — it can draw the board, the budgets and the replies, and it
cannot be the reason a message went missing. **sibling is not the message bus**, and a fleet whose bots can only talk
when sibling is running is not a fleet.

Explicitly not doing: a public directory of bots, federated discovery, or a bot that accepts a delegation from a bot no
person added.

## The chief of staff

The later second bot, in one design: **one bot whose tools are the other bots, and whose job is to hold the board.** It
is deferred until the application bot is useful and a real exchange exists (`FLEET-PLAN.md`).

- It is an ordinary mason — its own container, home and soul — with three extra tools: `ask_agent(id, question)`,
  `assign(id, task, deadline, budget)`, `board()`.
- It reads the board and writes to it; it does not read other bots' transcripts. What a bot did is what it reported,
  which is also the only thing that scales.
- Its exchanges go over A2A like everyone else's; it is the one bot allowed to speak first (BACKEND-PLAN §3), and the
  one whose noise budget a person tunes once.
- Its failure mode is named: a chief of staff that delegates everything becomes a router. The soul must say it does the
  work it can do and delegates only what has an owner.
- **Attention routing is deferred with it.** Which messages reach Denis directly and which are consolidated needs two
  bots and a real exchange before it is worth designing.

Prerequisite: tasks (BACKEND-PLAN §6) and per-delegation budgets (BACKEND-PLAN §5). Both are backend work; the
chief-of-staff itself is a soul, three tools and a board view.

## What sibling looks like, by milestone

Sequenced so that each one is useful alone, and so no milestone needs a backend surface that does not exist yet.

| # | Milestone | In sibling | Needs from mason | Exit criteria |
|---|---|---|---|---|
| 1 | **The window** | A list of bots with state, last activity, cost, and what is broken; open a transcript | manifest, status | A person can answer "is it working" without ssh |
| 2 | **The editor** | Roster, integrations (add/enable/secret/rotate), hooks on/off, schedules, tokens — every one of them currently a CLI subcommand | the same verbs over Chord, plus writes | Nothing in `deploy/README.md` needs a shell any more |
| 3 | **The wizard** | New bot from a template: name, purpose, which services, which person, then a pairing link; the deploy is behind a button | a create call the deployment honours (one container per bot, from the manifest in [`FLEET-PLAN.md`](FLEET-PLAN.md)) | Second bot in under five minutes, no file edited by hand |
| 4 | **The board** | Tasks per bot and across bots, with state and owner | tasks, projection | "Where is X" is answered by looking, not by asking |
| 5 | **The fleet** | Add a peer, watch an A2A exchange, see a budget burn | each bot's A2A status; budgets | Two bots complete one delegated task end to end |
| 6 | **The chief** | Board with one bot on top; its delegations visible; its noise budget adjustable | the same, plus proactivity | A week where the chief runs the board and Denis reads one digest |

Milestones 1 and 2 are the ones that pay for themselves immediately: they replace the CLI and the ssh. 3 is where it
starts to feel like a product. 5 and 6 are the fleet.

## Open questions

1. **The unit of deployment — answered.** One container per bot: the second bot is a second home in a second container,
   and several of them are a fleet ([`FLEET-PLAN.md`](FLEET-PLAN.md), [`adr/0001`](adr/0001-mason-defines-one-bot.md)).
   What is left is sibling's half: whether a create is a manifest it writes or a call the deployment honours.
2. **Who owns the vault?** The application bot reads his notes and maintains concise notes of its own; a second bot that
   wanted the same vault would have to share it or delegate to it. That is the fleet's question and the pilot will show
   which is less annoying.
3. **Does sibling keep state?** A control plane that stores anything becomes a second source of truth. The plan above has
   sibling storing only what the backend cannot: view preferences and the pairing of a person to an interface.
4. **How does sibling observe an A2A exchange without being in it?** Each bot keeps the record of what it asked and what
   it was asked, and sibling reads those records. Whether that is a dedicated surface, part of `/api/status`, or a task
   view is not designed, and it should not be designed before a real exchange exists.
