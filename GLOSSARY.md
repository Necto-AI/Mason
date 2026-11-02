# mason

mason is a headless, always-on agent backend: a durable agent engine plus a small set of contracts that interfaces
attach to. Telegram is the first interface, the operator console in this repository is the second and is frozen, and
this glossary is the vocabulary for the backend and for what attaches to it.

## The backend

**mason**:
The backend: a durable agent engine plus the contracts an interface speaks — a signed event in, a delivery and a
transcript out, a control plane, an identity, a version. It defines one bot; it does not define a team of them.
_Avoid_: the bot, the app, the platform, the assistant

**interface**:
Anything that attaches to mason to reach a person: a chat integration, the operator console, a future client. An
interface speaks the backend contract; it never grows a private one.
_Avoid_: frontend, UI (for the abstract thing), channel

**client**:
A consumer of the wire that holds a pairing token: it is sent a transcript and may speak as a person. One kind of
interface, and the only one that keeps a session.
_Avoid_: frontend, UI, channel, app

**operator console**:
The web client in this repository, frozen: transcript inspection, debugging, and a fallback when the chat is
unreachable. Maintenance fixes only, no features.
_Avoid_: dashboard, admin UI, frontend

**sibling**:
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

**profile**:
Durable facts about the person the bot works for, kept current by the bot itself.
_Avoid_: user memory, memory, context

## The fleet

**fleet**:
Several separately deployed mason bots that may talk to each other. One container hosts one root bot conversation; a
second bot is a second container with its own home.
_Avoid_: team (that is the arrangement sibling shows), group, cluster

**A2A**:
Agent2Agent Protocol, the Linux Foundation standard for agent-to-agent communication: the peer-communication boundary
between separately deployed bots. The Agent Communication Protocol (ACP) merged into it in August 2025, so A2A is the
only peer standard mason speaks; it is carried by the deployments and independent of whether they share a VM, and
mason's own code grows no peer registry or router for it (`docs/FLEET-PLAN.md`).
_Avoid_: ACP (merged into A2A in 2025), calling it mason's protocol, or confusing it with the editor-facing Agent Client
Protocol

## The home

**home**:
The bot's own directory tree. It is split in two, and the split is the security boundary between the server and
the machine its tools run on.
_Avoid_: house, state dir, `.mason`

**agent-owned files**:
The part of the home the bot reads and edits with its own tools, on the machine its tools run on: profile, log,
journal, skills, worker definitions, workspace.
_Avoid_: user data, workspace (the workspace is one directory inside it)

**service-owned files**:
The part of the home the bot never sees: soul, roster, credentials, integration secrets, the database, keys.
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

**roster**:
The names a person may speak as in the room. An interface maps its sender onto one of them; none of them is a bot.
_Avoid_: team, users, members

## The prompt

**section**:
One named piece of the system prompt, rendered from a function before each model request.
_Avoid_: block, part, fragment

**resident**:
Text that is in the prompt on every request: soul, profile, skills index, the room.
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
The reader's input as the server receives it: the text, the mode it was sent with, and whether it still waits in the
queue.
_Avoid_: message (that is what is read afterwards), prompt, request

**hook**:
Something outside the conversation that can wake the bot: an integration event, a schedule slot, a gesture.
_Avoid_: trigger, event source, listener

**fire**:
One call into a hook, from an integration event, a schedule slot, or a gesture. A redelivery under the same identity
is still one fire.
_Avoid_: event, invocation, delivery

**routine**:
A hook that fires on a schedule.
_Avoid_: cron job, schedule, timer

**delivery**:
An outbound act committed before it is sent and sent once. It goes to the integration the turn came from, through the
message tool that integration's hook instruction names, or to the transcript when no chat is on the other end: the
operator door, or a hook that names no chat tool at all (a schedule, a retry), where the call lands and says nobody read
it. `send_to_user` is the console's delivery, and a turn that has a chat refuses it (`reader`).
_Avoid_: message, reply, notification (each names one shape of it)

**reader**:
Whoever a turn's words are for: the call that reaches them is what decides. The console's reader holds an operator token
and reads the projection — the frozen console today, sibling next. A turn an event hook started answers a person in a
chat instead, who reads only what that hook's own message tool sends, and `send_to_user` is refused there because a
call the chat cannot see is a message recorded as sent that nobody received. A hook whose instruction names no chat
tool has no reader at all until somebody opens the console. A reader is not an integration and never wakes the agent on
a vendor's behalf.
_Avoid_: client, user, frontend

## Integrations

**integration**:
Another system mason is connected to, and the only kind of thing that talks to it from outside. It has two halves, either
of which may be absent: tools it lends the bot, and a trigger that wakes the bot with its events. An integration that
carries a person's words is also the place a reply goes — there is no separate interface type
(`docs/adr/0005-there-is-no-interface-type.md`).
_Avoid_: connector, plugin, client, app, interface (that is a role an integration plays, not a kind of thing)

**trigger**:
The half of an integration that wakes the bot: one authenticated event becomes one fire.
_Avoid_: webhook, connector, source, listener

**envelope**:
The signed v1 body an integration posts to the trigger door: version, id, kind and a payload written for a person to
read. Unknown fields are ignored, so v1 only grows additively; an incompatible change becomes v2, and v1 is read
forever.
_Avoid_: payload (that is one field), event body, message

**tool surface**:
The tools one integration lends the bot, named before the conversation starts and fixed for its life.
_Avoid_: tool list, MCP server (that is the process, not the surface), plugin API

## The room

**person**:
A human with a name on the roster.
_Avoid_: user, member, teammate

**actor**:
Who caused a fire, an approval or a refusal: what the sender asserted, and what the record kept. An assertion, not an
identity, until a mapping makes it one.
_Avoid_: user (for the actor), author (that is the roster name on a message)

**device**:
One pairing: the token, the label beside it, and what a revoke kills. A person and a device are different things.
_Avoid_: session, phone

**room**:
The people present in one bot's conversation. mason has a room.
_Avoid_: team, channel

**team**:
Several bots arranged to work together, each with a profession, as sibling shows them. The deployment word is **fleet**;
a team is the arrangement, not the containers.
_Avoid_: room, group, or **fleet** when you mean the deployments

## Workers

**worker**:
A conversation owned by one tool call, given a narrow job and a small context, that returns a report. A tool, not
a peer: it has no home, no name in the room, no way to speak to anyone, and no A2A link. It is never a mason
deployment.
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
The whitelist that turns a conversation into a transcript. Anything it does not name does not cross the wire.
_Avoid_: serializer, mapper, view
