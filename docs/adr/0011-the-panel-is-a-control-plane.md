# 11. The panel is a control plane, and the console is gone

Date: 2026-11-02

## Context

ADR-0004 concluded that mason is a headless backend and kept the web client in this repository, frozen, as a reference
operator console. It was the only way to see the conversation the way a reader was sent it, and it kept the projection
and the Chord contract exercised. That was true while the client was also the only way a person could speak to the bot
from a browser.

The connector cutover (#99) removed that premise. A person's words arrive as an attributed submission through a
connector, their replies leave through the same origin, and the console's own socket is a second conversational
contract with its own authentication, its own state replication and its own way to submit, steer and withdraw — a
surface #99's criterion 10 names for removal rather than compatibility. What the console still did that nothing else
could was inspect: the projected transcript, the run status, and the operator's controls.

At the same time the panel #99 asked for (criterion 9) has to be more than an inspector: connectors, their grants,
their credentials, the roster, hooks and routines, policies, pending approvals and health. Those are the commands'
file writes (`npm run connector`, `integration`, `team`, `token`) with a human in front of them, and they need powers
the console never had. A screen that can administer a deployment is not a chat, and a chat that can administer a
deployment is a screen where one careless keystroke spends a budget or opens a tool.

## Decision

The web application mason serves is an **operator panel**, not an interface: a control plane at `/` and `/admin`, read
and written over `GET /api/admin/state` and the writes beside it, and unable to speak.

- **Four grants, and none implies another.** `conversation` reads the projected transcript and the queue; `trace` reads
  the durable entries as stored; `admin` reads and writes the configuration; `approve` answers the gateway's questions.
  A new device gets `conversation`. The first credential of a fresh home gets `conversation`, `admin` and `approve`,
  because a home nobody can administer is broken. The trace is granted on purpose — it is the model's working notes,
  not the conversation — and there is a test that a device without it is sent no trace key at all, rather than an empty
  one.
- **The projected conversation stays the only reader-shaped view.** `projection.ts` is unchanged and still a whitelist;
  the raw view is a second area of the same answer (`trace.ts`), and the wire never holds a merged version of the two.
- **The panel is served by mason, from mason's own bundle.** It is the operator's view of this deployment, not a
  product, and it does not grow a chat: the only conversation controls it keeps are the two an operator has — stop the
  running turn, compact the context.
- **The console and its contract are deleted, not kept for compatibility.** `src/web/main.tsx`, the Chord browser host,
  `AgentService`, `/api/join` and the browser socket are gone. A browser holds no socket; an upgrade on any path but
  `/api/connector` is closed. The widget card, its sandbox and the markdown renderer survived, because they render what
  the conversation carries rather than who is reading it.
- **The migration is one command, and it is one-way.** `npm run doctor -- migrate` moves a pre-split home as it did,
  and stamps `conversation`, `admin` and `approve` onto every credential that predates grants — what the console could
  do, and never `trace`. It is idempotent, it leaves a narrowed credential alone, and it never runs on boot: a server
  that rewrote the operator's file on start would be a server that edits his home. A boot that finds an ungranted
  credential says so and points at the command.

## Consequences

- **`AgentService` no longer exists.** apiary's integration cannot read the transcript over the console's socket; the
  state it needs is `GET /api/admin/state`, behind a grant, and the versioned contract is `src/shared/admin.ts`. This
  supersedes ADR-0004's "the console's job is to remain a truthful reference implementation of the contract": the
  contract a consumer reads is named in `src/shared/`, and the panel is its one consumer in this tree.
- **Administration and inspection are separable.** A device can watch the room without holding credentials, and a
  laptop can administer without being sent the conversation it is administering. `connector.user.approver` remains the
  separate answer: a person answering from their chat is not a device holding `approve`.
- **An approval is answerable from either place, and settles once.** The panel's `POST /api/permissions/<id>` calls the
  same gateway the connector door does; the first authorized answer wins, a later one is `409`, and neither path may
  invent an "always allow" — that is a policy edit on the connectors page.
- **`integrations.json` is still the boot's.** The panel can edit a connector, its grant, its trigger and its
  credential, and says `restartRequired` when the file and the boot disagree. Tokens, roster names, connector
  credentials and hook switches are read per request (or are process state) and land on the next call, including on the
  device that made the change.
- **The panel has no DOM test.** There is no browser test harness in the repo, which is why `test/panel.test.ts` pins
  the HTTP contract and the Shell was verified by driving a real browser by hand (screenshots in the pull request).

## Alternatives considered

- **Keep the console and add an admin panel beside it.** Two web applications, two contracts and two ways to read the
  same conversation, with the console's socket kept alive for a client the spec says to remove. Rejected because the
  cost is not a page: it is the continued existence of a second conversational contract that every future change has to
  carry.
- **Make the panel a chat with an admin tab.** The operator would be one composer away from speaking as the bot's
  owner from a screen that also holds its credentials. Rejected: the conversation has connectors, which carry the
  attribution, the origin and the delivery that a browser cannot.
- **Read the trace without a separate grant, since the panel is already the owner's.** Rejected by #99's criteria and
  by this repository's own rule that the raw view is server-side by default: the trace is the model's reasoning and
  every tool's arguments, and an owner's phone is not the device that debugs the agent.
- **Give every credential all four grants in the migration.** Simple, and it would make a phone paired to read the room
  an administrator of the deployment. The migration gives what the console gave — conversation, approvals,
  administration — and leaves the trace off, because the console never had one.
