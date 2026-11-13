# `mason-protocol`

The mason connector protocol, major 1: one Chord contract, and the shapes it carries.

- [`PROTOCOL.md`](PROTOCOL.md) is the prose: the ten rules, the contract and its two states, the origin, the errors.
- `src/index.ts` is the contract itself — `mason.peer` — plus the constants every implementation would otherwise
  hard-code differently: the host names, the error codes, the approval metadata key.

There is no JSON Schema any more. Chord validates what a contract declares, so the contract *is* the schema, and a second
copy of it would be a document that starts disagreeing with the one the runtime enforces.

```ts
import { CONTRACT, MasonPeer, ERROR_CODE, connectorHost } from "mason-protocol";
```

Mason serves `mason.peer`; a connector reaches it and has nothing of its own to serve. Installing this package is what a
connector does to know what it is talking to. The SDK is separate: [`mason-connector`](../connector) adds the host, the
journal, the conversation it holds, attachments, and the conformance suite. Pinning `PROTOCOL_MAJOR` and pinning the SDK
version are two different decisions, and the two move independently.
