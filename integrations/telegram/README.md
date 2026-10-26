# mason-telegram

The first integration built on the two faces of
[ADR-0003](../../docs/adr/0003-integrations-are-services.md): one container that lends mason two tools and wakes it when
the team chat says something. It is a package of its own — its own `package.json`, its own tests, its own image — and
nothing in mason's build depends on it: mason knows `http://mason-telegram:8082/mcp` and a trigger secret, and the rest
is Telegram's business.

It never speaks as the owner: no transcript, no roster, no `send_to_user`. Its whole vocabulary is one event out and one
message back.

## The tools face — MCP over Streamable HTTP on `:8082/mcp`

| Tool | What it does |
|---|---|
| `send_message(chat_id, text, reply_to_message_id?)` | Sends a message to a Telegram chat and returns the id of the message it created. Queued per chat at 20 a minute. |
| `list_chats()` | Lists the chats the poller has seen — `{id, title, type}` — so the agent can find an id without a human pasting one. |

Nothing else is offered, and the container answers nothing on any other path. The endpoint is stateless: no session id,
no per-session state, one `McpServer` and transport per request over the same two tools, so either end restarting is
a reconnect rather than a stale session.

A `429` is not retried blindly: Telegram's own `retry_after` is honoured in its place, at most three times, and a wait
longer than a minute ends the tool call with a message the model can act on instead of holding it open.

## The trigger face — long polling into the event door

`getUpdates` with `timeout=30` and `allowed_updates: ["message"]`, one signed POST per message to `MASON_EVENT_URL`
(`POST /api/events/telegram` on the mason side), with `x-mason-signature: sha256=<hex hmac-sha256 of the raw body>`:

```json
{"v":1,"id":"tg-8811","kind":"chat.message",
 "payload":"Ilya (@ilya) in chat -1001234 (Team chat), replying to 8810: ship it?"}
```

- `id` is `tg-<update_id>`, and an update id is unique per bot and monotonic, so the door's permanent dedupe turns a
  redelivery after a crash into the same event rather than a second one.
- A message whose text starts with `/` is posted as
  `{"v":1,"id":"tg-8811","kind":"command","payload":"stop"}` instead, and does not fire a turn. Mason decides what the
  word means; the section below is what this container does with the answer.
- The chat id is inside the payload on purpose: the reply needs it, and `payload` is a string.
- The reply clause appears only when it is a reply, the handle only when the sender has one, and the title only when the
  chat has one — a private chat has none, and a stable rendering beats empty brackets.
- The three optional parts vanish rather than leaving placeholders: `Ilya in chat 4711: ship it?` is what a private chat
  with no username renders as.
- A message with a file ends with where the file is, because the path is what makes the attachment something the agent can
  open:

  ```json
  {"v":1,"id":"tg-448860480","kind":"chat.message",
   "payload":"Ilya (@ilya) in chat -1001234 (Team chat): sent a file: report.pdf, with a file at /home/mason/.mason/agent/workspace/inbox/448860480-report.pdf"}
  ```

  A photo with no caption reads `…: sent a photo, with a file at …`, a voice note `…: sent a voice note, with a file at …`:
  the sentence says what arrived, and the clause says where it is.
- A message longer than the door's 2 000-character payload cap is cut here with `… [truncated]`, because the door refuses
  an over-long payload rather than truncating it and a refusal advances the offset — the event would be lost. The cut is
  on the text, never on the file clause: a caption loses its own words before a payload loses the path.
- `202` is expected. What each other answer means, and what the offset does about it:
  - **A refusal advances past it.** `400` (a bad envelope), `401` (a bad signature), `404` (a path that names no
    integration), `405` (not a POST), `413` (over the body cap): logged with the integration's name and the body's own
    `error`, and the offset moves on, because a message the door will never accept must not block the chat behind it.
    Those five and no others — they are the answers a retry would get again.
  - **`429` waits.** The door's budget is six deliveries a minute and its answer says in `retry-after` when it has room
    again. The same envelope — same bytes, same signature, same `tg-<update_id>` — is posted once that long, which is one
    fire either way; a wait longer than `MAX_THROTTLE_WAIT_MS` (five minutes, this container's own cap) is not sat
    through, and one that names no number is not guessed at. One line says so each time, not one a second.
  - **A door that cannot be reached retries the batch.** A refused connection, a timeout, an answer that is not one of
    the five above (mason's own `500`, a sidecar's `502` — a door that failed did not refuse the event), or a `429` this
    will not wait out: the offset does **not** advance and nothing is persisted. The same batch is posted again after a
    backoff that starts at a second and doubles to half a minute, with one log line a minute while it is down and one
    when it answers again. Redelivery is free because a batch's ids are the update ids, and the door dedupes on them.

**What is dropped, and where.** A message from a bot, an edit, a chat that is not in `TELEGRAM_ALLOWED_CHATS`, and
anything that is neither words nor a file (a sticker, a location, a poll, a service notice) never becomes an event, and a
chat we did not choose never enters `list_chats` either. A word that starts with `/` takes the command path below and is
never dropped for being one: `/help` is answered here, and every other word is posted to mason, which answers whether it
acted. The bot's own `@mention` is stripped (case-insensitively, via `getMe` at startup), and everything else in the
message is kept verbatim, which is also how a group sends `/stop@mason_bot`.

**Files arrive as a path, because the agent reads one.** A photo, a document, a voice note, an audio file or a video is
written to `TELEGRAM_INBOX` as `<update_id>-<the sender's name, sanitised>` with mode `0600`, and the payload ends with
where it landed: `<update_id>-` is what makes two files called `report.pdf` two paths, and the id is unique per bot, so a
replayed batch writes the same bytes under the same name. The cap is Telegram's own — a bot may download 20 MiB — and a
file over it is refused with a sentence rather than an exception; the message is still delivered, with no path, which is
how the agent tells a file that arrived from one that could not be fetched. Anything older than seven days is deleted by
a sweep on every write and once at startup, because nobody else watches that volume. `mason-telegram` and `mason-env`
mount it at the same path (`mason-inbox`, declared in `deploy/compose.yaml`), which is what makes a path in a payload a
file `read` opens on the other side — and the mount is a directory of its own, so the rest of the agent's home (the
profile, the log, the skills, the memory repository) stays out of this container.

**The offset.** `offset.json` on the container's own volume (`/data`), written whole — temporary file, rename, `0600` —
once per batch, not once per message: a crash mid-batch replays at most one batch, and the id makes the replay the same
fire. A container whose volume has never held an offset reads `getUpdates` once with no offset, discards the backlog and
starts from now, because a restart must never replay yesterday's chat into the agent. `chats.json` sits beside it.

## Commands: what a chat can ask for

A message whose text starts with `/` is a command candidate: it is posted to the same door as `kind: "command"`, with
the word after the slash as the payload, and it does not fire a turn. Mason decides what the word means, because the
vocabulary is mason's (`src/server/events.ts`), and this container relays the answer.

| What a person types | What happens |
|---|---|
| `/stop` | The running turn is stopped, and the chat reads `stopped`. |
| `/compact` | The conversation is summarised, and the chat reads `compacted`. Words after the command are the instructions mason passes on. |
| `/clear` | The conversation is forgotten and started again, and the chat reads `cleared`. |
| `/status` | One line: what the agent is doing, what is queued, which integrations answered at boot, and how many did not. |
| `/help` | The paragraph below, answered here and never sent to mason. |

An integration declares which of those its secret may issue (`npm run integration -- commands telegram
stop,compact,clear,status` on the mason side); with none declared, every one of them is a message. **A word mason does
not act on is not an error**: the door answers `{"handled":false}`, and this container posts the message it kept beside
the command, so `/start`, `/foo` and a mistyped `/stopp` reach the agent as the text they were. A declared command that is
malformed (an argument where mason takes none, more than 200 characters of instructions to `/compact`) is refused with a
`400` and one line saying which rule it broke; the offset advances, because the person typed something mason will not do.

The command envelope carries the id its message would have had, so a redelivery is one claim at the door and the command
does not run twice. `/help` answers with what this relay forwards, because it cannot read `integrations.json`:

```text
mason understands these commands in this chat, when the integration declares them:
/stop: stop the turn that is running
/compact: summarise the conversation so far, with optional instructions
/clear: forget the conversation and start again
/status: what the agent is doing, and what is connected
Anything else you type, including any other /word, arrives as a message.
```

The same four names are set as Telegram's own bot command menu (`setMyCommands`) before the first poll, so typing `/` in
the chat shows them; a menu Telegram refuses is one warning and nothing else. A command is posted in the batch it arrived
in, immediately, because a turn that is running is not something the poller waits on: `/stop` reaches mason while the turn
it stops is still running. The answer is posted through the same per-chat send queue as `send_message`, so Telegram's
twenty-a-minute limit stays one file's problem, and a failed answer is a logged warning rather than a held batch: the
command was answered, and a chat that did not read the answer must not block the messages behind it.

## Configuration — the environment, and nothing else

| Variable | Required | What it is |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | The bot's credential, from BotFather. Never logged, never written, never inside a payload. |
| `MASON_EVENT_URL` | yes | Where events go: `http://mason:8787/api/events/telegram` on the compose network. |
| `MASON_TRIGGER_SECRET` | yes | The HMAC key the door verifies with, at least 32 characters. Minted by `npm run integration -- secret telegram --hook team-chat` on the mason side, printed once. |
| `TELEGRAM_ALLOWED_CHATS` | yes | Comma-separated chat ids this bot may relay. Anything else is dropped before it becomes an event. |
| `HTTPS_PROXY` | no | The VPN sidecar, `http://vpn:1080`, where Telegram is blocked. |
| `DATA_DIR` | no | Defaults to `/data`, the volume. |
| `TELEGRAM_INBOX` | no | Where an incoming file is written. Defaults to `/home/mason/.mason/agent/workspace/inbox`, the path both compose files mount `mason-inbox` at: moving it means moving both mounts, or the payload names a file nothing can open. |
| `PORT` | no | Defaults to `8082`. Moving it means moving `tools.url` in `integrations.json` too. |

A missing or malformed variable is a refusal at startup that names it: an instance without its allowlist would relay
every chat the bot is in, and one without its secret would deliver events nothing accepts.

**The proxy is for Telegram, not for mason.** Node 22's `fetch` does not read `HTTPS_PROXY` by itself, so the API calls
go through `undici`'s `ProxyAgent` configured from it (`src/fetch.ts`). The event POST does not: the door is a name that
only exists inside the compose network, and the sidecar has no route to it. One variable, one route — and a VPN outage
never looks like a delivery made.

## Privacy mode, and why a group is quiet

A bot added to a group in BotFather's default *privacy mode* only receives **mentions and replies** — every other
message in the group exists for Telegram but never reaches `getUpdates`, so this container cannot see it and no event
exists. Turning privacy mode off is what makes the bot read every message in the group, and it must be turned off in
BotFather (it cannot be changed by a bot from inside a chat). The container's own allowlist still applies on top: privacy
mode decides what Telegram *sends*, `TELEGRAM_ALLOWED_CHATS` decides what is *relayed*.

In a private chat there is no privacy mode: every message arrives.

## No ingress

There is no published port, here or on any integration. The container listens on `8082` inside the `mason-mcp` compose
network, which is `internal: true`, and mason reaches it by name; the host, another machine and the internet cannot. Its
way out is `mason-egress`, which is also `internal: true` and whose only reachable address is the `vpn` sidecar at
`http://vpn:1080` — so the sidecar is this container's whole route to Telegram, and there is no route to anything else.
That is a difference between the two containers, not a wall between them: mason shares `mason-edge` with the sidecar and
could open the same proxy, and it would gain nothing by it, because `mason-edge` already gives mason egress of its own.
What the two `internal: true` networks keep off the proxy is the tool machine — `mason-env` joins neither `mason-edge` nor `mason-egress`, so
it has no route to the proxy at all. mason reaches this container, this container reaches the sidecar, and nothing else is
a route out of it.

## Running it

```sh
cd integrations/telegram
npm install
npm test        # node:test, injected fetch — no sockets, no network, no token
npm run typecheck
TELEGRAM_BOT_TOKEN=… MASON_EVENT_URL=… MASON_TRIGGER_SECRET=… TELEGRAM_ALLOWED_CHATS=… npm start
```

Node 22, TypeScript run from source with `--experimental-strip-types`: there is no build step, and the image (`Dockerfile`
here) copies `src` rather than compiling it.

The deployment side is one commented service in [`deploy/compose.yaml`](../../deploy/compose.yaml) and a paragraph in
[`deploy/README.md`](../../deploy/README.md). The hook an event fires on the mason side is `team-chat`
(`src/server/hooks.ts`): mason refuses to boot if `integrations.json` names a hook this build does not define, and the
integration's trigger therefore requires mason to be up to date before the container's first event.

## What is not here

Webhooks (they need public HTTPS), outbound media — the agent sends words, not files — reactions, threads as
first-class, multi-bot, and identity mapping beyond the sender's name and username in the payload. Each is a face of
Telegram this container does not show the agent, and none of them is needed to answer a message.
