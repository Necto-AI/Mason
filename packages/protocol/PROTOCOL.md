# The connector contract, v1

A connector is a [Chord](https://github.com/earendil-works/pi) host. It opens one WebSocket to mason and everything
after that is two contracts, defined in [`src/index.ts`](src/index.ts). Nothing in this document is a frame: the wire is
Chord's, and a peer that speaks Chord speaks this.

## The two contracts

`mason.peer`, served by mason at the host `mason`. A connector reaches it and:

| member | what it does |
|---|---|
| state `session` | the handshake: this connector's commands, targets, granted kinds and budgets |
| `append(append)` | hands mason one of three things: a person's words, an event, or a notice |
| `control(op)` | spends one control out of the `session.commands` vocabulary |

`mason.connector`, served by the connector at the host `connector:<name>`. Mason reaches it and calls exactly one method:

| member | what it does |
|---|---|
| `deliver(delivery)` | sends one message to one address; the return value is the acknowledgement |

There is no third contract and no method registry. A peer may call what the contract declares.

## The ten rules

1. **One socket, one connector.** The credential stamps it; nothing on the socket may name another.
2. **Mason routes; the connector points.** No vendor tool, no other connector, no other target.
3. **Inbound is an append at the edge:** `submission`, `event`, `notice`. Never an assistant message, a tool result, a
   delivery, a reply or a compaction.
4. **The type is the trust contract.** A `submission` is a person's words; an `event` is a claim, fenced, never an
   instruction; a `notice` starts nothing.
5. **Every append carries an id, deduped forever. Every delivery carries an id and is acknowledged.** `uncertain` is
   never retried.
6. **An address is opaque:** connector-minted, returned byte for byte, never parsed. A delivery with no address goes to
   the connector's default.
7. **Targets live in mason's grant file, not on the socket.** The session confirms them; the set cannot change without a
   restart.
8. **Mason's prompt names every addressable thing.** A name that stops resolving fails at delivery with a sentence,
   never silently.
9. **Within major 1, additions only.** Unknown fields are ignored on both sides: every object in the contract is `open`.
10. **Nothing crosses the wire that the projection does not name.**

## Addresses

Two kinds, and they are not the same thing:

- A **target** is one place a connector may be sent to, declared by the operator in the entry's `connector.targets`. The
  model names one as `<connector>/<target>`, and a delivery carries `target: "<target>"`.
- A **ref** is an opaque address the connector minted on an append and put in `origin.ref`. Mason stores it in the
  transcript and returns it as `ref` on the delivery that answers that append. Mason never parses it.

A delivery with neither goes to whatever the connector treats as its default.

An events-only connector can therefore raise an alert with an `origin` and be answered, which is the whole reason the
two inbound methods became one append.

## Acknowledgements

`deliver` returns one of four statuses:

| status | meaning | may mason resend? |
|---|---|---|
| `delivered` | the medium has it | no |
| `duplicate` | it already had it under this id | no |
| `uncertain` | it may have left, and nobody can tell | no — a person decides |
| `rejected` | it definitively did not leave | a later turn may try again |

Mason resends an unacknowledged delivery under the same `deliveryId` after a reconnect. A connector keeps a ledger of
every id it answered, in its own store, because the restart that loses the answer is the restart that would lose a
`Map`.

## Errors

A refusal is a Chord error whose `reason` is one of mason's codes. Chord carries `code`, `message` and `reason` across a
link and drops everything else, which is why the code rides in `reason` and why nothing branches on `details`.

| code | meaning |
|---|---|
| `mason.face_not_granted` | this entry does not grant the face the append needs |
| `mason.actor_unknown` | the actor is not the one person this bot works for |
| `mason.kind_not_permitted` | the kind is not in this entry's grant |
| `mason.target_unknown` | the address is not one this connector's grant lists |
| `mason.rate_limited` | the minute's budget for this class is spent; try later |
| `mason.queue_overflow` | the turn is busy and the append asked to be refused rather than queued |
| `mason.invalid_request` | the call is not a call this side makes |
| `mason.not_authenticated` | the credential did not open the socket |

## Attachments

Bytes never cross the contract. A connector `POST`s them to `/api/connector/attachments` with its own credential, gets a
`contentId` back, and references that id in a `file` block. The cap and the expiry are in `session.limits`.

## Versioning

The contract names carry no version suffix. Chord's own `version` field on each contract is the number that changes, and
a provider that breaks a consumer must declare an adapter. Within major 1 the envelope only grows: a field added is a
field a peer ignores, and every object here has `additionalProperties: true` for exactly that reason.

## What an SDK has to implement

A connector in another language needs Chord's link protocol — `hello`, `hold`, `shape`, `unit`, `call`, `result`, `ack`,
`ping`, `bye` — and nothing else. `packages/connector/WIRE.md` records the subset.
