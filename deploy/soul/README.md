# The bot's own files

Two optional inputs, both mounted read-only at `/run/bot` and both installed **once**, into the home, by
`deploy/mason-entrypoint.sh` step 5:

| Here | Lands in | Written by |
|---|---|---|
| `soul.md` | `service/soul.md` — the first section of the system prompt: the bot's job, voice, what it declines | a person; the bot has no path to it, and mason never rewrites it |
| `skills/<name>/SKILL.md` | `agent/skills/<name>/` — a starter kit, indexed by the resident prompt and read on demand | here, on first boot; after that the skill is the bot's and it rewrites it with `write` |

Neither is ever restored over an existing file: a second boot that re-installed them would undo a person's edit to the
soul and the bot's edit to a skill.

That refusal covers the case it should not: a home that has booted once always has a `soul.md`, because the server
writes `DEFAULT_SOUL` into a fresh one. Handing a soul to a bot that already runs therefore does nothing on its own.
Replace one deliberately — remove `service/soul.md` inside the home, or boot once with `MASON_BOT_FORCE=1`, which
installs this `soul.md` over the one there and is otherwise identical to a normal boot. Skills have no such switch: a
seeded skill is already the bot's, and a changed starter kit is a new name or a hand edit.

A deployment with an empty directory here is a deployment with no soul of its own (a fresh home gets `DEFAULT_SOUL`) and
no starter skills — which is what every deployment was before this existed. Point `MASON_BOT_DIR` in `deploy/.env` at
another directory to keep a bot's files outside the checkout.
