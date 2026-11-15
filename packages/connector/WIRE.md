# The Chord frames a connector SDK must implement

The protocol is one Chord contract. Chord's own link protocol is what carries it, and this file is the subset an SDK
in another language has to speak. It is not a second specification: what is written here is what `@earendil-works/chord`
does at `dist/wire.js` and `dist/connection.js`, restricted to the parts a connector meets. If the two ever disagree,
Chord wins and this file is the bug.

Frames are JSON objects with a `t` tag. A payload longer than 64 KiB may arrive deflated as a binary message; an SDK that
does not implement that must say so, because Chord's peer will send it.

## The connection

1. Open the WebSocket at `/api/connector` with `Authorization: Bearer <credential>`. The header is the whole of the
   authentication; there is no token in the URL and no cookie.
2. Send `hello`. The first frame on the link, from both ends.
3. Read frames until `bye` or the socket closes. A close is the end of every hold on the link.

```json
{ "t": "hello", "protocol": 4, "name": "connector:telegram", "kind": "host", "codeVersion": 1, "acks": true }
```

`name` must be `connector:` + the connector's configured name: mason accepted the socket under that name and refuses a
child that announces another. `kind` is `host`. `protocol` is Chord's own version (4 in Chord 1.5). `acks` says this end
counts frames for flow control; mason sends `acks: true` too.

## Reaching an object

A connector holds one object: `mason.peer` on the host `mason`. Holding it is a `hold`; the answer is a `shape` and then
a `unit` carrying the state snapshot. The `conversation` member follows as `state` frames on the same hold.

```json
{ "t": "hold", "id": 1, "at": "mason", "token": { "name": "mason.peer", "scope": "remote", "version": 1, "input": {…}, … }, "principal": … }
{ "t": "shape", "id": 1, "variant": "default", "members": ["append", "control"], "contract": "…", "state": ["session"] }
{ "t": "unit", "id": 1, "values": { "session": { "protocol": 1, "commands": [], "kinds": [], "limits": {…}, "metadata": {…} } } }
```

The `token` is the contract's description, which is what the provider validates against. A connector obtains it from
`mason-protocol`'s exported contract (`MasonPeer.description`), or by importing the same contract in the same language.

`session` is the handshake. Nothing is sent before it arrives, and a reconnect re-holds the object and reads it again. A
connector that has no MCP server may send its integration manifest as `input.metadata`; it is validated and echoed in
`session.metadata`. A grant with a `user` face gets a `conversation` member and its commands; a grant without one gets no
commands, an empty conversation cell and no feed.

## The two clients

`mason-connector` exports one factory per surface, over this one socket and one credential class:

- `createUserClient` — `submit`, `event`, `control`, `onConversation`, attachments. The `user` grant's client.
- `createEventClient` — `event` and `onSession` only. No conversation, no control, no submit, no attachments.

The combined factory is internal: it is what the conformance kit builds, and it is not the public API.

## The conversation

The `conversation` state member is one value with a revision, and it arrives as Chord's `state` frames on the hold that
declared it. Four `as` values, and the client's rule is in the protocol:

```json
{ "t": "state", "hold": 1, "m": "conversation", "as": "snap", "value": { "revision": 1, "transcript": [], … } }
{ "t": "state", "hold": 1, "m": "conversation", "as": "ops", "ops": [[…]] }
```

`snap` is authoritative and replaces what is held, whatever revision it carries. `ops` is a diff: apply it to a copy, keep
the result only when its revision is greater than the one held, and drop it otherwise. `reset` says the value is gone and
the next `snap` replaces it; `error` carries a read failure and no value. Chord carries the delta encoding; a connector
does not build one.

An event client never receives these frames: it does not name the member, and the server serves an entry without a
`user` grant an empty cell and no feed.

## A call

```json
{ "t": "call", "id": 2, "hold": 1, "member": "append", "args": {…}, "root": { "rootId": "…", "codeVersion": 1 } }
{ "t": "result", "id": 2, "value": { "outcome": "accepted" } }
{ "t": "result", "id": 2, "error": { "code": "forbidden", "message": "…", "reason": "mason.kind_not_permitted" } }
```

An error carries `code` (Chord's own, out of a closed set) and `reason` (mason's fine-grained one). Only those two and
`message` survive a link: `retryable` and `details` do not cross, which is why nothing in this protocol relies on them.

A connector serves no object of its own: `mason.peer` is the only contract on the link, and mason calls nothing on the
connector. What a connector has to say it says by calling `append`.

## Flow control

Both ends announce `acks: true` and keep a count:

- a receiver sends `{ "t": "ack", "n": <frames received so far> }` once per burst, after processing the frames;
- a sender counts frames sent and treats an `ack` as cumulative. `n` may never exceed what was sent.

Frames that carry a payload may be sent deflated; a peer that inflates is required to announce it can. A connector may
declare `acks: false` in its hello, and then neither side counts.

## Keepalive

`{ "t": "ping", "n": 1 }` every 15 s, answered with `{ "t": "pong", "n": 1 }`. No frame for 45 s closes the link.

## Ending

`{ "t": "bye", "reason": "…" }` closes the link. Either end may send it. Everything held through the link is released,
and a connector schedules its reconnect.
