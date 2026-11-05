# mason is a headless backend; interfaces attach to it

**Status:** Accepted. The console this decision kept, and then the operator panel that replaced it, are both gone.

**Date:** 2026-10-26

**Revisited if:** a contract here cannot carry the interface it has to — an interface that needs a route, a table, a
prompt section or an entry kind of its own — or if mason is asked to own a client again.

mason is one bot for one person: one identity, one home, one conversation, one set of tools
(`docs/adr/0001-mason-defines-one-bot.md`). The thing worth building here is not a screen. It is a durable, always-on
engine plus a small set of deliberate contracts that anything can speak to — the connector socket carrying a
submission in and a reply out, the tool catalog, the home, a credential — and an interface is a thing that attaches to
those contracts and can be replaced without the backend noticing. Everything in the repository is sized for that. For a
while the largest thing in it was a client instead: a React application in `src/web/`, then an operator panel, built one
feature at a time on the server's own socket. Both are removed. A backend is judged by its contracts and their
guarantees, not by a screen it happens to own.

Telegram is therefore the first interface, and the cheapest way to test the backend in the place the person actually
is. It costs mason no ingress at all: the interface is a connector, so it opens an outbound socket to mason and asks
for nothing back (`docs/adr/0006-connectors-are-full-duplex-peers.md`). Nothing is published, no certificate is
terminated, no reverse proxy sits in the path, and no browser has to be paired. Notifications and mobile reach arrive
with an application the person already carries in a pocket, so a proactive turn is read on a phone at the hour it
happens rather than in a tab nobody opened. The place is also the test: an answer is read in the chat it will be read
in, by the person it was written for, which is a stronger check of the delivery contract than a transcript rendered on
the machine that produced it.

What that costs is real. Telegram is a third party in the path and, on this host, a third party behind a VPN: the chat
is unreachable when the tunnel is down, and the interface goes down with it. A chat has no composer, no dictation and
no sandbox for a rendered card, and every answer becomes a message in somebody else's history, in an application that
is not ours to keep. A chat is a demanding and narrow consumer of the contract, which is why it is a good first one:
whatever survives it is a contract, not a chat feature.

## Decision

mason is a headless, always-on agent backend: a durable agent engine plus a small set of deliberate contracts that
interfaces attach to. Telegram is the first interface and the cheapest way to test those contracts, not the definition
of the product. sibling is the intended rich client and the multi-agent future; it integrates with mason as a backend
rather than replacing it, it owns the panel an operator reads, and it will depend on the contract — so the contract, not
the screen, is what mason invests in. Every interface is a connector: a socket, a grant, and no privileged code path.
The decision is written about the backend and not about Telegram on purpose: the interface is the part expected to
change, so the day this repository has no Telegram in it, this still holds.

## Consequences

- **The inbound contract is a product surface.** Words and events arrive the same way, over the connector socket, with
  a stable id, a budget and a cap (`docs/SPEC.md` §4.1d). A new interface is written by opening that socket; the
  mason-side change it may need is a grant, never a route.
- **The outbound contract is one delivery.** `reply` commits an `app.reply` entry and the outbox sends it to the turn's
  origin: one operation, so what reaches the person and what the projection records cannot disagree.
- **The control contract is what a person drives.** `stop`, `compact`, `clear` and `status` are the vocabulary a
  connector's grant may carry, and the agent's own routines are a file it edits rather than a surface a client owns.
- **Observability is part of the contract.** A fire, a turn, a delivery and a refusal each leave a fact — in the
  transcript, in the durable entries, in the `[cache]` line and in the log. An operator reading sibling and an operator
  reading a chat must be able to get the same answers, or the backend is only observable through one of its
  interfaces.
- **The versioning policy is explicit because a consumer lives outside this repository.** Within a version, changes are
  additive: an older reader ignores a key it does not know and an older sender simply omits it, so nothing has to move
  at once. Anything incompatible is a new version with a deprecation window, decided here and not negotiated by
  whichever client notices first.
- **sibling integrates; it does not replace.** sibling adds bots, clients and orchestration above this backend and reads
  the transcript through the wire contract mason defines. A change that would break that contract for a consumer
  outside the tree is a change sibling makes in sibling, or a new version agreed here.

## Alternatives considered

- **Treat Telegram as the product definition: "the Telegram bot".** The interface would then own the vocabulary, and
  every contract decision would be made against one vendor's shape. Telegram is the first consumer of the contract and
  the cheapest way to test it; it is not its author.
- **Keep a client in this repository.** It was kept once as a frozen console and once as a panel, and both were the
  larger half of the tree while the contracts sibling will depend on stayed implicit. sibling is where a client belongs.
- **Wait for sibling's client before writing the contracts down.** The contracts already exist in code and are already
  being consumed; leaving them implicit means sibling discovers them by breaking them, and mason discovers the break in
  production.
- **Bring multi-bot to mason now.** Refused by `docs/adr/0001-mason-defines-one-bot.md`, and refused again here for a
  second reason: a team of bots behind a backend whose contracts are still implicit is two unfinished things instead of
  one sound one.
