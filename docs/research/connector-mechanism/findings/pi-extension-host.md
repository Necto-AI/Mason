# Exactly what can a pi extension contribute, how does pi load it, and what lifecycle, trust and versioning does it get? Read the code, not the marketing.

## Answer

A pi (coding-agent) extension is one TypeScript/JavaScript module exporting a default factory `(pi: ExtensionAPI) => void | Promise<void>`, loaded by **jiti** from `~/.pi/agent/extensions/`, `<cwd>/.pi/extensions/`, a `settings.json`/package declaration, or `-e <path>`, running **in the pi process with no isolation and no version negotiation**: it registers tools, slash commands, shortcuts, CLI flags, providers/models, virtual models, MCP servers, four kinds of renderers, and 41 lifecycle event handlers, and — being ordinary in-process Node code — it can already read every file and credential the process can. Project-local extensions are gated by `project_trust`, global and `-e` extensions are not; any module or factory error is a boot-fatal `error` diagnostic (`process.exit(1)`), while a handler that throws at runtime is reported and the run continues (except `tool_call`, which fails closed). `pi-durable`'s `defineExtension` is a different animal entirely: a **plain data object** (`name`, `tools`, `sections`, `hooks`, `wraps`, `tasks`) that the *application* installs into an application-owned registry and that conversations select by name — no loader, no path, no filesystem, no jiti, no privilege boundary to cross, and versioning only on persisted task records (`version` + `migrate`).

## Claims

### Contribution surface: every kind, its API method, what it mutates, when it lands

All from `ExtensionAPI` in [1] and the registrar bodies in [2]; effect timing from [2]/[5].

| Contribution | API | What it mutates | When it takes effect |
|---|---|---|---|
| LLM tool | `pi.registerTool(def)` | The extension's `tools` Map, then `runtime.refreshTools()` | During load: registered immediately, `direct`/`model-only` tools become *active* (declared to the model); others stay inactive until `setActiveTools()` [1][5] |
| Slash command | `pi.registerCommand(name, {description, handler, getArgumentCompletions})` | Extension `commands` Map; collisions get `name:2` invocation names | After load; invoked by the user, handler receives `ExtensionCommandContext` [1][2] |
| Keyboard shortcut | `pi.registerShortcut(keyId, {description, handler})` | Extension `shortcuts` Map; conflicts resolved by load order with diagnostics | During load [1][2] |
| CLI flag | `pi.registerFlag(name, {type, default})` | Extension `flags` + shared `runtime.flagValues` (read back with `pi.getFlag()`) | Defaults applied at commit; the CLI parses `--name` before load [1][2] |
| Color provider | `pi.registerProvider(name, config)` / `pi.registerProvider(Provider)` / `pi.unregisterProvider` | The `ModelRegistry` (adds/replaces a provider's whole model list, `baseUrl`, `headers`, `apiKey`, `streamSimple`, `images`, `classifiers`, `oauth`) | Queued during load, applied on `commit()`; called later it applies immediately [1][2] |
| Virtual model (router) | `pi.registerVirtualModel({provider, id, route})` / `unregisterVirtualModel` | The virtual-model registry; `route()` receives `(request, ctx)` per request | Queued during load; per-request routing [1][2][5] |
| MCP server | `pi.registerMcpServer(name, cfg)` / `unregisterMcpServer` / `getMcpServers` | `runtime.mcpServers` (a `McpServerRegistry`), validated + namespace-clash checked | Registered during load → connects on `session_start`; later → connects right away; not persisted [1][5] |
| Lifecycle handler | `pi.on(event, handler)` → unsubscribe fn | Extension `handlers` Map | At the matching event, handlers run in extension load order [1][5] |
| Message renderer | `pi.registerMessageRenderer(customType, fn)` | Extension `messageRenderers` Map, keyed by `customType` | On rendering a `CustomMessageEntry` [1] |
| Entry renderer | `pi.registerEntryRenderer(customType, fn)` | `entryRenderers` Map; "Custom entries do not participate in LLM context" | On rendering a `CustomEntry` [1] |
| Markdown transformer | `pi.registerMarkdownTransformer(fn)` | Single `markdownTransformer` slot per extension | Every user/assistant markdown render [1] |
| Tool-call renderer | `pi.registerToolRenderer(resolver)` | `toolRenderers` array; resolvers run in load order, `next()` falls through | Rendering calls of *any* tool, including unregistered ones [1][5] |
| Prompt section / prompt text | **no dedicated API** — mutate `event.systemPromptOptions` in `before_agent_start`, or `return { systemPrompt }` / set `forceSystemPrompt` | The per-run prompt build input, or the whole prompt string | Next model request of that run [1][5] |
| Per-tool prompt text | `ToolDefinition.promptSnippet`, `promptGuidelines`, `namespace.instructions`; plus `prepareLoadout(loadout)` returning `descriptions` / `hiddenDeclarations` | The declared tool list the prompt is built from | Whenever the active tool set changes [1][5] |
| Resource paths (skills/prompts/themes) | `return {skillPaths, promptPaths, themePaths}` from `resources_discover` | The resource loader's path set | After `session_start` [1] |
| Agent/LLM calls | `pi.sendMessage`, `pi.sendUserMessage`, `pi.appendEntry`, `pi.exec`, `pi.setActiveTools`, `pi.setModel`, `pi.setThinkingLevel`, `pi.setSessionName`, `pi.setLabel`, `pi.getSettings`, `pi.getAllTools` | The live session: transcript entries, tool set, model, thinking level, session metadata; `exec` runs a **shell command** | Immediately at call time; throwing stubs until the runner binds [1][2] |
| Inter-extension bus | `pi.events.emit/on` | A shared `EventBus`; subscriptions auto-dropped when the runtime is invalidated | Immediately [1][2] |

- A tool definition is far more than a name and a function: `parameters` (TypeBox), `outputSchema`/`structuredContent`, `exposure` (`direct|model-only|codemode|deferred|hidden`), `namespace`, `annotations`, `reachesTools`, `defaultActive`, `executionMode`, `prepareArguments`, `renderShell/renderCall/renderResult` [1] — "A custom tool defines a name, model-facing description, TypeBox parameter schema, and `execute()` function." [5] — direct.
- Tools cannot be removed; withdrawal is a re-registration with hidden exposure: `- `hidden`: registered but unreachable. Re-register a tool with `exposure: "hidden"` to withdraw it, since tools cannot be unregistered.` [5] — direct.
- Tools are strict about the schema: `registerTool` throws `Tool "${tool.name}" registered by extension "${extension.path}" must define an object parameter schema.` [2] — direct.
- Three *horizontal* extension flavours exist besides files: SDK `InlineExtension` factories, hidden `builtin:<name>` extensions (mcp, llama.cpp, codemode, tool-search), and `replaceable` ones a user extension can displace by registering the same tool/command/flag name [1][5]. — direct (`// Built-in extensions supply the code of `builtin:<name>` extension paths` [7]).

### The 41 events, one line each (when it fires)

From the `on(...)` overloads and doc comments in [1]; ordering from [5].

| Event | When it fires |
|---|---|
| `project_trust` | Before project resources load, so a personal/CLI extension can answer yes/no for a folder; "The first project_trust handler that returns yes/no wins" [3] |
| `resources_discover` | After `session_start`, letting extensions add skill/prompt/theme paths |
| `session_start` | A session is created, loaded, resumed, forked, or reloaded (`reason`) |
| `session_info_changed` | The session name/metadata changes |
| `session_before_switch` | Before `/new` or `/resume` replaces the session — cancellable |
| `session_before_fork` | Before `/fork`/`/clone` — cancellable, can skip conversation restore |
| `session_before_compact` | Before compaction — cancellable or replaceable with its own `CompactionResult` |
| `session_compact` | After compaction succeeds (carries the entry, `reason`, `willRetry`) |
| `session_compact_failed` | Compaction failed or aborted |
| `session_shutdown` | Before the runtime is torn down for quit/reload/new/resume/fork — the cleanup hook |
| `mcp_servers_change` | An extension registered/unregistered an MCP server after bind; handling it marks the extension as the MCP connector |
| `session_before_tree` | Before `/tree` navigation — cancellable, can supply summary instructions |
| `session_tree` | After tree navigation |
| `context` | Before each LLM call; gets messages *without* system messages and returns filtered ones — pi restores prompt/tools after |
| `context_with_system` | Same point, but hands over the full transcript including system messages; the return value is sent verbatim |
| `cache_warming_decision` | When idle prompt-cache warming is decided; `{action:"warm"|"stop"}`, last handler wins |
| `before_provider_headers` | After headers are assembled, before the HTTP call; handlers mutate `headers`, `null` deletes one |
| `before_provider_request` | Before the provider request; may replace the serialized payload |
| `after_provider_response` | Response received, before the stream is consumed (status + headers) |
| `provider_stream_event` | For each parsed provider stream event, before pi normalizes it; notification-only |
| `before_agent_start` | Before a run begins (user prompt or triggerTurn custom message); mutable `systemPromptOptions`, optional replacement `message` |
| `agent_start` / `agent_end` | One low-level agent loop starts / ends (`agent_end` also carries messages; not a final-idle signal) |
| `agent_before_settle` | Last actionable boundary: may append entries and request one more provider request (`continue: true`) |
| `agent_settled` | After all automatic retries/compaction/queued work is done — notification-only |
| `ui_prompt_start` / `ui_prompt_end` | A blocking extension UI prompt begins / ends |
| `turn_start` / `turn_end` | One model request + its tool calls begins / ends; `turn_end` is a boundary (`BoundaryState`) and can chain entries and continue |
| `message_start` / `message_update` / `message_end` | Per message (user, assistant, tool result): begins, streams token-by-token, finishes; `message_end` can replace the finalized message |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | Around one tool's execution (with `parentToolCallId` for nested calls, `durationMs` on end) |
| `tool_call` | After `tool_execution_start`, before the tool runs — mutate `input`, `{block:true}` to deny; a throwing handler blocks the tool |
| `tool_result` | After the tool produced a result — redact/annotate/replace `content`, `details`, `structuredContent` |
| `model_select` / `thinking_level_select` | The session model or thinking level changed (`source: set|cycle|restore`) |
| `user_bash` | The user runs `!`/`!!` — may return `operations`/`result` to handle it, or let it fall through |
| `input` | Raw user input arrives, before agent processing — `continue`, `transform` text, or `handled` |

- Ordering inside one model request is documented and stable: `context` → `context_with_system` → `before_provider_headers` → `before_provider_request` → `after_provider_response` → `provider_stream_event`; and per tool call `tool_execution_start` → `tool_call` → `tool_execution_update` → `tool_result` → `tool_execution_end` [5] — direct.
- Handler composition is event-specific, and the docs name the five patterns (notification, in-place mutation, chained transformation, gate, actionable boundary), with `cache_warming_decision` as "last override" [5] — direct.

### Loading: jiti, four locations, transactional registration, cache

- `Extension loader - loads TypeScript extension modules using jiti.` and `Pi uses \`jiti\`, so local TypeScript extensions do not need a separate compilation step.` — no build step, no manifest required [2][5] — direct.
- Loading is `const module = await jiti.import(extensionPath, { default: true })` with `moduleCache: false`; the default export must be a function (`Extension does not export a valid factory function`), and it may be async — "Pi waits for an asynchronous factory before startup continues" [2][5] — direct.
- Four discovery locations, in this order: `<cwd>/.pi/extensions/**`, `<agentDir>/extensions/**`, configured `extensions` paths from settings, and explicit `-e`/`--extension` paths; discovery is one level deep, accepting `*.ts`/`*.js`, `dir/index.ts`, or `dir/package.json` with a `pi.extensions` array [2][4] — direct (`// 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/`, `// 2. Global extensions: agentDir/extensions/`).
- Module resolution is *host-provided*, not the extension's own `node_modules`: jiti gets `virtualModules` (typebox, `@earendil-works/pi-ai|pi-agent-core|pi-coding-agent|pi-tui`, plus the legacy `@mariozechner/*` aliases) or, in unbundled builds, dist `alias`es [2][13] — direct. `packages.md` turns this into a rule: "Declare the host-provided packages listed above in `peerDependencies` with a `"*"` range and do not bundle them." [6].
- Registration is effectively transactional: `registerTool`/`registerCommand`/`on` write to the extension object, while flags, providers, MCP servers and virtual models are queued through `applyRuntimeChange` and only applied in `commit()`; a factory that throws runs `discard()` (state `"failed"`, loading-time event-bus subscriptions unsubscribed) and the extension is dropped with an error [2] — direct.
- Reload replaces the whole runtime and invalidates old contexts: `Reload and session replacement invalidate the old runtime. Code after \`await ctx.reload()\` still belongs to the old runtime and must not reuse its session-bound state.` [5]; the stale error text is `This extension ctx is stale after session replacement or reload.` [2] — direct.
- An extension is loaded once per cwd-scoped cache generation (`clearExtensionCache()` bumps a generation) and re-imported on `/reload` [2] — direct.

### What an extension can reach (and the host does not reserve it)

- `An extension runs inside the Pi process with the same operating-system permissions. It can inspect prompts, tool calls, files, credentials, and session history, so load extensions only from sources you trust.` [5] — direct.
- `Extensions, package installers, language servers, and other child processes run with those same permissions unless an operating-system or virtualization boundary restricts them.` and `Review extensions and packages before loading them. Extensions execute inside the Pi process.` [8] — direct.
- Credentials by design, not by accident: `ExtensionContext.modelRegistry` is documented as `/** Model registry for API key resolution */` [1], and `ModelRegistry` exposes `getApiKeyForProvider(provider)` and `getApiKeyAndHeaders(model)` [14]. `@earendil-works/pi-coding-agent` also exports `readStoredCredential(providerId, authPath = join(getAgentDir(), "auth.json"))`, a `One-off synchronous read of a stored credential from an auth.json file` [14]. — direct.
- Session history is handed over wholesale, read-only: `/** Session manager (read-only) */` typed as `Pick<SessionManager, "getCwd"|"getBranch"|"getEntries"|"getTree"|"buildSessionProjection"|...>` [1][15]; commands get *write* power through `newSession`, `fork`, `navigateTree`, `switchSession`, `reload` [1]. — direct.
- Filesystem and shell: `pi.exec(command, args, {cwd})` runs a command (`execCommand(...)`) [2], and the whole Node `fs`/`net`/`child_process` surface is ambient because there is no sandbox. The docs say so plainly: "The working folder controls resource discovery and the default location for tools, but it does not prevent commands from accessing other paths available to the Pi process." [8] — direct.
- Outbound traffic is steerable: a provider registration can set `baseUrl`, `headers`, `apiKey` and a `streamSimple` handler, i.e. an extension can redirect every model request to its own endpoint [1] — direct.
- The host deliberately does *not* hand over the prompt: `context` handlers "only see the conversation; the system messages belong to Pi" and are restored afterwards (`restoreSystemMessages`) [3]; `before_agent_start` gives mutable sections but the *replacement* path "replaces the whole prompt for that run while the transcript continues recording the structured sections" [5] — direct/interpretation. (Interpretation: the host reserves the prompt as *its* artifact and treats an extension's rewrite as an override to be logged, not a contribution to merge.)

### Trust: project_trust for `.pi`, nothing for global or `-e`

- `Project trust controls whether Pi loads most settings and resources supplied by a working folder. It prevents a folder from silently loading executable extensions before you approve it.` [8] — direct.
- The gate is by *presence* of trust-requiring files: `hasTrustRequiringProjectResources()` returns true when `.pi/settings.json|mcp.json|extensions|skills|prompts|themes|SYSTEM.md|APPEND_SYSTEM.md` exist or a non-user `.agents/skills` exists up the tree [9]; the prompt text is `Trust project folder? ... This allows ${APP_NAME} to load ${CONFIG_DIR_NAME} settings and resources, install missing project packages, and execute project extensions.` [10] — direct.
- Mechanism: a *pre-trust* pass loads only user/global/CLI extensions — `// Force untrusted project settings for the bootstrap pass. This keeps project-local extensions/packages out while still loading user/global and temporary CLI extensions.` [7] — then `project_trust` handlers (and only personal/CLI ones, per `Only personal and explicit command-line extensions can participate in the \`project_trust\` event that runs before project extensions load.` [5]) or the trust store or `defaultProjectTrust` (`ask` by default) decide; the final set is loaded with the decision applied [7][10] — direct.
- Persistence and overrides: `~/.pi/agent/trust.json`, nearest-ancestor match, `--approve`/`--no-approve`, `/trust` [8][9] — direct.
- Trust is not a boundary after boot: `Project trust does not limit what tool calls can access or affect.` and `Project trust controls which project resources load at startup, but it does not make that content or the resulting actions safe.` [8] — direct.
- `~/.pi/agent/extensions/` and `-e`/`--extension` are loaded with no prompt at all; the trust gate covers only the project configuration directory [7][8] — direct (the loader's global branch has no trust check).

### Versioning: none enforced, only changelog discipline and import aliases

- Nothing version-gates an extension. The manifest pi reads is `{extensions, skills, prompts, themes}` — no `apiVersion`, no `engines`, no host range [12]. Grepping the whole repo finds no extension-API version negotiation (`grep -rn "apiVersion" packages/*/src` returns only Azure/Vertex API versions) — direct.
- The only declared relationship is a convention: host packages as `peerDependencies` with `"*"`, enforced by a *warning* — `Host-provided extension packages must be declared in peerDependencies with a "*" range, not dependencies` [11] — direct.
- Compatibility is bought by alias indirection instead: `// Extensions resolve the pi-ai root to the compat entrypoint (a strict superset of the core entrypoint): existing extensions using the old global API keep working at runtime until compat is removed.` [2][13]; `pi-ai/compat` calls itself `Temporary compatibility entrypoint preserving the old global pi-ai API surface` and says `This module is deleted with the coding-agent ModelManager migration.` [16] — direct.
- Breaking changes ship as changelog "Changed" lines and one `@deprecated` JSDoc in the API itself (`/** @deprecated Retained for source compatibility; canonical auth flows ignore it. */`); examples: `generateSummary() ... now ignore their reserveTokens parameter`, `before_provider_headers handlers no longer see the OpenRouter, NVIDIA NIM, and OpenCode attribution headers` [4][1] — direct.
- Host version at this pin: `"version": "1.4.0"` in `packages/coding-agent/package.json`, released `## [1.4.0] - 2026-10-21` [17][4] — direct.

### When an extension is broken

- A module or factory failure is `Failed to load extension: <message>`; it lands in `extensionsResult.errors` and is turned into an `error` diagnostic — `message: \`Failed to load extension "${path}": ${error}\`` [2][18] — then, for *every* mode, `const hasRuntimeErrors = runtime.diagnostics.some((d) => d.type === "error")` … `if (hasRuntimeErrors) { ... process.exit(1) }`, printing `Hint: Start without extensions using "${APP_NAME} -ne".` [18] — direct. **A broken extension refuses the boot.**
- A *package that fails to install* is softer: `If a configured package fails to install at startup, for example because npm cannot reach the registry, Pi warns about it, skips that package's resources, and keeps running. Pi tries to install it again on the next start or \`/reload\`.` [6] — direct.
- A handler that throws at runtime is reported and the run continues: `Pi reports handler errors and continues where possible. A \`tool_call\` handler failure blocks the tool as a fail-safe; a tool execution failure becomes an error result for the model.` [5], delivered through `ExtensionRunner.onError`/`emitError` with `{extensionPath, event, error, stack}` [1][3] — direct.
- A `user_bash` handler failure blocks the command rather than falling through to local execution [5] — direct — i.e. two gates fail closed and everything else fails open.
- Name collisions never unload anyone: `Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.` [7] — direct.
- Mid-session reload keeps the process alive and shows an `[Extension issues]` block in the interactive loaded-resources screen [19] — direct (that path renders `extensionsResult.errors` after the reload; the boot path exits instead).

### pi-durable's `Extension` is a different mechanism

- `export interface Extension<Tool> { readonly name; readonly tools?; readonly sections?; readonly hooks?; readonly wraps?; readonly tasks? }` and its doc: `Named bundle of code; installed in a registry and selected by conversations by name.` [20] — direct.
- There is no loader: `defineExtension` is an identity function (`return extension`), `createRegistry()` is `Create an application-owned registry holding only the built-in tasks.`, and `install()` validates and publishes a new immutable snapshot synchronously [21][22]. `grep` for `import(`/`readFile`/`jiti` in `packages/durable/src/harness/*.ts` returns nothing — the *application* decides what code exists; durability's versioning applies to persisted task records, not to the extension API: `/** Definition version persisted with live input and checkpoints. */` and `migrate?: ... /** Convert a record stored by any older supported version; runs at reservation. */` [20][23] — direct.
- Validation is a closed, cheap set of invariants: `Unique tool names and section keys within one extension; valid, unreserved section keys.`, `Extension ${extension.name} has two sections with key ${key}`, reserved `instructions` key, duplicate task names throw at publication [22] — direct.
- Selection is data, not code: `AgentState.extensions` picks extensions by name per conversation, `tools`/`modelTools` filter the enabled/offered tools, `instructions` renders after every extension section [20] — direct.
- **Prefix stability is a durable feature, not an extension courtesy.** Sections are keyed and tagged (`<key>…</key>`), rendered per request against `shown` — `Sections in effect after replaying system messages in order: set in place, \`null\` deletes, re-adding appends.` — and only the *minimal patch* is written: `planSystemEntries` diffs desired vs shown and emits `context_edit`/system entries, with tool changes carried by `declarationsEqual` [24] — direct. A section that throws keeps its previous text (`A section that throws keeps its shown text, if any, and is reported`) [24] — direct. Nothing equivalent exists in the coding-agent extension API; there the closest pledge is `Pi records the initial prompt and tool set in the transcript's first system message, then appends tool and prompt changes before the next model request.` plus the warning that `Providers that cannot represent the transition receive a complete transcript checkpoint, which can invalidate the cached prefix.` [5] — direct.

## Sources

[1] packages/coding-agent/src/core/extensions/types.ts (2308 lines: `ExtensionUIContext`, `ExtensionContext`, `ToolDefinition`, every event, `ExtensionAPI`) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/extensions/types.ts — accessed 2026-10-30 — primary (vendor code)
[2] packages/coding-agent/src/core/extensions/loader.ts (jiti import, aliases/virtual modules, `createExtensionAPI` commit/discard, discovery, `discoverAndLoadExtensions`) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/extensions/loader.ts — accessed 2026-10-30 — primary
[3] packages/coding-agent/src/core/extensions/runner.ts (`emitProjectTrustEvent`, `restoreSystemMessages`, `onError`, `invalidate`, shortcut/command diagnostics) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/extensions/runner.ts — accessed 2026-10-30 — primary
[4] CHANGELOG.md (1.4.0 dated 2026-10-21; API "Changed" entries) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/CHANGELOG.md — accessed 2026-10-30 — vendor (release notes)
[5] docs/extensions.md — /home/denis/dev/mason/vendor/pi/packages/coding-agent/docs/extensions.md — accessed 2026-10-30 — docs (ships with the code; agrees with it on every point checked)
[6] docs/packages.md — /home/denis/dev/mason/vendor/pi/packages/coding-agent/docs/packages.md — accessed 2026-10-30 — docs
[7] src/core/resource-loader.ts (pre-trust pass comment, conflict diagnostics, builtin extension loading, package warnings) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/resource-loader.ts — accessed 2026-10-30 — primary
[8] docs/security.md (in-process permissions, project trust scope, what trust does not protect) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/docs/security.md — accessed 2026-10-30 — docs
[9] src/core/trust-manager.ts (`TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`, `hasTrustRequiringProjectResources`, `ProjectTrustStore`) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/trust-manager.ts — accessed 2026-10-30 — primary
[10] src/core/project-trust.ts (`resolveProjectTrusted`, prompt text, `defaultProjectTrust` order) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/project-trust.ts — accessed 2026-10-30 — primary
[11] src/core/resource-loader.ts `collectExtensionPackageWarnings` (the peerDependencies warning) — same file as [7], lines 70–103 — accessed 2026-10-30 — primary
[12] src/core/pi-manifest.ts (`readPiManifest`: only `extensions|skills|prompts|themes` string arrays) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/pi-manifest.ts — accessed 2026-10-30 — primary
[13] src/core/extensions/virtual-modules.ts (VIRTUAL_MODULES map and its compat comment) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/extensions/virtual-modules.ts — accessed 2026-10-30 — primary
[14] src/core/model-registry.ts (`getApiKeyForProvider`, `getApiKeyAndHeaders`) and src/core/auth-storage.ts (`readStoredCredential`, default `join(getAgentDir(), "auth.json")`) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/ — accessed 2026-10-30 — primary
[15] src/core/session-manager.ts (`ReadonlySessionManager = Pick<SessionManager, "getCwd"|"getBranch"|"getEntries"|"getTree"|...>`) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/session-manager.ts — accessed 2026-10-30 — primary
[16] packages/ai/src/compat.ts (header: temporary compat entrypoint, "deleted with the coding-agent ModelManager migration") — /home/denis/dev/mason/vendor/pi/packages/ai/src/compat.ts — accessed 2026-10-30 — primary
[17] packages/coding-agent/package.json `"version": "1.4.0"` — /home/denis/dev/mason/vendor/pi/packages/coding-agent/package.json — accessed 2026-10-30 — primary
[18] src/main.ts (extension errors → diagnostics; `hasRuntimeErrors` → `process.exit(1)`; `EXTENSION_LOAD_FAILURE_HINT` = `pi -ne`) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/main.ts lines 74, 799–810, 878–926 — accessed 2026-10-30 — primary
[19] src/modes/interactive/interactive-mode.ts `[Extension issues]` block over `extensionsResult.errors` (lines ~1915–1960) — /home/denis/dev/mason/vendor/pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts — accessed 2026-10-30 — primary
[20] packages/durable/src/harness/types.ts (`Extension`, `ToolRegistration`, `PromptSection`, `Wrap`, `HooksOf`, `AgentState`) — /home/denis/dev/mason/vendor/pi/packages/durable/src/harness/types.ts — accessed 2026-10-30 — primary
[21] packages/durable/src/harness/define.ts (`defineExtension` identity, `section`, `hook`, `wrapTool`, `wrapSection`) — /home/denis/dev/mason/vendor/pi/packages/durable/src/harness/define.ts — accessed 2026-10-30 — primary
[22] packages/durable/src/harness/registry.ts (`createRegistry`, `validateExtension`, immutable snapshot publish) — /home/denis/dev/mason/vendor/pi/packages/durable/src/harness/registry.ts — accessed 2026-10-30 — primary
[23] packages/durable/src/types.ts (`TaskDefinition.version`, `migrate`) — /home/denis/dev/mason/vendor/pi/packages/durable/src/types.ts lines 334–362 — accessed 2026-10-30 — primary
[24] packages/durable/src/harness/prompt.ts (`replaySections`, `renderSections`, `planSystemEntries`, tagged `<key>` wrapping) — /home/denis/dev/mason/vendor/pi/packages/durable/src/harness/prompt.ts — accessed 2026-10-30 — primary

## Conflicts

- **Doc vs. code on who may answer `project_trust`.** `docs/extensions.md` says: `Only personal and explicit command-line extensions can participate in the \`project_trust\` event that runs before project extensions load.` [5] `docs/security.md` agrees: `User-level and command-line extensions can handle the \`project_trust\` event.` [8] The code path is narrower than "personal": `resolveProjectTrusted` iterates whatever is in `extensionsResult`, and `loadProjectTrustExtensions()` builds that set with project settings forced untrusted — so `builtin:<name>` extensions can also be present, though `InlineExtension`'s doc notes a `builtin` extension "loads after project trust is resolved, so it cannot handle `project_trust`" [1][7][10]. Net: docs and code agree on the outcome, the mechanism that guarantees it is the pre-trust pass, not a check inside the event dispatch. Flagging because a connector design that copies "only user-scope extension may answer trust" should copy the pre-trust pass, not the sentence.
- **"Reload replaces the extension runtime" vs. the cache.** The doc's lifecycle section says `Reload replaces the extension runtime` [5]; the loader keeps a per-path factory cache keyed by cwd+generation and only re-imports when `clearExtensionCache()` bumped the generation, which `reload()` does call [2]. Not a contradiction in behaviour (a reload yields a fresh factory), but the *module* is re-imported with `moduleCache: false` rather than the runtime object being reused — worth knowing if a connector ever wants module-level state to survive a reload. It does not.
- **"No version gate" vs. the compat entrypoint.** There is no declared API version anywhere [12], yet `virtual-modules.ts` and `getAliases()` pin extensions onto `pi-ai/compat` and describe it as "a strict superset of the core entrypoint: existing extensions using the old global API keep working at runtime until compat is removed" [2][13]. So the version story is a *silent redirect that will one day be deleted*, not a negotiation. Both statements are true; the second is the load-bearing one for a connector design.

## Unanswered

- **Whether a broken extension really refuses the boot in `rpc` mode specifically.** `main.ts` computes `hasRuntimeErrors` from `runtime.diagnostics` and calls `process.exit(1)` before `createAgentSession`, independent of `appMode` [18], but I did not run it, and `AgentSessionRuntime` could in principle filter diagnostics for RPC. Verified by reading only. **Where to look next:** `src/core/agent-session-runtime.ts` and `src/core/sdk.ts`; or run `pi --mode rpc` with a deliberately throwing extension.
- **Whether the extension error path in `interactive` mode is reachable at *startup* or only after `/reload`.** The `[Extension issues]` renderer exists in `interactive-mode.ts` [19] and the boot path exits unconditionally [18]; I could not tell from code alone whether an interactive boot with a broken extension exits or shows the issue list, since both code paths exist. This matters to mason only for the "refuse the boot vs. quarantine and run degraded" question. **Next:** run `pi` interactively with a broken extension in `~/.pi/agent/extensions/`.
- **Whether the extension API surface is formally versioned anywhere outside the changelog** (semver policy for `ExtensionAPI`, a deprecation window, a `pi --version` compatibility statement). I looked in `docs/*.md` (`grep -rn "breaking change|API stability|unstable"` — nothing), `AGENTS.md` (no mention), `pi-manifest.ts` (no version field), `CHANGELOG.md` (only per-release entries), and `packages/coding-agent/README.md` (not read in depth). I found no such policy; I cannot say it does not exist upstream.
- **How much of the prompt an extension can change without a transcript checkpoint** — i.e. whether `systemPromptOptions` mutations are diffed into a `pi.system`-style delta or always re-render the whole system message. `docs/extensions.md` says "Prefer changing prompt sections, selected tools, or guidelines so Pi can append a transcript delta" [5], which implies a diff exists in coding-agent, but I did not find or read it (the `planSystemEntries` diff I quoted lives in **durable**, a different package). **Next:** grep `src/core/agent-session.ts` for the system-entry planner before claiming coding-agent has prefix-stable prompt deltas.
- **Whether `getSettings()` exposes stored secrets** (`getSettings(): Settings` is a copy of merged settings; I did not enumerate the schema for fields that carry keys). The credential claim rests on `modelRegistry` + `readStoredCredential` + ambient fs, not on settings.
- Not investigated, out of angle: `pi-env`/`RemoteExecutionEnv` interaction with extension tools; the codemode QuickJS sandbox (the only isolation pi actually ships, and it isolates *model-written scripts*, not extensions); `packages/coding-agent/src/extensions/mcp/` as an in-tree reference implementation of a connector-shaped extension.

## Queries

No web searches were run: the sub-question is "read the code, not the marketing", and every claim above is a local primary source at the pinned commit `f321e5bdd`. Local commands actually run, in order:

1. `cat docs/research/connector-mechanism/brief.md`; `git log --oneline -1` → `f321e5bdd`
2. `ls packages/`; `wc -l packages/coding-agent/src/core/extensions/*.ts` (types 2308, loader 879, runner 1565)
3. `sed -n '1,200p' | '300,460p' | '1596,2000p' | '2158,2308p' types.ts`
4. `cat index.ts jiti-loader.ts jiti-static-loader.ts virtual-modules.ts wrapper.ts`
5. `sed -n '1,240p' | '240,560p' | '560,879p' loader.ts`
6. `cat docs/extensions.md`; `cat docs/packages.md`; `sed -n '1,110p' docs/security.md`
7. `grep -rn "project_trust|isProjectTrusted|projectTrust" src/`
8. `sed -n '30,40p' | '170,208p' src/core/trust-manager.ts`; `sed -n '1,120p' src/core/project-trust.ts`
9. `grep -n "hasRuntimeErrors" -B4 -A12 src/main.ts`; `sed -n '790,830p' | '910,935p' src/main.ts`
10. `sed -n '520,640p' | '745,835p' | '70,120p' src/core/resource-loader.ts`
11. `cat src/core/pi-manifest.ts`; `grep -rn "apiVersion|engines|peerDependencies" src/`
12. `grep -rn "deprecat" docs/*.md src/core/extensions/*.ts`; `head -60 CHANGELOG.md`; `grep -n "extension" CHANGELOG.md`
13. `sed -n '1,40p' packages/ai/src/compat.ts`
14. `grep -n "getApiKey|export function readStoredCredential" src/core/model-registry.ts src/core/auth-storage.ts`
15. `grep -n "ReadonlySessionManager" -A 20 src/core/session-manager.ts`
16. durable: `cat src/harness/define.ts`; `sed -n '1,170p' src/harness/registry.ts`; `sed -n '299,380p' | '410,470p' src/harness/types.ts`; `sed -n '1,80p' src/harness/prompt.ts`; `sed -n '325,380p' src/types.ts`
