# `mason-connector`

The TypeScript SDK for one external mason connector. It owns the parts that are the same for every connector and wrong
in the same way when each one writes them itself: the Chord host, the link, the durable journal, the delivery ledger,
attachments, and the approval marker. It does not own vendor behaviour.

```ts
import { createConnector, nodeWebSocketLink } from "mason-connector";
import { openSqliteStore } from "mason-connector/store/sqlite";
import WebSocket from "ws";

const connector = createConnector({
	name: "telegram",
	version: "0.3.0",
	url: "wss://mason.local/api/connector",
	credential: process.env.MASON_CONNECTOR_CREDENTIAL ?? "",
	// The credential travels as `Authorization: Bearer` on the upgrade request. A browser's `WebSocket` cannot set a
	// header and Node's built-in one cannot either, so a Node connector passes `ws`.
	link: nodeWebSocketLink(WebSocket),
	store: await openSqliteStore({ path: "/var/lib/mason-telegram/state.db" }),
	handlers: {
		async onDelivery(delivery) {
			// Send it, then say what happened. Throwing means "this may or may not have left", which mason records as
			// uncertain and never retries — because retrying could send it twice.
			return { status: "delivered", detail: "sent" };
		},
		async onSession(session) {
			// The handshake: the targets mason may send to, the controls this socket may spend, the granted kinds.
			console.log(session.targets, session.commands, session.kinds);
		},
	},
});

await connector.start();

const outcome = await connector.submit({
	appendId: `tg-${update.update_id}`,
	origin: { ref: "8811", messageId: "42" },
	content: [{ type: "text", text: "what is on my calendar" }],
});
```

## What the SDK guarantees, and what it does not

- **A call is journaled before it goes on the link.** `submit`, `event`, `notice` and `control` write themselves into the
  store first, so a link that dies mid-flight is a resend of the same id rather than a second logical operation.
  `status: "pending"` means exactly that: the act is durable and unfinished, and `flush()` or a reconnect sends it again.
- **A delivery is answered once.** The ledger is persisted, so a resend under the same `deliveryId` is answered from it
  even across a restart: a `delivered` one is `duplicate`, and one whose outcome could not be known is `uncertain`
  again. That is the whole of at-least-once delivery: mason keeps resending, and the connector refuses to send twice.
- **A handler that throws is `uncertain`, not retried.** If the send may have left, nobody knows. Guessing loses or
  duplicates a message, so the SDK reports the uncertainty and a person decides.
- **A refusal is a Chord error.** Its `reason` is one of mason's codes (`mason.kind_not_permitted`,
  `mason.rate_limited`, …); `errorCodeOf(error)` reads it back.

## Stores

| Import | Store | Use |
|---|---|---|
| `mason-connector/store/sqlite` | `openSqliteStore({ path })` | the reference production store: one SQLite file |
| `mason-connector/store/memory` | `new MemoryStore()` | **test-only** — forgets the journal and the ledger on restart |

`node:sqlite` needs `--experimental-sqlite` on Node 22 and nothing on Node 24. A connector with its own persistence
implements `ConnectorStore` — five methods — and passes it in.

## MCP

The SDK does not ship an MCP server. It ships the one thing the contract fixes: the approval marker.

```ts
import { declareTool } from "mason-connector/mcp";

const sendMessage = declareTool({
	name: "send_message",
	description: "Send one message to a Telegram chat.", // one line: this is what the model reads
	inputSchema: { type: "object", properties: { chat_id: { type: "string" }, text: { type: "string" } } },
	approval: true,
});
```

A tool with no marker is `required`. Mason never infers risk from a tool's name and never treats MCP's own annotations as
authority: the marker is the connector author's statement, and trusting it is an operator's explicit choice.

## The conformance suite

```ts
import { runConformance } from "mason-connector/testkit";

const result = await runConformance({
	name: "telegram",
	faces: {
		targets: [{ id: "home", label: "the direct conversation", capabilities: ["text", "files"] }],
		kinds: ["chat.message"],
		commands: ["stop", "compact", "clear", "status"],
	},
	handlers: { onDelivery: sendIt },
});

if (result.failed.length > 0) throw new Error(`${result.failed[0].name}: ${result.failed[0].error.message}`);
```

`runConformance` builds the connector itself, against a fake mason that serves `mason.peer` over a real Chord link, and
drives every case the protocol defines: the session as state, submissions and their duplicate ids, events and an
ungranted kind, a notice that starts nothing, delivery to a target and to the default, the duplicate answer, a lost
acknowledgement collapsing after a reconnect, an uncertain send that is never retried, the control vocabulary, a spent
budget, the journal replaying a call made while the link was down, and attachments with a cap. A case for a face the
fixture does not implement is skipped, and the report says which.

There is no tools-face case: a meaningful one needs live MCP discovery, which is the server half.

## Writing a connector in another language

[`WIRE.md`](WIRE.md) is the subset of Chord's frames an SDK has to implement.
