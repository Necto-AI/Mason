# The connector contract, v1 — proposed

> The shape a connector has to implement to be a surface for mason, and what mason promises it in return. This is the
> interface a community connector is written against. It is **proposed**: [`adr/0006-connectors-are-full-duplex-peers.md`](adr/0006-connectors-are-full-duplex-peers.md)
> decides the principle, and the slices are issues on this repository. Nothing here is implemented beyond the two faces
> that exist today (`docs/adr/0003-integrations-are-services.md`).

## What a connector is

A process, not a page. It speaks at most four channels to mason, and it declares which of them it uses:

| Channel | Direction | Transport | Declared as |
|---|---|---|---|
| **events** | connector → mason | signed `POST /api/events/<name>` | `trigger: { hook, secret }` |
| **tools** | mason → connector | MCP over Streamable HTTP at `<url>/mcp` | `tools: { url, description }` |
| **state** | mason → connector | subscription (WebSocket, Chord-compatible) | `state: ["status", "projection", "presence", "tools"]` |
| **reply** | mason → connector | a tool the connector exposes, named in its entry | `reply: "<tool name>"`, optional `also: ["<connector>"]` |

A connector with none of them is a file that does nothing; a connector with only `tools` is a source of abilities (a
calculator, a search); a connector with only `events` is a one-way alarm. A chat has all four.

## What mason promises

1. **A turn knows where it came from.** Every fire carries its origin connector's name into the turn, and the model is told
   it in the prompt section rather than in prose written for one vendor.
2. **A reply goes to the origin, once.** `reply` is mason's tool and the connector's tool is where it lands; a redelivery
   after a restart is refused rather than repeated. A connector that declares `state: ["projection"]` sees the same reply
   as a transcript entry — that is how a second surface displays a conversation it did not carry. A connector named in the
   origin's `also` list receives the reply as a delivery of its own, and a private message is never fanned out into a space
   that speaks to more than one person without an entry that says so.
3. **State is what was declared and nothing more.** `status` is cheap and always available; `projection` is the whitelisted
   transcript; `tools` is names without arguments or output; the conversation itself never crosses.
4. **A credential per connector, revocable per connector.** Revoking one does not unpair the others, and the server reads
   the file per request so a revoke needs no restart.

## What mason asks

1. **Declare, do not discover.** The entry is written by an operator: URL, hook, capabilities, one paragraph of prompt. A
   connector that wants new powers gets them by an edit a person made.
2. **One reply tool, and it returns.** `{"chat_id", "message_id"}` for a chat, an id for anything else. The turn continues
   after it, so a connector must not assume the reply is the end of the turn.
3. **Name files, do not inline them.** An attachment is a path in a shared directory both sides can read (the
   `mason-inbox` volume is the worked example), never a base64 blob in a tool argument.
4. **Be idempotent on the envelope id.** A redelivery is the same fire; mason deduplicates, but a connector that also keeps
   its own offset is the one that survives both ends restarting.

## The prompt section

Each entry carries one paragraph, operator-authored, injected once per turn:

```json
{ "prompt": "Telegram is Denis's phone. Answer short: a few lines, no headings, no tables. Ask one question at a time. Never send more than three messages in a row; if you need more, write a file and send it." }
```

- **A budget of 400–600 characters.** Longer is a skill, and skills are loaded on demand.
- **Written by the operator, never by the server.** A connector that could write its own section could write instructions
  nobody approved.
- **Only for what is true of the medium**, not for what is true of the agent: the agent's job is `soul.md`, its abilities
  are its tools, its depth is its skills.

## Versioning

`v` in the envelope is the event contract's version, and stays `1` until something breaks it; unknown fields are ignored,
so v1 grows. The connector contract's own version is the file's: an entry that uses `state` or `reply` without a mason
that knows them refuses the boot with the field's name, which is the same refusal a bad hook name gets today. A connector
built against a newer mason degrades: it loses the channels that mason does not have and keeps the rest, because every
channel is declared separately.

## The conformance list, for a community connector

Nine things, all checkable against a fake mason:

1. posts one envelope per event, signed over the raw bytes, with an `id` unique inside its own stream;
2. keeps an offset that survives a restart, and starts from "now" on a fresh one;
3. exposes `/mcp` with an `initialize` that names itself and a version;
4. describes each tool in one line, because that line is what the model reads;
5. declares a reply tool and returns an id from it;
6. treats a `429` as a wait, not a failure, and honours `retry-after`;
7. never logs its own credential, and never puts it in a URL it logs;
8. puts an attachment in the shared inbox and names the path;
9. has a test that drives its own MCP server through an in-memory transport, and one that drives the door with a fake
   signature. The telegram connector is the worked example of both.
