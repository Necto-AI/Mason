# `mason-connector`

The TypeScript SDK for one external mason connector. It owns the parts that are the same for every connector and wrong
in the same way when each one writes them itself: the Chord host, the link, the durable journal, the conversation a
user client holds, attachments, and the approval marker. It does not own vendor behaviour. Two factories, one per
surface: `createUserClient` reads the conversation and may submit; `createEventClient` only appends events.

```ts
import { createUserClient, nodeWebSocketLink, type WebSocketConstructor } from "mason-connector";
import { openSqliteStore } from "mason-connector/store/sqlite";
import WebSocket from "ws";

// `ws` declares an overload `WebSocketConstructor` does not describe (an address of `null`), so the class arrives
// typed as the constructor the SDK takes. Otherwise the class is the whole transport: it is what sets the header.
const socket = WebSocket as WebSocketConstructor;

const client = createUserClient({
	name: "telegram",
	version: "0.3.0",
	url: "wss://mason.local/api/connector",
	credential: process.env.MASON_CONNECTOR_CREDENTIAL ?? "",
	// The credential travels as `Authorization: Bearer` on the upgrade request. A browser's `WebSocket` cannot set a
	// header and Node's built-in one cannot either, so a Node connector passes `ws`.
	link: nodeWebSocketLink(socket),
	// Optional: the same manifest an MCP server declares, sent in the handshake. Mason seeds its events disabled.
	integration: { about: "The team chat", events: [{ kind: "chat.message", description: "a message", prompt: "Answer it." }] },
	store: await openSqliteStore({ path: "/var/lib/mason-telegram/state.db" }),
});

// What a reader sees, as mason publishes it: the snapshot when the link opens, then each diff's value.
client.onConversation((state) => {
	for (const row of state.transcript) console.log(row.id, row.kind);
});
// The handshake: the controls this socket may spend, the kinds it may raise, and its budgets.
client.onSession((session) => console.log(session.commands, session.kinds, session.limits));

await client.start();

/** Your vendor's webhook: one message, and the append that carries it to mason. */
async function onMessage(message: { id: number; chat: number; text: string }): Promise<void> {
	const outcome = await client.submit({
		appendId: `tg-${message.id}`,
		content: [{ type: "text", text: message.text }],
		origin: { ref: String(message.chat), messageId: String(message.id) },
	});
	if (outcome.status === "refused") console.log(outcome.code, outcome.reason);
}
```

An **event client** — a service that reports and reads nothing — is the narrower factory. It has no conversation, no
control, no submission and no attachments, and mason serves it an empty `conversation` cell:

```ts
import { createEventClient, nodeWebSocketLink } from "mason-connector";

const client = createEventClient({ name: "alarm", version: "1.0.0", url, credential, link, store });
client.onSession((session) => console.log(session.kinds));
await client.start();
await client.event({ kind: "alarm.ringing", payload: { host: "db-1" } });
```

## What the SDK guarantees, and what it does not

- **A call is journaled before it goes on the link.** `submit`, `event` and `control` write themselves into the store
  first, so a link that dies mid-flight is a resend of the same id rather than a second logical operation.
  `status: "pending"` means exactly that: the act is durable and unfinished, and `flush()` or a reconnect sends it again.
- **The conversation is the answer, and holding it is the SDK's job.** `conversation` is a state member: a snapshot when
  the link opens and after a reconnect, then diffs. The SDK applies them by the protocol's rule — a snapshot replaces
  what is held, a diff is kept only when its revision is later — which is what makes a reconnect safe. Nothing is
  delivered to a connector and nothing is acknowledged: the rows are the message, and a client that renders them reads
  the same frames.
- **Bytes are content ids, both ways.** `attachments.upload` stores a file and answers its id; `attachments.download`
  reads what a row's `assets` names, with the same credential that read the row. No path and no base64 crosses the link.
- **A handler that throws costs the frame, not the link.** The throw is logged and the state it was handed is already
  held, so the next frame is applied to what the SDK has.
- **A refusal is a Chord error.** Its `reason` is one of mason's codes (`mason.kind_not_permitted`,
  `mason.rate_limited`, …); `errorCodeOf(error)` reads it back. A refusal is a verdict and the journaled call is
  dropped; a spent budget or a link that is going down is not, and the call stays journaled for the retry.

## Stores

| Import | Store | Use |
|---|---|---|
| `mason-connector/store/sqlite` | `openSqliteStore({ path })` | the reference production store: one SQLite file |
| `mason-connector/store/memory` | `new MemoryStore()` | **test-only** — the journal is gone when the process ends |

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
	name: "alarm",
	faces: {
		kinds: ["alarm.ringing"],
		commands: ["stop", "status"],
	},
	handlers: { onConversation: (state) => console.log(state.transcript.length) },
});

if (result.failed.length > 0) throw new Error(`${result.failed[0].name}: ${result.failed[0].error.message}`);
```

`runConformance` builds the connector itself, against a fake mason that serves `mason.peer` over a real Chord link, and
drives every case the protocol defines: the session as state, one submission and its duplicate id, words that name an
actor the grant does not, words to an entry that grants no `user`, an event of a granted kind and of an ungranted one, an
append carrying no address, the control vocabulary, a spent budget that keeps the call journaled, the journal replaying a
call made while the link was down, attachments with a cap, and a download by content id. A case for a face the fixture does not implement is
skipped, and the report says which.

There is no tools-face case: a meaningful one needs live MCP discovery, which is the server half.

## Writing a connector in another language

[`WIRE.md`](WIRE.md) is the subset of Chord's frames an SDK has to implement.
