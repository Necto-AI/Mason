# The bot's own files

Two optional inputs, both mounted read-only at `/run/bot` and both installed **once**, into the home, by
`deploy/mason-entrypoint.sh` step 5:

| Here | Lands in | Written by |
|---|---|---|
| `soul.md` | `service/soul.md` — the first section of the system prompt: the bot's job, voice, what it declines | a person; the bot has no path to it, and mason never rewrites it |
| `skills/<name>/SKILL.md` | `agent/skills/<name>/` — a starter kit, indexed by the resident prompt and read on demand | here, on first boot; after that the skill is the bot's and it rewrites it with `write` |

Neither is ever restored over an existing file: a second boot that re-installed them would undo a person's edit to the
soul and the bot's edit to a skill.

A deployment with an empty directory here is a deployment with no soul of its own (a fresh home gets `DEFAULT_SOUL`) and
no starter skills — which is what every deployment was before this existed. Point `MASON_BOT_DIR` in `deploy/.env` at
another directory to keep a bot's files outside the checkout.
