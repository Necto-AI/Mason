# What is a Claude Code plugin, and specifically what is a 'mod' — and what does that tell us about letting a plugin add code with UI to a host?

## Answer
A Claude Code plugin is a directory with an optional manifest that bundles declarative components (skills, agents,
hooks, MCP/LSP servers, `bin/`, monitors, themes) plus, optionally, a **hooks module** — JavaScript whose exported
`register(on, options)` receives `on` and a capability table `$`. A plugin that ships that module is a **mod**, and a
mod is the exact shape mason is being asked about: out-of-tree JS that registers commands, tools, prompt sections,
event hooks and *UI panes* into a running host. Anthropic's answer to "how do you not become a plugin host with the
server's own privileges" is not a sandbox (`Mods aren't sandboxed`) — it is three narrower moves: a **manifest that
cannot name a path outside its own directory**, a **capability table `$` that is the only way out of the module** (no
Node, no `fetch`, no `require`), and a **static-analysis pass at load that requires every `$` call be written out in
full**, so the host can print the mod's whole effect surface (`hooks:` / `calls:`) before it runs a line. Trust is
then placed in a *first-in-chain guard mod* that runs ahead of every user mod and protects only what the operator
manages — which means the host's own invariants are protected by another plugin, not by the runtime.

## Claims

### 1. The manifest: what matters, path containment, unknown keys

- A plugin is one installable directory, loaded as a unit [1] — "A Claude Code plugin is a directory of skills, agents, hooks, MCP servers, or other components that Claude Code installs and loads as one unit." — direct
- The manifest is optional and lives at `.claude-plugin/plugin.json` [2] — "The manifest is optional. Without it, Claude Code loads the components it finds in the standard layout." — direct
- Only `name` is required, and it is the namespace root for everything the plugin adds [2] — "`name` is the only required key." / "Plugin identifier, required. Use kebab-case. Every component is namespaced under it" — direct
- Installing enables, unless the manifest opts out [4] — "Installing a plugin also enables it, unless its manifest or marketplace entry sets [`defaultEnabled: false`] and you haven't enabled it yourself." — direct
- Every component path is plugin-root-relative and must start with `./` [2] — "Every component path in a manifest is relative to the plugin root and must start with `./`. A path such as `commands/foo.md` fails validation." — direct
- Containment rule, stated as a validator rule [2] — "Every component path must resolve inside the plugin root and must exist." — direct
- The error strings for escape and for traversal [2] — "`<component> path escapes plugin directory: <path>`" and `Path contains ".." which could be a path traversal attempt` — direct
- The loading page states the same rule as a load-time refusal, not just a lint [11] — "Whether a plugin loads in place or from a cached copy, Claude Code doesn't let it declare components outside its own directory." — direct
- Symlinks out and backslash paths are rejected too [11] — "A symlink that leads outside the plugin, other than links between plugins within one marketplace" — direct
- Unknown top-level keys are stripped and the plugin still loads; four subtrees are strict and an unknown key there refuses the load [2] — "An unrecognized top-level key is stripped, and an unrecognized key inside a `userConfig` option, `channels` entry, `lspServers` config, or `monitors` entry is rejected" — direct
- Strict-object failure is fatal, not a warning [2] — "`userConfig` options, `channels` entries, `lspServers` configs, and `monitors` entries are strict. An unknown key inside one is an error, and the plugin doesn't load" — direct
- A `sensitive` `userConfig` value is masked and stored outside `settings.json` [2] — "If `true`, masks input and stores the value in secure storage instead of `settings.json`." — direct
- The manifest carries a version that pins users [2] — "Version string. Setting it keeps users on that version until you change it" — direct
- The manifest has **no field declaring the host API it was written against**; the only version-shaped field is plugin-to-plugin `dependencies`, each entry `"name@marketplace"` or `{ ..., "version": "..." }` [2] — "Plugins that must be enabled for this one to work." — partial (the fields table is complete; the absence is my reading of it)
- Component paths that replace a default folder silently drop that folder, so the manifest is authoritative over the layout [2] — "When you set `commands`, the default `commands/` directory isn't scanned." — direct
- A plugin root `CLAUDE.md` is not project context [3] — "Claude Code doesn't load a `CLAUDE.md` at the plugin root, and `claude plugin validate` warns `CLAUDE.md at the plugin root is not loaded as project context`." — direct
- Three path variables are handed to components, and the plugin root moves on update so it is not a state directory [2] — "`${CLAUDE_PLUGIN_ROOT}` changes when the plugin updates, so don't write state there." — direct

### 2. Component kinds, and how each reaches the user or the context

- The closed set of component kinds [3] — "A Claude Code plugin is built from components, such as skills, agents, hooks, and MCP servers. Each component has a default folder in the plugin" — direct
- The full list, from the section headings of the components page: skills, commands, agents, hooks, MCP servers, LSP servers, executables (`bin/`), default settings, themes and output styles, channels, monitors [3] — plus, separately, `hooks.modules` which makes it a mod — direct (enumerated from [3] §"Add each kind of component" and §"Hooks")
- A plugin's contribution to the context every turn is names-and-descriptions only [1] — "for each skill, agent, and command that Claude can invoke on its own, the name and description are in Claude's context on every turn" — direct
- Full bodies are on demand [1] — "The full text of a skill or agent loads only when it's used." — direct
- Namespacing is by plugin name, for every kind [1][3] — "the skill runs as /my-plugin:review" and "This file becomes `/my-plugin:about`" and "the user can invoke it with `@agent-my-plugin:security-reviewer`" — direct
- MCP tools enter per turn through the host's own MCP search policy, not through the plugin [1] — "What the plugin's MCP servers add per turn follows [MCP tool search]" — direct
- Executables are surfaced by mutating `PATH`, not the context [4] — "Claude Code adds each enabled plugin's `bin/` directory to the `PATH` of the Bash tool's shell" — direct
- Servers are processes that run for the whole session [1] — "MCP servers the plugin defines run alongside each session where it's enabled, and its hooks fire at their events." — direct
- The privilege statement at the top level is the same as for mods [1] — "what the plugin runs, it runs as you" — direct
- A mod's registered *tool* is presented to the model as an MCP tool, i.e. the host reuses an existing entry kind rather than adding one [7] — "Claude sees it under a longer name made of `mcp__`, your plugin's name, two underscores, and the name you registered." — direct
- A mod's registered *command* is ready before the first turn, because the host blocks on `session.start` [7] — "Claude Code waits for that hook before the first prompt, so what you register is available from the first turn." — direct
- A mod's command output is both printed and read by the model [7] — "The `text` you return prints in the transcript and Claude reads it." — direct
- UI is a **closed list of render sites**, not a free surface: 13 named sites (`Pane`, `AbovePrompt`, `UserMessage`, `AssistantMessage`, `ToolUse`/`ToolResult`/`ToolGroup`, `CommandOutput`, `AskUserQuestion`, `ToolProgress`, `Spinner`, `TurnDuration`, `InfoNotice`, `SessionMode`, `PromptHint`) [6] — "A render site is an extension point in Claude Code's interface. Each row is a value of `e.component` in a `ui.render` hook" — direct
- UI inside a site is a **closed list of elements** drawn from a declarative tree the host validates [6] — "Elements are the building blocks of a tree a `ui.render` hook returns, and you get them from `$.ui.resolve(e)`." — direct
- A mod may take over what the host already draws [5] — "replace or restyle parts Claude Code draws itself, such as a tool call's row, the spinner, or the dialog Claude asks questions in" — direct
- A mod may inject or replace **system-prompt sections**, which is the host's prompt-prefix seam [6] — "`{ sections }`, a list of `{ id, text, scope }` in the order they're sent" — direct
- The host documents the cache consequence of a shifting prefix [8] — "Text from these hooks that changes between requests [invalidates the prompt cache]." — direct
- A plugin cannot invent a new kind of contribution: what it adds is one of the enumerated component kinds, a `$` method the host already has, or a render site/element the host already draws [2][6] — inferred (from the closed tables; the docs do not say it in one sentence)
- Token cost is a first-class, documented property of enabling a plugin [1] — "Those tokens count toward your usage and leave less room in the [context window] even in sessions where nothing from the plugin runs." — direct

### 3. The mods model in detail: what a mod is, how it loads, what it may draw, and what protects the host

- Definition [5] — "A mod is a plugin that changes how Claude Code looks and behaves. It's made of JavaScript or TypeScript event handlers" — direct
- A mod is a plugin whose `hooks/hooks.json` names a module, and the module's entry point is a known export [6] — "`modules`: an array with one path, relative to this file, to the hooks module, as in `"modules": ["./register.js"]`" / "The mod's entry point. Exports `register(on, options)`." — direct
- The distinction from hooks-as-shell-commands, stated by Anthropic itself [5] — "A mod's handlers are functions that run inside Claude Code instead." — direct
- The same distinction as a table row [5] — "Functions in a plugin that Claude Code calls in its own process" — direct
- Settings hooks are still there, wrapped one-to-one beneath the function hooks [8] — "`PreToolUse` hooks from managed settings: run before the first mod's `tool.call` hook." — direct
- `options` is the manifest's `userConfig`, so configuration flows manifest → `register` [6] — "`options` holds the values of the [`userConfig`] fields the manifest declares, with defaults filled in." — direct
- Isolation mechanism 1: one shared worker thread for all installed mods, and it is not a security boundary [13] — "Installed mods share one worker thread." — direct
- Isolation mechanism 2: the module is stripped of ambient capability [7] — "The hooks module itself has no Node.js APIs, no timer globals such as `setTimeout`, and no network or file access of its own." — direct
- Isolation mechanism 3: the capability table is the only exit, and that is why the effect surface is enumerable [5] — "To do anything outside its own code, such as draw, add a command, call a model, read a file, start a process, or make a network request, a hook calls the mods API." — direct
- The enumeration argument, in Anthropic's own words [5] — "A hook has no other way to do those things, which is why Claude Code can [list what a mod does] before you install it." — direct
- The `$` surface, by namespace [7] — `$.fs`, `$.process`, `$.http`, `$.store`, `$.env`, `$.settings`, `$.session`, `$.mcp`, `$.ui`, `$.command`, `$.tool`, `$.model`, `$.clock`, `$.state` — direct (table on [7], method table on [6])
- The load-time static analysis, and the coding rules it imposes on authors [9] — "Write each mods API call in full: `$`, the namespace, then the method, as in `$.store.get('notes')`." — direct
- The rules that make a capability un-hideable [9] — "Don't assign `$` or one of its namespaces to a variable, destructure it, or index it with a computed name." — direct
- No dynamic import, no `require`, relative imports only [9] — "A dynamic `import()` fails with `a dynamic import(); a hooks module imports its own files with an import declaration`." — direct
- The validator prints the whole effect surface before anything runs [9] — "`❯ ./register.js hooks: session.start, tool.call, command.run{command=tally}, ui.render{component=Spinner}`" and "`❯ ./register.js calls: $.command.register, $.ui.invalidate`" — direct
- Gates are flagged in that report, including a missing error handler [9] — "`gating hook without .catch: tool.call`" — direct
- Capability calls are themselves events, so policy can intercept them [7] — "Every one of these calls is itself an event, named for its namespace and method without the `$.`, such as `fs.read` for `$.fs.read`." — direct
- And that is the stated enforcement path for an operator [7] — "A mod [earlier in the chain] can observe, rewrite, or refuse your call, which is how an organization restricts what mods reach." — direct
- The chain is middleware, ordered by provenance, with the built-in guard outermost [8] — "Hooks on the same event form one middleware chain. Each mod's `next` calls the following mod's hook, and the last `next` reaches Claude Code's own behavior." — direct
- Ordering is fixed: guard, then org `prependPlugins`, then user mods, then `appendPlugins`, then built-ins [8] — "1. The built-in guard `sec-default@builtin` … 2. Mods you install 3. Mods your organization lists in `appendPlugins` 4. Other mods built into Claude Code" — direct
- **The trust sentence** [5] — "A mod is code that runs with your permissions." — direct
- **The no-sandbox sentence** [5] — "Mods aren't sandboxed. If you turn on [sandboxing], the sandbox isolates the Bash commands Claude runs, and a process that a mod starts runs outside it." — direct
- What a mod can reach, as a list [5] — "**Read your secrets**: environment variables and settings files, including an API key you keep in either" — direct
- Host permission rules do *not* cover a mod's own calls [4] — "Claude Code's [permission rules] and [sandbox] cover the tool calls Claude makes, not the code a plugin runs by itself" — direct
- **What protects the host, quote 1** — the guard mod's protected list [10] — "A user's mod can't change what your managed hooks receive or decide, the system prompt, your managed `CLAUDE.md` and other managed instructions, what any mod reads as settings, or the tools and descriptions of your managed MCP servers." — direct
- **What protects the host, quote 2** — the guard is itself a mod, listed and unremovable [10] — "Claude Code loads a built-in mod named `sec-default@builtin` ahead of every mod a user installs. Users can't turn it off." — direct
- **What protects the host, quote 3** — the guard's load condition is a deployment fact, not a guarantee [10] — "The guard loads when either of these is true: The machine has managed settings / The session runs on `/login` credentials for a Team or Enterprise plan" — direct
- The guard's protection is scoped to managed configuration only; outside it the mod acts as the user [10] — "Outside what you manage, a user's mod acts as that user." — direct
- Deny rules are protected but only for Claude's calls [10] — "Permission rules and `PreToolUse` hooks apply to Claude's tool calls, not to a mod's `$.fs` and `$.process` calls." — direct
- What a mod may draw [5] — "a pane beside the transcript or a band above the prompt, with tabs, buttons, and text fields" — direct
- What a mod may not draw [5] — "A mod can restyle much of Claude Code's interface, but not the permission prompt. It can't change what a prompt shows you." — direct
- Drawing degrades by surface, and the doc gives a fallback policy [5] — "A mod that draws can check which app it's running in, and fall back to a line in the transcript or a command's text reply where nothing draws." — direct
- Hooks are time-boxed and a slow hook is skipped, not the session [6] — "A hook's own execution time for one event, not counting time inside `next` or a mods API call other than `$.clock.sleep` | 10 seconds" — direct
- A failed hook is skipped, and the chain continues [8] — "It failed before calling `next`: Claude Code skips it, and the next handler runs in its place" — direct
- Session-end hooks get a shared, much shorter budget [6] — "All `session.end` hooks together | As long as the [SessionEnd hook budget], 1.5 seconds unless you change it" — direct
- A mod's own API calls never re-enter its own hooks, which bounds recursion [6] — "`kind` is `re-entry` when the hook was skipped because the event came from inside a mods API call by that hook" — direct
- Mods ship inside the host as first-party features, which is the strongest evidence the seam is the same one the host uses [5] — "Some of Claude Code's own features are mods." and the public `mods/` directory in the repo — direct

### 4. Install / enable / scope, and what happens to a plugin the host can't load

- Three scopes, each a settings-file entry [12] — "**User scope**: the plugin is enabled for you in every project on this machine. The entry goes in `enabledPlugins` in `~/.claude/settings.json`." — direct
- Project scope turns it on for collaborators but does not install it for them [12] — "Committing that entry turns the plugin on for your collaborators but doesn't download it to their machines" — direct
- Precedence when several scopes set one plugin [12] — "the local setting overrides the project setting, and the project setting overrides the user setting" — direct
- Loading is explicitly three layers, and the third is the one that matters [1] — "**Settings**: your settings list the marketplaces you've added and the plugins that are enabled. / **Disk**: `~/.claude/plugins/` holds what Claude Code has fetched and installed. / **Session**: plugins load at startup, or when you reload plugins" — direct
- Disk and settings changes do not reach a running session [11] — "Changes to settings or to disk don't reach this layer until you run `/reload-plugins` or start a new session." — direct
- A plugin the host can't fully load is **partially loaded, not quarantined** [11] — "A rejected path appears as a `path escapes plugin directory` error, and the plugin loads without that component." — direct
- A plugin whose strict subtree is malformed is refused wholesale [2] — "the plugin doesn't load" — direct
- A plugin that is enabled but not on disk appears in a per-plugin error surface [11] — "`Plugin "<name>" not cached at <path>` in the `/plugin` **Errors** tab" — direct
- Some skips are silent by design (managed settings), with no error anywhere [11] — "`/plugin` and `claude plugin list` show no plugin and no error for a skipped folder." — direct
- A crashed mod is traced and unloaded, and repeated unattributable crashes disable all non-built-in mods for the session [10] — "If the worker thread that runs installed mods crashes three times, Claude Code unloads every mod that isn't built in" — direct
- Disabling mods leaves the rest of the plugin working — the mod is a component, not the plugin [5] — "`disableAllHooks` and your organization's `allowManagedModsOnly` stop a mod and leave the rest of its plugin in place: the plugin stays installed, and its skills, commands, agents, and MCP servers load." — direct
- An operator can refuse a whole class of mods by policy [10] — "With the option set in managed settings: No mod a user brings runs its hooks" — direct
- No human trust prompt exists for a plugin; the trust text is a fixed warning [4] — "Make sure you trust a plugin before installing, updating, or using it. Anthropic does not control what MCP servers, files, or other software are included in plugins" — direct
- Integrity is pinned only where the catalog pins it [4] — "when a marketplace entry pins an [`archive` source] to a `sha256` digest and the downloaded file's digest doesn't match it, Claude Code refuses the install" — direct
- Reviews decay because updates are automatic [4] — "the files you reviewed can change on disk" — direct
- What a reviewer gets is an inventory, not a proof of behaviour [4] — "The **Will install** section shows that a hook exists but not what it runs" — direct
- Uninstall leaves cached files for 14 days [11] — "It removes that directory in a background cleanup 14 days later, so a session that already loaded the old version keeps running." — direct

### 5. What a plugin explicitly cannot do

- It cannot declare a component outside its own directory — the single load-bearing containment rule [11] — "Claude Code doesn't let it declare components outside its own directory." — direct
- It cannot choose its own path form; `..` is refused as a traversal attempt [2] — "A path containing `..` is the usual case, and `claude plugin validate` reports the error `Path contains ".." which could be a path traversal attempt`" — direct
- Its module cannot touch the machine except through `$` [7] — "The hooks module itself has no Node.js APIs, no timer globals such as `setTimeout`, and no network or file access of its own." — direct
- It cannot hide what it calls from static analysis [9] — "You can pass `$` to a function declared at the top level of the same file" (and nowhere else) / "Passing `$` to a method, a function defined inside the hook, or a function you import from another of your files fails validation." — direct
- It cannot change the permission prompt [5] — "It can't change what a prompt shows you." — direct
- It cannot take a built-in command name [7] — "`$.command.register` throws for a taken name, with a message such as `"/focus" refused: it is the built-in /focus`." — direct
- It cannot get a first-party-looking tool name — its tools are `mcp__<plugin>__<name>` [7] — direct (as quoted above)
- It cannot override what the operator manages, when the guard is loaded [10] — "A user's mod can't change what your managed hooks receive or decide, the system prompt, your managed `CLAUDE.md` and other managed instructions, what any mod reads as settings, or the tools and descriptions of your managed MCP servers." — direct
- It cannot add a UI surface of its own invention; only the enumerated render sites and elements exist [6] — inferred from the closed tables
- Two things the docs say a mod *can* do that a mason connector probably should not: submit a prompt as the user, and approve a tool call before it is asked [5] — "**Act without asking you**: approve a tool call before you're asked" — direct

## Sources
[1] Plugins overview — https://code.claude.com/docs/en/plugins/overview.md — accessed 2026-10-30 — docs
[2] Plugin manifest reference (plugin.json, every field) — https://code.claude.com/docs/en/plugins/manifest-reference.md — accessed 2026-10-30 — docs
[3] Add components to a plugin — https://code.claude.com/docs/en/plugins/components.md — accessed 2026-10-30 — docs
[4] Plugin security and trust — https://code.claude.com/docs/en/plugins/security.md — accessed 2026-10-30 — docs
[5] Mods overview — https://code.claude.com/docs/en/plugins/mods/overview.md — accessed 2026-10-30 — docs
[6] Mods reference (files, events, methods, render sites, elements, limits) — https://code.claude.com/docs/en/plugins/mods/reference.md — accessed 2026-10-30 — docs (pinned in-page: CLI/Desktop as of v2.1.290, VS Code as of v2.1.299)
[7] Use the mods API (`$`) — https://code.claude.com/docs/en/plugins/mods/api.md — accessed 2026-10-30 — docs
[8] React to events with a mod (chain, tiers, failure) — https://code.claude.com/docs/en/plugins/mods/events.md — accessed 2026-10-30 — docs
[9] Create a mod (static-analysis rules, register loop) — https://code.claude.com/docs/en/plugins/mods/create.md — accessed 2026-10-30 — docs
[10] Manage mods for your organization (guard, allowManagedModsOnly, worker crash) — https://code.claude.com/docs/en/plugins/mods/admin.md — accessed 2026-10-30 — docs
[11] Plugin loading reference (settings/disk/session, containment at load) — https://code.claude.com/docs/en/plugins/loading.md — accessed 2026-10-30 — docs
[12] Install and manage plugins (scopes) — https://code.claude.com/docs/en/plugins/install.md — accessed 2026-10-30 — docs
[13] Troubleshoot a mod (worker thread, refusal messages) — https://code.claude.com/docs/en/plugins/mods/troubleshoot.md — accessed 2026-10-30 — docs
[14] changelogs.core-directive.com, "What a mod is" (third-party changelog tracker) — https://changelogs.core-directive.com/reference/mods/overview — accessed 2026-10-30 — blog (secondary; used only for dates: `modules` key in v2.1.242 2026-08-24, off by default; v2.1.286 2026-09-30; on by default at v2.1.287. Not yet confirmed against Anthropic's own changelog.)

## Conflicts
- **"Not sandboxed" vs. "no Node, no `fetch`, no `require`".** Both are Anthropic's own words, from [5] and [7], and they describe different boundaries: the *process/worker* is unsandboxed (a `$.process.run` child inherits the user's full access), while the *module context* is capability-stripped. Not a contradiction, but the docs never state them in one place, and secondary write-ups routinely report only the first. Recorded because a reader who takes "not sandboxed" as the whole story will misjudge what the `$` table buys (`[5]`: "Mods aren't sandboxed." vs `[7]`: "The hooks module itself has no Node.js APIs… no network or file access of its own.").
- **"The guard protects it" vs. "the guard may not be loaded".** [10] states the guard cannot be turned off by users, and separately that it only loads on a machine with managed settings or on a Team/Enterprise `/login`. An API-key, Bedrock, Vertex or Foundry session on an unmanaged machine gets no guard. Both are in [10]; the headline and the condition are ~40 lines apart.
- **Permission rules as a boundary vs. not.** [4] says permission rules and the sandbox "cover the tool calls Claude makes, not the code a plugin runs by itself", while [10] says deny rules and managed `PreToolUse` hooks *do* take precedence over a mod's `tool.check` approval but not over its `$.fs`/`$.process` calls. Consistent, but only if read together; [4] alone reads as if nothing applies.
- **Validation as evidence vs. inventory.** [5] sells `claude plugin validate` as the reason you can trust the `calls:` list; [4] warns that the install pane "shows that a hook exists but not what it runs". The list is complete because of static analysis, not because the pane inspects behaviour.
- No conflict found on the manifest rules; [2] and [11] state the same containment rule at validate time and load time.

## Unanswered
- **No host-API-version field.** I read the complete `Fields` table in [2] and there is no `engines`, `apiVersion`, `requires` or equivalent: a plugin never declares which Claude Code build it was written against. The only version machinery is `version` (pins users) and `dependencies` (plugin→plugin ranges). Consequence for mason: the host's answer to drift appears to be *additive-only* (`$` grew `$.prompt.compose`, `$.mcp.connect`, `$.session.append`, `$.telemetry.*` between 2.1.283 and 2.1.286 per [14]) plus the `environment 2` token that appears in the debug log line, which no doc page explains. Why this matters and what it means for a version gate is under-evidenced — a follow-up should read `https://code.claude.com/docs/en/plugins/dependencies.md` and the `claude-code.d.ts` declarations at `github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts` for a deprecation statement.
- **`environment 2`** appears only in a log line quoted by [14] and in [13]: "hooks module first-mod@inline loaded (worker, environment 2, tier user)". Not defined in any page I fetched. It is the closest thing to a declared host-API generation and it is undocumented.
- **"Container of its own".** Several secondary write-ups claim the module runs "in a container of its own" with no `Buffer`/`process`; Anthropic's pages say "worker thread" ([13]) and "no Node.js APIs" ([7]) but never "container". I did not verify the container claim and it should not be repeated as fact. Not fetched: the `mods/` source in the repo, which would settle it.
- **Does a loaded mod cost tokens when idle?** [1] is explicit that skill/agent/command name+description enter context every turn; it does not say what a mod's registered tools or `ui.render` hooks cost. The `prompt.compose` hook can inject system-prompt sections, which certainly costs tokens, but no page states a per-turn cost for a mod. Inferred only: a mod that registers no tool and no command costs nothing in context.
- **Whether a plugin can render outside the terminal-ish surfaces.** Not established for the browser/cloud session: [5] says drawing appears only in CLI, Desktop and VS Code, and cloud sessions run hooks but draw nothing. Relevant if mason's console is the target surface.
- **No independent, non-vendor benchmark of the `validate` static analysis** (whether it can be evaded). Every page I found on that is either Anthropic's or a security vendor's assertion. I did not fetch `claudecodemods.com/security/` (a third-party mod catalog's own pre-install pipeline proposal, not evidence about the host).

## Queries
- (no `web_search` used for the body; all facts read from `code.claude.com/docs/en/**/*.md` fetched with `curl`, index from `code.claude.com/docs/llms.txt`)
- web_search: `Claude Code "mods" hooks module JavaScript plugin changelog version 2.1.286`
- web_search: `"Claude Code" plugin mod "not sandboxed" security analysis in-process plugin code`
