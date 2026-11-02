# The connector contract

The normative contract is **[`packages/protocol/PROTOCOL.md`](../packages/protocol/PROTOCOL.md)** beside the JSON Schema
it describes ([`protocol.v1.json`](../packages/protocol/schemas/protocol.v1.json)). That document ships in the npm package
on purpose: a connector author installs it, reads it, and needs nothing from this repository.

This file used to hold a proposed contract — events over an HMAC door, tools over MCP, replies through a vendor tool named
on the entry, no submissions and no approvals. That proposal is superseded. Do not write a connector against it, and do
not keep a second copy of the rules here: two documents that both claim to be the contract is how they start disagreeing.

## Where the decision lives

- [`adr/0006-connectors-are-full-duplex-peers.md`](adr/0006-connectors-are-full-duplex-peers.md) — a connector is a
  process and mason is the only thing in the middle. The reply router, the capability-scoped state subscription and the
  credential follow from it.
- [`adr/0003-integrations-are-services.md`](adr/0003-integrations-are-services.md) — superseded where it says an
  integration has exactly two faces; a connector now has up to three, and `events` is one of them.
- Issue #99 on this repository — the cutover that replaces the integration layer, of which the protocol and the SDK are
  the first slice.

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
| Mason's server speaking this protocol | not yet: the socket, the outbox, live MCP and the permission gateway land next |
| Telegram and Slack as external processes on the SDK | not yet |
| Removal of the HMAC event door and the legacy console socket | not yet |

Until the server speaks it, a connector built on this contract has nothing to connect to. The SDK and the protocol are
published first because every later slice — the server, the admin panel, the two real connectors — is written against
them, and because a contract that two independent implementations have not yet read is a contract nobody has tested.
