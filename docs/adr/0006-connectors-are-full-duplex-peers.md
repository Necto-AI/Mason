# A connector is a full-duplex peer; mason is the only thing in the middle

**Status:** Accepted, amended 2026-11-02 (what #101 shipped, and the two places it simplified this proposal)

**Date:** 2026-10-26

**Revisited if:** a connector needs a channel this contract does not have (a write, a file, a presence the agent must
react to), or if a second person needs to share one bot — which is a different decision (`docs/adr/0001-mason-defines-one-bot.md`).

ADR-0003 made an integration a service with two halves. ADR-0005 removed the interface type and gave an integration a
voice. This decision finishes the job Denis asked for: **one way in, for every surface, including the app that shows the
transcript** — and it costs two things that have to be named before anything is built.

## The proposal, stated plainly

Today there are two kinds of external participant and two channels:

- an **integration** speaks to mason twice — MCP tools it lends, an HMAC event door it posts to — and receives nothing
  else;
- a **reader** (the frozen console, sibling next) holds an owner token, opens a Chord socket, and gets the projection live.
  That is a second protocol for the same relationship: a surface that shows the agent and takes the person's words.

Denis's proposal, which is the right one: **collapse them.** A connector is a process that (1) delivers events, (2) lends
tools, (3) subscribes to the session state it needs to render, and (4) is where a reply goes. A chat is a connector. A web
app is a connector. A mailbox is a connector. Mason has one contract and one door, and sibling stops being special — it is a
connector with an `sibling` flavour, holding its own credential, and the same bot could appear in two people's sibling
accounts because nothing in mason's contract says "one surface per person".

## Decision

1. **`send_to_user` is removed as a mason-owned channel.** A delivery is the origin connector's reply tool. `src/server/extensions/delivery.ts` keeps exactly two jobs, both about the *turn* rather than the medium: refusing a nested delivery, and never replaying one after a restart.

2. **A turn always knows its origin, and the reply is routed there.** Mason keeps one tool the model calls — `reply` — because a prompt must never name a vendor's tool and a schedule has no origin tool in scope. `reply` dispatches to the origin connector's declared reply tool, to the transcript when the origin is the operator door, and refuses with a sentence when the origin cannot receive (a one-way webhook, a routine with no named target).

3. **An entry carries a prompt section.** `integrations.json` gains a short, operator-authored `prompt` per connector: what it is for, how to use it, what not to do with it. It is injected once per turn, from the file, never from the remote server: an MCP server that could write into the system prompt would be writing instructions an operator never approved. A budget (400–600 characters) keeps the section a paragraph rather than a manual, and the skills index stays the place for depth.

4. **A connector subscribes to what it renders, and only that.** State is capability-scoped, per entry:

   | Capability | What it yields | Who needs it |
   |---|---|---|
   | `status` | run status, queued count, integrations connected | every connector, including one that only types dots |
   | `projection` | the whitelisted transcript, entry by entry | a surface that shows the conversation (console, sibling) |
   | `presence` | "this chat is being worked on", start/stop | a chat |
   | `tools` | the tool calls a turn is making, names only | a rich surface; never arguments or output |

   The whitelist in `src/server/projection.ts` remains the gate: a connector with `projection` reads what the console
   reads today, and one without it reads nothing. No capability yields the conversation itself.

5. **Credentials follow the capability.** A connector credential is a token (hashed in `config.json`, revocable, read per
   request) bound to its entry, with the entry's declared powers: `events`, `tools`, `state: [...]`, `commands: [...]`. The
   HMAC secret stays as the signature on an event body, because a shared secret proves a sender without a session; it is
   not a credential a session can be opened with.

6. **The operator door remains, and shrinks to the control plane.** Mason still needs one way to manage itself — roster,
   tokens, integration entries, hooks on and off, the run — that is not a connector's to do: a connector manages its own
   medium, never mason's configuration. sibling uses the operator door for that and the connector contract for the
   conversation. That is two roles in one app, which is honest, and the alternative is giving a connector the power to
   re-mint credentials.

## What this costs, and the one thing it cannot do

- **A browser cannot be a connector.** A connector is a process that accepts MCP calls and subscribes to state; a page
  cannot. sibling therefore keeps a small server-side connector (or its existing token door) between the browser and mason.
  This is not a wart to remove later: it is what "the app is a client of mason" means, and it is why the frozen console
  has a token at all.
- **Multi-user is a bigger decision than plumbing.** "The same bot in two people's sibling accounts" is two questions:
  *whose* credential pays for a turn, and *whose memory* a turn writes to. Mason today is one home, one identity, one
  conversation (`ADR-0001`). A connector contract can carry several people; the home layout cannot, yet. That is a separate
  ADR and it is not required for anything in the current plan.
- **A vendor prompt section is a prompt-injection surface with a lock on it.** The lock is that only the operator writes
  it, in a file that is already trusted; the moment a connector may send its own prompt text, the system prompt is a
  remote-controlled document.

## What changes in the plan

`BACKEND-PLAN.md` milestone 1 becomes: voice and capabilities on the entry, origin on the fire, `reply` as the router, and
the prompt section — with `send_to_user` deleted in the same milestone rather than kept. Milestone 2's event channel gains
the connector subscription, so one contract carries what Chord carries for the console today.

## Amendment, same day: the reply is a router with a fan-out, not a broadcast

Denis's refinement, kept because it is right and because it hides two different things behind one flag.

**A connector may receive the reply as a reply, so several surfaces show what the bot said.** That sentence covers two
acts, and they must not share a setting.

1. **A display mirror needs no mechanism at all.** Every reply is committed to the transcript before it is sent, and a
   connector that declares `state: ["projection"]` reads it. sibling showing the Telegram conversation is not fan-out: it is
   the projection, which is exactly why one bot can be used from two surfaces without a second protocol. Nothing to build
   beyond the capability in §4 of this ADR.
2. **A delivery fan-out is a different act with a different audience.** "Also send this to Slack" makes another
   application buzz, and the people in it are not necessarily the people in the chat that asked. So it is opt-in per
   connector and stated on the entry — `also: ["slack"]` beside `reply` — and the default is the origin alone.

One rule binds the second: **a reply is never fanned out of a private conversation into a space that speaks to more than
one person without being asked.** The entry knows which it is (`speaks: "person" | "service"`), so the refusal is a
boot-time check rather than a runtime guess.

**Why not `mirrors: true`.** If one boolean meant "send everywhere", the first bug would be a direct message arriving in a
team channel and the second would be the same person notified twice in two apps for one thought. Two acts, two words.

## Amendment, 2026-11-02: what shipped, and where it differs

`#101` built the server half of this decision (`src/server/connector.ts`, `src/server/connectors.ts`,
`src/server/replies.ts`, `docs/SPEC.md` §4.1d). Three things are as proposed and worth naming because they are the load
bearing ones:

1. **One reply operation.** `send_to_user` is gone; `reply` is the only call a turn makes to reach a reader, and no
   prompt or hook instruction names a vendor's tool. The projection reads the `app.reply` entry rather than the call, so
   a streamed message and a committed one cannot become two rows.
2. **The origin is structured, never prose.** A submission is an `app.connector` entry carrying its origin; a fire that
   named a conversation carries one on its `app.hook` entry. The tool reads the newest input entry from the transcript,
   which is what makes routing survive a restart, a compaction and a queued steer.
3. **The credential follows the entry.** One Mason-issued credential per connector, hashed in `config.json`, read on
   every upgrade; a revoke lands on the next connection. It opens the socket and the attachment endpoints and nothing
   else.

Two places where the implementation is simpler than this document proposed, both deliberate:

- **No declared reply tool.** §2 above said `reply` dispatches to the origin connector's declared reply tool. What
  shipped is the protocol's own delivery: the reply is committed, and the outbox sends `connector/delivery.final` with a
  `deliveryId` and an acknowledgement. A connector declares no tool for it, because a tool name is the one thing the
  protocol exists to keep out of the model's mouth, and the delivery already has a durable identity and an honest
  `uncertain` answer. The vendor's message tool remains available as an ordinary MCP tool for extra actions, subject to
  the permission gateway in `#102`.
- **No delivery fan-out, and no `also`.** The amendment below proposed one, with a `speaks` guard. v1 of the protocol
  says a reply reaches one target and a projection subscriber displays it without causing a send, so the `also` list
  and its guard have nothing to guard yet. Fan-out would be a protocol change, and the place to argue for it is a
  connector protocol major, not an entry's field.

Still owed by later slices: the per-entry `prompt` section (§3) waits for the admin panel (`#103`), which is where an
operator writes it; the tools face's live discovery and the permission gateway are `#102`; and the HMAC event door and
the old Telegram relay are removed in `#104`. Until then the old door's fires carry no origin, so a turn it starts
records its reply and reaches nobody — the honest state of a half-migrated deployment, and the reason the connector is
the path to build on.
