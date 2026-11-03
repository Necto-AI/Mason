# How dsh assembles a harness

> Research note, 2026-11-03. Read from `deepseek-ai/deepseek-harness` at `master`: `docs/architecture.md`,
> `docs/subsystems/{system-prompt,tools,core}.md`, `docs/cordis-tutorial/*`, `docs/AGENTS.md`, `packages/AGENTS.md`,
> `packages/{core,bundle}/*`, `docs/cookbook/*`, `docs/capability-seams.md`. Line references are from that checkout.
> `[judgement]` marks my reasoning.

## 1. The scale, stated honestly

379 packages, ~143k lines of TypeScript, 322 English documents (each with a Chinese pair), five shipped profiles, a
plugin marketplace. That is a platform for many applications, and everything below is a consequence of that choice — not
a claim that mason should be this.

What it buys: a third party adds a whole application by mounting three YAML rows (see `03`), and swaps a capability by
replacing one provider. What it costs: a patch file called `base/cordis.patch.yml` that is **548 lines** (`web-app`'s is
601), a framework vendored and locally patched 20 times, and a documentation standard with word budgets and eight
generators.

## 2. Boot: a profile is a list of bundles, a bundle is a patch

There is no application entrypoint except a profile. "Supported Node applications launch through named `dsh` profiles"
(`docs/architecture.md:45`), and a gate enforces it: "Only `dsh` profiles launch supported Node apps; package bins,
demos, and public SDK argv escapes are forbidden" (`AGENTS.md:13`, checked by `scripts/verify-application-entrypoints.ts`).

The layers, in order (`docs/architecture.md:25`):

1. the profile's ordered bundles (`dsh-base`, then `web-app` / `headless` / `sdk-app` / `acp-app`),
2. the profile's own `cordis.patch.yml`,
3. `$DSH_HOME/cordis.patch.yml`,
4. any `--patch` overlays.

A patch targets a row by `id` and replaces its **whole** config, or inserts new rows; a preset patch applies the same
operations inside that preset's `config.plugins`. `dsh --profile web --dump-config` prints the tree that will boot, and
"any row it prints can be replaced by a patch of your own" (`docs/architecture.md:33-35`). The same algorithm composes
the dump and the mount (`vendor/README.md:43`), which is why the dump is trustworthy — a small property with a large
effect on debuggability. `[judgement]`

Composition rows can depend on the environment: `disabled: !!js process.platform === 'win32'`, and
`disabled: !!js "!ctx.get('profileContext')"` — an expression evaluated against the loader's context at every mount
decision. HMR is itself a row, enabled per profile.

## 3. The kernel is small, and the session log is the truth

Six packages are the spine (`docs/architecture.md:53-60`), each owning one `ctx` key:

| Package | Owns | Key |
|---|---|---|
| `core/session` | The append-only `SessionEvent` log and in-memory store | `ctx.sessions` |
| `core/system-prompt` | Prompt-section and tool-schema assembly | `ctx.systemPrompt` |
| `core/tools` | The scoped tool registry and guarded execution pipeline | `ctx.tools` |
| `core/agent` | The `Agent` interface and live registry | `ctx.agents` |
| `core/agent-loop` | The default driver implementing that interface | `ctx.agentLoop` |
| `llm/llm` | Message and stream vocabulary plus the adapter seam | `ctx.llm` |

The invariant that ties them together is one line, and it is the best sentence in the tree: **"Model-visible means
logged. Every model request must be reconstructable from the log"** (`docs/architecture.md:113`). `deriveMessages()`
projects model history from the log; fork, resume, transcripts, telemetry and persistence all derive from the same
committed settlements. A plugin that changes message content registers a *pure projection*, so the derivation stays
one function.

Three event domains follow from that (`docs/architecture.md:66-72`): **session events** (durable facts, appended and
broadcast on `session/event`), **agent events** (`agent/*`: inbox, step, status, request, validation, continuation), and
**capability events** (`fs/*`, `tools/*`, `telemetry/*`) that attach policy and adapters to a seam without importing the
loop.

## 4. A turn, in the order the code runs it

`docs/architecture.md:80-100` gives the sequence. The parts that matter for anyone designing a similar loop:

```text
turn/start
  claim next-step input plus one queued message
  snapshot model selection; assemble prompt sections + step-admitted tool schemas
  -> agent/pre-step                       (waterfall: reject | enter)
     step/start
     agent/request -> prepareCall         (binds the adapter)
     append entered messages as user/message
     derive and freeze model history from the log
     stream the bound call -> llm/stream -> agent/assistant-stream
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     another step, or next-step input arrived
  -> agent/turn-stopping                  (serial, no next())
turn/end
```

Four things are worth naming:

- **A step is one model request plus its tools; a turn is zero or more steps.** The turn opens before its first input is
  claimed and closes when nothing is owed. That definition is what makes the queue semantics decidable.
- **The system prompt is a message, not a request field.** It is committed as a `system/message` surface node: appended as
  node 0 on the first step, then replaced in place when the rendered text changes (`docs/subsystems/system-prompt.md`).
  This is how "the prompt is cached" and "the prompt is in the log" are both true.
- **Waterfalls are around-middleware.** `agent/pre-step`, `agent/request`, `llm/stream` and the three `tools/*` events are
  waterfalls whose listeners must call `next()`; `agent/turn-stopping` is serial. Each listener can wrap, rewrite or own
  the decision.
- **Cancellation commits neither.** `prepareCall()` binds the adapter before the system prompt and accepted users are
  committed; a cancellation during either async phase commits nothing.

## 5. The tool pipeline

`docs/subsystems/tools.md` documents `ToolDefinition`: the model-facing schema (name, description, parameters) plus a
**mandatory canonical output declaration** — a raw JSON Schema the returned value must satisfy, and a pure
`render(args, value)` that projects it to content blocks. The registry builds the model-facing `ToolSchema[]` "by an
explicit allowlist — `output`/`execute`/`projectContent`/… must never leak into a model request".

The pipeline has three policy hooks with different jobs, and they are not interchangeable (`docs/tool-execution-pipeline.md:13`
labels the first one exactly: "`tools/pre-execute` waterfall — hooks, permission, sandbox"):

- `tools/pre-execute` — the permission decision, an around-hook that can refuse before anything runs;
- `projectContent` — install execution-prepared content before post-execute policies;
- `finalizeContent` — a total, non-throwing last-mile transform applied to *every* outcome, including failures, immediately
  before materialization;
- plus `timeoutMs`, which is "enforced by `@deepseek-ai/dsh-tool-call-timeout-policy` (a `tools/execute` wrapper)" and is
  never sent to the model.

That layering is the reason a harness can host a permission system, a redactor and a presenter without any of them
knowing about each other. The repo's rule captures the design intent: "Enforce a decision in the operation that makes it.
Schema omission, prompt filtering, facades, wrappers, and listener order are not enforcement when direct or alternate
callers can bypass them" (`packages/AGENTS.md:17`). `[judgement]` mason's `beforeTool` gateway is the same idea, reached
independently and with fewer hooks.

## 6. Prompt assembly

Sections are registered by name and `order`, sorted ascending then by name, and rendered by one assembly call
(`docs/subsystems/system-prompt.md`). A section's text "may be static or resolved from the current assembly context", and
is merge-extensible: `dsh-agent` adds `agent` and `modelSelection` to `AssembleContext`.

Two mechanisms are worth taking:

- **Named order slots, allocated centrally.** Contributors don't invent numbers; they resolve through
  `getSectionOrder()` / `getContextOrder()`. `TOOL_APPLY_PATCH` takes order 1350 between `TOOL_EDIT` (1300) and
  `TOOL_GLOB` (1400) — a curated insertion point, not a sort key.
- **One effective `complete` section becomes the sole prompt.** A session can declare that its prompt is not assembled
  from contributors at all. The superagent's router uses this (`04-the-superagent-prompts.md` §2); the harness restores
  that section as the only one and fails if more than one section claims to be complete.

Tool schemas join the same assembly, which is why the tool list and the prompt move together — and why a tool that appears
mid-conversation would reprice the prefix. mason made the same discovery and wrote it down in `runtime.ts`
("a tool list that changes between turns breaks the prompt cache").

## 7. "Where new behavior goes"

The table at the end of `docs/architecture.md` is the single most transferable artifact in the repository. It maps a
goal to a mechanism, in one line each, and the rule attached to it is that changing the loop updates the map. A sample:

| Goal | Mechanism |
|---|---|
| Add a model provider | register its adapter on `ctx.llm` |
| Add a model-facing capability | register on `ctx.tools`; its schema joins prompt assembly |
| Give one session a different capability set | compose an agent preset; a service row there needs an `isolate` realm |
| Add a human command | register on `ctx.commands`; it dispatches without a model turn |
| Start a session from an external webhook | register a trusted rule on `ctx.webhookRuntime` and mount a provider adapter |
| Intercept a request, tool, or turn | use its `agent/*` or `tools/*` event; `agent/turn-stopping` stops a turn |
| Add model-facing context | call `agent.inject()`; it lands in the next admitted request |
| Add durable session state | extend `SessionEventMap`; render and replay from the log |
| Scope a registration to one agent | use that agent's `agent.ctx` |

Beside it sits a *definition* the repo takes seriously: "A **seam** is a swappable capability with three roles: a Service
Definition declaring the interface, a Service Provider implementing it, and a Consumer using it… one role alone is not a
seam; adding a capability means designing all three" (`docs/architecture.md:126-131`). The generated capability graph
(`docs/capability-seams.md`, produced by `scripts/gen-doc-graphs.ts`) then prints, for every service, its providing
package, its known implementations and its direct consumers.

## 8. What makes it contributable — and what that machinery costs

The practices, in the order they help a stranger:

1. **A tier table with one home per fact.** `docs/AGENTS.md` lists each tier — root `AGENTS.md`, subtree `AGENTS.md`,
   `architecture.md`, `subsystems/`, Agent Notes (decisions), `defensive-patterns/` (review-enforced rules),
   `postmortem/` (incident stories), `cookbook/` (numbered procedures), package README (the per-package contract),
   generated reference — and says for each what does **not** belong there. A fact has one address.
2. **Word budgets, checked.** `scripts/doc-budgets.manifest.json` sets ceilings per file (root `AGENTS.md` ≤ 2,080 words,
   `architecture.md` ≤ 2,400), and `verify-doc-budgets` fails the build. When a file goes red the remedy is ordered:
   relocate, condense, and only then raise with a justification in the PR.
3. **Generated reference instead of hand-maintained lists.** The Cordis API surface, the tool catalogue, the config
   catalogue, the module graph, the persistence catalogue, CLI help and the seam graph are all regenerated from source
   and freshness-gated. Hand edits to them are rejected.
4. **A cookbook of procedures with verify steps**: `adding-a-package`, `adding-a-tool`, `adding-an-llm-adapter`,
   `adding-a-settings-card`, `adding-a-remote-api`, `adding-a-session-format-version`, `adding-a-vendored-package`, plus
   `extension-cookbook.md` mapping features to capabilities.
5. **Review-enforced rules with names.** `docs/defensive-patterns/` is "rules this repository enforces in review, split by
   artifact", and `packages/AGENTS.md` states the sharp ones as standing orders: business rules live in their own package;
   shared state has an owner; require a current owner and need for each abstraction; publish state only at its commit
   point; apply bounds to the complete result; registry contributions prove disposal.
6. **Tests that assert the composition, not the unit.** "Product-visible plugins require a non-unit REAL-composition test.
   Hand-built `ctx.plugin(...)` suites are insufficient… mock only external services" (`packages/AGENTS.md:7`). The
   postmortem that produced this rule ends: "100% line coverage was satisfied the whole time. Coverage proves lines ran;
   it says nothing about whether the feature works the way it ships" (`docs/postmortem/0001:98`).
7. **A slop checklist in the docs standard.** Duplicated rules, history outside its tier, implementation-status
   annotations, hand-restated catalogues, reasoning transcripts, paragraph walls, emphasis inflation, spec-speak. Anything
   that keeps 322 documents from turning into 322 arguments.

The cost is real: two documents per file (English + Chinese, with a pairing workflow and a terminology guide), a
`generate` step in every doc change, and a repo where a contributor must learn the tier table before writing a paragraph.
The contributor path itself is written as a tutorial — prerequisites, first-time setup, daily workflow, then a summary of
CI — with the checks named as `package.json` scripts rather than described in prose (`docs/development.md`).
`[judgement]` For mason, only items 1, 2, 3, 4 and 6 are worth their weight today; 5 and 7 are cheap to adopt as
review questions; the bilingual pairing is not applicable.

## 9. What the harness admits

- **Developer preview, breaking changes expected.** The README says so in capitals; the superagent pins an alpha version
  and warns it may contain bugs.
- **The framework is not pluggable.** "Everything is a plugin" is true of the product, not the runtime: `new Context()`
  hard-installs the service resolver, registry, event bus and logger; you can replace implementations but not the
  dispatcher (`01-cordis-the-plugin-model.md` §6).
- **The agent can install code into its own process.** The plugin manager lets the model add and remove bundles, which is
  exactly why HMR and revertible effects exist — and exactly why the deployment docs say to run it in a dedicated
  account and profile.
- **Composition files are large and replace whole values.** 548-line patches, no deep merge, and every patch mismatch is a
  warning rather than an error.
