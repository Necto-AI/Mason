# mason

mason is a headless, always-on agent backend: a durable agent engine plus a small set of contracts that interfaces
attach to. Telegram is the first interface, and there is no application in this repository: this glossary is the
vocabulary for the backend and for what attaches to it.

## The backend

**mason**:
The backend: a durable agent engine plus the contracts an interface speaks — a signed event in, a delivery and a
transcript out, a control plane, an identity, a version. It defines one bot; it does not define a team of them.
_Avoid_: the bot, the app, the platform, the assistant

**interface**:
A role a connector plays when it reaches a person: a chat, a rich client, or another user-facing surface. It is not a
separate kind of thing beside a connector.
_Avoid_: frontend, UI (for the abstract thing), channel

**client**:
A consumer of a connector's user face: it may submit a person's words and receive what the face's grant lets it render.
_Avoid_: frontend, UI, channel, app

**grant**:
One power a device's credential carries: `conversation` (the projected transcript), `trace` (the raw entries), `admin`
(the configuration) or `approve` (the pending questions). None implies another, a new device gets `conversation`, and the
trace is granted on purpose. A connector has grants too — the ceiling in its entry — but those are about a service, not
a person's device.
_Avoid_: permission (that is one tool call), scope (that is connector state), role

**apiary**:
The separate project that is mason's rich client and the control plane for a fleet: it reads the wire contract, shows
several bots, and organises and observes them. It is not the message bus — bots talk through A2A. Out of scope here.
_Avoid_: the app, mason's client (it is one of several), the router

## The bot

**bot**:
One deployed mason: one identity, one home, one conversation, one set of tools, and one profession — its soul, skills,
routines and integration grants are chosen for that job. A second profession is a second deployment.
_Avoid_: agent, instance, assistant (an *agent* in pi's sense is a conversation's resolved prompt and tool set)

**application bot**:
The bot this repository is built for: it finds, evaluates and tracks internships and fellowships, prepares the
applications and drafts, and stops for Denis's explicit approval before it submits anything. Its plan is
`docs/APPLICATION-PLAN.md`.
_Avoid_: the assistant, the pilot

**soul**:
The bot's job and personality — what it is for, how it speaks, what it declines. Set by whoever deploys it.
_Avoid_: persona, system prompt, SYSTEM.md

**person**:
Who a bot works for. A person is `~/people/<name>/`, a git repository holding their profile; one person may own
several bots, and a bot works for one.
_Avoid_: user, account, owner

**profile**:
Durable facts about the person, curated by every bot that works for them and shared between those bots. A bot writes
it the way it writes its own memory: a change is a commit (`docs/adr/0012-a-person-is-not-a-bot.md`).
_Avoid_: user memory, memory, context

## The fleet

**fleet**:
Several separately deployed mason bots that may talk to each other: one process, home and port per bot, started and
watched by a control plane and never by mason itself.
_Avoid_: team (that is the arrangement apiary shows), group, cluster

**A2A**:
Agent2Agent Protocol, the Linux Foundation standard for agent-to-agent communication and the peer boundary between
separately deployed bots (ACP merged into it in August 2025). It is carried by the deployments, independent of whether
bots share a VM; mason's code grows no peer registry or router, and the peers it accepts are a list a person edits
(`docs/FLEET-PLAN.md`).
_Avoid_: ACP, calling it mason's protocol, confusing it with the editor-facing Agent Client Protocol

## The home

**home**:
The bot's own directory tree. It is split in two, and the split is the security boundary between the server and
the machine its tools run on.
_Avoid_: house, state dir, `.mason`

**agent-owned files**:
The part of the home the bot reads and edits with its own tools, on the machine its tools run on: log, journal,
skills, worker definitions, workspace.
_Avoid_: user data, workspace (the workspace is one directory inside it)

**service-owned files**:
The part of the home the bot never sees: soul, credentials, integration secrets, the database, keys.
_Avoid_: config, internal state

**workspace**:
The directory a conversation's tools work in, inside the agent-owned files.
_Avoid_: cwd (that is the path, not the place), sandbox

**log**:
Dated facts, one per line, appended as they are learned and never rewritten.
_Avoid_: journal, diary, memory

**journal**:
A day's consolidated account, rewritten from that day's log.
_Avoid_: summary, daily log, notes

## The prompt

**section**:
One named piece of the system prompt, rendered from a function before each model request.
_Avoid_: block, part, fragment

**resident**:
Text that is in the prompt on every request: soul, profile, the skills index.
_Avoid_: static, always-on, cached

**prompt delta**:
The transcript entry that records what changed in the prompt between two requests. It carries no message text and
wakes nobody.
_Avoid_: system message, diff

**declared tool**:
A tool the model is offered in the request, and can therefore decide to call.
_Avoid_: direct tool, active tool

**deferred tool**:
A tool that exists but is not in the request; it is reached from a script by name, or found by search.
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
A person's input as mason receives it: its content, origin, attribution, the mode it was sent with, and whether it
still waits in the queue. A human message is a submission, not a hook fire, even when both arrive through one
connector.
_Avoid_: message (that is what is read afterwards), prompt, request, hook

**hook**:
Something outside the conversation that can wake the bot without being a person's conversational input: a service
event, a schedule slot, or a gesture.
_Avoid_: trigger, event source, listener, tool result

**fire**:
One call into a hook, from a service event, a schedule slot, or a gesture. A redelivery under the same identity is
still one fire. Unlike a tool result, a fire is unsolicited input that can start or steer a turn.
_Avoid_: event, invocation, delivery, submission

**routine**:
A hook that fires on a schedule.
_Avoid_: cron job, schedule, timer

**delivery**:
One outbound act that reaches the turn's origin connector and records the same reply in the transcript. The model calls
`reply`; it does not choose a vendor's message tool. A turn with no reachable reader says so rather than recording a
delivery nobody received.
_Avoid_: message, notification (each names one shape of it)

**reply**:
The one Mason-owned tool a turn uses to reach its reader. It targets the turn's origin — the connector that carried the
words — and commits an `app.reply` entry; a routine with no origin names its target explicitly.
_Avoid_: send_to_user (the removed console-only tool), message, answer

**delivery id**:
The durable identity of one reply: `reply:<callId>` of the call that asked for it. A streaming start, its deltas, its
final and a resend after a reconnect all carry it, which is what lets a connector answer `duplicate` instead of sending
twice.
_Avoid_: message id, request id

**outbox**:
The committed replies a connector has not acknowledged yet, read from the transcript rather than from a second store. A
reply is owed until an `app.delivery` entry says what became of it, and an `uncertain` one is never retried.
_Avoid_: queue, retry buffer

**reader**:
Whoever a turn's words are for. A connector's user face and an operator's projection are different powers: reading a
transcript does not grant administration, and carrying a person's words does not grant transcript access.
_Avoid_: client, user, frontend

## Connectors

**connector**:
An external participant that talks to mason through any combination of three faces: user, tools, and events. A
connector is not a Mason module, and one kind of connector does not exist per face.
_Avoid_: integration (the former name), plugin, client, app, interface (that is a role, not a kind of thing)

**user face**:
The connector face that carries a person's submissions, the agent's replies, and the state its grant lets it render.
_Avoid_: ACP (the name of a specific editor-facing protocol), channel, interface

**events face**:
The connector face that delivers service events to mason: one authenticated event becomes one fire. It does not carry
ordinary human conversation; that is the user face.
_Avoid_: webhook, trigger, source, listener, tool result

**payload**:
The data a fire carries. It reaches the model fenced as untrusted data and never becomes an instruction; the summary is
the one line a person reads about it, and neither is a rendered sentence the sender composed.
_Avoid_: envelope (the signed body that carried a payload, removed in #104), event body, message

**tool surface**:
The tools one connector lends the bot through MCP.
_Avoid_: tool list, MCP server (that is the process, not the surface), plugin API

**connector credential**:
The credential mason issues one entry so its process can open `/api/connector` and the attachment endpoints. It is
stored as a hash in `service/config.json`, read on every upgrade, and is not an owner token: it can speak as that
connector and do nothing else.
_Avoid_: token, API key, session (that is a person's, and a connector speaks for no person)

**content id**:
The name of one uploaded file, `cnt_<hex>`. Bytes cross the transfer endpoint by this id, never base64 in a frame and
never a shared path, and an id is served only to the connector that uploaded it.
_Avoid_: attachment id, file token

**tool catalog**:
What one service offers *now*: each tool's own name, description, JSON Schema and approval marker, read from the server
and never registered as a tool. A script asks the catalog (`mcp_search`, `mcp_describe`, `mcp_call`); the model is never
offered it, so a server that redeploys does not move the prompt.
_Avoid_: tool list, tool surface (that is the face's name, not its contents), MCP tools (that is what a catalog holds)

**operator control plane**:
The separate administrative contract for credentials, connector entries, owner actor and global configuration. It is not
a privilege a conversational connector receives.
_Avoid_: admin channel, connector management face

## The conversation

**person**:
The human a home works for. One bot, one person: who that is, is `agent/profile.md`, and no file repeats it.
_Avoid_: user, member, teammate, owner (see **owner actor**)

**actor**:
Who caused a submission, a fire, an approval or a refusal: the external id a connector asserted. mason accepts exactly
one of them, the entry's `owner`; anything else is refused, and no actor at all is accepted as a message nobody signed.
_Avoid_: user (for the actor), author (that is a name on a message written before the cutover)

**owner actor**:
The one external actor id a connector's user face names in `connector.user.owner`. Its words are the person's, and an
answer it gives settles a permission request that came through that connector — the other authority being a device
holding `approve`.
_Avoid_: approver, admin, primary user

**origin**:
The connector and external conversation a submission (or a fire) came from, and therefore the destination of its
ordinary reply. It is structured data on the entry, never prose in a prompt. A retry inherits the origin of the turn it
resumes, so a resumed answer still has its chat.
_Avoid_: source, channel, session

**device**:
One pairing: the token, the label beside it, and what a revoke kills. A person and a device are different things.
_Avoid_: session, phone

**room**:
One kind of external conversation a connector may carry words in (`kind: "room"`), as opposed to a direct message
(`kind: "person"`). A property of the medium, not something a single-person home has.
_Avoid_: team, channel, group chat

**team**:
Several bots arranged to work together, each with a profession, as apiary shows them. The deployment word is **fleet**;
a team is the arrangement, not the containers.
_Avoid_: room, group, or **fleet** when you mean the deployments

## Workers

**worker**:
A conversation owned by one tool call, given a narrow job and a small context, that returns a report. A tool, not
a peer: it has no home, no way to speak to anyone, and no A2A link. It is never a mason deployment.
_Avoid_: subagent (that is the API), helper, child bot, delegate

**agent definition**:
The file that says what a worker is for, which tools it may use, and what shape its report takes.
_Avoid_: prompt, config, role

## The wire

**transcript**:
What an interface's reader is sent: their words, what the agent delivered, widgets and coarse notices, derived from
the conversation.
_Avoid_: conversation, history, chat log

**projection**:
The whitelist that turns a conversation into a transcript. Anything it does not name does not cross the connector wire.
_Avoid_: serializer, mapper, view

**trace**:
The operator-only record of the stored agent session: model messages, tool calls with their arguments and results,
hook payloads, prompt changes, and delivery and control events. It is not the projected transcript, it is never a
connector's state, and a device reads it only with the `trace` grant.
_Avoid_: transcript, conversation (when the raw record is meant), debug log
