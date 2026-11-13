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
_Avoid_: event (when a routine fired), invocation, submission

**delegation**:
One tool call that owns a conversation with a narrow job and returns a report. A conversation, not a peer: no home, no
way to speak to anyone, never a deployment.
_Avoid_: worker (the former name), subagent (that is the API), helper, child bot

**send**:
The one mason-owned tool a turn uses to reach its reader: it commits an `app.reply` entry carrying the turn's origin, and
that row of the conversation is the message. There is no address for a model to name, so a turn nobody wrote to records
the send and says nobody was reached.
_Avoid_: reply (the former name), send_to_user, message

**reply id**:
The durable identity of one send: `reply:<callId>` of the call that asked for it, and the id of the row a reader's client
renders. One message, one id, one row.
_Avoid_: message id, request id, delivery id

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
An external process mason admitted on `/api/connector`, with the credential minted for its integration: it appends a
person's words or an event, and mason calls `deliver` on it. Tools are the entry's MCP server, never the socket.
_Avoid_: integration (that is the entry), plugin, client, app

**append**:
The one inbound call: a submission, an event or a notice, each with an id mason dedupes forever and an origin it never
parses. One call for three shapes is what lets an events-only connector be answered.
_Avoid_: submit, fire, envelope

**payload**:
The data an event carries. It reaches the model fenced as untrusted data and never becomes an instruction.
_Avoid_: envelope, event body, message

**connector credential**:
The credential mason issues one entry so its process can open `/api/connector` and the attachment endpoints. A hash in
`service/config.json`, read on every connection, and the only credential mason issues.
_Avoid_: token, API key, session

**content id**:
The name of one uploaded file, `cnt_<hex>`. Bytes cross the transfer endpoint by this id, never base64 in a frame and
never a shared path, and an id is served only to the connector that uploaded it.
_Avoid_: attachment id, file token

**tool catalog**:
What one MCP server offers *now*: each tool's name, description, JSON Schema and approval marker, read and never
registered as a tool. A script asks it (`mcp_search`, `mcp_describe`, `mcp_call`), so a server that redeploys does not
move the prompt.
_Avoid_: tool list, MCP tools (that is what a catalog holds)

## The conversation

**person**:
The human a home works for. One bot, one person: who that is, is `agent/profile.md`.
_Avoid_: user, member, owner (see **owner actor**)

**actor**:
Who caused a submission or an event: the external id a connector asserted. mason accepts exactly one, the entry's
`owner`; anything else is refused.
_Avoid_: user (for the actor), author (that is a name on a message written before the cutover)

**owner actor**:
The one external actor id a connector's grant names in `connector.user.owner`. Its words are the person's, and it may
drive the controls the entry grants.
_Avoid_: approver, admin, primary user

**origin**:
The connector and the opaque `ref` it minted on the append a turn came from, plus the actor when it named one: where an
answer goes. Data on the entry, never prose in a prompt. A retry inherits the origin of the turn it resumes.
_Avoid_: source, channel, session, conversation (there is one, and it is the transcript)

**ref**:
The address a connector mints into `origin.ref`, returned byte for byte on the delivery that answers that append. Mason
never parses it, so a medium with no chat ids is a connector like any other.
_Avoid_: address, room id, conversation id

## The wire

**transcript**:
What a reader is shown: their words, what the agent delivered, and coarse notices, derived from the conversation.
_Avoid_: conversation, history, chat log

**projection**:
The whitelist that turns a conversation into a transcript. Anything it does not name does not cross.
_Avoid_: serializer, mapper, view

**revision**:
The counter on the conversation a client holds, and the transitions that produced it: a snapshot is authoritative and
always applied, while a diff whose revision is not greater than the one held is already applied. Mason owns it,
because a Chord diff carries ops and no number; it is process-scoped, and starts again at 0 with mason.
_Avoid_: version, sequence, cursor, timestamp
