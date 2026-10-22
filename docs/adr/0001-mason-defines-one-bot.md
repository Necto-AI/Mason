# mason defines one bot; sibling defines a team

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
