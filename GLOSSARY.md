# mason

mason is a headless, always-on agent backend: one durable agent, one home, its tools, and connectors. There is no
application in this repository; this glossary is the vocabulary for the backend and for what attaches to it.

## The backend

**mason**:
The backend: a durable agent engine plus the contracts a connector speaks — a socket in, a reply out, a home, a
credential. It defines one bot; it does not define a team of them.
_Avoid_: the bot, the app, the platform, the assistant

**bot**:
One deployed mason: one identity, one home, one conversation, one set of tools. A second bot is a second deployment.
_Avoid_: agent, instance, assistant (an *agent* in pi's sense is a conversation's resolved prompt and tool set)

**interface**:
A role a connector plays when it reaches a person: a chat, or another user-facing surface. Not a separate kind of thing,
and mason has no interface type.
_Avoid_: frontend, UI (for the abstract thing), channel

**sibling**:
The separate project that is mason's rich client and the control plane for a fleet of bots. It reaches mason as a
connector, reads the wire contract, and owns whatever panel an operator reads. Out of scope here.
_Avoid_: the app, mason's client (it is one of several), the router

## The home

**home**:
The bot's own directory tree: one directory under the root, or whatever `MASON_HOME` names. It is split in two, and the
split is the boundary between the server and the machine its tools run on.
_Avoid_: house, state dir, `.mason`

**root**:
The directory the bots live under, `~/.mason` or `MASON_ROOT`: `common/` and one directory per bot, each one home. A
command targets one with `-b`, else `MASON_BOT`, else the only bot.
_Avoid_: fleet (that is the bots, not the directory), state dir

**common store**:
The three files every bot under a root shares: the default provider and model, one key per provider, and where tools run.
Written by `mason init` and read by every boot.
_Avoid_: global config, shared home

**agent-owned files**:
The part of the home the bot reads and edits with its own tools, on the machine its tools run on: profile, log, skills,
routines, the workspace.
_Avoid_: user data, workspace (the workspace is one directory inside it)

**service-owned files**:
The part of the home the bot never sees: soul, credentials, the MCP keys, the database, keys.
_Avoid_: config, internal state

**soul**:
The bot's job and personality — what it is for, how it speaks, what it declines. Set by whoever deploys it, never by the
bot.
_Avoid_: persona, system prompt, SYSTEM.md

**profile**:
Durable facts about the person the bot works for, written and kept current by the bot itself. One bot, one person.
_Avoid_: user memory, memory, context

**workspace**:
The directory a turn's tools work in, inside the agent-owned files.
_Avoid_: cwd (that is the path, not the place), sandbox

**log**:
Dated facts, one per line, appended as they are learned and never rewritten.
_Avoid_: journal, diary, memory

## The prompt

**section**:
One named piece of the system prompt, rendered from a function before each model request.
_Avoid_: block, part, fragment

**resident**:
Text that is in the prompt on every request: soul, profile, the skills index.
_Avoid_: static, always-on, cached

**declared tool**:
A tool the model is offered in the request, and can therefore decide to call.
_Avoid_: direct tool, active tool

**deferred tool**:
A tool that exists but is not in the request; it is reached from a script by name.
_Avoid_: hidden tool, lazy tool

## The work

**turn**:
Everything between an input arriving and the answer that settles it. One turn may cost several model requests.
_Avoid_: run, cycle, interaction

**generation**:
One model request and its answer, inside a turn. A tool round starts another one.
_Avoid_: request, step

**tool round**:
The model's tool calls and their results, between two generations of the same turn.
_Avoid_: tool step, iteration

**submission**:
A person's input as mason receives it: its content, origin, attribution, and whether it still waits in the queue.
_Avoid_: message (that is what is read afterwards), prompt, request

**routine**:
A timer the agent owns: a name, an interval and the prompt that fires. It lives in `agent/routines.json`, which the
agent edits, and a deployment ships none. Marked in the transcript `[ROUTINE: name]`.
_Avoid_: cron job, schedule, timer, hook

**event**:
A fire a connector sends over its socket, of a kind its grant names. It wakes a turn with the payload, fenced as
untrusted data. Marked in the transcript `[EVENT: kind]`.
_Avoid_: webhook, trigger, hook, notification

**lifecycle hook**:
A call the vendor runtime makes inside a running turn — `beforeRequest`, `onYield`, `afterRun`, `beforeTool`. It is not
a way for anything outside the conversation to wake the bot.
_Avoid_: hook (alone), trigger, event

**fire**:
One wake of the bot by a routine or an event. A redelivery under the same identity is still one fire. Unlike a tool
result, a fire is unsolicited input that can start a turn.
_Avoid_: event (when a routine fired), invocation, delivery, submission

**delegation**:
One tool call that owns a conversation with a narrow job and returns a report. A conversation, not a peer: no home, no
way to speak to anyone, never a deployment.
_Avoid_: worker (the former name), subagent (that is the API), helper, child bot

**delivery**:
One outbound act that reaches the turn's origin connector and records the same reply in the transcript. The model calls
`reply`, never a vendor's message tool.
_Avoid_: message, notification (each names one shape of it)

**reply**:
The one mason-owned tool a turn uses to reach its reader. It targets the turn's origin — the connector that carried the
words — and commits an `app.reply` entry.
_Avoid_: send_to_user (a removed tool), message, answer

**delivery id**:
The durable identity of one reply: `reply:<callId>` of the call that asked for it. A streaming start, its deltas, its
final and a resend after a reconnect all carry it, which is what lets a connector answer `duplicate` instead of sending
twice.
_Avoid_: message id, request id

**outbox**:
The committed replies a connector has not acknowledged yet, read from the transcript, not a second store. A reply is
owed until an `app.delivery` entry says what became of it, and an `uncertain` one is never retried.
_Avoid_: queue, retry buffer

## Integrations and connectors

**integration**:
One entry in `service/integrations.json`: a service mason may reach, with an MCP server, a connector grant, or both. Only
an entry with a grant has a connector.
_Avoid_: service, app, plugin

**MCP server**:
The endpoint an integration points at, over Streamable HTTP, that lends the bot tools. Mason is the client and holds the
credential the server issued it, never the one it issued the connector.
_Avoid_: tool surface, tools face

**connector**:
An external process mason admitted on `/api/connector`: it carries a person's words and reports events, with the
credential minted for its integration. Two faces, user and events; tools are the entry's MCP server.
_Avoid_: integration (that is the entry), plugin, client, app

**user face**:
The connector face that carries a person's submissions and the agent's replies, streamed and final.
_Avoid_: ACP (the name of a specific editor-facing protocol), channel

**events face**:
The connector face that delivers events to mason: one granted kind becomes one fire. It does not carry ordinary human
conversation; that is the user face.
_Avoid_: webhook, trigger, source, listener

**payload**:
The data a fire carries. It reaches the model fenced as untrusted data and never becomes an instruction.
_Avoid_: envelope (removed with the event door), event body, message

**connector credential**:
The credential mason issues one entry so its process can open `/api/connector` and the attachment endpoints. Stored as
a hash in `service/config.json`, read on every connection, and the only credential mason issues.
_Avoid_: token, API key, session

**content id**:
The name of one uploaded file, `cnt_<hex>`. Bytes cross the transfer endpoint by this id, never base64 in a frame and
never a shared path, and an id is served only to the connector that uploaded it.
_Avoid_: attachment id, file token

**tool catalog**:
What one MCP server offers *now*: each tool's own name, description, JSON Schema and approval marker, read and never
registered as a tool. A script asks the catalog (`mcp_search`, `mcp_describe`, `mcp_call`); the model is never offered
it, so a server that redeploys does not move the prompt.
_Avoid_: tool list, tools face (that is the entry's server, not its contents), MCP tools (that is what a catalog holds)

## The conversation

**person**:
The human a home works for. One bot, one person: who that is, is `agent/profile.md`, and no file repeats it.
_Avoid_: user, member, teammate, owner (see **owner actor**)

**actor**:
Who caused a submission or a fire: the external id a connector asserted. mason accepts exactly one of them, the entry's
`owner`; anything else is refused.
_Avoid_: user (for the actor), author (that is a name on a message written before the cutover)

**owner actor**:
The one external actor id a connector's user face names in `connector.user.owner`. Its words are the person's, and it
may drive the controls the entry grants.
_Avoid_: approver, admin, primary user

**origin**:
The connector and external conversation a submission came from, and therefore the destination of its reply. It is
structured data on the entry, never prose in a prompt. A retry inherits the origin of the turn it resumes.
_Avoid_: source, channel, session

**room**:
One kind of external conversation a connector may carry words in (`kind: "room"`), as opposed to a direct message
(`kind: "person"`). A property of the medium, not something a single-person home has.
_Avoid_: team, channel, group chat

## The wire

**transcript**:
What a reader is shown: their words, what the agent delivered, and coarse notices, derived from the conversation.
_Avoid_: conversation, history, chat log

**projection**:
The whitelist that turns a conversation into a transcript. Anything it does not name does not cross.
_Avoid_: serializer, mapper, view
