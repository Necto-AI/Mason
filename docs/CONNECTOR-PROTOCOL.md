# The connector contract

The normative contract is **[`packages/protocol/PROTOCOL.md`](../packages/protocol/PROTOCOL.md)**: two
[Chord](https://github.com/earendil-works/pi) contracts, `mason.peer` and `mason.connector`, beside the TypeScript that
defines them. That document ships in the npm package on purpose — a connector author installs it, reads it, and needs
nothing from this repository. [`packages/connector/WIRE.md`](../packages/connector/WIRE.md) is the frame subset for an
SDK in another language.

This file used to hold a proposed contract — events over an HMAC door, tools over MCP, replies through a vendor tool
named on the entry. That is superseded, and so are the hand-written schema and the JSON-RPC envelope that replaced it
(#156): the wire is Chord's, inbound is one append with an optional opaque origin, and an answer is a delivery to an
address. Do not keep a second copy of the rules here: two documents that both claim to be the contract is how they start
disagreeing.

## Where the decision lives

- [`adr/0006-connectors-are-full-duplex-peers.md`](adr/0006-connectors-are-full-duplex-peers.md) — a connector is a
  process and mason is the only thing in the middle. The reply router, the capability ceiling and the credential follow
  from it.
- [`adr/0003-integrations-are-services.md`](adr/0003-integrations-are-services.md) — superseded where it says an
  integration is an MCP endpoint and a trigger: an entry holds an `mcp` server, a grant, or both.
- Issue #99 — the cutover this protocol is the first slice of.

## What exists today

| | |
|---|---|
| The contracts, the ten rules, the error codes | `packages/protocol` (`PROTOCOL.md`, `src/index.ts`) |
| SDK: socket, journal, dedup ledger, attachments | `packages/connector` |
| Conformance suite and fake mason (a real Chord host) | `packages/connector/testkit` |
| Three fixtures proving the suite (words, alarms, tools-only) | `packages/connector/test` |
| Proof that the packed artifact works outside this repository | `npm run prove:connector` |

| | |
|---|---|
| Mason's server speaking this protocol | `src/server/connector.ts`: the Chord host, admission, the durable outbox, attachments and budgets |
| The grant and the credential | the entry's `connector` block in `service/integrations.json`; `npm run connector -- add` mints the credential |
| What mason enforces, and what is pinned | `docs/SPEC.md` §4.1d; `test/connector*.test.ts` |
| The console connector, in this repository | `scripts/chat.ts` — `mason chat`, on the same socket as every other connector |
| Telegram as an external process on the SDK | `github.com/DenisSud/mason-telegram` — text, files, an MCP server |
| What the agent is told about a connector | `docs/agent/`, mounted read-only at `/mason/docs` and indexed by the prompt, never pasted into it |

A connector can connect, append words or an event, receive deliveries and move files. One way in: this socket.
