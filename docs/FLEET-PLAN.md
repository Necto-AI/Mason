# Several bots: separately deployed, ACP between them

> Written 2026-11-02, from the product decision in [`SPEC.md`](SPEC.md) §1. This replaces the peer-to-peer design the
> apiary plan carried: a custom delegation envelope, Chord as a same-host transport, and A2A compatibility later. None of
> that is invented here. Bots are separate mason deployments, they talk through the Agent Communication Protocol, and
> apiary organises and observes them without being in the path.

## What a fleet is

**One mason container is one bot.** A bot has one home, one conversation, one soul and the integrations its profession
needs. A container never hosts several root bot conversations under one server: that would make the home, the roster,
the credentials and the conversation one object for several identities, which is exactly the confusion
[`adr/0001-mason-defines-one-bot.md`](adr/0001-mason-defines-one-bot.md) exists to prevent.

**A fleet is several of those, deployed separately.** The second bot is a second container with its own home, its own
soul, its own integrations and its own ACP address. Nothing in mason has to learn what a fleet is for that to be true:
the unit was already one bot.

**A worker is not a fleet member.** A worker is a conversation a tool call owns inside one bot — browser work, bulk
reading, a long form fill. It has no home, no roster name and no ACP link, and it never becomes addressable by another
bot.

## The boundary is ACP

**ACP means Agent Communication Protocol**, not the editor-facing Agent Client Protocol. It is the standard
peer-communication boundary between mason bots, and this is the decision that replaces everything the earlier plan
proposed:

| Earlier plan | Now |
|---|---|
| a mason-defined envelope: `{v, id, from, to, kind: "delegate", task, budget, replyTo}` | ACP's own message and task shapes carry it; mason does not invent a peer protocol |
| Chord between masons on one host, HTTPS across hosts | one transport, whichever binding ACP settles on; the host topology is not the protocol |
| "shape it to be A2A-compatible later" | A2A is not the direction; ACP is the boundary now |
| apiary as the router that lets bots reach each other | apiary organises and observes the fleet; the message does not pass through it |

What the earlier design got right and stays: **a delegation is a task, not a conversation.** It lands somewhere the
receiving bot tracks, produces at most one answer per request, is idempotent by its identity, and never makes two bots
chat at each other in a loop. **A budget is part of the request**, because a bot that can spend another bot's money
without saying how much is not safe to leave running. **Default: no peers.** A bot accepts a message from a bot a person
added, and from nothing else.

What is not decided here: which ACP specification version and SDK carries the exchange, how peer identity and
authorisation map onto it, and how the approval and budget messages ride on it. Those are [`SPEC.md`](SPEC.md) open
question 1, and the answer belongs to the implementation, not to this note.

## One manifest may launch the group

A deployment of several bots should be one declarative thing: the bot containers with their homes, volumes and
integrations, the ACP connectivity between them, and — when the second environment stage exists — an optional shared-VM
supervisor. **Docker Compose is the first candidate**, because the stack is already compose files and a person can read
the result; it is not a requirement, and it should not be built before a prototype proves the fleet it describes.

Two rules that outlive the choice of format:

- **The manifest describes containers, not bots.** A bot is a home and a soul; a container is where it runs. A future
  format that cannot say "these two bots share this VM" without merging their containers is the wrong format.
- **Nothing is armed by default.** Adding a second bot to a manifest does not give it peers, credentials or a shared VM.
  A shared VM is named on purpose, per group.

## Sharing one VM is a second stage, and a choice

The environment track is strictly ordered (`docs/adr/0009-firecracker-first-then-a-shared-vm.md`): first one bot's tool
machine is a Firecracker VM, then the target becomes configurable so a chosen group of bots shares one. Sharing is
configurable, not mandatory, and it is the cheap option rather than the safe one:

- **Bots in one VM share one operating-system trust domain.** Their homes, conversations and credentials stay logically
  distinct, but they share a kernel, a root filesystem and a mount table. A defect in one bot's tool use is a defect in
  its neighbours' environment.
- **ACP does not change.** The peer protocol is the same whether the bots are on one VM or two, so the topology decision
  is reversible without touching the protocol.
- **The service half never enters the guest.** `soul.md`, the roster, the credentials and the database live in
  `service/` on the server, outside every VM, shared or not (`docs/adr/0002-split-home.md`).

## The second bot is a decision, not a step

The next bot after the application bot is **a chief of staff**, and it is deferred until the first bot is useful and a
second specialist exists to talk to. When it comes it is an ordinary mason: a soul that says what it is for, its own
integrations, and ACP to the bots it works with. It does not become a runtime layer above the others, it does not read
their transcripts, and it is not a new interface type.

**Attention routing is deferred with it.** Which messages reach Denis directly and which are consolidated is a design
that needs two bots and a real exchange to be worth writing down; designing the notification hierarchy first is how a
fleet becomes noise.

## Order of work

| # | Step | Done when |
|---|---|---|
| 0 | One bot is useful | the application bot runs the internships-and-fellowships job end to end, with approval before submission |
| 1 | A second bot exists with a real job | a chief of staff or another specialist runs as a second container with its own home, feeding on the first bot's reported state |
| 2 | ACP between them | one request crosses two deployments, gets one answer, and is idempotent under redelivery |
| 3 | A manifest | one declarative file brings up both containers, their homes and their ACP connection, with no hand-edited state |
| 4 | Shared VM | the same manifest can place a named group in one Firecracker VM, and says in one line what that VM shares |

Steps 0 and 1 are product work. 2 to 4 are not started, and none of them is worth starting before the bot it serves is
used.

## Not in this plan

- Implementing ACP, peer discovery or cross-bot delegation.
- A fleet-management UI in mason. apiary is where a person organises several bots, and mason's job is to be a bot.
- Notification and attention routing between bots.
- Multi-user bots (several people sharing one home). That is a different decision, and it is not required for a fleet of
  specialist bots — each bot still serves Denis.
