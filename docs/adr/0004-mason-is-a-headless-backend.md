# mason is a headless backend; interfaces attach to it

**Status:** Accepted

**Date:** 2026-10-26

**Revisited if:** a contract here cannot carry the interface it has to — an interface that needs a route, a table, a
prompt section or an entry kind of its own — or if mason is asked to own a client again.

mason is one bot for one person and a small room on one host: one identity, one home, one conversation, one set of
tools (`docs/adr/0001-mason-defines-one-bot.md`). The thing worth building here is not a screen. It is a durable,
always-on engine plus a small set of deliberate contracts that anything can speak to — a signed event in, a
delivery and a transcript out, a control plane, an identity, a version — and an interface is a thing that attaches to
those contracts and can be replaced without the backend noticing. Everything in the repository is sized for that: a
home split across the server and the tool machine, a roster of the names a person may speak as, mapped by whichever
interface the person is using, hooks that wake the bot, one delivery that is two writes today and not yet one path. For
a while the largest thing in it was a client instead: a React application that speaks Chord,
paired by token, held by a session cookie, gated by `Origin`, with a roll-up of run state, a composer that steers, a
widget sandbox built on an iframe bridge and a dictation service of its own — written by the bot's own project, one
feature at a time, while the approval of what the bot may do had not been built at all, and the security boundary, the
attribution of what a person says and the durability of what it remembers had been exercised by tests more than by
use. A backend is judged by its contracts and their guarantees, not by a screen it happens to own.

Telegram is therefore the first interface, and the cheapest way to test the backend in the place the person actually
is. It costs mason no ingress at all: an integration's trigger posts an event to the door inside the compose network
(`docs/adr/0003-integrations-are-services.md`), the HMAC proves the sender, and the answer leaves through the same
integration's tool surface. Nothing is published, no certificate is terminated, no reverse proxy sits in the path, no
browser has to be paired and no session has to be kept. Notifications and mobile reach arrive with an application the
room already carries in a pocket, so a proactive turn is read on a phone at the hour it happens rather than in a tab
nobody opened. The place is also the test: an answer is read in the chat it will be read in, by the person it was
written for, which is a stronger check of the delivery contract than a transcript rendered on the machine that
produced it.

What it costs is real, and it is what the first interface cannot exercise. Telegram is a third party in the path and,
on this host, a third party behind a VPN: the chat is unreachable when the tunnel is down, and the interface goes down
with it. There is no streaming — a message arrives whole, so the working line, the fading tail and steering a turn
mid-thought have no surface, and a long turn is silence until it is not. There are no widgets: `generateSandboxedUi`
output needs a sandbox and a viewport, and a chat has neither. There is no composer, so there is no dictation, though
`asr/` exists for exactly that button. An approval has to fit in a chat — a question and a few buttons, not a form —
and the answer has to be recorded rather than merely said. And every answer becomes a message in somebody else's
history, in an application that is not ours to keep. A chat is a demanding and narrow consumer of the contract, which
is why it is a good first one: whatever survives it is a contract, not a chat feature.

The web client is kept, frozen, as the reference operator console. It is the only way to see a transcript as the
reader would have been sent it, entry by entry, which is what a projection bug and a delivery that half-worked are
debugged with; it is the fallback when the tunnel is down and the chat is gone; it keeps `projection.ts` and the Chord
contract exercised continuously, in `test/projection.test.ts` and `test/chord-e2e.test.ts`; and it is the one worked
example of the contract's consumer side that apiary can read. Freezing it loses nothing that a maintenance fix cannot
restore, and keeping it costs a page that does not change.

## Decision

mason is a headless, always-on agent backend: a durable agent engine plus a small set of deliberate contracts that
interfaces attach to. Telegram is the first interface and the cheapest way to test those contracts, not the definition
of the product. apiary is the intended rich client and the multi-agent future; it integrates with mason as a backend
rather than replacing it, and it will depend on the contract — so the contract, not the chat, is what mason invests
in. The web client in this repository is frozen as a reference operator console: transcript inspection, debugging and
a fallback when Telegram or the tunnel is down, maintenance fixes only and no features. Every interface is an
integration — a signed trigger in, a tool surface out — and none of them, Telegram included, is a privileged code
path. The decision is written about the backend and not about Telegram on purpose: the interface is the part expected
to change, so the day this repository has no Telegram in it, this still holds.

## Consequences

- **The inbound contract is a product surface.** One door per integration, `POST /api/events/<integration>`, an HMAC
  over the raw body, one `v1` envelope with a stable id, an optional `actor`, a 256 KiB cap and its own budget of six
  events a minute. A new interface is written by producing envelopes and naming the hook they fire; the mason-side
  change it may need is a hook, never a route.
- **The outbound contract is one delivery, not yet one path.** `send_to_user` recorded in the transcript is what
  reaches a person — `src/server/extensions/delivery.ts:2-16` performs no side effect at all: delivery is the call
  being committed — and the three projected cells are what a client is sent. Those are two halves of one guarantee,
  and today they are two writes: the chat is written to by the integration's own `send_message`
  (`integrations/telegram/src/mcp.ts:4`), the transcript by `send_to_user`, and nothing joins them. Reconciling them
  into one act — the message that reaches the person being the message the projection records — is work this
  decision owes, not an implementation detail.
- **The control contract is what an interface drives.** `submit`, `withdrawSubmission`, `abort`, `reset`, `compact`,
  `fireHook` and `toggleHook` exist at `AgentService` version 1 (`src/shared/contract.ts:171-209`). The conversation's
  lifetime, routines as hooks on a schedule, approvals answered by a press that becomes a recorded event, and memory a
  person can inspect are each a contract surface this decision puts before anything a client can see, and each is
  named here rather than built in a chat, with the roadmap carrying the specification (B1-1, B1-2, B1-5,
  `docs/research/openbot/13-parity-roadmap.md`). What is still owed is routines, approvals, memory, and the outbound
  contract's reconciliation above.
- **Identity and attribution are contract, not client.** The roster is the names a person may speak as, mapped by
  whichever interface the person is using; mason has to own that mapping rather than infer it from a payload. The
  envelope's optional `actor` is that mapping's input and never its answer: it is an assertion by the integration that
  signs the body, and it grants nothing — an id the roster does not know is recorded as `unattributed` rather than
  obeyed. The field is specified, not yet read: `src/server/events.ts` reads `{ v, id, kind, payload }` and ignores the
  rest, so a sender that includes an `actor` today is ignored harmlessly, and roadmap A0-3 adds it as an additive `v1`
  field recorded in the fire entry. What arrives from Telegram today is a display name and a handle, which is a hint,
  not a person — apiary will need the mapping to be an answer.
- **Observability is part of the contract.** A fire, a turn, a delivery and a refusal each leave a fact — in the
  transcript, in `/api/status`, in `/api/integrations`, in the `[cache]` line and in the log. An operator reading a
  console and an operator reading a chat must be able to get the same answers, or the backend is only observable
  through one of its interfaces.
- **The versioning policy is explicit because a consumer lives outside this repository.** Within a version, changes
  are additive: the event envelope stays `v1`, `AgentService` stays at its version, and the projected cells gain
  fields rather than changing shape. An optional field added to an envelope — `actor` is the first — is an additive
  change to `v1`, not a `v2`: an older reader already ignores a key it does not know and an older sender simply omits
  it, so nothing has to move at once. Anything that is incompatible is a new version, `v2`, with a deprecation window,
  decided here and not negotiated by whichever client notices first, and `v1` is read forever. Nothing is deleted
  because no client in the tree still reads it.
- **The guarantees are the fundamentals: idempotency, attribution, no loss, recovery.** An event id makes a redelivery
  the same fire; a person's words carry a person's name; a fire is a fact in the transcript whatever became of the
  answer; a restore leaves a home a client still opens. These are the things the investment goes into, and each is
  testable without an interface in front of it.
- **Interfaces stay integrations, and the allowed suite is one hook wide.** No Telegram — or apiary — module in
  `src/`, no per-interface table, route, prompt section or entry kind; an interface enters through the event door and
  leaves through a tool on its own MCP endpoint. What an interface may have here is a container, one
  `integrations.json` entry, one trigger secret and one hook — the hook's `promptTemplate` is where interface-specific
  prompt text belongs, because a prompt has to name the tool the answer leaves through: the built-in `team-chat` hook
  names `mcp__telegram__send_message` (`src/server/hooks.ts:390-401`), and it is the one place in `src/` where an
  interface's name appears. This amends ADR-0003's artefact list, which named a container, a config entry and a secret
  as the whole of it. If a requirement cannot be met that way, the requirement is reconsidered before the pattern is
  broken.
- **The backend degrades; it does not go down with an interface.** A hook still runs when the tunnel is down or a
  container is stopped, a message the container cannot relay is retried rather than dropped, and "the interface is
  unreachable" is a state the backend can be asked about rather than a reason it is absent.
- **No new client features land in mason.** The console receives maintenance fixes only: no new surface, no new widget
  capability, no new conversational gesture. A client feature proposed here is apiary's, and this repository is not
  where it is built. The console's job is to remain a truthful reference implementation of the contract.
- **apiary integrates; it does not replace, and it does not rewrite what the freeze protects.** apiary adds bots,
  clients and orchestration above this backend and reads the transcript through the wire contract mason defines. A
  change that would break that contract for a consumer outside the tree is a change apiary makes in apiary, or a new
  version agreed here.

## Alternatives considered

- **Treat Telegram as the product definition: "the Telegram bot".** The interface would then own the vocabulary, and
  every contract decision would be made against one vendor's shape — no streaming, no widgets, no approvals beyond a
  button row. Telegram is the first consumer of the contract and the cheapest way to test it; it is not its author.
- **Ship both a first-class backend and a first-class client.** Two things finished halfway: the client remains the
  larger half of the repository, as it was, and the contracts apiary will depend on stay unversioned and implicit.
- **Delete the web client.** Clean, and it would remove the only worked example of a consumer, the last thing that
  keeps `projection.ts` and the Chord path exercised, and any way to read a transcript when the tunnel is down.
- **Wait for apiary's client before writing the contracts down.** The contracts already exist in code and are already
  being consumed; leaving them implicit means apiary discovers them by breaking them, and mason discovers the break in
  production.
- **Make Telegram an interface implemented in the server rather than an integration.** A native adapter per
  interface, in server code, with its credential and its protocol in the trusted process — the opposite of
  `docs/adr/0003-integrations-are-services.md`, and the beginning of an interface-shaped backend.
- **Bring multi-bot to mason now.** Refused by `docs/adr/0001-mason-defines-one-bot.md`, and refused again here for a
  second reason: a team of bots behind a backend whose contracts are still implicit is two unfinished things instead of
  one sound one.
