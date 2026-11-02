# mason defines one bot; sibling defines a team

> **Amended 2026-11-02** — a bot has one profession, and peers speak A2A rather than sibling carrying the message; see
> the amendment at the end. The split itself is unchanged.

mason is one bot — an identity, a home, a toolset, a way of reaching a person — and a worker is one of its tools. A
group of bots, each with a profession, plus the delegation and conversation between them, is sibling's subject, and
sibling will run several bots built from this codebase. We split it here because the two layers keep being confused:
anything that needs to know about *another bot* (a peer registry, a router, cross-agent messaging, who reports to
whom) does not belong in mason, no matter how natural it looks in a prompt.

## Consequences

- **"Team" means bots; "room" means humans.** The roster, `/join`, and the author on a message are a room — plural
  people talking to one bot — not a team. `docs/ROOM-IDENTITY.md` keeps the older word in its prose, because it is the
  record of what was decided then; `GLOSSARY.md` is the authority.
- **A worker is not a bot.** No home, no roster name, no hooks of its own, no way to message anyone. That is the test
  for whether a piece of delegation belongs here or in sibling.
- **The bot's role lives in its soul.** A deployment (sibling included) hands each bot its own `soul.md`; mason ships a
  default. There is no separate role field.
- **mason organises its own work, not other bots'.** Triage → delegate to a worker → answer the person stays; a
  supervisor over peers does not.

## Amendment, 2026-11-02: a bot has one profession, and peers speak A2A

Two things changed around this rule. The rule itself did not.

**A bot has one profession.** "One bot" was always an identity, a home, a toolset and a way of reaching a person; it is
now also a scope. The soul, the skills, the routines and the integration grants are chosen for one job, and the bot
running today is the application bot — internships and fellowships, approval before submission (`docs/APPLICATION-PLAN.md`).
It is not a general assistant with a role label, and a second profession is a second deployment rather than a mode.

**Peer communication is no longer sibling's alone.** The rule above still holds: mason grows no peer discovery, no
registry, no router and no cross-agent message store. A list of accepted peers is operator configuration read like
`integrations.json`; it is not a registry. What changed is who carries a message between two bots. It is not sibling
and not a custom envelope: separately deployed mason bots talk through A2A, the Agent2Agent Protocol, a standard
boundary that the deployments carry (`docs/FLEET-PLAN.md`). This amendment first named the Agent Communication
Protocol; that protocol merged into A2A under the Linux Foundation in August 2025, so A2A is what the decision points
at. sibling organises and observes the fleet, shows what a delegation did, and is still not the bus. A2A is independent
of the execution-environment topology — two bots use it whether they share one VM or have their own — and the
shared-VM case is one operating-system trust domain, so it is an isolation simplification, not a security one
(`docs/adr/0009-firecracker-first-then-a-shared-vm.md`).

**A worker is still not a peer.** It gets no A2A link, no home and no identity to be addressed by. The test for whether
something belongs here is unchanged: if it needs to know about another bot, it is the fleet's business.
