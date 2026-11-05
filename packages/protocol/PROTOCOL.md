# The mason connector protocol, v1

This document and [`schemas/protocol.v1.json`](schemas/protocol.v1.json) are the normative contract for an external
connector. The schema is the machine-readable half: where the two disagree, the schema wins and this file is a bug. A
connector in another language needs nothing else — `mason-connector` is a convenience, not the definition.

A connector is a process, never a page. It may be any combination of three **faces**: it carries people's words
(`user`), it lends tools (`tools`), it reports events (`events`). A calculator has only `tools`; an alarm only `events`; a
chat has all three. Faces are faces of one connector, not three kinds of connector.

## Transport

One WebSocket, opened **by the connector**, carrying JSON-RPC 2.0 in both directions. MCP over Streamable HTTP stays the
tools transport; this socket does not replace it and does not carry tool calls.

| | |
|---|---|
| URL | `<origin>/api/connector` |
| Credential | `Authorization: Bearer <mason-issued connector credential>` on the upgrade request |
| TLS | required outside a trusted local deployment network |
| Framing | one JSON-RPC message per WebSocket text frame |
| Keepalive | `connector/ping` (a request, answered with `{at}`) on an idle socket every 20 s; no message for 60 s closes it |

A second socket for the same connector supersedes the first, and the superseded one is closed with a reason. Reconnecting
is the recovery mechanism for everything: there is no session resumption beyond the sequence numbers below.

The socket is authenticated as the **connector**, independently of the people it carries. A credential is scoped to its
entry's faces and grants, and a revocation takes effect without restarting mason.

## Handshake

The first call on every socket is `mason/hello`. Before it answers, nothing else is accepted.

```json
{"jsonrpc":"2.0","id":"h1","method":"mason/hello","params":{
  "protocol":{"major":1,"minors":[0]},
  "connector":{"name":"telegram","version":"0.2.0"},
  "faces":{"user":{"actors":[{"externalActorId":"8811","displayName":"Denis"}],
                    "conversations":[{"externalConversationId":"-1001234","kind":"room"}],
                    "capabilities":["text","files","approvals"]},
           "tools":{"url":"https://telegram.internal:8082/mcp"},
           "events":{"kinds":["chat.message"]}}}}
```

The answer is the negotiation, and it is the connector's whole view of its own privilege:

```json
{"jsonrpc":"2.0","id":"h1","result":{
  "protocol":{"major":1},
  "connector":"telegram",
  "faces":{"user":{"actors":[{"externalActorId":"8811","displayName":"Denis"}],
                   "conversations":[{"externalConversationId":"-1001234","kind":"room"}],
                   "capabilities":["text","files","approvals"]},
           "tools":{"url":"https://telegram.internal:8082/mcp"},
           "events":{"hooks":{"chat.message":"telegram-message"}}},
  "inactive":[{"face":"events","reason":"the entry declares no trigger"}],
  "capabilities":["text","files","approvals"],
  "commands":["stop","compact","clear","status"],
  "limits":{"submissionsPerMinute":60,"firesPerMinute":6,"controlsPerMinute":6,"attachmentsPerMinute":30,
            "attachmentBytes":26214400,"attachmentTtlMs":86400000}}}
```

Rules that make the handshake a ceiling rather than a wish:

1. **A major mismatch is a refusal**, `mason.protocol_mismatch`, and the socket closes. There is no degraded mode across
   majors.
2. **A face the operator did not grant is inactive, not a failure.** It is named in `inactive` with a reason, because a
   connector silently missing half its behaviour is the bug nobody finds. Declaring a face never activates it.
3. **The control vocabulary is part of the answer.** `commands` is what the operator granted on `mason/control`: absent
   is none, and a word outside it is `mason.invalid_request` — which is how a connector tells a missing permission from a
   typo without spending a call to find out.
4. **A granted face is narrowed to what the operator configured.** `faces.user.actors` comes back holding the one
   advertised actor whose id the entry names as its owner — or empty, when the connector advertised no such id — and
   `faces.events.hooks` is the `kind`→hook map that will fire. Both may be shorter than what the connector advertised.
5. **Capabilities are negotiated separately from grants.** They say what content this connector can render. A grant says
   what it may do. A connector may be granted `user` and still receive no files, because it never claimed `files`.
6. **Unknown fields are ignored on both sides.** Within major 1, additions are the only change there is.

## Submissions and fires are different acts

Both may steer work that is already running. Only one of them creates ordinary human conversation.

### `mason/submit` — a person's words

```json
{"jsonrpc":"2.0","id":"s1","method":"mason/submit","params":{
  "submissionId":"tg-8811-42",
  "origin":{"connector":"telegram","externalConversationId":"-1001234","externalMessageId":"8811",
            "externalActorId":"8811"},
  "actor":{"externalActorId":"8811","displayName":"Denis"},
  "content":[{"type":"text","text":"what is on my calendar"}],
  "mode":"followUp",
  "capabilities":["text","approvals"]}}
```

The result is a durable claim, and `submissionId` is the identity mason deduplicates on **forever**:

```json
{"jsonrpc":"2.0","id":"s1","result":{"accepted":true,"id":"tg-8811-42","entryId":"e-14"}}
```

- A resend of a claimed `submissionId` answers `{"accepted":true,"id":"tg-8811-42","duplicate":true}` and creates no
  second operation. The connector may retry freely until it has an answer; it may not invent a new id for the same act.
- `actor` must be the one actor the entry names as its owner. Any other is refused (`mason.actor_unknown`), and so is
  any actor when the entry names no owner. A submission with **no** actor is accepted: it is a message nobody signed.
- `origin.externalConversationId` must be in the granted list (`mason.conversation_not_permitted` otherwise).
- `approver` is accepted for compatibility and has no effect: there is no approval step in this build, so there is no
  per-actor approver to claim.
- Content is typed blocks. A `file` block names a `contentId` obtained from the transfer endpoint; never a path, never
  base64. The transfer is one way: mason reads the bytes itself and never asks a connector for them back.

### `mason/fire` — an unsolicited service event

```json
{"jsonrpc":"2.0","id":"f1","method":"mason/fire","params":{
  "fireId":"alarm-77",
  "kind":"alarm.ringing",
  "payload":{"sensor":"hallway","since":"2026-11-02T09:00:00Z"},
  "summary":"hallway smoke alarm"}}
```

- The hook is chosen by the operator's `kind`→hook map, never by the connector. An unmapped `kind` is
  `mason.kind_not_permitted`.
- `payload` is untrusted data. It is handed to the model as data and never becomes an instruction.
- A fire implies **no reader**. If nothing is reachable, mason records the work and reports that nobody was reached; it
  does not claim delivery.

### `mason/control` — the closed vocabulary

`stop`, `compact`, `clear`, `status`, and nothing else. A control never reads anything. `stop` has its own budget so a
connector that spent its fire minute can still stop the turn those fires started. An undeclared op is
`mason.invalid_request` and spends nothing.

## Tools

Tools do not travel on this socket. The `tools` face is an MCP server over Streamable HTTP, which stays MCP because
inventing a transport for the one thing that already has a standard is how a protocol loses its reason to exist. Two
things about it are fixed here, because mason has to act on both.

**Mason connects to it with its own credential.** Direction matters: mason holds a credential the connector issued for
mason's MCP calls, and the connector holds the credential mason issued for this socket. Neither side ever sees the
other's operator credential, and a connector never receives a credential that speaks for a person.

**Every tool declares its approval marker.** In the tool's `_meta`, in mason's namespace:

```json
{"name":"send_message","description":"Send one message to a chat.","inputSchema":{},
 "_meta":{"dev.mason/approval":"required"}}
```

| `dev.mason/approval` | Meaning |
|---|---|
| `required` | mason asks a person before this call runs, unless the call is denied outright |
| `not_required` | the call runs without asking **only** when the operator trusts this connector's markers, or has an allow rule for this tool |

Rules that make the marker worth reading:

1. **Missing, or a value mason does not know, means `required`.** A tool that says nothing about its effects is a tool
   nobody vouched for, and the safe answer to "may this run without asking?" is always no.
2. **The connector author writes it**, because that service knows what the operation does. Mason does not infer risk from
   a tool's name.
3. **MCP's own annotations are not authority.** `readOnlyHint` and `destructiveHint` are claims a server makes about
   itself; trusting them is a decision only an operator may make, and this marker is the claim they decide about.
4. **Markers are static per tool.** An operation whose risk depends on its arguments is two tools.
5. **Live, not frozen.** Mason discovers the current catalog through codemode, and a tool that disappears or is
   redefined rejects a later call with a rediscovery instruction rather than running against a stale schema.

Nine out of ten tools are `required` in practice: a send, a write, a delete, anything that leaves the process. The one
that is not is the read you would let a stranger run.

## Replies

Mason routes a reply; the model never names a vendor's tool. A reply targets the submission's origin, or an explicit
proactive target, and it is sent as **one logical delivery** with one `deliveryId`.

| Method | Kind | When |
|---|---|---|
| `connector/delivery.start` | notification | first frame of a streaming reply |
| `connector/delivery.delta` | notification | more of the same reply |
| `connector/delivery.final` | **request** | the reply, and its acknowledgement is what mason records |
| `connector/delivery.cancel` | notification | the delivery is withdrawn before it was final |

- `start`/`delta` are only sent to an origin that claimed `streaming`. Everybody else receives `final` alone, under the
  same `deliveryId` a streaming origin would have seen. Delivery identity never changes with capability.
- v1 has no delivery fan-out.

The answer to `delivery.final` is a `deliveryAck`:

| `status` | Meaning | Mason does |
|---|---|---|
| `delivered` | the medium accepted it | records the delivery as done |
| `duplicate` | this `deliveryId` was already delivered | records the delivery as done, once |
| `uncertain` | the vendor may or may not have accepted it; `detail` says what could not be known | records an uncertain outcome and **does not retry** |
| `rejected` | it was refused and was not sent; `detail` says why | records the refusal |

`uncertain` is the honest report of a lost acknowledgement. A connector that retries a send it is unsure about produces a
duplicate message; a connector that reports `uncertain` produces one message and one visible question.

An unacknowledged `delivery.final` is resent after reconnect, in `seq` order, with the same `deliveryId`. The connector
answers it from its own record, and never by sending again:

- a delivery it already sent is `duplicate`;
- a delivery whose outcome it could not know is **`uncertain` again**, not `duplicate`.

That second line matters. Answering `duplicate` for a send that may never have left lets mason record a delivery nobody
received, and a person who was never told anything is the worst outcome the whole arrangement exists to avoid.

## Interactions

The approval half of v1 is **inert in this build**. `connector/interaction.request` and `mason/interaction.answer` are
still reserved method names, so a connector that implements them compiles and runs, but no version of mason sends or
answers one: what a service may do is the credential it holds, and there is no paused-call question to answer. A
connector may advertise the `approvals` capability; nothing acts on it.

## Attachments

Bytes cross through authenticated HTTP, referenced by content id. A shared filesystem path is not a remote protocol, and
inline binary does not belong in a JSON-RPC frame.

| | |
|---|---|
| `POST /api/connector/attachments` | raw body, `content-type` and `x-mason-filename` headers → `{contentId, size, expiresAt}` |
| Cap | `limits.attachmentBytes`, `413` above it |
| Expiry | `limits.attachmentTtlMs`; the submission that names a stale id says the file is gone |

The transfer is one way. A content id is scoped to the connector that uploaded it, and mason reads the bytes itself when a
submission names one: nothing serves them back to a connector, and no connector ever needs a download.

## Errors

A JSON-RPC error's `data` is a `ProtocolErrorData`: a stable `code`, a sentence, and whether it is worth retrying.

```json
{"jsonrpc":"2.0","id":"s2","error":{"code":-32000,"message":"rate limited",
  "data":{"code":"mason.rate_limited","message":"60 submissions a minute","retryable":true,"retryAfterMs":1200}}}
```

| `code` | Retryable | When |
|---|---|---|
| `mason.protocol_mismatch` | no | the majors differ |
| `mason.face_not_granted` | no | a call uses a face the entry does not grant |
| `mason.actor_unknown` | no | an actor that is not the entry's owner, or any actor when it names none |
| `mason.conversation_not_permitted` | no | an origin outside the granted list |
| `mason.kind_not_permitted` | no | a fire `kind` the entry does not map |
| `mason.rate_limited` | yes, after `retryAfterMs` | the class budget is spent |
| `mason.queue_overflow` | yes, after `retryAfterMs` | mason's queue is full |
| `mason.invalid_request` | no | a malformed or unknown field |
| `mason.not_authenticated` | no | a bad or revoked credential |
| `mason.unknown_permission` | no | an answer to a request that does not exist |
| `mason.internal` | depends | mason failed; the sentence says what |

## The conformance suite

A connector is conformant when the published suite passes against it. It ships with `mason-connector` as
`mason-connector/testkit` — a fake mason that enforces this document rather than agreeing with everything — and it runs
in a connector's own repository, with no path into mason's source:

```ts
const result = await runConformance({ name: "telegram", faces, handlers });
```

The fixtures that prove the suite itself are a tools-only connector, an events-only one, and a full user one, because the
three shapes exercise different halves of what is above.

## Delivery guarantees, stated honestly

The transport is **at-least-once with durable identity**, and mason does not claim more:

- An inbound submission or fire is acknowledged only **after** its durable claim, so a lost acknowledgement means a
  resend, and a resend is deduplicated on the id.
- An outbound delivery is committed to a durable outbox before it is sent, resent after reconnect, and deduplicated by the
  connector on `deliveryId`.
- Where the vendor's outcome cannot be known, the connector says `uncertain` and mason records a question instead of
  retrying into a duplicate.

That is the whole promise. Two processes that both restart between the same two moments cannot be told apart from a
message that never arrived, and pretending otherwise is how a person gets the same message three times.

## Budgets

Every class is budgeted separately per connector, so a flood in one cannot starve the others: submissions, fires,
controls, attachments. `stop` has its own budget beside the controls. A refusal is `mason.rate_limited` with
`retryAfterMs`, and the connector waits that long, capped at a minute so one wrong number cannot park a message for an
hour — a wait, not a verdict.

## Versioning

`protocol.major` is negotiated once per socket; `minors` are additive and negotiated to the highest shared value. Within
major 1 the only allowed change is a new optional field or a new enum member a receiver may ignore, and an unknown field
is always ignored. Anything else is major 2.

The SDK's own version is not the protocol's version. A connector pins `mason-connector` for its ergonomics and pins
`protocol.major` for its wire compatibility, and the two move independently.
