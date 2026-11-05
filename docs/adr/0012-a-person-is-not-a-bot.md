# 12. A person is not a bot

**Status:** Accepted — decided by Denis, 2026-11-03; the home change lands with the 0.1.0 repackage
**Date:** 2026-11-03

## Context

ADR-0001 fixed one deployment as one bot: one identity, one home, one profession. In that home, `agent/profile.md`
holds the durable facts about the person the bot works for, kept current by the bot itself.

That is right for one person with one bot, and it stops being right the moment one person wants three: a bot for
university, a bot for work, and the one that already runs. The facts about *him* then exist three times, inside three
memory repositories, and each bot re-derives what the others already know. A second person on the same machine breaks
it differently: her facts live inside her bot, so a bot that works for two people has no one place to read.

The thing being duplicated is not the bot. It is the person.

## Decision

**A person is a directory. A bot is a home. One person may own several bots.**

- `~/people/<name>/profile.md` is what mason knows about one person, and every bot that works for them reads the same
  file. `~/people` is a git repository per person, mounted into the tool machine at the same absolute path in every bot
  (`MASON_PEOPLE_DIR`, default `~/people`), so a path the server sends is a path the agent reads. The history of what
  the bots believe about a person is one history, reviewable and revertible, rather than a side effect of whichever bot
  ran.
- **Bots write it.** The profile is an artefact they construct and curate over time, not a form a person fills in. This
  is the existing rule in `GLOSSARY.md`, moved somewhere it can be shared; what makes it safe with several writers is
  that every change is a commit.
- **The write is a commit.** A bot changes the profile the way it changes its own memory: read, edit, commit. Two bots
  writing one person means two commits to one repository, and the person reads the log. There is no lock: the window
  is small and the file is small, and a lost edit shows up in `git log` rather than disappearing into a silent merge.
- **Memory stays per bot.** `log/` and `journal/` are this bot's experience. A fact another bot would need belongs in
  the profile; a fact about what this bot did belongs in its log. That line is why the profile is not a second log.
- **One workspace per bot.** Two bots in one working directory erase each other's evidence. Sharing files is a mount a
  person adds deliberately, never a default.
- **One bot per process.** A fleet is several mason processes, each with its own home, port and connector credentials,
  on one machine or several. Mason grows no supervisor and no multi-bot mode: the process is the isolation unit
  (ADR-0001, ADR-0009), and a control plane that runs several bots is a client that starts and watches those processes.
- **One execution machine is shared by pointing at it.** Each bot runs its tools on its own `pi-env` daemon on the same
  box (`MASON_ENV=ssh://…`). What is shared is the machine, not a daemon process, and bots that must not read each
  other's files do not share a box without a container each.

## Consequences

- `agent/profile.md` leaves the home. `npm run doctor -- migrate` moves it to `people/<name>/profile.md`, and names the
  person it inferred when the home does not say which one the bot works for.
- The prompt's profile section reads the people directory. A home bound to no person falls back to the roster's one
  entry, or to the only directory under `~/people`, and says which it chose.
- Creating a person is a person's act (`mason person add`), not a bot's: a bot may extend what mason knows about an
  existing person and may not invent one, which is the same rule as the vault.
- The fleet, its supervision and its ports become a deployment concern (ADR-0004): nothing in `src/server/` learns to
  run two bots.
