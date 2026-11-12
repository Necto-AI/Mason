# `mason-protocol`

The mason connector protocol, major 1: two Chord contracts, and the shapes they carry.

- [`PROTOCOL.md`](PROTOCOL.md) is the prose: the ten rules, the two contracts, addresses, acknowledgements, errors.
- `src/index.ts` is the contracts themselves — `mason.peer` and `mason.connector` — plus the constants every
  implementation would otherwise hard-code differently: the host names, the error codes, the approval metadata key.

There is no JSON Schema any more. Chord validates what a contract declares, so the contract *is* the schema, and a second
copy of it would be a document that starts disagreeing with the one the runtime enforces.

```ts
import { CONTRACT, MasonPeer, MasonConnector, ERROR_CODE, connectorHost } from "mason-protocol";
```

Installing this package is what a connector does to know what it is talking to. The SDK is separate:
[`mason-connector`](../connector) adds the host, the journal, the delivery ledger, attachments, and the conformance
suite. Pinning `PROTOCOL_MAJOR` and pinning the SDK version are two different decisions, and the two move independently.
