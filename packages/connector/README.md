# `@mason/connector`

The TypeScript SDK for one external mason connector. It owns the parts that are the same for every connector and wrong in
the same way when each connector writes them itself: the socket, the handshake, the durable journal, the dedup ledger,
attachments, and the approval marker. It does not own vendor behaviour, and it makes no policy decision.

```ts
import { createConnector } from "@mason/connector";
import { openSqliteStore } from "@mason/connector/store/sqlite";

const connector = createConnector({
	name: "telegram",
	version: "0.2.0",
	url: "wss://mason.local/api/connector",
	credential: process.env.MASON_CONNECTOR_CREDENTIAL ?? "",
	store: await openSqliteStore({ path: "/var/lib/mason-telegram/state.db" }),
	faces: {
		user: {
			actors: [{ externalActorId: "8811", displayName: "Denis" }],
			conversations: [{ externalConversationId: "8811", kind: "person" }],
			capabilities: ["text", "files", "approvals"],
		},
		tools: { url: "https://telegram.internal:8082/mcp" },
		events: { kinds: ["chat.message"] },
	},
	state: ["status", "presence"],
	handlers: {
		async onDelivery(delivery) {
			// Send it, then say what happened. Throwing means "this may or may not have left", which mason records as an
			// uncertain outcome and never retries — because retrying could send it twice.
			return { status: "delivered", external: { messageId: 42 } };
		},
		async onInteraction(request) {
			return { delivered: true, surface: "telegram" };
		},
	},
});

await connector.start();

const outcome = await connector.submit({
	submissionId: `tg-${update.update_id}`,
	origin: { connector: "telegram", externalConversationId: "8811", externalMessageId: "42" },
	actor: { externalActorId: "8811" },
	content: [{ type: "text", text: "what is on my calendar" }],
});
```

## What the SDK guarantees, and what it does not

- **A call is journaled before it goes on the wire.** `submit`, `fire`, `control` and `answer` write themselves into the
  store first, so a socket that dies mid-flight is a resend of the same id rather than a second logical operation.
  `status: "pending"` means exactly that: the act is durable and unfinished, and `flush()` or a reconnect sends it again.
- **A delivery is answered once.** The ledger is persisted, so a resend under the same `deliveryId` is answered from it
  even across a restart: a `delivered` one is `duplicate`, and one whose outcome could not be known is `uncertain` again.
  That is the whole of at-least-once delivery: mason keeps resending, and the connector refuses to send twice.
- **A handler that throws is `uncertain`, not retried.** If the send may have left, nobody knows. Guessing loses or
  duplicates a message, so the SDK reports the uncertainty and a person decides.
- **Nothing else is durable.** State frames are applied as they arrive; a gap is a resync, not a patch. Streaming
  `start`/`delta` are notifications and are not replayed.

## Stores

| Import | Store | Use |
|---|---|---|
| `@mason/connector/store/sqlite` | `openSqliteStore({ path })` | the reference production store: one SQLite file |
| `@mason/connector/store/memory` | `new MemoryStore()` | **test-only** — forgets the journal and the ledger on restart |

`node:sqlite` needs `--experimental-sqlite` on Node 22 and nothing on Node 24. A connector with its own persistence
implements `ConnectorStore` — five methods — and passes it in.

## MCP

The SDK does not ship an MCP server. It ships the one thing the contract fixes: the approval marker.

```ts
import { declareTool } from "@mason/connector/mcp";

const sendMessage = declareTool({
	name: "send_message",
	description: "Send one message to a Telegram chat.", // one line: this is what the model reads
	inputSchema: { type: "object", properties: { chat_id: { type: "string" }, text: { type: "string" } } },
	approval: true, // required unless the operator trusts this connector's markers
});
```

A tool with no marker is `required`. Mason never infers risk from a tool's name and never treats MCP's own annotations as
authority: the marker is the connector author's statement, and trusting it is an operator's explicit choice.

## The conformance suite

```ts
import { runConformance } from "@mason/connector/testkit";

const result = await runConformance({
	name: "telegram",
	faces: {
		user: { actors, conversations, capabilities: ["text", "files", "approvals"] },
		events: { "chat.message": "telegram-message" },
	},
	handlers: { onDelivery: sendIt, onInteraction: askSomebody },
});

if (result.failed.length > 0) throw new Error(`${result.failed[0].name}: ${result.failed[0].error.message}`);
```

`runConformance` builds the connector itself, against a fake mason, and drives a real socket through every case the
protocol defines: version negotiation and refusal, grants and the faces they leave inactive, submissions and their
duplicate ids, unknown actors and unpermitted rooms, fires and unmapped kinds, budgets and `stop` beside a spent one,
delivery and its duplicate and its unsure outcome, streaming under one id, approvals answered once, state sequence, and
attachments with a cap. A case for a face the fixture does not implement is skipped, and the report says which.

There is no tools-face case yet: a meaningful one needs live MCP discovery, which is the server half. The tools-only
fixture passes the handshake, grant and control cases and reports the rest as skipped, rather than passing a case that
would prove nothing.

The fake mason enforces the protocol rather than agreeing with everything, because a mock that says yes proves nothing
about a connector that has to survive a no.

## Prove it from outside

`npm run prove:connector` in mason's repository builds both packages, packs them, installs the tarballs into an empty
temporary project outside the tree, and runs the suite there with plain `node`. That is the only evidence that the
published artifact works: an SDK that runs from source is not an SDK.
