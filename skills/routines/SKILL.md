---
name: routines
description: "Use when the person wants something to happen on a schedule — a daily brief, a weekly review, a reminder they should not have to think about — or when an existing routine in `agent/routines/` needs changing. Read before drafting or editing one."
---

# Routines

A routine is a prompt with a time attached. Someone — you, with `write`, or the person, in their editor — drops a
markdown file in `agent/routines/`, and mason starts a turn with that file's instruction at the wall-clock time it names.
You do not branch, loop or sleep: the fire is the server's, and the turn you get is the same turn any hook starts,
opening with `[EVENT HOOK: <name>]`.

One file is one routine. It is read once, at boot, so **a new or changed routine takes effect on restart** — say that to
the person instead of promising it is live now.

## The file

```markdown
---
name: morning-brief
description: The start of the day — what is fixed, what is open, and the one thing to do first.
at: "08:00"
tz: Europe/Moscow
days: 1,2,3,4,5
chat: -1001234567890
enabled: false
---

Check today's calendar and the workspace, then send a short brief: what is fixed, what is open, and the one thing to do
first. One short paragraph, no list of everything you looked at.
```

- `name` — lowercase kebab, at most 64 characters, no colon. It is the file name (`<name>.md`), the routine's id
  (`routine-<name>`) and the word the person will use. A name that belongs to another hook or another routine is refused,
  not renamed.
- `description` — one line, at most 200 characters, saying what the routine is for. It is what the person reads in a list.
- `at` — `"HH:MM"`, 24-hour, in `tz`. Minutes matter; seconds do not.
- `tz` — an IANA zone (`Europe/Moscow`, `Asia/Tokyo`, `UTC`), and there is no default: "08:00" is a place, not an offset.
- `days` — optional, comma-separated weekdays with `0` = Sunday … `6` = Saturday. Absent means every day.
- `chat` — optional, a Telegram chat id: digits, with a leading `-` for a group. Present, the answer goes to that chat;
  absent, it goes to the console.
- `enabled` — `true` or `false`, and absent means `false`. Nothing else arms a routine: the file is the switch.

The body after the frontmatter is the instruction the turn is started with, at most 4,000 characters. Write it as you
would write a request to yourself: what to look at, what "nothing to report" looks like, and how long the answer may be.
A routine fires once a day at most — daily only, by design, so two routines cannot wake each other and a schedule cannot
loop.

## Drafting one for a person

1. **Draft it with `enabled: false`.** Write the file, then tell the person, in one message: what it will do, in what
   zone and on which days, and where the answer will appear.
2. **Arm it only when they say yes.** Arming is changing that one line to `enabled: true` — nothing else. An armed
   routine means the bot speaks first: it is a message the person will receive without having asked for it that morning,
   so it is their decision and not a detail of the draft. Their yes is for that schedule, and a later change of time,
   days or chat is the same kind of change and gets the same yes.
3. **Say that it starts on restart.** The list is read at boot. Do not tell them it is running until it is.

Two things to get right, because they are what a bad routine gets wrong: a routine that fires into a chat nobody is
watching is noise, and a routine whose prompt says "report anything interesting" produces a report nobody reads. Say
exactly what to check and when to be silent — "if there is nothing, reply in one line" is a real instruction, and
"send nothing" is a better one when the person meant it.

## What the turn looks like

The turn starts with `[EVENT HOOK: <name>]` and your own prompt under it. The answer is delivered the way any hook's is:
the instruction names the delivery tool, so a routine with `chat` answers with `mcp__telegram__send_message` and
`send_to_user` is refused there, while a routine without one answers in the console with `send_to_user`. Do not name a
delivery tool yourself in the body — the file's `chat` already decided where the answer goes, and a second tool named in
your own prose is the following turn's ambiguity.

The profile, the log and the workspace are yours in a routine's turn, the same as any other. A fire carries no payload:
there is no event behind it beyond the clock.
