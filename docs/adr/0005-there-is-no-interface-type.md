# There is no interface type; there is a direction and a voice

**Status:** Proposed

**Date:** 2026-10-26

**Revisited if:** a surface needs a door, a table or a prompt section of its own — or if a reply path is ever addressed to
a vendor by name again.

ADR-0004 decided mason is a headless backend and that "every interface is an integration — a signed trigger in, a tool
surface out — and none of them, Telegram included, is a privileged code path". The code half-honoured it. What is left
disagrees with it in two places, and both are worth naming before more is built on top.

**`send_to_user` is a second reply path.** `src/server/extensions/delivery.ts` defines a mason-owned tool whose delivery
is a transcript entry, which the operator console renders. An integration's tool (`mcp__telegram__send_message`) reaches a
person the other way, through the vendor. So the same act has two homes, and the agent is told which to use by a hook
prompt that names the vendor: `src/server/hooks.ts` says "answer it there with mcp__telegram__send_message". A second
chat integration makes that sentence wrong, a third makes it absurd, and none of it is what a backend should know.

**The vocabulary still has an interface in it.** The plan in [`../BACKEND-PLAN.md`](../BACKEND-PLAN.md) put capability on
"the interface", as though an interface were a thing with a type. It is not: it is an integration that happens to carry a
person's words.

## Decision

**An integration is the only way in, and an integration may be a chat, a mailbox, a build system or a screen.**

1. **The entry declares the voice, not the interface.** `integrations.json` gains two fields:
   `speaks: "person" | "service"` (whose words these are) and `capabilities: { render: ["text", "image", "file"], interact:
   ["reply"], live: false }` (what the medium can carry). The hook prompt is built from them. No prompt names a vendor
   again, and the same `team-chat` hook serves Telegram, Slack, mail and a console.

2. **A fire carries its origin, and a reply is addressed to the origin.** The event door already knows which integration
   signed the envelope; that name travels with the fire, reaches the prompt as a field the model never has to invent, and
   is what a reply targets. The conversation's context carries it, so a turn that spans several tool calls answers the
   same place it came from.

3. **`send_to_user` stops being a channel and becomes the router.** One tool, one meaning: deliver to the origin
   integration's reply tool when it has one; to the transcript when the origin is the operator door (a person watching the
   console); refuse, with a sentence the model can act on, when the origin has no reply path — a scheduled wake or a
   webhook from a service that only speaks inbound. The extension keeps what it is good at: refusing a nested call, and
   never replaying a delivery after a restart.

4. **Two doors, and their names say what they are.**
   - The **event door** is an integration's: `POST /api/events/<integration>` and the MCP tool surface. HMAC or MCP
     session; a declared set of powers (fire the hook its trigger names, issue a declared command); never a read.
   - The **operator door** is a reader's: a token spent into an `HttpOnly` session cookie, the Chord socket and
     `/api/*`. It reads the projection and controls the run. apiary is this door's next client; the frozen console is its
     current one.
   A reader is a category, not an interface: reading what the agent did is a different power from waking it, and it is the
   one power an integration must never hold, because a secret that can read the transcript is a secret that can read
   everything.

## What this settles

**Your reading is right, with one correction.** Integrations are the only things that talk *to* mason, and replying is
theirs; the "interface" distinction disappears. What does not disappear is the reader: something has to show a person what
the agent did, transcript and all, and that something holds a credential of its own. So auth does not become
connector-only — it splits, and it was always two powers wearing one name:

| | Event door | Operator door |
|---|---|---|
| Who | an integration | a reader (console today, apiary next) |
| Credential | HMAC secret, or the MCP session it was paired with | token → `HttpOnly` cookie, `Origin` checked |
| May | fire its hook, issue its declared commands | read the projection, control the run, manage hooks |
| Must never | read the transcript | wake the agent on behalf of a vendor |

The browser session exists for one reason that has nothing to do with architecture: a browser cannot hold a bearer token
safely, so the token is spent once and exchanged for a signed cookie. An integration has no browser and needs no cookie.

## What it costs

- **Every fire needs an origin.** A schedule and a manual gesture have none, and each has to say what happens when the
  turn wants to speak: a routine names a target integration in its definition, and a gesture from a console answers the
  console.
- **A prompt written for one medium stops working for another** unless the capabilities are honest. `render: ["text"]` for
  a chat is a promise the model can be told; a surface that quietly supports more is a surface whose capabilities nobody
  maintains.
- **The projection stays a whitelist.** Nothing here loosens it: an operator reads what `projection.ts` derives, and an
  integration still reads nothing.

## What it does not change

`modules`/houses, the home split, the durable log, the roster, the event envelope's shape, and the rule that a trigger
secret is not a token. This decision removes a duplicate, it does not open a door.
