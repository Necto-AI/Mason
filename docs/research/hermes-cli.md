# Hermes Agent — install, CLI and configuration, from the source

Research note, 2026-11-07. About the earlier survey: `docs/research/always-on-agents/04-hermes-agent.md`
(read from commit `1f91da2a`, 2026-10-25) covers Hermes' architecture — memory, triggers, tools, security. It
does not cover the installer, the CLI verb list, the config file layout or the service-install story; that is what
this note mines. The survey identified the product correctly: the primary repo is
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) [1]. For this note the repo was cloned
shallow, at commit `122fc40fb06b722b4debedac429c57336cff61ae` — twelve days newer than the survey's pin [1]. An
explicit diff of what changed in between was not made; where a CLI/config property was checked at both dates
(first-run modes, wizard sections, config writer seam, doc lists), the survey's statements still match today's
source. Where the CLI has visibly moved since the survey (the monolithic `_PLATFORMS` list in the setup wizard is
now grouped before an even larger platform plugin registry), nothing about the contract changed, only the reach.
Statements here are read from the commit at [1]; the live docs site stayed unreachable from this box
(the survey records the same 403/451), so docs pages are cited from `website/docs/` inside the repo.

## 1. Install: what runs, what it writes, what first-run asks

Hermes is a Python application, not an npm package: `pyproject.toml` names the package `hermes-agent` (version
stamped at build; `0.0.0` in source) and declares three console entry points — `hermes` (`hermes_cli.main:main`),
a legacy `hermes-agent`, and `hermes-acp` for editor integration [3]. There is no PyPI install path documented;
the supported first install is the one-liner

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

(into `~/.hermes`), a PowerShell equivalent for native Windows (into `%LOCALAPPDATA%\hermes`), plus three
alternative shapes: signed Desktop bundles for macOS (Apple Silicon only) and Windows, a Termux APT package for
Android, and Docker [2][22]. The POSIX installer script is in the repo at `scripts/install.sh`; its stages are
printed in order as "prerequisites repository venv python-deps config products setup gateway complete" [4].

What a run writes, in order. `INSTALL_DIR` defaults to `$HERMES_HOME/hermes-agent` with
`HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"`, and the install log goes to `$HERMES_HOME/logs/install.log`
[4]. The script bootstraps a sha256-verified pinned `uv` from `pm/lock.json`, then delegates the heavy
dependencies — "Python 3.14, Node.js, npm, pnpm, ripgrep, FFmpeg, and Python dependencies" — to PM, Hermes' own
package manager; PM also pre-installs a pinned Chromium for browsing and `cua-driver` for computer use, unless
`--skip-browser` / `--skip-computer-use` say otherwise — and the choice is remembered: "later installs and
`hermes update` do not add them back" [2][4][22]. The `config` stage then creates the home skeleton
(`scripts/install.sh::stage_config`):

```bash
mkdir -p $HERMES_HOME/{cron,sessions,logs,pairing,hooks,image_cache,audio_cache,memories,skills}
```

copies `.env.example` to `.env` (`chmod 600`) if absent, and copies `cli-config.yaml.example` to
`config.yaml` if absent [4]. The `setup` stage runs
`"$INSTALL_DIR/.hermes/bin/hermes" setup </dev/tty` — the setup wizard reads the terminal, not stdin, because
under `curl | bash` stdin is the script itself [4]. The `gateway` stage runs
`hermes gateway install --if-missing` — a service install invitation, offered only if the wizard did not already
handle it (see 5) [4]. Finally it adds `$HOME/.local/bin` to PATH in the shell rc if missing — as a guarded
one-liner, never added twice — and prints the reload hint the file spells out
(`Reload your shell to use hermes: open a new terminal, or run: $rc`), where `$rc` is the right
`source ~/.bashrc` / `~/.zshrc` / fish / `.profile` line for the login shell [4].

What first-run asks. If no terminal is present, both interactive stages are skipped with "run `hermes setup`
after install" [4]. The wizard (`hermes_cli/setup.py`) first offers to import from another agent — it
pre-selects `~/.openclaw`, `~/.claude`, `~/.codex`, `~/.cursor` and installs an `agent-importers` plugin
[2][23]; after an import, each already-configured section offers to skip itself
(`hermes_cli/setup_migration.py::_skip_configured_section`) [7].
A fresh install then shows a three-option mode picker, quoted from the source:

```python
_FIRST_TIME_MODES = (
    ("Quick Setup (Nous Portal) — free OAuth login, no API keys, model + tools (recommended)",
     "_run_first_time_quick_setup"),
    ("Full setup — configure every provider, tool & option yourself (bring your own keys)", None),
    ("Blank Slate — everything off except the bare minimum; opt in to each capability",
     "_run_blank_slate_setup"),
)   # hermes_cli/setup.py
```

[5][6]. Quick Setup runs the Nous Portal flow — one code comment names its four steps: "login, model pick,
provider switch, Tool Gateway opt-in" (`hermes_cli/setup_quick.py::_run_nous_flow`) — and it is also available
directly as `hermes portal` / `hermes setup --portal` [2][6]. The separate gateway-service question is
recorded in `gateway.service_install_choice` by any setup flow that reaches it (see 5) [10].

Full Setup walks `SETUP_SECTIONS` [5]:

```python
("model", "Model & Provider"), ("tts", "Text-to-Speech"), ("terminal", "Terminal Backend"),
("gateway", "Messaging Platforms (Gateway)"), ("tools", "Tools"), ("telemetry", "Shared Metrics"),
("agent", "Agent Settings")
```

the model section asking which provider and its key, platform setup asking per-platform tokens, allowlists
and a home channel — and "Agent Settings are not prompted: first installs get defaults" [5]. The wizard backs up
`config.yaml` to a timestamped copy before writing anything, and refuses to run under the managed
(`/etc/hermes`, Docker image) scope or with no TTY [5]. Bare `hermes` with no configured provider still opens,
printing the banner row rendered at `hermes_cli/banner.py:618`, whose text is
`no model configured` followed by `run /model or hermes setup` [25].

## 2. The CLI surface

`hermes --help` is an argparse tree built by `hermes_cli/_parser.py` (the top-level parser and `chat` subcommand)
plus one `build_*_parser` per group in `hermes_cli/subcommands/<group>.py`, registered in a stable order in
`_build_cli_parser` [11][12]. The full built-in first token set, quoted verbatim from `hermes_cli/main.py`
[12]:

```python
_BUILTIN_SUBCOMMANDS = frozenset(
    {
        "acp", "approvals", "auth", "backup", "bundles", "checkpoints", "codex-runtime", "completion",
        "clipboard", "computer-use", "connectors",
        "config", "console", "cron", "curator", "dashboard", "serve", "debug", "doctor",
        "dump", "egress", "fallback", "gateway", "hooks", "import", "insights",
        "gui", "desktop", "kanban", "login", "logout", "logs", "lsp", "mcp", "memory", "migrate", "moa",
        "journey", "memory-graph", "learning",
        "model", "monitoring", "pairing", "pause", "peer", "pets", "plugins", "portal", "profile",
        "project", "proxy", "prompt-size", "resume", "send", "sessions", "setup",
        "skin", "skills", "slack", "status", "tools", "uninstall", "update",
        "usage", "vault",
        "webhook", "whatsapp", "whatsapp-cloud", "worktree", "chat", "secrets", "security",
        "browser",
        "verify",
        # Plugin commands missing from top-level --help is an accepted trade-off.
        "help",
    }
)   # hermes_cli/main.py
```

Plugin-registered extra verbs are discovered on demand, and the cost of that is budgeted — "eagerly importing
every bundled plugin module costs 500-650ms" (`hermes_cli/main.py`) [12].

The `hermes --help` epilogue itself (built in `hermes_cli/_parser.py`) is the compact day-1 vs day-2 map: bare
`hermes` is the interactive chat (the `chat` subcommand is "also the implicit default", and `-q`/`--oneshot`
is the pipe-friendly answer-only mode with auto-bypassed approvals); `hermes model` selects the provider and
model; `hermes tools` configures which tools are enabled; `hermes config` shows, edits, gets, sets,
unsets, prints paths for, checks and migrates; `hermes gateway` runs, installs, starts, stops, restarts,
uninstalls, lists and sets up, plus `enroll`; `hermes update` is self-updating; `hermes doctor`
diagnoses; `hermes sessions` list/browse/rename; `hermes logs` views agent.log; `hermes auth add`, `list`,
`remove` and `refresh` manage pooled credentials; `hermes -p <profile> <cmd>` (also `--profile`) runs any
command against a named profile's home [11]. Setting up vs managing: `setup` is the only
wizard; day-2 mutation verbs are granular subcommands: `model`, `config set`, `mcp add`, `plugins`
(install/search/update/remove/enable/disable/list/trust), `tools`, `cron edit`/`pause`/`resume`/`run`,
`profile alias`/`create`/`use`/`list`/`delete`/`export`/`import`,
plus `hermes import-agent openclaw|claude-code|codex|cursor` for migration any time, and
`hermes config migrate` for schema migrations (see 3) [2][11][12].

Chat/talk modes are shipped, plural: the classic prompt_toolkit REPL (bare `hermes`), a modern TS TUI
(`--tui` or `display.interface: tui`), a one-shot pipe mode (`-z`/`-q`), a safe command console
(`hermes console`), a voice mode with microphone input and spoken replies (the gateway guide links a Voice
Mode page, and voice memo transcription is a gateway feature), and the gateway-based chat on the platforms the
docs index names — with slash commands shared across interfaces: one command registry feeds the CLI
dispatch, the gateway dispatch and every platform's help [2][11][14][24].

## 3. Configuration storage

One home per profile; the home is where everything lives. `get_hermes_home()` is
"context-local override → `HERMES_HOME` env var → platform default" (`hermes_constants.py:194`) — on Linux/macOS
`~/.hermes`, on Windows native `%LOCALAPPDATA%\hermes` [2]. A profile is a directory under
`~/.hermes/profiles/<name>`, recognised by an identity marker of any one of `config.yaml`, `.env`, `SOUL.md`,
`profile.yaml`, `auth.json`, `state.db` (this is the same predicate the earlier survey quotes, still current)
[13]. The layout of files inside one home:

- `config.yaml` — the one settings file. Sections quoted from `hermes_cli/AGENTS.md` [13]:

  ```text
  model, agent, terminal, compression, display, stt, tts, memory, security, delegation,
  smart_model_routing, checkpoints, auxiliary, curator, skills, gateway, logging, cron,
  profiles, plugins, honcho
  ```

  Writes go through one seam:
  `hermes_cli.config.atomic_config_write` "refuses deletion by omission" or the full-state
  `atomic_config_replace`; direct `yaml.dump` calls are rejected by a CI lint
  (`scripts/check_config_yaml_writers.py`) so round-trip formatting (comments) survives [13].
- `.env` — secrets only. `hermes_cli/AGENTS.md` states the rule in one line: "**.env = SECRETS ONLY** (keys,
  tokens, passwords)" with every optional var registered in `OPTIONAL_ENV_VARS`, and "Non-secret settings go in
  config.yaml". `hermes config set/get/unset` routes bare names registered there (e.g. platform tokens) to
  `.env` — never to config.yaml [13].
- `auth.json` — OAuth and pooled credentials per profile (the earlier survey's finding, still the layout) [26].
- `state.db` — SQLite sessions, FTS5-searchable [26].
- `SOUL.md`, `memories/`, `skills/`, `cron/` — persona, bounded memory files, skills, cron store [26][4].

Layering and precedence. Three loaders serve three surfaces, and `hermes_cli/AGENTS.md` warns "If the CLI sees a
key and the gateway doesn't (or vice versa), you're on the wrong loader — check `DEFAULT_CONFIG` coverage"
[13]. In order: `load_cli_config()` (CLI, merges CLI defaults + user YAML); `load_config()` (most subcommands,
merges `DEFAULT_CONFIG` deep-merge — "new keys deep-merge automatically", so a stale config.yaml gains new
defaults at read time); `load_user_config_effective()` for the gateway runtime — "user file + managed overlay +
`${VAR}` expansion + model-key canon, NO defaults — for presence-sensitive readers" [13]. Above the user layer
sits a managed overlay at `is_managed()`/`/etc/hermes` for the Docker image; the config-backend seam
(`/etc/hermes` and the plugin backends, e.g. remote, selected by `HERMES_CONFIG_BACKEND`) exists exactly so the
overlay logic stays outside the file layer [13][15]. No environment variable overrides a profile's YAML once a
daemon is serving that profile: "Under multiplex the process env never overrides a profile's YAML"
(`hermes_cli/AGENTS.md`) [13].

Migrations. `config.yaml` carries an on-disk `_config_version` stamp; version bumps are only for actively
restructuring; additive keys deep-merge without a stamp bump [13]. `hermes config migrate` runs a table-driven
migration registry where "Below-floor configs (explicit `_config_version` < 12) are left byte-for-byte
untouched" — the process continues with defaults merged at read time rather than corrupting an ancient file
[16]; the verb itself is in the `hermes config` parser group [22].

How a running instance sees edits. Three mechanisms, all verified at source [13][15][20]:

- Reads are live-with-cache. `ConfigBackend`/`FileBackend` "the version is the `file_signature` stat tuple"
  (`hermes_cli/config_backend.py`) — the stat tuple is checked per read, so a config edit applies at the next
  read, and "Read live (mtime-cached) so a config edit applies at the next status; fail-closed on read error"
  (`gateway/run.py:348`) is the same contract stated in code.
- `.env` is reloaded per turn in the gateway, quoted: "Reload .env per turn for rotated keys while config.yaml
  stays authoritative for budgets" (`gateway/run.py, _reload_runtime_env_preserving_config_authority`) [20].
- The gateway process as a whole does not do in-process config reload: `SIGUSR1` (systemd
  `ExecReload=/bin/kill -USR1 $MAINPID`, arrived at by `systemctl reload` or `hermes gateway restart`) is a
  "graceful gateway restart — drain active turns, exit, supervisor relaunches. Not an in-process config
  reload." (`gateway/run.py, _start_gateway_make_restart_signal_handler`) [17][20].

Secrets summary: model/provider keys and platform tokens go to `.env` [13]; OAuth grants and pooled
credentials live in `auth.json` [26]; budget knobs are plain config, not secrets — the earlier survey's
per-MCP-server `spend_limit` is a config value [26]; and there is an in-process browser password vault whose
stored secrets never enter the model's context (survey finding, unchanged here) [26].

## 4. Service wiring

One process, many channels. The gateway is a single background process that connects to all configured
platforms at once — its own docs statement is "The gateway is a single background process that connects to all
your configured platforms, handles sessions, runs cron jobs, and delivers voice messages"
(`website/docs/user-guide/messaging/index.md`) [24]. Platform surface, from the index's own list: Telegram,
Discord, Slack, Google Chat, WhatsApp and WhatsApp Cloud API, Signal, SMS, Email, Mattermost, Matrix, DingTalk,
Feishu/Lark, WeCom, WeCom Callback, Weixin, BlueBubbles (iMessage), Photon (iMessage), QQ, Yuanbao, Microsoft
Teams, LINE, ntfy, Raft, IRC, Buzz, SimpleX — the table also carries a plugin row for Home Assistant — and
besides the table there are an OpenAI-compatible API endpoint and a web Dashboard [24]. The earlier survey
said "~20 platforms" quoting the README; the docs index's comparison table has 28 rows today [26][24].

What is declared in config vs discovered at runtime. Platform credentials (`TELEGRAM_BOT_TOKEN`,
`MATTERMOST_TOKEN`, etc.) are written to `.env` ("SECRETS ONLY") by `hermes gateway setup`, which also writes
the allow-list vars (`..._ALLOWED_USERS`) and the home channel [8][9]. On the config side, the docs index's
"Messaging status" note is the contract: "Credentials saved by `hermes gateway setup` can enable a
credential-based platform without a `platforms` entry in `config.yaml`; an explicit
`platforms.<name>.enabled: false` still disables it" [24]. Platform definitions themselves are not a config
layer: built-in descriptions live in the wizard's `_PLATFORMS` table (`hermes_cli/gateway_setup_wizard.py`) —
today only Mattermost's vars and instructions are listed there verbatim — with additional platform plugins
discovered from a catalog and revealed in the same setup menu [9]. Non-secret routing is config: webhook routes
and cron schedules map to cron jobs (an event trigger fires the job on schedule or webhook); MCP servers are
added with `hermes mcp add` and discovered at runtime by the MCP client (`gateway/run.py` reveals
`mcp_startup.py` for that); `hermes pairing` manages DM pairing codes, and allowlists are per-platform
environment variables the adapters read — each platform's var table carries an `is_allowlist: True` entry,
persisted to `.env` by the shared wizard helper [9][20].

Constraints the user still hand-edits. The allowlists are written by the setup wizard but stay plain
environment variables and config keys, freely editable afterwards; the same wording gate (an
"already configured" line plus a `[y/N]` question with default No) guards every platform's reconfigure, shared
by core wizards and plugin platforms alike (`setup_platforms.py::declines_reconfigure`) [8]. The escape hatches
are `hermes config edit` and `hermes setup <section>`, which the wizard prints in its own help [5][13].
Under multiplex (one
systemd-spawned process serving all profiles) `hermes gateway migrate --multiplex` is one-way:
"`--standalone` is deleted and a per-profile fleet is not a supported target" (`hermes_cli/AGENTS.md`) [13].

## 5. The always-on story

The executable daemon is the gateway. "Install the gateway service so Hermes starts automatically at login and
keeps scheduled jobs and messaging available?" is the exact question asked at the end of the wizard, and
`hermes gateway install` is the verb (also `start`, `stop`, `status`, `restart`, `uninstall`, `enroll`,
`list`) [10][17]. Service install is a matrix, not one unit: per `hermes_cli/AGENTS.md` — "a user unit AND
`--system` unit with `User=`" under systemd, a launchd plist with `gui/<uid>` / `user/<uid>` domain selection,
Windows Scheduled Task, and the Desktop-spawned backend all carry the profile's `HERMES_HOME` explicitly,
"because a supervisor starts with an empty environment" [13][17]. The systemd unit content, quoted from
`hermes_cli/gateway.py` [17]: `Restart=always`, `RestartSec=5`, `RestartForceExitStatus={RESTART_EXIT_CODE}`,
`SuccessExitStatus={RESTART_EXIT_CODE}`, a zero-victim `KillMode=mixed` with `SIGTERM`, optional
`WatchdogSec` (unit becomes `notify`-type with `NotifyAccess=main` when the watchdog is configured), and
`ExecReload=/bin/kill -USR1 $MAINPID` as above [17]. A Host-wide gateway lock with an atomic
"refuse to be the second gateway" is how a manual start and a supervisor start are prevented from racing, with
exit code 75 (EX_TEMPFAIL) signaled for supervisors to retry (`gateway/run.py, _claim_host_gateway_role`) [20].

Multiplex — one process per host serving every named profile — is the fleet shape
`hermes gateway migrate --multiplex` moves a per-profile setup to [13]. The installer's own story is a straight
user service on the machine, not a container; on Termux the APT package ships the agent itself (what an
always-on service install looks like there is not visible from this machine's clone) [2][22]. Reporting when it
is not running: `hermes gateway status` prints the literal `✗ Gateway service is not installed`
(`hermes_cli/gateway.py:3694`) and a live-pid check; the liveness rule from `hermes_cli/AGENTS.md`
is "Process liveness is `(pid, start_time)` ... never bare PID existence" [13]; platform state ("Messaging
gateway stopped") is explicitly a *status* report, not a liveness claim — "An enabled platform can
correctly show **Messaging gateway stopped**" (docs index) [24]. Cron and heartbeat runs live in the gateway
process, so anything scheduled while it is down is missed, not queued: the earlier survey's "Tasks that need an
active agent will not run while it is stopped" is the homepage FAQ's own wording [26].

## 6. Health and diagnostics

`hermes doctor` is the diagnostic and repair surface; it walks an ordered list of checks, each printing its own
rows [18]. The tuple in `hermes_cli/doctor.py`, contracted to titles only — each `(None, ...)` continues the
previous title, and their body functions are elided [18]:

```python
DOCTOR_CHECKS = (
    ('Security Advisories', ...), ('MCP Server Security', ...),
    ('Python Environment', ...), ('SSL / CA Certificates', ...),
    ('Required Packages', ...), ('Configuration Files', env-file, config-file, config-drift),
    ('xAI Model Retirement (May 15, 2026)', ...),
    ('Session Reset (timers removed Sep 7, 2026)', ...),
    ('Auth Providers', ...),
    ('Directory Structure', ... state-db, cron-store, checkpoint-store, gateway supervision),
    ('External Tools', git-and-rg, terminal-backend, node-and-browser, npm-audit),
    ('API Connectivity', ...), ('Tool Availability', ...), ('Skills Hub', ...),
    ('Memory Provider', ... plugins-disabled-by-update, plugins-in-both-lists),
    ('NeMo Relay Plugins', ...), (profiles,),
)   # hermes_cli/doctor.py, titles only
```

Three verbs matter operationally: `hermes doctor` (report), `hermes doctor --fix` (auto-repair what can be
repaired; the summary says so and lists what needs a human), and `hermes doctor --ack <id>` — persisting an
acknowledgement of a named advisory so its startup banner stops annoying, with a fail-closed
"Make sure `config.yaml` is writable" error path [18].

`hermes status` is the one-screen health surface, defaulting to a summary; `--full`/`--deep` print every
section [19]. Quoted from `hermes_cli/status.py::_SECTIONS`:

```python
_render_header, _render_environment, _render_api_keys, _render_auth_providers,
_render_nous_gateway, _render_apikey_providers, _render_terminal, _render_platforms,
_render_gateway, _render_cron, _render_sessions, _render_deep, _render_footer
```
Separately from the general status, `hermes gateway status` answers gateway-specific questions (is a service
installed, is the owned process alive, when did it last restart) [13][17]. Beyond these: `hermes logs`
(agent.log/errors.log tail and follow), `hermes insights`, `hermes usage`, `hermes debug share` ("Upload
debug report for support"), `hermes dump`, `hermes verify` [2][11][12].

## Where the source contradicts itself, and what did not hold since the survey

- Platform count. README's own quote is "~20 platforms"; `gateway_setup_wizard.py`'s built-in platform table
  lists one platform verbatim today (Mattermost) and points at the vocabulary of ~28 rows in the docs index;
  the count is a moving target and every count is "at this commit" [26][2][9][24].
- CLI threshold for a verb to show in `hermes --help`. Plugin-registered commands are documented as an accepted
  gap: "Plugin commands missing from top-level --help is an accepted trade-off" (`hermes_cli/main.py`) [12].
- Survey-vs-now, no misidentification found: the survey's central statements (one Python process serving CLI /
  TUI / gateway / API server / ACP, profile = home directory identity marker, config.yaml + .env +
  auth.json + state.db, per-turn .env reload) all check out against the present commit [1][3][5][13][15][20].
  One continuity note rather than drift: the installer still ships `cli-config.yaml.example` to the home on
  first boot, and the wizard's three fresh-install modes match the quickstart doc's description of them [4][23].

## Missing evidence

- Live docs and the homepage remain unreachable from this box (403 direct / 403 via browser; same as the
  survey recorded), so nothing here depends on the hosted documentation site; the hosted/cloud offering and
  the Nous Portal pricing story described in the survey are unchanged as far as I can tell and not re-verified
  [2][26].
- The ACP server and `lsp` verbs are seen in the parser and the `_BUILTIN_SUBCOMMANDS` set but their
  end-user surface is not documented in the reachable source in the same detail as config; what `hermes lsp`
  does is read from `agent/lsp/cli.py` registration only [12].
- Termux: the APT package path is real (repo README and `website/docs/getting-started/termux.md` exist), but
  the package source, and whether the Termux build installs a service manager, is not visible from this
  machine [2][22].

## Sources

1. `NousResearch/hermes-agent` — https://github.com/NousResearch/hermes-agent — shallow clone at commit
   `122fc40fb06b722b4debedac429c57336cff61ae`, cloned and read 2026-11-07. All numbered paths below are inside
   this clone.
2. `README.md` (root) — quick install one-liners, Desktop bundles, `hermes` command map, Nous Portal,
   CLI vs messaging table, migration from OpenClaw/Claude/Codex/Cursor.
3. `pyproject.toml` (repo root) —
   `hermes-agent` package, `[project.scripts]` (line 585): `hermes`, `hermes-agent`, `hermes-acp`.
4. `scripts/install.sh` (1302 lines) — the stage ladder is `prerequisites`, `repository`, `venv`,
   `python-deps`, `config`, `products`, `setup`, `gateway`, `desktop`, `complete`;
   `HERMES_HOME` default; home skeleton at stage_config;
   `hermes setup </dev/tty`; `hermes gateway install --if-missing`; PATH/rc hint.
5. `hermes_cli/setup.py` — wizard orchestrator, `SETUP_SECTIONS`, `_FIRST_TIME_MODES`, config backup
   pre-setup, `--reset`, non-TTY refusal, agent-import offer, `hermes setup <section>`.
6. `hermes_cli/setup_quick.py` — `_run_nous_flow`, `_run_portal_one_shot`, Blank Slate.
7. `hermes_cli/setup_migration.py` — post-import section-skip logic (`_model_section_has_credentials`).
8. `hermes_cli/setup_platforms.py` — Telegram token regex validation, per-platform `save_prompted`, wizard
   shared wording.
9. `hermes_cli/gateway_setup_wizard.py` — `_PLATFORMS` (Mattermost verbatim today) + registry plugin
   platforms; `_all_platforms()` merge.
10. `hermes_cli/gateway_setup_service.py` — `SERVICE_INSTALL_QUESTION`, `gateway.service_install_choice`.
11. `hermes_cli/_parser.py` — top-level parser, `chat` subparser, help epilogue examples, top-level flags.
12. `hermes_cli/main.py` — `_BUILTIN_SUBCOMMANDS` (line 2648), `_build_cli_parser` (line 3192),
    plugin-CLI discovery cost, `cmd_completion`, `cmd_logs`; setup path wiring.
13. `hermes_cli/AGENTS.md` — CLI/config/gateway/invariant doc; config sections list, `.env = SECRETS ONLY`,
    writer seam, three loaders, migrations contract, gateway service matrix, multiplex, liveness rule.
14. `hermes_cli/commands.py` — slash command registry shared by CLI and gateway; (referenced via
    `hermes_cli/AGENTS.md`).
15. `hermes_cli/config_backend.py` — ConfigBackend seam, `FileBackend` `file_signature` versioning, env var
    `HERMES_CONFIG_BACKEND`, managed overlay not a backend concern.
16. `hermes_cli/config_migrations.py` — `run_migrations`, `SUPPORT_FLOOR_VERSION = 12`.
17. `hermes_cli/gateway.py` (with `hermes_cli/gateway_launchd.py`) — gateway verb list, systemd unit
    generator `generate_systemd_unit` (line 3189) with `Restart=always`, watchdog, `ExecReload=kill -USR1`;
    launchd plist generator; Windows Scheduled Task mentioned in `hermes_cli/AGENTS.md`.
18. `hermes_cli/doctor.py` (+ `doctor_*.py`) — the `DOCTOR_CHECKS` tuple, `run_doctor`, `--fix`, `--ack`.
19. `hermes_cli/status.py` — `_SECTIONS` and `show_status`.
20. `gateway/run.py` — mtime-cached config reads, per-turn `.env` reload, `SIGUSR1` handler text,
    `_claim_host_gateway_role`, systemd-vs-manual gateway race handling.
21. `hermes_cli/subcommands/` (60 modules) — e.g. `connectors.py` (`list`, `accounts`, `connect`, `rename`,
`disconnect` — OAuth app accounts),
    `mcp.py` (`accounts, add, audit, catalog, configure, ... trust, test`), `skills.py` etc.; this is where
    each day-2 verb group lives.
22. `website/docs/getting-started/installation.md` — what the source installer does, Desktop bundles, Termux
    APT, binaries pre-installed by PM, install channel + skip flags.
23. `website/docs/getting-started/quickstart.md` — the three fresh-install modes in user-facing prose.
24. `website/docs/user-guide/messaging/index.md` — "single background process … handles sessions, runs cron
    jobs"; platform comparison table (28 rows); "Saved means credentials are stored, not that the messaging
    gateway is running".
25. `hermes_cli/banner.py` (line 618) — the "no model configured — run /model or hermes setup" row;
    `hermes_cli/onboarding_run.py` and `hermes_cli/free_tier_bootstrap.py` — first-run/onboarding due-state
    tracking for the desktop.
26. The earlier survey `docs/research/always-on-agents/04-hermes-agent.md`, read 2026-10-26 at commit
    `1f91da2a277093c6909542d8c725c0c52fae4628` — used only for cross-checking statements still current.

## Questions this raises for a first run

- Hermes ships a bare-`hermes` REPL that still runs without a provider ("no model configured — run /model or
  hermes setup"), while mason's console connector is the chat; would a chat-first surface that answers even
  before configuration change mason's first impression, or does chat-before-config just manufacture confusion?
- Hermes' setup wizard is one verb with named sections (`hermes setup model`, `setup gateway`, `setup tools`)
  and a `--quick` that fills only missing items — is mason's wizard missing a "just fill the gaps" mode, and
  is `mason setup <section>` operationally meaningful to a day-2 owner?
- The pre-setup config backup (`backup_config(config_path, "pre-setup")`, `hermes_cli/setup.py`) with a
  restore hint is cheap insurance; does mason back up `service/integrations.json` before a wizard rewrite, and
  is a restore command visible where the failed wizard exits?
- Hermes keeps every secret in one `chmod 600` `.env` and never in `config.yaml`, and `hermes config set`
  routes registered secret names to `.env` automatically; mason splits credentials across
  `service/config.json` and integrations — would a one-file-per-role split or an always-on deny at the writer
  seam be the difference between a quiet and a leaky first run?
- `hermes gateway install --if-missing` handles the "setup offered, service not actually installed" gap
  explicitly, with a recorded decline in `gateway.service_install_choice`; does mason's podman compose state
  have an equivalent recorded answer for a user who declined?
- `hermes doctor --fix` and `--ack <id>` are two verbs mason's `mason` has no counterpart for; when mason's
  first run fails at the credential or network layer, what verb does the owner type, and does it auto-repair?
- The gateway's status surface distinguishes "installed but stopped" from "installed and alive-pid-checked";
  would `mason status --full` answer the same three questions (declared, running, last restarted) without
  parsing logs?
- Migrations are versioned (`_config_version` with a support floor under which ancient configs are left
  untouched and defaults are merged at read time); mason has no version stamp on either config file today —
  does the first versioned migration get cheaper before or after one ships?
- Hermes' one-shot `-q` mode exists so scripts can pipe a single prompt in; does mason's CLI have a
  script-friendly surface (`mason chat -q`) or is every automation a connector?
