# mason defines one bot per deployment

**Status:** Accepted, amended 2026-11-02 and after the multi-user work was parked.

Mason models one bot: one identity, one home, one toolset, and one person it works for. A group of bots, their shared
orchestration, and communication between deployments are outside this runtime's scope. Anything that needs to know
about another bot — a peer registry, router, cross-agent messaging, or reporting hierarchy — does not belong here.

## Consequences

- **One person speaks to one bot.** A connector carries the person's words and declares one `owner` actor, whose words
  are the owner's and who may drive the controls. The former room, roster, and `/join` path have been removed.
- **A worker is not a bot.** It has no home or identity of its own, no routines, and no way to message anyone. Delegation
  stays work performed by the bot, not a second deployment.
- **The bot's role lives in its soul.** A deployment supplies its own `soul.md`; Mason ships a default. There is no
  separate role field.
- **Mason organises its own work, not other bots'.** Triage, delegation to a worker, and answering the person belong
  here. Supervising peer bots does not.

## Amendment: no fleet, no peer protocol

An earlier proposal gave bots separate professions and made separately deployed bots speak A2A to each other. It was
not built and is not planned. Mason has no peer discovery, registry, router, message bus, or cross-agent message store.
A deployment is one bot for one person; a second bot is a second deployment that this repository does not need to know
about.

A bot's profession is one job, expressed through its soul, skills, and routines. A deployment says who it works for in
`agent/profile.md` and what it may reach in `service/integrations.json`. Mason ships neither as a fixed identity.
