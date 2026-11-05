# mason defines one bot; sibling defines a team

**Status:** Accepted, amended 2026-11-02 and again after the prune

mason is one bot — an identity, a home, a toolset, a way of reaching a person — and a worker is one of its tools. A
group of bots, each with a profession, plus the delegation and conversation between them, is sibling's subject, and
sibling will run several bots built from this codebase. We split it here because the two layers keep being confused:
anything that needs to know about *another bot* (a peer registry, a router, cross-agent messaging, who reports to
whom) does not belong in mason, no matter how natural it looks in a prompt.

## Consequences

- **One person speaks to one bot.** A connector carries the person's words and declares one `owner` actor, whose words
  are the owner's and who may drive the controls. "Room" was once a second notion here, with a roster and a `/join`
  path; both are gone, and `GLOSSARY.md` is the authority on what a word means now.
- **A worker is not a bot.** No home, no identity of its own, no routines, no way to message anyone. That is the test
  for whether a piece of delegation belongs here or in sibling.
- **The bot's role lives in its soul.** A deployment (sibling included) hands each bot its own `soul.md`; mason ships a
  default. There is no separate role field.
- **mason organises its own work, not other bots'.** Triage → delegate to a worker → answer the person stays; a
  supervisor over peers does not.

## Amendment: no fleet, no peer protocol

An earlier amendment gave a bot one profession and made separately deployed bots speak A2A to each other, with sibling
observing the fleet. Neither was built and neither is planned. What stands is the rule: mason grows no peer discovery,
no registry, no router, no message bus and no cross-agent message store. A deployment is one bot for one person, and a
second bot is a second deployment that nothing in this repository has to know about.

A bot's profession is still one job, and the soul, the skills and the agent's own routines are chosen for it. There is
no built-in profession to be pinned to: a deployment says who it works for in `agent/profile.md` and what it may reach
in `service/integrations.json`, and mason ships neither.
