# The application bot: internships and fellowships first

> Written 2026-11-02. This is the plan for the first bot a mason deployment does, and it is the product the other plans
> serve: [`SPEC.md`](SPEC.md) §1 states the direction, [`MVP-PLAN.md`](MVP-PLAN.md) is how it is proved, [`FLEET-PLAN.md`](FLEET-PLAN.md)
> is where a second bot would go. Nothing here is built and nothing here replaces the backend's own plan
> ([`BACKEND-PLAN.md`](BACKEND-PLAN.md)); it says what the bot is for, and therefore what its integrations, its state and
> its approval gate have to be.

## The job

Find internships and fellowships worth Denis's time, get the applications ready, take his edits, and stop for his
sign-off before anything leaves the house.

Internships and fellowships first. Jobs, scholarships and university applications are later expansions of the same
pipeline, not a different product, and none of them changes the rule at the end of this section.

**Preparation is autonomous; external commitment is approved.** The bot may discover, evaluate, track, draft, fill and
revise without asking. It does not submit an application, and it does not send an email, without a record of Denis's
explicit approval for that exact act. If he asks for changes, the bot applies them and returns the revised version for
approval again — approval is per version, not per opportunity.

**There is no planned graduation to automatic submission.** The gate is not a phase before trust is earned; it is the
product. Removing it is a later product decision with its own record, not a natural next milestone.

## What it does, in order

1. **Find.** Search the sources that carry internships and fellowships, plus the ones Denis points at. Every find is a
   record with its source, its deadline and the requirement it makes of him.
2. **Deduplicate.** One opportunity is one record. The same programme announced on three sites is one row with three
   sources, and a reopened announcement is not a new opportunity.
3. **Evaluate.** Fit against his profile, evidence and constraints: what it asks for, what he has, what is missing, how
   much work the application is, and whether it is worth the time. An unranked list of twenty is not an answer; a short
   list with reasons is.
4. **Track.** Status, next action, deadline and the documents each opportunity needs, in mason, not in a chat log
   (`BACKEND-PLAN.md` §6).
5. **Prepare.** Gather the evidence (projects, repositories, notes, prior writing), draft the answers and the documents
   the application asks for, and fill what can be filled.
6. **Revise on his edits.** His edits are the source of truth. The bot applies them, keeps the version, and resubmits
   for approval rather than for review-in-passing.
7. **Stop at the gate.** Present the finished application and the exact thing it is about to do — submit a form, send
   an email — and wait for an explicit yes. Then record what was approved: the version, the destination, the time.
8. **Follow up.** Deadlines, confirmations, responses and anything the programme asks for, as drafts and reminders, not
   as autonomous mail.

## Where the state lives

**mason owns operational state.** The durable task and its application record hold the status, the next action, the
source references, the documents, the version history and the approval record. A person asking "where is the X
fellowship" gets an answer from that record, not from scrolling a conversation.

**Obsidian is a human-facing notes interface.** The bot reads the vault and maintains concise project and opportunity
notes inside the existing protections: his notes are production, so writes propose rather than rewrite, and no scratch
work lands there. A note links back to the record; it does not become the record.

**The calendar is a human-facing planning interface.** It shows deadlines and planned work — "submit X by Friday",
"revise Y on Tuesday" — and it is not the authoritative state machine. If the calendar and the record disagree, the
record is right and the bot repairs the calendar.

The test for anything new: if losing it would lose work, it belongs in mason. If a person reads it, it belongs in the
vault or the calendar, with a reference back.

## Integrations, with permissions stated

| Integration | What the bot may do | What it may not do |
|---|---|---|
| **GitHub** | read repositories, commits, issues and releases as evidence for application answers | write, comment, open or close anything, or use a token with write scope |
| **Gmail** | search, read, and prepare drafts, including replies with the thread headers set | send a message without Denis's explicit approval for that message |
| **Google Calendar** | read his commitments so a deadline does not collide, and propose events | become the state machine, or invent deadlines |
| **Obsidian vault** | read notes; maintain concise project and opportunity documents where the vault's protections allow it | store queues, retries, scratch work or internal run state; rewrite his edits |
| **Browser (worker-owned)** | reach application portals, fill forms, attach the prepared documents | submit, accept terms, pay, or send, without the approval record |
| **Yandex Disk / Calendar / Mail** | later work — the research and [`adr/0008`](adr/0008-three-yandex-integrations-one-container.md) stay as the design | not wired into this bot in the first pilot |

**Specialisation also limits reach.** The bot gets the integrations its job needs, not every tool available: no code
write access, no mail send, no arbitrary outbound identity. A new integration is a new grant, with the permission column
filled in before the switch is turned on.

**Order of work: Gmail and Google Calendar come first.** They serve the communication and the deadline workflow
directly, and they are what the first version of this bot needs. Yandex remains planned later work: its research
(`docs/research/yandex-integrations/`), its ADR and [#78](https://github.com/DenisSud/mason/issues/78) are not deleted
and not rewritten as though Gmail had been the original decision.

## The approval gate

One mechanism, used for every external act, and it is [#9](https://github.com/DenisSud/mason/issues/9) in the backend
plan, not a new invention here:

- **A verdict, not a glance.** Approving means choosing among "submit this version", "send this message", "wait"; a
  message the bot drafted and Denis read is not an approval until it says so.
- **Per version.** An approval names the version it approves. An edit after approval makes the approval stale, and the
  bot asks again.
- **Per act.** Approving a submission does not approve the follow-up email, and approving one email does not approve the
  next.
- **Recorded.** Who approved, what exactly, where it was going, and when — durable, and readable later when a programme
  replies months after the fact.
- **Fail closed.** No record, no act. If the approval mechanism is broken or absent, the bot hands over the finished
  application and Denis submits it himself. That is the behaviour today, before the gate exists.

## Workers, not second bots

The heavy, serialised parts run as workers inside this bot, and they return a report (`GLOSSARY.md`, [#4](https://github.com/DenisSud/mason/issues/4)):

- **Browser work** (#8) — reaching portals, reading a form, filling fields, capturing what was filled. The main
  conversation gets the report and a link, never the page transcript.
- **Opportunity sweeps** — many listings read in one place, deduplicated, reported as rows.
- **Evidence gathering** — reading repositories and notes for the pieces an answer needs.

A worker never submits, never sends and never speaks as the bot. The gate stays in the main conversation, where the
approval record is.

## What this plan does not do

- Implement Gmail, Google Calendar, GitHub, Obsidian or browser access.
- Build the approval gate, the task object or the version history; those are backend work.
- Decide which application platforms matter, which documents a typical application wants, or how a form is filled — the
  pilot finds out.
- Add a second bot. The chief of staff is later (`FLEET-PLAN.md`).
- Change historical research. Where an older note recommends something that lost, it is marked, not rewritten.

## Open questions

1. **Which portals and programmes first?** The pilot needs a short list Denis actually cares about, and a form or two to
   practise on, before any of the plumbing is worth building.
2. **How do Gmail and Google Calendar arrive?** An MCP server over Google's APIs is the shape an integration already has
   (`adr/0003`), but the OAuth scopes, the consent screen and the draft-versus-send split need the same primary-source
   treatment the Yandex run got before anyone writes code.
3. **How is evidence chosen?** "Which project shows this best" is a judgement the bot can make and the person can
   correct; whether that is a skill, a memory entry or a task field is open.
4. **What does a follow-up look like?** Reminders, draft replies to a programme's mail, or both — and who owns the
   inbox's read state.
5. **What happens to the vault when several bots read it?** One bot owns the notes it writes today; if a second bot ever
   needs the same vault, that is `FLEET-PLAN.md`'s question, not this bot's.
