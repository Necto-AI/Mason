# mason

mason is one bot: an always-on agent with an identity, a home, a toolset and a way of reaching the
person it works for. This glossary is the vocabulary for what a bot is made of.

## The bot

**mason**:
The software in this repository. It defines one bot; it does not define a team of them.
_Avoid_: the agent, the assistant, the system

**bot**:
One deployed mason: one identity, one home, one conversation, one set of tools.
_Avoid_: agent, instance, assistant (an *agent* in pi's sense is a conversation's resolved prompt and tool set)

**soul**:
The bot's job and personality — what it is for, how it speaks, what it declines. Set by whoever deploys it.
_Avoid_: persona, system prompt, SYSTEM.md

**profile**:
Durable facts about the person the bot works for, kept current by the bot itself.
_Avoid_: user memory, memory, context

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
The names a browser may claim as the author of what it says. People, not bots.
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

**hook**:
Something outside the conversation that can wake the bot: an integration event, a webhook, a schedule.
_Avoid_: trigger, event source, listener

**fire**:
One delivery from a hook. A fire that repeats is still one fire.
_Avoid_: event, invocation, delivery

**routine**:
A hook that fires on a schedule.
_Avoid_: cron job, schedule, timer

**delivery**:
The one path by which anything reaches a person. A turn with nothing worth saying delivers nothing.
_Avoid_: message, response, output

## Integrations

**integration**:
Another system mason is connected to. It has two halves, either of which may be absent: tools it lends the bot, and
a trigger that wakes the bot with its events.
_Avoid_: connector, plugin, client, app

**trigger**:
The half of an integration that wakes the bot: one authenticated event becomes one fire.
_Avoid_: webhook, connector, source, listener

**tool surface**:
The tools one integration lends the bot, named before the conversation starts and fixed for its life.
_Avoid_: tool list, MCP server (that is the process, not the surface), plugin API

## The room

**person**:
A human with a name on the roster.
_Avoid_: user, member, teammate

**device**:
A browser that holds a pairing token. A person and a device are different things.
_Avoid_: client, session, browser

**room**:
The people present in one bot's conversation. mason has a room.
_Avoid_: team, channel

**team**:
Bots organised to work together, each with a profession. sibling has teams; mason does not.
_Avoid_: room, group, fleet

## Workers

**worker**:
A conversation owned by one tool call, given a narrow job and a small context, that returns a report. A tool, not
a peer: it has no home, no name in the room, and no way to speak to anyone.
_Avoid_: subagent (that is the API), helper, child bot, delegate

**agent definition**:
The file that says what a worker is for, which tools it may use, and what shape its report takes.
_Avoid_: prompt, config, role

## The wire

**transcript**:
What the reader is sent: messages, tool activity and status, derived from the conversation.
_Avoid_: conversation, history, chat log

**projection**:
The whitelist that turns a conversation into a transcript. Anything it does not name does not cross the wire.
_Avoid_: serializer, mapper, view
