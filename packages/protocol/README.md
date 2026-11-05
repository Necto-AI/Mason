# `mason-protocol`

The mason connector protocol, major 1: the normative wire contract between mason and an external connector.

- [`schemas/protocol.v1.json`](schemas/protocol.v1.json) is the contract. It is one self-contained JSON Schema document
  (draft 2020-12), with a `$defs` entry per message. A connector in any language is written against that file.
- [`PROTOCOL.md`](PROTOCOL.md) is the prose that makes the schema readable: transport, handshake, the split between a
  person's words and a service event, delivery and its honest guarantees, approvals, state, attachments, errors.
- This package's TypeScript exports are the same shapes spelled for TS, plus the constants every implementation would
  otherwise hard-code differently: the major version, the method names, the error codes, the approval metadata key.

Where the three disagree, the schema wins and the others are bugs. A test asserts that the error codes and the enums in
TypeScript and in the schema are the same set, so the drift cannot happen quietly.

```ts
import { METHOD, PROTOCOL_MAJOR, ERROR_CODE, APPROVAL_META_KEY } from "mason-protocol";
import schema from "mason-protocol/schema" with { type: "json" };
```

Installing this package is optional. A connector that only needs the schema can copy the JSON file and ignore npm
entirely; the values in it are the contract, not the version of a dependency.

The SDK is separate: [`mason-connector`](../connector) adds the socket, the journal, the dedup ledger, attachments, and
the conformance suite. Pinning `protocol.major` and pinning the SDK version are two different decisions, and the two move
independently.
