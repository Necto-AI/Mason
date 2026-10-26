# Apiary as the control plane — managing a fleet of agents

> Written 2026-10-26. Apiary is the app; mason is the backend (ADR-0004). This is the plan for what apiary has to become
> to make a *fleet* of mason agents intuitive to set up, organise and run — and what mason has to expose for that to be
> possible. The peer-to-peer section is the part that changes mason's shape, so it is written as a contract first and a
> feature second.

## The problem, stated honestly

Today, standing up one agent is: copy `deploy/.env`, mint a token, mint a trigger secret, paste five variables, run a
script, and know that `integrations.json` is read once at boot. That is a developer's ritual, not a product. And the
second agent is worse: there is no notion of an agent as an object, so there is nothing to copy, to compare, or to stop.

Apiary's job is to make those sentences false. Concretely, three things a person must be able to do without reading a
README:

1. **Create** an agent: a name, what it is for, which services it may reach, which person speaks to it, and a link that
   pairs the interface.
2. **See** it: what it is doing, what it did, what it cost, what is broken.
3. **Organise** several of them: who delegates to whom, which one is in charge, and what a person is expected to answer.

## What apiary needs from mason

Mason's job is to be a backend with a machine-readable boundary. Five surfaces, in build order:

| Surface | Shape | Why apiary cannot exist without it |
|---|---|---|
| **Manifest** | `GET /api/manifest` — name, version, identity, roster, integrations with their capabilities, hooks with their state, schedules | The UI must be derived from the backend, not hardcoded. A console that guesses is a console that lies |
| **Status** | `GET /api/status` — last N structured events: turns, firings, integration connects, budget hits, errors | [`BACKEND-PLAN.md`](BACKEND-PLAN.md) §7. "What is broken" is the first question anyone asks a fleet view |
| **Manage** | Chord methods that already exist (`fireHook`, `toggleHook`, `reset`, `compact`, `submit`) plus roster, integrations, schedules, tokens | Apiary is the console that replaced the frozen one; it needs the same verbs and more |
| **Tasks** | the `task` object from BACKEND-PLAN §6, with a projection | A board is only worth drawing if the things on it are real records |
| **Peers** | an agent card, a delegation envelope, a reply path (§below) | This is the part that makes a fleet a team rather than a list |

All of it sits behind `src/server/auth.ts`. An apiary instance is a client with a token, not a privileged backdoor: if a
surface is not reachable by a token-holding client, it is not reachable by apiary either.

## Peer to peer: the contract

The question that decides everything else is **who addresses whom**. Two agents talking is not two chat sessions: one of
them is asking for work and the other has to accept it, be paid for it, and answer once.

Design, deliberately small:

### Identity

Every mason has a stable **agent id** (its `house` name plus a key it generates at first boot), and publishes an **agent
card**: id, name, what it is for (one line), what it can be asked to do (its hooks), which integrations it has, and the
address to reach it at. The card is public to peers, and only to peers that a person has added.

### The envelope

One message shape, signed, with the properties a delegation needs — the same discipline as the event door, because it is
the same kind of door:

```json
{ "v": 1, "id": "…", "from": "<agent id>", "to": "<agent id>", "kind": "delegate",
  "task": { "title": "…", "brief": "…", "deadline": "…" },
  "budget": { "tokens": 50000, "currency": "USD", "max": 0.4 },
  "replyTo": "<agent id or nothing>" }
```

Rules that matter more than the fields:

- **A delegation is a task, not a conversation.** It lands in the receiver's task store (BACKEND-PLAN §6) and produces
  at most one answer, so a fleet of three agents cannot drown itself. Chat between agents is what the room already is.
- **A budget is part of the message.** The receiver may spend up to it and no more; a delegation without a budget is
  refused, and that is what makes a chief-of-staff safe to leave running.
- **Signature with the sender's key**, and a person's roster decides which peers exist at all. Default: no peers.
- **Idempotent by `id`**, like an event fire: a re-delivery after a restart is the same task, not a second one.

### Transport

Two implementations, one envelope:

1. **Same host (now).** Chord link between masons, which mason already speaks. Cheapest, and it lets the console watch
   both sides of a delegation live.
2. **Across hosts (later).** The same envelope over HTTPS, and shape it to be A2A-compatible — A2A 1.0 has agent cards,
   task lifecycles and streaming, and the research in [`research/always-on-agents/`](research/always-on-agents/) puts it
   in the substrate every vendor cites. Compatible where it costs nothing; not a second protocol invented on top.

Explicitly not doing: an agent registry in a public directory, federated discovery, or an agent that accepts a
delegation from an agent no person added.

## The chief of staff

The end state Denis asked for, in one design: **one agent whose tools are the other agents, and whose job is to hold the
board.**

- It is an ordinary mason, with a soul that says so, and three extra tools: `ask_agent(id, question)`,
  `assign(id, task, deadline, budget)`, `board()`.
- It reads the board and writes to it; it does not read other agents' transcripts. What an agent did is what it reported,
  which is also the only thing that scales.
- It is the one agent allowed to speak first (BACKEND-PLAN §3), and the one whose noise budget a person tunes once.
- Its failure mode is named: a chief of staff that delegates everything becomes a router. The soul must say it does the
  work it can do and delegates only what has an owner.

Prerequisite: tasks (BACKEND-PLAN §6) and per-delegation budgets (§5). Both are backend work; the chief-of-staff itself
is a soul, three tools and a board view.

## What apiary looks like, by milestone

Sequenced so that each one is useful alone, and so no milestone needs a backend surface that does not exist yet.

| # | Milestone | In apiary | Needs from mason | Exit criteria |
|---|---|---|---|---|
| 1 | **The window** | A list of agents with state, last activity, cost, and what is broken; open a transcript | manifest, status | A person can answer "is it working" without ssh |
| 2 | **The editor** | Roster, integrations (add/enable/secret/rotate), hooks on/off, schedules, tokens — every one of them currently a CLI subcommand | the same verbs over Chord, plus writes | Nothing in `deploy/README.md` needs a shell any more |
| 3 | **The wizard** | New agent from a template: name, purpose, which services, which person, then a pairing link; the deploy is behind a button | a create call the deployment honours (compose template or an agent-per-container layout, see open question 1) | Second agent in under five minutes, no file edited by hand |
| 4 | **The board** | Tasks per agent and across agents, with state and owner | tasks, projection | "Where is X" is answered by looking, not by asking |
| 5 | **The team** | Peers: add a peer, watch a delegation, see a budget burn | peers, budgets | Two agents complete one delegated task end to end |
| 6 | **The chief** | Board with one agent on top; its delegations visible; its noise budget adjustable | the same, plus proactivity | A week where the chief runs the board and Denis reads one digest |

Milestones 1 and 2 are the ones that pay for themselves immediately: they replace the CLI and the ssh. 3 is where it
starts to feel like a product. 5 and 6 are the fleet.

## Open questions

1. **The unit of deployment.** Mason today is one home, one agent, several interfaces. A fleet could be several homes in
   one container set, or one container set per agent. The second is what the compose files already are, and it is what
   makes isolation and per-agent machines honest ([`ENV-PLAN.md`](ENV-PLAN.md)); it also multiplies containers. Milestone
   3 has to pick, and the answer decides apiary's whole shape.
2. **Who owns the vault?** Notes are shared between agents in the clinical-compass case. Either one agent owns the vault
   and others delegate, or a share is mounted read-only into several. The pilot will show which is less annoying.
3. **Does apiary keep state?** A control plane that stores anything becomes a second source of truth. The plan above has
   apiary storing only what the backend cannot: view preferences and the pairing of a person to an interface.
4. **A2A compatibility: now or when a second host exists?** Doing it now costs a day and buys nothing on one machine;
   doing it later means the envelope is already shaped for it. The envelope above was chosen so that later is cheap.
