# Research: how pi loads, layers, validates and persists configuration

## Summary

Pi (pi-coding-agent 1.5.0, from the checkout in mason's `node_modules`) keeps per-user state in one derived agent
directory — `~/.pi/agent` by default, overridable by `PI_CODING_AGENT_DIR` — that is a flat set of small JSON files
(`settings.json`, `auth.json`, `models.json`, `models-store.json`, `trust.json`, `keybindings.json`) plus resource
directories. The three store classes show three distinct philosophies: settings is tolerant (bad file becomes an
empty scope plus a warning, writes merge only modified fields so unknown keys survive upgrades), auth is strict
about shape but self-healing across processes (whole-file rewrite under a `proper-lockfile` lock, revision-checked
re-reads for live rotation), and trust is a tiny strict map (path to `true`/`false`/`null`) that throws loudly on
anything else. Nothing uses write-to-temp-then-rename: atomicity comes from the file lock plus a single
`writeFileSync`.

All code paths were read on 2026-11-07 from the compiled `dist/` of `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-ai` under `/home/user/dev/mason/node_modules/`, unless a doc path or absolute home path is
given.

## 1. The directory model

The agent directory is derived, never stored. `getAgentDir()` returns
`process.env[ENV_AGENT_DIR]` if set, else `join(homedir(), CONFIG_DIR_NAME, "agent")`
(`pi-coding-agent/dist/config.js`, functions `getAgentDir`, `ENV_AGENT_DIR`). The names are computed from the
package's own `package.json`: the app name defaults to `pi`, the config dir name defaults to `".pi"`, and
`ENV_AGENT_DIR` is computed as the uppercased app name plus `_CODING_AGENT_DIR` — so
pi-coding-agent's own `package.json` field `piConfig` (`"configDir": ".pi"`) is what yields `PI_CODING_AGENT_DIR`
and `~/.pi/agent` (`pi-coding-agent/package.json`; read back in `pi-coding-agent/dist/config.js`, around
`const piConfigName`).
The session directory has its own override: the env var `ENV_SESSION_DIR` is known in practice as
`PI_CODING_AGENT_SESSION_DIR` and is itself overridable by `--session-dir` (`pi-coding-agent/dist/config.js`; doc
`pi-coding-agent/docs/environment-variables.md`, table "Pi Process Configuration"). `PI_PACKAGE_DIR` separately
relocates the package asset root for Nix/Guix store paths (`pi-coding-agent/dist/config.js`, `getPackageDir`).
There is no per-project agent dir; only settings and the resource files have a project-local twin under the
project's `<cwd>/.pi/`.

What the files are for. Code side: `models.json` (compatible endpoints, models, model overrides — `getModelsPath`),
`auth.json` (stored API keys and OAuth credentials — `getAuthPath`), `settings.json` (user settings —
`getSettingsPath`), plus `themes/`, `tools/` (managed binaries, migrated to `bin/`), `bin/`, `prompts/`,
`sessions/`, and a debug log rooted in `getAgentDir()` (`pi-coding-agent/dist/config.js`, path functions).
`trust.json` and `models-store.json` are located by `trust-manager.js` and `models-store.js`
(`pi-coding-agent/dist/core/trust-manager.js`, constructor `trustPath = join(agentDir, "trust.json")`;
`pi-coding-agent/dist/core/models-store.js`, `join(getAgentDir(), "models-store.json")`). The shipped
documentation table in `pi-coding-agent/docs/configuration.md` (section "Agent directory") matches and adds
`keybindings.json`, `mcp.json`, `AGENTS.md`/`AGENTS.override.md`/`SYSTEM.md`/`APPEND_SYSTEM.md`, `extensions/`,
`skills/`, `prompts/`, and `themes/`.

The live home confirms the map, read from `/home/user/.pi/agent/` on 2026-11-07: `settings.json`, `auth.json`,
`models.json`, `models-store.json`, `trust.json`, `security.json`, `env.json`, plus directories `extensions/`,
`sessions/`, `git/` (installed git packages), `npm/`, `skills/`, `memory-reviews/`, `pi-web-access/`,
`pi-subagents/`, `web-search-cache/`, `tmp/`, and loose extension-owned files `gmail.json`, `mem0.json`,
`pi-voice.json`, `web-search.json`. Every file other than the six JSON stores is owned by installed packages or
extensions, not by pi core: searching all `@earendil-works` packages on this machine for `security.json` or
`env.json` matches nothing, while the pi-setup checkout names both
(`/home/user/.pi/agent/git/github.com/densudk/pi-setup/extensions/env/index.ts` and
`/home/user/.pi/agent/git/github.com/densudk/pi-setup/lib/credentials.ts`, both read 2026-11-07). In this home,
`env.json` is a flat map of env-var names to secret values (values redacted here) and `security.json` holds
`profiles`/`rbw`/`guard` keys, secret-tooling state used by the pi-setup extensions — their role and shape are
the evidence; no values are recorded here.

## 2. Layering and precedence

Settings have three layers plus flags. `SettingsManager.create(cwd, agentDir)` loads a global file
(`join(agentDir, "settings.json")`) and a project file (`join(cwd, CONFIG_DIR_NAME, "settings.json")`) through
`FileSettingsStorage`, then `deepMergeSettings(global, project)` — nested objects merge recursively, project wins
(`pi-coding-agent/dist/core/settings-manager.js`, `deepMergeObjects`/`deepMergeSettings`).
`defaultTools` is special: a list of plain tool names replaces the inherited list, a list of only `+name`/`-name`
entries is appended to the inherited one, and the resolved list applies modifiers to `DEFAULT_TOOL_NAMES`
(same file, `mergeDefaultTools`, `resolveDefaultTools`; the same rule is documented in
`pi-coding-agent/docs/settings.md` under "Tools"). CLI flags tie-break below settings: `--tools` and SDK tool
options are validated by `getToolListError` and override `defaultTools` per invocation, and extensions add merge
layers with
`applyOverrides` (`settings-manager.js`; `main.js` ~line 552-556 calls `applyOverrides` on the CLI's
`parsed.useTheme` flag).
One key is deliberately non-overridable: `defaultProjectTrust` "can only be set in agent-directory settings"
(`pi-coding-agent/docs/settings.md`, row for `defaultProjectTrust`).

Project-local config is trust-gated. `loadFromStorage` returns `{}` for the project scope when
`projectTrusted` is false (`settings-manager.js`), and startup builds a `bootstrapSettingsManager` with
`projectTrusted: false` precisely so `sessionDir` can be resolved before trust, then a runtime
settings manager with the resolved trust value (`pi-coding-agent/dist/main.js`, lines ~477 and ~606-612). The
resources that require trust live under `<cwd>/.pi/`: `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` lists
`settings.json`, `mcp.json`, `extensions`, `skills`, `prompts`, `themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`
(`trust-manager.js`). What counts as a trustworthy decision is the nearest matching record in `trust.json`,
searched upward from cwd (`findNearestTrustEntry`, walking `dirname` until the value is `true`, `false`, or the
search hits the root; `null` is the "distrust this child because the parent is trusted" marker written by the
"Trust parent folder" option, `getProjectTrustOptions`).

Models layer four ways. `ModelRuntime.create` starts from the builtin provider catalog in
`@earendil-works/pi-ai/providers/all` (compiled-in model data, `getBuiltinModelDataGeneratedAt`), then overlays
(1) an optional pi.dev remote catalog per provider, persisted in `models-store.json`; (2) hand-authored
`models.json` from `ModelConfig.load` — provider configs, new models, and `modelOverrides`; and (3) extension and
virtual model registrations, all recomposed per provider id via `composeProvider`/`recomposeProvider`
(`pi-coding-agent/dist/core/model-runtime.js`, `create` and the composition functions;
`pi-coding-agent/dist/core/model-config.js`). This is exactly the split between the two files: `models.json` is
user-authored endpoint/provider/model configuration ("Use custom model configuration only when Pi does not already
include the provider or endpoint you need", `pi-coding-agent/docs/models.md`), while `models-store.json` is a
managed cache keyed by provider id, one entry shaped `{ models: [...], lastModified, etag, checkedAt }` per
provider — written only
by the catalog refresh machinery, refreshed when the stored `checkedAt` is older than
`REMOTE_CATALOG_REFRESH_INTERVAL_MS` (4 hours), merged only when the remote `Last-Modified` is newer than the
builtin data (`pi-coding-agent/dist/core/remote-catalog-provider.js`; live example, read 2026-11-07:
`/home/user/.pi/agent/models-store.json` holds `opencode-go` and `opencode` entries of 32 and 61 models with
`lastModified`, `etag`, `checkedAt`; `PI_OFFLINE` disables the network half, `model-runtime.js` sets
`modelNetworkEnabled` from `process.env.PI_OFFLINE === undefined`).

Credential resolution precedence at request time: a runtime `--api-key` first, then the stored `auth.json`
credential, an `apiKey` from `models.json`, and finally the provider's environment variables or ambient cloud
credentials (`pi-coding-agent/docs/models.md`, section "Authenticate"; code confirmation in
`model-runtime.js` `getProviderAuthStatus`, in order runtime, stored, models.json, then the availability
snapshot from environment). Inside an auth entry, a stored `key` that uses `$VAR` or `!command` syntax is resolved
late at read time, not at write time (`auth-storage.js` `read` calls `resolveConfigValue`; parser in
`pi-coding-agent/dist/core/resolve-config-value.js`, "Resolve configuration values that may be shell commands,
environment variables, or literals").

## 3. Read, validate, repair

Every reader strips a UTF-8 BOM (`stripBom` used by settings, auth, trust, keybindings, models). Beyond that the
stores diverge from one another.

Settings are tolerant and never clobbered. Parsing is bare `JSON.parse(stripBom(...))` — no schema check at load
time; the published `schemas/settings.schema.json` exists for editor completion (`"$schema"` support is advertised
in `pi-coding-agent/docs/settings.md`) and its root forbids nothing (`"additionalProperties": true`,
checked in the schema file). Instead, `migrateSettings` repairs known renames in memory on every load: `queueMode`
to `steeringMode`, a boolean `websockets` to the `transport` enum, the old `skills` object shape to an array,
`retry.maxDelayMs` to `retry.provider.maxRetryDelayMs` (`settings-manager.js`, `migrateSettings`). A file that
fails to parse or validate structurally is caught by `tryLoadFromStorage`, recorded as an error, and the whole
scope falls back to `{}`; the error surfaces as a diagnostic text of the form `Invalid settings file <path>: ...`
(`pi-coding-agent/dist/core/settings-diagnostics.js`, `collectSettingsDiagnostics`, printed as warnings at
startup, `main.js` lines ~544-548). Crucially, when a scope has a load error `save()` refuses to write it — the
in-memory fallback `{}` is never flushed over the broken file (the early `return` on
`globalSettingsLoadError` / `projectSettingsLoadError` in `save` and `saveProjectSettings`). Unknown or future keys
survive because no reader strips them and writers behave as read-merge-modify: `persistScopedSettings` parses the
current file content, copies it to `mergedSettings`, and assigns only the *modified* fields and nested keys
(`save` snapshots `modifiedFields`/`modifiedNestedFields` marked by `markModified`), so keys pi does not know and
fields set by other processes are preserved (`settings-manager.js`, `persistScopedSettings`). Values that are
present but wrong are rejected where they are used: `parseTimeoutSetting` throws
`Invalid ${settingName} setting` and the compaction getters throw
`Invalid compaction.${field} setting ... Expected a non-negative safe integer` (`settings-manager.js`).

Auth is strict about shape, system-healed across restarts. The validation lives in
`ReadOnlyAuthStorage.load`: the root must be an object ("Invalid auth.json: expected an object"), each credential
must itself be an object, an `api_key` entry needs a string `key` (or none) and an optional `env` map of string
values, and an `oauth` entry needs string `access`, string `refresh`, and a finite numeric `expires`; anything else
throws `Invalid auth.json credential for provider "<id>"` (`pi-coding-agent/dist/core/auth-storage.js`). The
regular `AuthStorage` class (the one in the running agent) is softer: on read it keeps a cached snapshot and a file
revision, and `reload()` deliberately swallows parse failures ("Preserve the last valid in-memory snapshot"), while
the one-shot `readStoredCredential` returns `undefined` on any error. The writer side — `FileAuthStorageBackend`
behind `AuthStorage` — ensures the parent dir (mode `0o700`) and the file exists (an empty `{}` with mode `0o600`
if missing), takes a `proper-lockfile` lock on the file, reads fresh content under the lock,
runs the callback returning `{ result, next }`, and when `next !== undefined` rewrites the whole file as
`JSON.stringify(merged, null, 2)` before releasing (`auth-storage.js`, `withLock`/`withLockAsync`). The lock is
mkdir-based; the sync path retries `ELOCKED` up to 10 attempts 20 ms apart, and the async path waits a bounded 30 s
deadline with exponential backoff + jitter and marks itself compromised if the lock disappears (`onCompromised`,
checked before and after the mutation). Writes are not atomic renames — the guarantee is lock-serialized
`writeFileSync`.

Trust is strict and tiny. `readTrustFile` throws `Failed to read trust store <path>: <message>` on a parse error,
and on each wrong value throws `Invalid trust store <path>: value for "<key>" must be true, false, or null`
(`trust-manager.js`) — a bad trust file is loud, not silently defaulted. Writes are
`writeTrustFile`: truncate-on-copy of non-boolean values (invalid entries are quietly dropped when a valid write
follows), keys sorted, trailing newline appended, all under a `proper-lockfile` lock on the directory with an
explicit lock path beside the file (`lockfile.lockSync(trustDir, { lockfilePath: "<trust.json>.lock" })`) with the
same 10×20 ms `ELOCKED` retry (`acquireTrustLockSync`). Overlapping path keys
(different casing on Windows, symlinks) are collapsed by `findTrustFileKeys`/`pathsEqual` before mutation.

Models.json is validated strictly and discarded wholly. `ModelConfig.load` returns an immutable snapshot: missing
file equals empty config, a read error becomes the recorded string `Failed to load models.json: ...`, a parse
error `Failed to parse models.json: ...` (JSONC comments are stripped first with `stripJsonComments`, and a BOM
too), and a TypeBox schema failure lists each keyword path as `Invalid models.json schema:\n  - <path>: <message>`
(`pi-coding-agent/dist/core/model-config.js`, `load` and `formatValidationPath`). On any failure the file's
providers are dropped entirely — no partial recovery. Field defaults (for example `contextWindow` 128000,
`maxTokens` 16384, `input ["text"]`, `reasoning false`) live in the same schema (`model-config.js` schema
definitions). The published counterpart is `schemas/models.schema.json`; unknown fields are tolerated by the
writer side because `modelOverrides` ignores unknown model ids ("Unknown override IDs are ignored",
`pi-coding-agent/docs/models-configuration.md`, Model overrides section). `models-store.json` is read back by
`parse(content) = content ? JSON.parse(stripBom(content)) : {}` with no schema — it is machine-owned (author
inference from the fact that the only writers shown in the code are the refresh publications), so the only
repair is re-fetching the catalog (a store entry without `lastModified` is always refetched,
`remote-catalog-provider.js` comment on `remoteModels`). `keybindings.json` is the quiet one: `loadRawConfig`
returns `undefined` on parse errors or non-objects (file effectively ignored), but its one-time migration does
rewrite the file in place when the migration detects old shapes (`pi-coding-agent/dist/core/keybindings.js`;
`migrations.js` `migrateKeybindingsConfigFile` writes `${JSON.stringify(config, null, 2)}\n`).

A batch of one-shot migrations runs every startup, before the runtime settings manager is built
(`main.js` ~line 542, `runMigrations` in `pi-coding-agent/dist/migrations.js`): legacy `oauth.json` and
`settings.json.apiKeys` are merged into a fresh `auth.json` (mode `0o600`), after which `oauth.json` is renamed
`<name>.migrated`, and `apiKeys` is deleted from `settings.json`, which is rewritten in full here — a rare write
outside the merge machinery, guarded by an `existsSync(authPath)` early-return. Also relocated: stray `*.jsonl`
session files into `sessions/`, the managed `fd`/`rg` binaries from `tools/` into `bin/`, and `commands/` renamed
to `prompts/` for the agent and project dirs; deprecated `hooks/` and non-binary `tools/` directories produce
printed warnings.

## 4. Writes — atomicity, locking, what rewrites when, what is live

Atomicity and locking pattern. Every mutable store uses the same idiom: acquire a `proper-lockfile` lock on the
file (or a `.lock` beside it for trust), read the file's current bytes inside the lock, compute the next body
from the *file* content (not the in-memory copy), and `writeFileSync` in place. Locks and retries: auth uses
10 attempts at 20 ms for sync callers and a 30 s bounded wait with backoff for async ones; settings reuses the same
`acquireLockSyncWithRetry`; trust locks the directory with an explicit `<file>.lock` path; models-store reuses
`FileAuthStorageBackend`. There is no temp-file-then-rename anywhere in `auth-storage.js`,
`settings-manager.js`, `trust-manager.js`, or `models-store.js` — durable ordering comes from the lock and from
the read-inside-lock step. File creation permissions are stated once per store: agent dir `0o700`, auth file
`0o600` (`auth-storage.js` `ensureParentDir`, `ensureFileExists`); settings, trust, and keybindings are written
with default mode. The revision hook is `getFileRevision` — `dev:ino:size:mtimeNs:ctimeNs` of the file from
`statSync` (`pi-coding-agent/dist/utils/paths.js`, lines 62-70) — used to skip re-reading an unchanged file and to
notice a file rewritten by another process, which is how two `AuthStorage` instances share a snapshot safely.

What rewrites what. `auth.json` is rewritten as a full object per operation — `modify` reads the file under lock,
splices the one provider entry (`{ ...currentData, [provider]: next }`), and writes the whole merged object; a
delete writes the object minus the entry (`AuthStorage.modify`/`delete`). Writes happen on credential actions, not
on a schedule: initial `/login` store, OAuth refresh — the refresh token is always persisted even if the refresh is
superseded ("A rotated refresh token is always persisted", `pi-ai/dist/models.js`, `resolveRefreshCredential`), key
rotation or `--api-key` mutation via `ModelRuntime.setRuntimeApiKey`, and logout via `delete` plus
`ensureFileExists` which writes `{}` the first time anything touches the store after the file is missing.
`settings.json` is rewritten on the async write queue (`enqueueWrite` chains onto `writeQueue`) from the *snapshot*
taken at `save()` time, merged only field-by-field / nested-key-by-nested-key into the file's current content
(`persistScopedSettings` in `settings-manager.js`). Typical triggers are the setters —
`setDefaultModel`/`setDefaultModelAndProvider` (the `/model` picker's Ctrl+S), `setDefaultThinkingLevel`,
`setSteeringMode`, `setTheme`, `modelThinkingLevels`, compaction and `lastChangelogVersion` — plus the one-time
first-run setup dialog (section 5), which is itself just these setters (see the "theme choice and analytics
opt-in" comment at `pi-coding-agent` `main.js` ~line 546). `trust.json` is rewritten on every
trust decision (`setMany` covers both the child and parent-folder options). `models-store.json` is rewritten only
through refresh publications: `publish({ persist: ... })` writes or deletes the provider entry
(`pi-ai/dist/models.js` `publishProviderModels`; also the 304/404/501 paths which only advance `checkedAt` in
`remote-catalog-provider.js`). `keybindings.json` is rewritten only by its migration step.

Which changes are live and which need a restart. Credentials are live: after `synchronizeCredentialState`
recomposes the provider and re-runs a local refresh, `refreshProviderAvailability` updates the availability
snapshot under a per-provider sequence, so a stored key or rotated OAuth token takes effect for the next stream
request without restarting (`model-runtime.js`, `synchronizeCredentialState`, `refreshProviderAvailability`). The
models catalog is refreshed by `ModelRuntime.refresh`, with `allowNetwork` derived from `PI_OFFLINE` — restartable
from `/model` ("Opening `/model` reloads the file", `pi-coding-agent/docs/models.md`) and forced with
`pi update --models`. Settings are snapshot-based, not file-watched: an external edit lands only via `/reload`
("Run `/reload` after manually changing settings, keybindings, instructions, or resources",
`pi-coding-agent/docs/configuration.md` intro) or a manually invoked `SettingsManager.reload()` awaited behind
`writeQueue`; trust too has a one-shot read (`trustStore.get(cwd)` at startup, cached per cwd in
`projectTrustByCwd`, `main.js` ~line 600). Extensions' own settings extension-points also go through
`applyOverrides`; nothing runs in a file watcher.

## 5. First run

Before a first run the directory need not exist; `getAgentDir` is a pure path computation and nothing validates it
at boot. Reading `/home/user/dev/mason/node_modules/@earendil-works/pi-coding-agent/docs/configuration.md` is the
only spec of what will appear. What actually creates what:

- `settings.json` is created by the one-time interactive setup — and by nothing else. `shouldRunFirstTimeSetup`
  returns `!existsSync(settingsPath)` — but only when three guards pass: official distribution
  (`isOfficialDistribution`, comparing package name, app name, and config dir), experimental features enabled,
  and no `PI_CODING_AGENT_DIR` override (`pi-coding-agent/dist/cli/startup-ui.js`, `shouldRunFirstTimeSetup`;
  interactive-mode call site in `main.js` ~line 548). The dialog writes the chosen theme and an
  `enableInstallTelemetry`/`enableAnalytics` bit through the normal setter path, i.e. the merge-write machinery
  above, which creates the parent directory when it writes (`FileSettingsStorage.withLock` mkdirs the path when a
  file must be created). In every other mode — SDK, non-official builds, no experimental flag, non-interactive
  shells — pi writes no settings file at all until a setter that marks a modified field runs.
- `auth.json` is created on the first credential touch: `FileAuthStorageBackend`'s lock helpers unconditionally
  ensure the parent dir (mkdir `0o700`) and ensure the file exists (writing an empty `{}` object with mode
  `0o600`) before taking the lock (`auth-storage.js`). In practice — author inference from the call sites — this
  happens at the first login/credential store or OAuth token refresh, the only writers of credential entries. A
  legacy `oauth.json` or `settings.json apiKeys` block, if present, is migrated into a fresh `auth.json` by
  `runMigrations` instead of the `{}` default (`migrations.js` `migrateAuthToAuthJson`).
- `trust.json` is created on the first trust decision — `writeTrustFile` creates the parent directory recursively,
  then writes the sorted two-level map (`trust-manager.js`). In a home where trust was never
  asked, the file simply does not exist and every lookup returns `null`.
- `sessions/` and the per-cwd session subdirectory are created lazily by `SessionManager` on first session write
  (`pi-coding-agent/dist/core/session-manager.js`, `mkdirSync(sessionDir, { recursive: true })` at lines ~300 and
  ~650).
- `models-store.json` is created when a first catalog refresh publishes an entry: on a fresh fetch of a newer
  catalog, and also on a 404 or 501 which persists a `checkedAt`-only record so the next attempt knows it was
  checked (`remote-catalog-provider.js`; permissions in the live home are `0600`, dated 2026-11-07
  at `/home/user/.pi/agent/models-store.json`).
- `models.json` is never created by pi: a missing file just loads as an empty provider configuration
  (`model-config.js` `load`, `ENOENT` branch) — author inference from the doc framing too ("use custom model
  configuration only when Pi does not already include the provider", `pi-coding-agent/docs/models.md`).
- Directory scaffolding (`extensions/`, `skills/`, `prompts/`, `themes/`, `bin/`, `npm/`, `git/`) is created when
  packages or resources are installed or loaded, not at startup — author inference: no startup code path in
  `main.js` creates them, and in the live home their content is all package-sourced (inventory at
  `/home/user/.pi/agent/`, 2026-11-07).

## Questions this raises for a shared-config home

- Pi computes the agent directory's name from the *package's own* `package.json` `piConfig` field, so a consumer
  using the library (not the CLI) is expected to pass its own paths — what does mason's boot need to do to make a
  shared directory resolve the same way for both, and where does mason's own `piConfig`-equivalent live?
- If mason stores its secrets in the same agent dir as pi's `auth.json`, whose writer owns the file, and how do the
  two revision-checked snapshots (`sharedAuthFileReadState` keyed by path in `auth-storage.js`) behave when a
  non-pi writer rewrites the whole file?
- Which mason-owned config would want the `ModelConfig` discipline (immutable snapshot, defaults from a single
  schema, whole-file discard on error) versus the settings-manager discipline (live merge, repair-by-migration,
  field-tagged writes), and what decides it?
- The `settings.json` merge writes only *fields marked modified in this session*; a same-directory other-agent
  editor running between snapshot and write is safe, but two *in-process* snapshots from different agents racing
  the same queue are not — is mason's concurrency model per-process, and does a per-process write queue (the
  `writeQueue` promise chain) suffice for it?
- The migration hook (runMigrations on startup) is a public-ish entry point for every JSON file — what does mason
  need to migrate if it shares any file with pi, and where does that code live in mason?
