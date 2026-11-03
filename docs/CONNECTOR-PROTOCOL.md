# The connector contract

The normative contract is **[`packages/protocol/PROTOCOL.md`](../packages/protocol/PROTOCOL.md)** beside the JSON Schema
it describes ([`protocol.v1.json`](../packages/protocol/schemas/protocol.v1.json)). That document ships in the npm package
on purpose: a connector author installs it, reads it, and needs nothing from this repository.

This file used to hold a proposed contract — events over an HMAC door, tools over MCP, replies through a vendor tool named
on the entry, no submissions and no approvals. That proposal is superseded, and so is the HMAC door itself: it was removed
in #104, along with the trigger face, the vendor-aware delivery path and the boot-frozen MCP registration. Do not write a
connector against either, and do not keep a second copy of the rules here: two documents that both claim to be the
contract is how they start disagreeing.

## Where the decision lives

- [`adr/0006-connectors-are-full-duplex-peers.md`](adr/0006-connectors-are-full-duplex-peers.md) — a connector is a
  process and mason is the only thing in the middle. The reply router, the capability-scoped state subscription and the
  credential follow from it.
- [`adr/0003-integrations-are-services.md`](adr/0003-integrations-are-services.md) — superseded where it says an
  integration has exactly two faces; a connector now has up to three, and `events` is one of them.
- Issue #99 on this repository — the cutover that replaces the integration layer, of which the protocol and the SDK are
  the first slice. The operator panel is the last: [`adr/0011-the-panel-is-a-control-plane.md`](adr/0011-the-panel-is-a-control-plane.md)
  replaced the console with a control plane that cannot speak.

## What exists today

| | |
|---|---|
| Protocol v1: schema, prose, error codes | `packages/protocol` |
| SDK: socket, journal, dedup ledger, attachments, MCP marker | `packages/connector` |
| Conformance suite and fake mason | `packages/connector/testkit` |
| Three fixtures proving the suite (tools-only, events-only, full) | `packages/connector/test` |
| Proof that the packed artifact works outside this repository | `npm run prove:connector` |

| | |
|---|---|
| Mason's server speaking this protocol | `src/server/connector.ts`: the socket, admission, the state mirrors, the reply outbox, attachments and budgets (`docs/SPEC.md` §4.1d) |
| The grant and the credential | the entry's `connector` block in `service/integrations.json`; `npm run connector -- add <name>` mints the credential |
| What mason enforces, and what is pinned | `docs/SPEC.md` §4.1d; `test/connector*.test.ts` |
| Telegram as an external process on the SDK | `github.com/DenisSud/mason-telegram` (`#104`) — text, files, replies, approvals, a tools face |
| A minimal Slack as an external process on the SDK | `github.com/DenisSud/mason-slack` (`#104`) — text, replies, approvals; no files, widgets or streaming |
| The permission gateway and the live tool catalog | `src/server/permissions.ts`, `src/server/mcp.ts`; `docs/SPEC.md` §4.1e |
| The panel and the one-way migration | in (`#103`, ADR-0011) |
| Removal of the HMAC event door and the in-repository Telegram relay | in (`#104`) — `POST /api/events/<name>`, the trigger face, the vendor delivery path |

A connector can connect, submit words, fire events, subscribe to the state its entry grants, receive replies, move files
and answer permission requests. There is one way in: this socket. The signed event door is gone, an entry that still names
a `trigger` refuses the boot and `npm run doctor -- migrate` removes the key, and nothing in this build speaks the old
envelope.
