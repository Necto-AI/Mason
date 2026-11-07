# OpenClaw: CLI, first run, and where every kind of configuration lives

Read on 2026-11-07 from [1] at commit `32a3c75c9` (cloned same day; npm package version `2026.11.1`, per [2]).
OpenClaw is the open-source personal-agent gateway formerly named Clawdbot and then Moltbot; the rename history is
recorded in the shipped doc "Clawd → Moltbot → OpenClaw" [3], and the code still carries the scar tissue: the legacy
state dir `~/.clawdbot` is probed [4] and the legacy systemd unit name is `clawdbot-gateway` [5]. Everything below is
from reading the repo itself; the shipped `docs/` pages were read as cross-checks and are cited where they agree with
the code. File paths in citations like `src/...` are paths inside that repo.

## 1. First run, end to end

The recommended entry is the installer script, `curl -fsSL https://openclaw.ai/install.sh | bash`, which detects the OS,
provisions Node if missing, installs OpenClaw, and then launches onboarding; `--no-onboard` installs without the wizard.
Windows gets a PowerShell equivalent and a native Hub app that also provisions a local Gateway during first-run setup
[6].

On a fresh system `openclaw setup` (and bare interactivity) "falls through to guided onboarding" [7]; the setup command's
coded description is "Chat with OpenClaw; onboard when setup is incomplete" [8]. The wizard itself is
`runSetupWizardOnce` in [9]. Step order, from that file:

1. Print a banner, then read the existing config snapshot if any. If `openclaw.json` exists but is invalid, the run
   does not proceed: it notes the issue paths, and the outro says `Config invalid. Run 'openclaw doctor --fix' to apply
   supported repairs, then re-run setup.`, then exits 1 [9]. That is the main documented failure presentation for a
   broken state — a short outro naming one repair command, not a stack of errors.
2. A risk acknowledgement and a telemetry-consent step. If plugin compatibility notices exist they are shown here with
   `Review: openclaw doctor` and `Inspect: openclaw plugins inspect --all` [9].
3. Choose a setup flow. The prompt offers `keep-model` (only if a model is already configured), `quickstart`
   (minimal prompts; the default generation), `advanced` (full prompts), and `import` when migration sources are
   detected; `--flow quickstart|manual|advanced|import` on `openclaw onboard` selects it non-interactively, and an
   invalid value fails immediately: `Invalid --flow. Use quickstart, manual, advanced, or import.` [9].
4. Choose local or remote Gateway. In quickstart the mode defaults to `local`; in advanced it is a select prompt whose
   hints say whether `ws://127.0.0.1:<port>` is reachable, from a live probe [9]. Remote mode instead walks a remote
   wizard and only writes config (no service install) [9].
5. Pick the agent workspace (advanced asks; quickstart uses the stored or default workspace, default
   `~/.openclaw/workspace`, computed with `OPENCLAW_WORKSPACE_DIR` and profile-aware overrides [10]).
6. Model auth (`runSetupModelAuthStep`): pick a provider/auth method; the choice surface is plugin-manifest driven,
   with `Custom Provider` ("Any OpenAI or Anthropic compatible endpoint") as the only hard-coded option and generic
   `setup-token|token|apiKey` choices accepted [11]. Inference is then verified with a real completion before anything
   is persisted ("verifies that connection, persists only the working route" [12]); onboarding failures keep `phase`
   beside the JSON error envelope so scripts can report where they died [13].
7. Gateway config for setup (`configureGatewayForSetup`): port, bind, and auth material. Quickstart generates a Gateway
   secret by default and does not ask token-vs-password [14]. The generated token can be provisioned into the shared
   secret store, with the config holding a SecretRef; the store write deliberately happens *before* the config write so
   a persisted ref is never without its value, and reruns never rotate a token already paired with clients [15].
8. Channels (`setupChannels`): channel plugins present a selection; the wizard writes channel config and runs post-write
   hooks; `--skip-channels` skips with a note [9].
9. Memory import and memory-setup flow, then search setup, then skills setup; `advanced` additionally walks official
   plugin installs, app recommendations, and plugin config; default internal hooks get enabled unless skipped [9].
10. Commit the config (the wizard stages everything and only writes late: "Persist gateway/roster decisions only after
    the interactive verification boundary" [9]) and write wizard metadata (`wizard` keys: `lastRunAt`,
    `lastRunVersion`, `lastRunCommand`, `lastRunMode`, `securityAcknowledgedAt` [16]).
11. Finalize [17]: seed the workspace, offer/install the Gateway service (see §4), offer shell completion, then hand
    off to the TUI or the Control UI dashboard ("offers to keep the Gateway running in the background, and opens the web
    dashboard" [18]); a TUI handoff exits the CLI after it launches [17]. Failures at this stage degrade into notes: a
    service install that fails is reported as `status: "failed"` with the error, and the recovery projection points at
    `openclaw gateway status --deep` / `openclaw gateway install --force`, or plain `openclaw gateway run` if the user
    chose not to install a service [17]. On Linux without a usable user systemd (containers), the daemon step is skipped
    with a note rather than retried [17]. An interactive cancel leaves with `Setup cancelled.` [19].

What the first run writes on disk, all under the state dir `~/.openclaw` (overridable by `OPENCLAW_STATE_DIR`; named
profiles get `~/.openclaw-<profile>` [20]; a legacy `~/.clawdbot` dir is known but no longer auto-used [4]):

| Path | Role | Citations |
|---|---|---|
| `openclaw.json` | the config (JSON5), written by the wizard at the end of onboarding | [21], [9] |
| `openclaw.json.bak`, `.bak.1` … `.bak.4` | five-deep rotating backup ring written on every config write | [22] |
| `workspace/` (default) | the agent workspace; seeded if absent with `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, `TOOLS.md`, `MEMORY.md`, then `git init` | [23] |
| `agents/<id>/agent/` | per-agent state home, incl. `openclaw-agent.sqlite`, the per-agent auth-profiles DB (legacy `auth-profiles.json` is a migration source only) | [24], [25] |
| `agents/<id>/sessions/` | per-agent session store (`sessions.json`) and session SQLite usage | [26] |
| `state/openclaw.sqlite` | the shared SQLite state DB; `state/openclaw-quarantine.sqlite` is its integrity quarantine | [27] |
| `logs/` | file logs (`gateway.log`, support bundles under `logs/support/`) | [28] |
| `.env` | global runtime dotenv for provider keys and service env | [29] |
| `credentials/` | legacy OAuth credential dir, still resolved for doctor and backup ownership | [20] |
| `npm/` | staged OpenClaw copy used by a service installed from a temporary (npx/dlx) CLI | [30] |

Errors mid-run are presented as prompter notes and outros, one repair command each; JSON-mode failures use one stdout
envelope `{ ok: false, error: { type: "cli_error", message } }` plus onboarding `phase` fields, with diagnostics on
stderr [13].

## 2. The CLI surface as --help shows it

The program is Commander-based; root commands are declared in two descriptor catalogs, and help is composed from those
descriptors with lazy per-command registration ([31], [32]). Setup/onboarding verbs:

- `openclaw` (root) — opens the TUI / onboarding path; `--dev`, `--profile <name>`, `--container`, `--log-level`,
  `--no-color`, `--update` (shorthand for `openclaw update`), `-V/--version` are global flags [33].
- `setup` — "Chat with OpenClaw; onboard when setup is incomplete"; `setup --baseline` writes only a baseline config
  and workspace ([8], [7]).
- `onboard` (with subcommands) — "Guided setup for auth, models, Gateway, workspace, channels, and skills";
  subcommands include `recommendations` [8].
- `configure` — "Interactive configuration for credentials, channels, gateway, and agent defaults" (the day-2 wizard)
  [31].
- `config` — "Non-interactive config helpers (get/set/patch/unset/file/schema/validate). Run without subcommand for
  guided setup." (see §3) [31].
- `reset`, `uninstall`, `migrate`, `backup`, `database`, `storage`, `templates` — reset/backup/migration family [31].

Daemon, gateway and service verbs (the "install/daemon" group): `gateway` ("Run, inspect, and query the WebSocket
Gateway", with `install|start|stop|restart|uninstall|status|run|call|doctor|health|auth-token|discover|…`) [32], and
`daemon` — "Manage the Gateway service (launchd/systemd/schtasks)"; it is explicitly a legacy alias mapping to the same
`openclaw gateway` service commands [34]. `system`, `logs`, `status`, `health`, `triage` are the health/log surface (§6).

Day-2 management rather than setup — everything that assumes a working install:

- `channels` ("Manage connected chat channels and accounts"), `directory` (contact/group ID lookup), `pairing`, `qr`,
  `devices`, `users` [32].
- `models`, `models auth|accounts|list|status`, `infer`/`capability` (provider-backed inference), `memory` [32].
- `agents` ("Manage isolated agents (workspaces + auth + routing)"), `agent` ("Run an agent turn via the Gateway"),
  `message`, `sessions`, `resume`, `attach` [31], [32].
- `cron`/`automations`, `hooks`, `webhooks`, `transcripts` [32].
- `mcp`, `browser`, `skills`, `plugins`, `secrets`, `security`, `approvals`/`exec-approvals`/`exec-policy`, `sandbox`,
  `worktrees`, `nodes`, `node`, `connect`, `worker`, `proxy`, `dns`, `docs` [32].
- `update` ("Update OpenClaw and inspect update channel status"), `dashboard`, `completion` [32].
- `clawbot` — "Legacy clawbot command aliases" namespace [32].

Per-command pages under `docs/cli/` document each; the shipped CLI index groups them by intent exactly as above [33].

## 3. Configuration storage

One JSON5 file: `~/.openclaw/openclaw.json` (or `$OPENCLAW_STATE_DIR/openclaw.json`), overridable whole by
`OPENCLAW_CONFIG_PATH` [21]. It is a single file, not a layered stack: there is no default file written ahead of time —
"If the file is missing, OpenClaw uses safe defaults" [35] — and includes are opt-in via `$include` directives resolved
inside the config's directory unless `OPENCLAW_INCLUDE_ROOTS` widens the sandbox [21]. There are no JSON/JS/YAML or
profile variants layered on top except named profiles, each a fully separate state dir and config [20].

Top-level schema keys (from the zod root shape [16]): `$schema, meta, env, wizard, diagnostics, logging, update,
telemetry, browser, ui, secrets, auth, acp, models, nodeHost, agents, tools, security, bindings, broadcast, attachments,
messages, tts, approvals, session, commands, cron, transcripts, hooks, channels, discovery, talk, gateway, cloudWorkers,
database, storage, desktop, memory, mcp, skills, plugins, surfaces, proxy` (authoring overrides in
`types.openclaw.ts` reshape a few of these; the schema is the authority) [36]. Validation is strict: "Unknown keys,
malformed types, or invalid values cause the Gateway to refuse to start" — only `$schema` is exempt; `doctor --fix`
repairs legacy keys [35].

Precedence of flag vs env vs file, as the code reads it:

- Paths: `OPENCLAW_CONFIG_PATH` beats the state-dir default [21]; `OPENCLAW_STATE_DIR`/`OPENCLAW_PROFILE`/`OPENCLAW_HOME`
  move where both config and state live [20], [37].
- Port: `OPENCLAW_GATEWAY_PORT` env wins over `gateway.port` in config; profile default is 18789 unprofiled and a
  per-profile derived port otherwise [43]. Gateway URL/auth for CLI service commands are also flag-overridable
  (`--url`, `--port`, `--token`, `--password`) [34].
- Values: process environment first, then cwd `.env` (no override, and provider credentials from a cwd `.env` are
  ignored as lower-trust), then the global `~/.openclaw/.env` (no override except recorded managed systemd values),
  then the config `env` block applied only for missing keys, then an optional login-shell import [29]. Channel tokens
  likewise have env fallbacks (e.g. `TELEGRAM_BOT_TOKEN`); those are "fallback", not override, and named accounts must
  use config fields [44].

How a running process sees changes: the Gateway watches the config file and hot-applies revisioned snapshots. The reload
planner classifies each changed path as `restart` (Gateway process), `hot` (in-process, possibly restarting the owning
channel/cron subsystem), or `none` (snapshot refresh only); unmatched paths default to restart; mode `hybrid` is default
(auto-restart when required), `off` keeps watching/validating but waits for a manual restart. Plugin-supplied rules
extend the classification [38], implemented by the watcher/planner in [39]. File edits are validated before activation
and invalid edits are rejected while the last-good runtime keeps running; editor temp-write/rename churn is settled,
included files are watched too, and a five-minute background reconciliation catches missed events [38]. Writes made
through the running Gateway publish their committed snapshot directly, bypassing the file-watcher debounce [38].
Rollback warnings and the pre-update config snapshot live outside the `.bak` ring [22]. For CLI-side edits the shipped
`docs/cli/config.md` says `config get` prints the redacted snapshot (secrets never print) and `set`/`patch`/`unset`
mutate `openclaw.json` [40]; I did not trace the CLI write path in code. Separately, issue #9627 records that config
writes made during update/doctor expanded `${VAR}` env references into permanently stored plaintext [41].

Where secrets are held: with them inline in `openclaw.json` as plaintext (still allowed), as a SecretRef —
`{ source: "env" | "file" | "exec" | "store", provider, id }` with providers defined under `secrets.providers` (env
allowlists, a private `~/.openclaw/secrets.json` for `file`, an exec command such as a Vault resolver, or the shared
SQLite store) [42]; in the global `~/.openclaw/.env` [29]; and in the per-agent auth-profiles SQLite database
`agents/<id>/agent/openclaw-agent.sqlite` (or the shared state store), where model-provider credentials materialize
[25]. Plaintext credentials in files the agent can read are explicitly flagged as agent-readable exposure; SecretRefs
reduce that surface, and `openclaw secrets audit --check` reports plaintext residue [43]. The Gateway auth token
specifically is provisioned into the shared secret store (`OPENCLAW_GATEWAY_TOKEN` entry, team scope) with a store
SecretRef in config [15]. Nix installs make config read-only (`OPENCLAW_NIX_MODE=1` implies `OPENCLAW_CONFIG_READONLY`)
and doctor refuses its fix postures there [37].

## 4. The daemon

The Gateway runs as a native user service. `openclaw gateway install` installs and starts it; `start/stop/restart/`
`uninstall` and `status` manage it; `daemon` is the legacy alias for the same verbs [45]. On macOS it is a user
LaunchAgent at `~/Library/LaunchAgents/ai.openclaw.gateway.plist` with `RunAtLoad: true` and `KeepAlive: true` [46],
[47]; secrets ride in a generated owner-only (0600) environment file loaded through an owner-only (0700) wrapper,
while the plist itself is 0644 [45]. On Linux it is a systemd user unit named `openclaw-gateway` (profile-suffixed when
named), `ExecStart` plus fixed policy including `Restart=always`, `RestartSec=5`, `WantedBy=default.target` [48], [49],
[50]; because user units do not survive logout by default, onboarding explicitly enables linger
(`ensureSystemdUserLingerInteractive`) [51]. On Windows it is a Scheduled Task named "OpenClaw Gateway" [48]. Named
profiles must not collide with launchd's reserved `ai.openclaw.gateway` label, and mac/win case-folding conflicts are
refused explicitly [37].

Port and bind: default port 18789, `gateway.bind` defaults to `loopback` on regular hosts; `lan` means `0.0.0.0`,
`tailnet`/`auto` are container- and Tailscale-aware, and non-loopback exposure still requires configured auth [52].
The live schema default is `bind: "loopback"` [36]. Sandboxing of the gateway process itself is conventionally not
attempted — the hardening posture is per-service environment files and a wrapper, not a seatbelt or bubblewrap around
the Gateway; the `sandbox` noun in the CLI is for agent execution (Docker containers, "Docker-based agent isolation")
[32]. Self-update: `openclaw update` (also reachable as global flag `--update` [33]) switches
stable/extended-stable/beta/dev channels; npm installs update through the package-manager flow, source checkouts through
git, and desktop apps through their own updater; update admission, preflight, doctor verification and rollback receipts
are covered in docs [53], [54]. Config `update.checkOnStart` and `update.auto.enabled` schedule can make checking and
updating automatic [16]. A service installed from a temporary CLI copies OpenClaw into `~/.openclaw/npm` and update
refreshes that copy in place [30].

## 5. Channel wiring

What the wizard writes: for each chosen channel, `setupChannels` walks a per-channel plugin whose setup hook asks for
the credential (masking secret input, offering plaintext versus SecretRef storage), writes `channels.<id>` config, and
offers DM-policy defaults; quickstart additionally pre-seeds "allowFrom"-style defaults for channels that opt in and
skips their confirm/dm-policy prompts [9]. The day-2 equivalent is `openclaw channels add --channel telegram --token
<bot-token>`, which "writes the token into your config for you"; the hand-edited alternative is the JSON5 block
`channels.telegram { enabled, botToken, dmPolicy, groups }` [44]. WhatsApp onboarding "supports personal-number mode
and writes a self-chat-friendly baseline: `dmPolicy: 'allowlist'`, `allowFrom` including your own number,
`selfChatMode: true`" [55]; the standard security surface (`allowFrom` E.164 numbers, `dmPolicy:
pairing|allowlist|open`, pairing-store approvals) stays config the operator can hand-edit [55], [44].

What stays hand-edited: groups membership policy, account subdivision (`channels.<id>.accounts.*`), and anything the
plugin does not own — the config has schema support for per-account overrides, and account-level `token`/`tokenFile`
fields exist alongside the channel default [44], [42]. Channels with OAuth flows use `openclaw channels login` where
the plugin offers it; Telegram explicitly does not ("Set the token in config or env, then start the gateway") [44].

Credential storage and rotation: a channel token lives in one of — plaintext `botToken` in `openclaw.json`, a
`tokenFile` (regular file; symlinks rejected) [44], an env fallback for the default account (`TELEGRAM_BOT_TOKEN`,
`DISCORD_BOT_TOKEN`) [44], or a SecretRef, in which case rotation is changing the referenced value and running
`openclaw secrets reload` (doctor names that command when a store owner is degraded [56]); hot reload then applies the
channel change without a Gateway restart [38]. Doctor warns when a post-migration state relies on an env-fallback
token that the doctor process cannot see [57].

## 6. Health

Three tiers, each with distinct scope [58], [59]:

- `openclaw health` — one WebSocket RPC health snapshot of the running Gateway: `--verbose` forces a live per-channel
  check of every configured account and agent, `--json` for scripts; without it a ≤60-second cached snapshot may be
  returned while a live refresh happens in the background. Startup still in progress returns `status: "starting"` with
  the observed phase rather than failing [58].
- `openclaw status` — the pasteable diagnosis: channel health and recent session recipients, `--all` adding the security
  audit, plugin compatibility and memory-vector checks, `--deep` adding live channel probes, `--usage` adding
  normalized provider usage windows ("X% left") [59].
- `openclaw doctor` — the repair surface. Postures [60]: interactive (migrates state, offers repairs midway), `--json`
  (advisory, read-only), `--fix`/`--repair` (applies supported repairs), `--lint` (read-only, CI exit codes), and
  explicit SQLite maintenance modes (`--state-sqlite compact`, `--session-sqlite <mode>`). The check inventory is
  large: gateway/service recovery (launchd/systemd scope diagnosis, dueling units, stale services, version drift),
  config preflight/migrations, database engine and SQLite maintenance, device pairing, channel ingress and dead
  letters, bin-for-bin "fix now" versus "recommended improvement" severity buckets [57]. `--fix` also rotates a config
  backup ring entry before every write [22]. `status --deep` adds a best-effort system scan for gateway-like services
  and plugin-aware config validation [45].

## Contradictions

- Docs describe `config get` as "redacted config snapshot (secrets never print)" [40], but issue #9627 records that
  update/doctor config writes resolved `${VAR}` references and permanently stored plaintext credentials in
  `openclaw.json`, i.e. the write path can materialize secrets [41]. Both can be true (read redaction vs write
  resolution). I did not verify which side is fixed at commit `32a3c75c9`.
- The shipped CLI index advertises `openclaw onboard --classic` as the "full step-by-step wizard" [8], while the same
  page says `--flow quickstart` "opens the classic wizard with minimal prompts" — two different "classic" states (full
  and minimal) beside the default modern flow. The flags are real in code; the flow topology is documented only in
  docs, and I did not disentangle it in the wizard source further than step order above [9].

## Missing evidence

- I read the wizard steps and finalize logic but did not execute onboarding; exact interactive copy comes from the
  `wizard/i18n` strings referenced in [9], [17], not from a run.
- `openclaw configure` (the day-2 wizard) and `openclaw onboard --modern` internals were not traced in code; their
  behavior description rests on helper docs [11], [18].
- Whether a plain `openclaw config set` routes through the running Gateway or writes the file and lets the watcher
  pick it up is asserted by [38] only for Gateway-routed writes; the CLI-side write path was not traced.
- Bare `openclaw` (no args) TUI behavior: descriptor catalogs imply TUI-on-default [31], [32], but I did not trace the
  root fallback in code.

## Sources

Kept:

1. [openclaw/openclaw GitHub repository, commit 32a3c75c9, read 2026-11-07](https://github.com/openclaw/openclaw) —
   the repo this note reads; local clone at /tmp/openclaw. Why it matters: every code claim.
2. `package.json` (same repo, same commit) — npm name `openclaw`, version `2026.11.1`, bin `openclaw` → `openclaw.mjs`.
3. `docs/start/lore.md` — the Clawd → Moltbot → OpenClaw rename record.
4. `src/config/state-dir.ts` — `resolveLegacyStateDirs` names `~/.clawdbot` as the legacy state dir.
5. `src/daemon/constants.ts` — `LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES = ["clawdbot-gateway"]`; current service names.
6. `docs/install/index.md` — the one-line installer (`curl … install.sh | bash`), Node provisioning, `--no-onboard`.
7. `docs/cli/setup.md` — routing order for `openclaw setup`, `--baseline`, system-agent fallback.
8. `docs/cli/onboard.md` — onboard flags (`--classic/--modern/--flow/--agent-name/--import-*`), quickstart behavior.
9. `src/wizard/setup.ts` — the actual onboarding sequence, failure outro, mode/flow prompts, channel step ordering.
10. `src/agents/workspace-default-path.ts` — default workspace dir resolution (`~/.openclaw/workspace`, env/profile
    aware).
11. `src/commands/auth-choice-options.static.ts` — the hard-coded auth-choice surface ("Custom Provider", generic
    `setup-token|token|apiKey`).
12. `docs/cli/index.md` intro wording — "verify inference first, then start OpenClaw" (docs; consistent with code).
13. `docs/cli/index.md` — global flags, JSON failure envelope, onboarding `phase` retention, output modes.
14. `docs/cli/onboard.md` — `--flow quickstart` secret-by-default wording, `--flow manual` full prompts.
15. `src/gateway/auth-token-store-ref.ts` — Gateway token provisioned before config write, rerun stability.
16. `src/config/zod-schema.root-shape.ts` — `wizard.*` metadata keys; `update.checkOnStart`/`update.auto`.
17. `src/wizard/setup.finalize.ts` — service install/decision tree, TUI handoff, recovery projections.
18. `docs/start/getting-started.md` summary from the 2026-11-07 web search — "Quick start … opens the web dashboard"
    (secondary; consistent with the code flow).
19. `src/commands/onboard-helpers.ts` — `guardCancel` prints "Setup cancelled."; `DEFAULT_WORKSPACE` plumbing.
20. `src/config/state-dir.ts` with `src/config/agent-dirs.ts` — profile/state-dir resolution; legacy state dir.
21. `src/config/paths.ts` — `CONFIG_FILENAME = "openclaw.json"`, `OPENCLAW_CONFIG_PATH`, state-dir join, gateway
    port/env resolution, `resolveOAuthDir` → `credentials/`, `OPENCLAW_INCLUDE_ROOTS`.
22. `src/config/backup-rotation.ts` — `CONFIG_BACKUP_COUNT = 5`, the `.bak` ring, pre-update snapshot outside the ring.
23. `src/agents/workspace.ts` (with `workspace-bootstrap-policy.ts`) — bootstrap filenames written into the workspace,
    `ensureGitRepo`, publication semantics.
24. `src/agents/agent-scope-config.ts` — `resolveEffectiveAgentDir` → `~/.openclaw/agents/<id>/agent`.
25. `src/agents/auth-profiles/sqlite.ts` — `resolveAuthProfileDatabasePath` → `openclaw-agent.sqlite`; shared store;
    legacy `auth-profiles.json` as migration source.
26. `src/config/sessions/paths.ts` — per-agent `agents/<id>/sessions/` and `sessions.json`.
27. `src/state/openclaw-state-db.paths.ts` — `<state>/state/openclaw.sqlite` and the quarantine DB.
28. `src/logging/diagnostic-support-export.ts` — `<state>/logs/` layout (`gateway.log`, support bundles).
29. `docs/help/environment.md` (in-repo) — env precedence: process > cwd `.env` > `~/.openclaw/.env` > config `env` >
    login-shell import.
30. `docs/cli/gateway/service.md` (in-repo) — the `~/.openclaw/npm` copy for installs run from temporary CLIs; staged
    swap semantics; service lifecycle and wrapper details.
31. `src/cli/program/core-command-descriptors.ts` — root verb catalog with exact shipped descriptions.
32. `src/cli/program/subcli-command-metadata.ts` (plus `subcli-descriptors.ts`) — sub-CLI verb catalog with
    descriptions and lazy registration.
33. `docs/cli/index.md` — the shipped CLI index: intent grouping, global flags, JSON envelopes.
34. `docs/cli/daemon.md` (in-repo) — `daemon` as legacy alias; install/status options; launchd/systemd/schtasks.
35. `docs/gateway/configuration.md` (in-repo) — JSON5 config, safe defaults, strict schema validation, editing paths,
    `$include` confinement.
36. `src/config/types.openclaw.ts` — top-level key authoring overrides (several keys reshaped against the schema).
37. `src/config/paths.ts` (`isNixMode`, `resolveIsConfigReadOnly`, profile/service identity conflicts) with
    `src/config/config-write-guard.ts` (Nix refusal message).
38. `docs/gateway/configuration/hot-reload.md` (in-repo) — hybrid/off modes, hot vs restart classification, editor
    churn tolerance, five-minute reconciliation.
39. `src/gateway/config-reload.ts` and `src/gateway/config-reload-plan.ts` — the watcher/plan implementation behind the
    classification described in docs.
40. `docs/cli/config.md` (in-repo) — `config get` reads the redacted snapshot; get/set/patch/unset/file/schema/validate.
41. `openclaw/openclaw` issue #9627 — "Config secrets exposed in JSON after update/doctor".
42. `docs/gateway/secrets/secretref-contract.md` (in-repo) — SecretRef shape, env/file/exec/store providers, id rules.
43. `docs/gateway/secrets.md` (in-repo) — plaintext-vs-SecretRef stance, `secrets audit --check` wording.
44. `docs/channels/telegram/setup.md` (in-repo) — `channels add --token`, hand-edit JSON5, env fallback, no login flow,
    `tokenFile` rules.
45. `docs/cli/gateway/service.md` and `docs/cli/daemon.md` — service subcommand options; `status --deep` scan.
46. `src/daemon/launchd-plist.ts` — `RunAtLoad: true`, `KeepAlive: true`, `ProcessType: "Interactive"`, env dict.
47. `src/daemon/launchd-service-files.ts` — plist lives in `~/Library/LaunchAgents/<label>.plist`.
48. `src/daemon/constants.ts` — service names: `openclaw-gateway` (systemd), `ai.openclaw.gateway` (launchd),
    "OpenClaw Gateway" (schtasks), node equivalents.
49. `src/daemon/systemd-unit.ts` — fixed policy `Restart=always`, `RestartSec=5`, `SuccessExitStatus`,
    `WantedBy=default.target`.
50. `src/daemon/systemd.ts` — exported surface (`installSystemdService`, linger, unit scope resolution).
51. `src/wizard/setup.finalize.ts` — `ensureSystemdUserLingerInteractive` gate; systemd availability checks.
52. `docs/gateway/config-gateway.md` (in-repo) — bind modes and auth-before-exposure rules.
53. `docs/cli/update.md` (in-repo) — update channels, package-manager vs source flows, Windows elevation gates.
54. `docs/install/updating.md` (in-repo) — update-owner marker, image/container update paths.
55. `docs/channels/whatsapp.md` (in-repo) — `dmPolicy`/`allowFrom`/`selfChatMode` behavior and personal-number
    baseline.
56. `docs/cli/doctor.md` (in-repo) — degraded SecretRef owners and the `secrets reload` retry command.
57. `docs/cli/doctor/checks.md` (in-repo) — the remaining check inventory; fix-now vs improvement; backup-ring wording.
58. `docs/cli/health.md` (in-repo) — health snapshot semantics, cached vs `--verbose` live, startup phase reporting.
59. `docs/cli/status.md` (in-repo) — `--all/--deep/--usage` scopes.
60. `docs/cli/doctor/running.md` (in-repo) — doctor postures, `--fix`/`--lint`, exit codes, signal behavior.

Rejected/deprioritized: `docs.openclaw.ai` web pages (same content as the in-repo `docs/`; usable only where the in-repo
docs support them); third-party explainers (LumaDock, Stack Junkie) — marketing-shaped summaries, superseded by the
repo itself; an unrelated search-result set from the same query — not relevant.

## Questions this raises for a first run

- Should mason's wizard also treat "invalid existing config" as a first-class repair-then-rerun outcome (an outro
  pointing at one fix command), rather than a distinct error surface?
- What is the mason equivalent of "verified inference before any persistence" — one real completion gated before the
  config write, or is the credential + grant enough?
- Where should the connector credential live — inline in `service/config.json`, a stepped sidecar, or a
  SecretRef-style indirection mason defines once and reuses everywhere?
- Should mason's wizard write config only at the end, staging every prompt's effect in memory as OpenClaw does, or is
  a per-step write with a backup ring simpler and just as safe?
- Is there a mason analogue to the hot-reload classification (restart / hot / none) — i.e., does
  `service/integrations.json` actually get re-read hot, or is the boot-once contract the honest version of a `none`
  reload mode?
- What does mason's `doctor`, if it exists, check first, and does it need the fix-now/recommended split at zero MCP
  tools?
- If a named-profile story ever arrives (mason serving one bot per state dir), does `MASON_HOME` already cover it?
- Should the wizard offer the "my way or the store" choice for secrets (inline plaintext vs referenced), or does mason
  pick one store and force it?
- What is the smallest honest failure presentation for "the connector socket is up but the grant is empty"?
