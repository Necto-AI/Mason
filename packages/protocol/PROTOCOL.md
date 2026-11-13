# The connector contract, v1

A connector is a [Chord](https://github.com/earendil-works/pi) host. It opens one WebSocket to mason and everything
after that is two contracts, defined in [`src/index.ts`](src/index.ts). Nothing in this document is a frame: the wire is
Chord's, and a peer that speaks Chord speaks this.

## The two contracts

`mason.peer`, served by mason at the host `mason`. A connector reaches it and:

| member | what it does |
|---|---|
| state `session` | the handshake: this connector's commands, granted kinds and budgets |
| state `conversation` | the conversation a person reads — transcript rows, queue, run status — with its revision and diffs |
| `append(append)` | hands mason one of three things: a person's words, an event, or a notice |
| `control(op)` | spends one control out of the `session.commands` vocabulary |

`mason.connector`, served by the connector at the host `connector:<name>`. Mason reaches it and calls exactly one method:

| member | what it does |
|---|---|
| `deliver(delivery)` | sends one message to one address; the return value is the acknowledgement |

There is no third contract and no method registry. A peer may call what the contract declares.

## The conversation

`conversation` is mason's read model as one state member: what a chat window renders, and nothing the model wrote for
itself. Chord carries it — a snapshot when the member is first held and after a reconnect, then diffs, which is why the
protocol has no envelope, no sequence number and no cursor of its own.

| field | what it is |
|---|---|
| `revision` | a counter mason owns: it rises by one for every published value within one mason process, and starts again at 0 when mason restarts |
| `transcript` | the reader's rows, in order: `user`, `delivered` (a message, `streaming` while the model writes it), `event`, `notice` |
| `queue` | the submissions waiting behind the running turn, each with `withdrawable` |
| `run` | one token: `idle`, `generating`, `running_tools`, `retrying`, `compacting` |
| `busy` | whether a turn is running; `activeRunTaskId` names it when it is |
| `transitions` | the transitions that produced *this* revision, and no others: `message.committed`, `run.started`, `run.stopped`, `run.errored`, `queue.added`, `queue.withdrawn` |

A `delivered` row streams under the id the committed row carries, so a message a person watches arrive becomes the row
it settles into: one message, one id, one row. A revision that reports nothing carries an empty `transitions`; a snapshot
describes the revision it is, never a history to replay.

Two frames carry this member: a snapshot, and the diffs that follow it. A snapshot is authoritative — a client applies
the one it is handed, whatever revision it carries. A diff is applied to what the client holds and kept only when its
revision is greater than the held one; a diff that is not greater is one already applied, and dropping it is what makes a
reconnect safe. The counter is mason's and process-scoped: it starts again at 0 with every mason process, so a restarted
mason hands a client holding revision 42 a snapshot at revision 1, and the snapshot is the frame that wins.

Chord 1 has no event member on a contract, so a transition reaches a client as the state member's frame for its
revision rather than as a frame of its own. What the client is promised is the kind and its subject — a row id, a run
task id or a queue id — so it reacts to what happened without re-deriving the transcript to find out.

## The ten rules

1. **One socket, one connector.** The credential stamps it; nothing on the socket may name another.
2. **Mason routes; the connector points.** No vendor tool, no other connector, no address of the model's own.
3. **Inbound is an append at the edge:** `submission`, `event`, `notice`. Never an assistant message, a tool result, a
   delivery, a reply or a compaction.
4. **The type is the trust contract.** A `submission` is a person's words; an `event` is a claim, fenced, never an
   instruction; a `notice` starts nothing.
5. **Every append carries an id, deduped forever. Every delivery carries an id and is acknowledged.** `uncertain` is
   never retried.
6. **An address is opaque:** connector-minted, returned byte for byte, never parsed. A delivery with no address goes to
   the connector's default.
7. **One person, one surface.** At most one enabled connector holds the `user` face; mason refuses the boot of a
   deployment that grants it to two, and the refusal names the rule.
8. **An answer goes back where the words came from.** A delivery carries the `ref` the turn's append carried, and no
   other address exists: no grant, no prompt and no model names one.
9. **Within major 1, additions only.** Unknown fields are ignored on both sides: every object in the contract is `open`.
10. **Nothing crosses the wire that the projection does not name.**

## Addresses

There is one kind:

- A **ref** is an opaque address the connector minted on an append and put in `origin.ref`. Mason stores it in the
  transcript and returns it as `ref` on the delivery that answers that append. Mason never parses it.

A delivery with no `ref` goes to whatever the connector treats as its default. There is no second address and no
`target` field: the turn's origin is the only destination an answer has.

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

One credential opens everything and a failed check is not a code on this socket: an upgrade it does not open is a
connection closed with a reason, refused before any contract is served. The table below is what a call that was heard is
refused with; `mason.not_authenticated` is the answer of the one HTTP path, the attachment upload, which has a status
line to put it in.

| code | meaning |
|---|---|
| `mason.face_not_granted` | this entry does not grant the face the append needs |
| `mason.actor_unknown` | the actor is not the one person this bot works for |
| `mason.kind_not_permitted` | the kind is not in this entry's grant |
| `mason.rate_limited` | the minute's budget for this class is spent; try later |
| `mason.queue_overflow` | the turn is busy and the append asked to be refused rather than queued |
| `mason.invalid_request` | the call is not a call this side makes |
| `mason.not_authenticated` | the credential did not open the attachment upload |
| `mason.internal` | mason itself failed, and not on the caller's account: the same call may work on a retry |

## Attachments

Bytes never cross the contract. A connector `POST`s them to `/api/connector/attachments` with its own credential, gets a
`contentId` back, and references that id in a `file` block. The cap and the expiry are in `session.limits`.

## Versioning

The contract names carry no version suffix. Chord's own `version` field on each contract is the number that changes, and
a provider that breaks a consumer must declare an adapter. Within major 1 the envelope only grows: a field added is a
field a peer ignores, and every object here has `additionalProperties: true` for exactly that reason. A field may also
be retired inside major 1 for the same reason: an open object binds whether or not it carries one, so a deployed
connector keeps working with `session.targets` and `delivery.target` gone and simply reads no targets. Major 1 stays the
version (#200); a bump would refuse every connector already deployed to remove two fields nobody has to bind.

A **member** may be added inside major 1 as well, and `conversation` is the first one: binding is directional, so a
provider has to cover what its consumer names and is free to offer more. A connector deployed before the member existed
names `session`, `append` and `control`, and those are what it is served; it receives no `conversation` frames at all,
because Chord streams only the members a consumer's own contract declares. The compatibility test in `test/` freezes the
description such a connector holds and binds it to the served contract, which is the proof rather than the promise.

## What an SDK has to implement

A connector in another language needs Chord's link protocol — `hello`, `hold`, `shape`, `unit`, `call`, `result`, `ack`,
`ping`, `bye` — and nothing else. `packages/connector/WIRE.md` records the subset.
