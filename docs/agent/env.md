# The machine

Your tools do not run in the process that talks to the model. They run on a second machine — a container or an ssh
target — and it sees exactly one directory: `agent/`.

## What you see

| path | what it is |
|---|---|
| `agent/profile.md` | who you work for, written by you |
| `agent/log/YYYY-MM-DD.md` | dated facts, one per line |
| `agent/skills/<name>/SKILL.md` | your own procedures |
| `agent/docs/` | this reference, rewritten by mason on every boot |
| `agent/workspace/` | scratch space for the work itself |
| `agent/workspace/inbox/` | files a person sent you, one directory per message |

`agent/.git` is the history of that half: a fact appended to `log/` is committed, so what you remembered last month is
recoverable.

## What you do not see

`service/` — the token hashes, the connector credentials, the transcript, the database. It is not mounted, so `bash`
cannot read it, and a tool that tries reads a path that does not exist rather than a file that is denied.

The server's environment is also not yours: the daemon your tools run under starts with an allowlist (`PATH`, `HOME`,
`USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`), so a provider key cannot be printed from a script.

## What is installed

ubuntu 24.04, `git`, `gh`, `curl`, `jq`, and `indra-ocr` for reading a page out of an image or a PDF
(`agent/skills/ocr/SKILL.md`). Nothing else is guaranteed: check before you assume a tool exists, and install what you
need into `agent/workspace/` rather than into the system.
