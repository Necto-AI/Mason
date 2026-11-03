# What mason can take from dsh, and what it should not

> Research note, 2026-11-03. `[judgement]` marks my reasoning. Every factual claim about dsh is cited in `01`–`04`; every
> claim about mason cites the file it is in. Written after reading both trees, not from the marketing.

## 0. The goal is different, and it decides most of the answer

dsh is a **harness for many applications**: 379 packages, 322 English docs, ~143k lines, five shipped profiles, a plugin
marketplace, and hot module reload so the agent can install and remove parts of its own runtime. Its value is the
platform: whatever an app needs, there is a seam, and a third party can mount a bundle beside the core without a fork.

mason is **one deployment, one bot, one owner**: one prompt with one owner (`src/server/prompt.ts`), one conversation,
connectors as the interface boundary, a permission gateway in front of every tool, and an operator panel that is a
control plane. Its value is behaviour and durability, not extensibility for third parties.

That difference kills the biggest dsh idea (load arbitrary code into the running process) and leaves the smaller, more
useful ones: how a capability is named and declared, how the surface of the system is documented so a stranger can add to
it, and how a prompt is kept honest. `[judgement]`

mason is also about the size of the superagent prototype — ~14.7k lines in `src/` against its ~15.2k — and not the
harness. The right comparison for cost is the bundle, not the platform.

## 1. What mason already has, and dsh does not, or does worse

Worth stating first, because three of the transferable practices are already mason's and only need making explicit.

- **An extension model with no plugin loader.** `Extension` already carries `name`, `tools`, `sections`, `hooks`,
  `wraps`, `tasks` (`vendor/pi/packages/durable/src/harness/types.ts:371-380`), and a conversation selects what runs.
  Composition is code, selection is data, and nothing is fetched at runtime. That is the same shape as dsh's presets
  (`cordis.patch.yml`) with the whole plugin-loading half removed — which is the half mason must not have.
- **Derived status instead of a stored one.** `src/server/status.ts` derives `AgentStatus` from the committed view;
  dsh's Ticket carries a stored stage with a first-matching-row-wins table (`docs/003-execution.md`). Mason's version
  cannot disagree with the transcript, which is a stronger property.
- **Idempotence keys that name the caller's intent.** `hooks.ts` distinguishes `explicitRequestId` (permanent),
  `scheduledRequestId` (one per interval slot) and `gestureRequestId` (never collapsed)
  (`src/server/hooks.ts:272,281,290`, documented at `:33-42`).
  The superagent collapses one source message into one ticket and relies on a trigger id; mason's three tiers are a finer
  answer to the same problem, and the doc comment explaining why is better than anything in the dsh tree.
- **The credential boundary.** Every path in is authenticated, the `pi-env` daemon runs under `env -i` with an allowlist,
  and connector credentials open exactly two paths (`src/server/auth.ts`, `src/server/connectors.ts`). dsh's own
  deployment doc tells operators to use a dedicated OS account because the bundle changes process-wide `PATH` and git
  settings, and the design article lists "credentials that must never enter the context" as an *open problem*
  (§8.4). mason solved the thing dsh says is unsolved.
- **A projection whitelist.** `src/server/projection.ts` decides what a device is sent, and `trace` is a separate grant.
  I found no equivalent in dsh: its web client is the operator's own UI, and the only filtering I could find near that
  seam is per-tool presentation metadata for the model, not a server-side whitelist for a reader. `[judgement]`

## 2. The transfers, ranked by value over cost

### T1. An architecture document that is current truth, plus a "where new behaviour goes" table

**dsh does**: `docs/architecture.md` is an ordered map — composition, core packages, turn flow, seams — and ends with a
table that answers the only question a contributor has: *I want to add X, what do I touch?* Nineteen rows, each naming a
mechanism rather than a file: "add a model provider → register its adapter on `ctx.llm`", "intercept a request, tool or
turn → use its `agent/*` or `tools/*` event", "add model-facing context → call `agent.inject()`"
(`docs/architecture.md`, "Where new behavior goes"). The rule attached to it is that changing the loop updates the map.

**mason would**: add `docs/ARCHITECTURE.md` with the same job and the same ending: an inventory of mason's dozen or so
extension points, each with the file that owns it, the mechanism, and the test that pins it. This is not a replacement for
`docs/SPEC.md`: that file is doing three jobs at once — product goal, milestone specification, and a repository map — and
it already says plainly which parts are not built (`"None of this is implemented"`, `docs/SPEC.md:46-49`). The map and the
*what is true today* belong in one page that changes when the code does; the milestones stay where they are. A first draft
of the rows, from reading the tree:

| Goal | Where |
|---|---|
| A new agent capability (a tool, a prompt section) | `src/server/extensions/*.ts`, installed in `BASE_EXTENSIONS` (`runtime.ts:50-63`) |
| A new way for words to arrive | a connector face in `packages/protocol`, plus `src/server/connector.ts` |
| A new service the agent reaches | `service/integrations.json` (tools face) or a connector `connector` block |
| Something that wakes the agent | `src/server/hooks.ts`, a fire from a connector, or a schedule |
| A new permission decision | `src/server/permissions.ts` (`beforeTool`), markers on the tool, a rule in the connector grant |
| A new panel area | `src/web/admin/sections/`, a route in `src/server/admin.ts` with `requireGrant`, a grant in `src/shared/admin.ts` |
| A new thing a reader may see | `src/server/projection.ts` first — nothing reaches a device until the whitelist says so |
| A new fact the agent keeps | `src/server/extensions/memory.ts`, one dated line in `agent/log/` |
| A new skill | `skills/<name>/SKILL.md`, copied to `agent/skills/` on first boot |

**Cost**: a day of writing, and it will be wrong in places until it is checked. **Payoff**: this is the single highest
ratio in the whole study. mason's equivalent today is `AGENTS.md` — 80 paragraphs, ~2,660 words of standing orders, above
the 2,080 dsh allows its own root file — plus `docs/SPEC.md` (968 lines, ~13,500 words, mostly milestone history).
Neither answers "where does X go" for someone who did not write it.

**The catch**: the table rots. dsh knows this and makes the machine check what it can — the capability graph is generated
from a script (`docs/capability-seams.md` opens with "Generated by scripts/gen-doc-graphs.ts - do not edit by hand"), and
`module-graph.md`, `tool-catalog.md`, `config-catalog.md` are generated too. So T1 and T2 are one piece of work.

### T2. A generated catalog of the surface, checked in CI

**dsh does**: `scripts/gen-doc-graphs.ts` emits the service/seam graph; other generators emit the tool catalog, config
catalog, module graph and CLI help. Freshness is gated: the English source is regenerated, and stale output fails.

**mason would**: one script, `npm run gen:surface`, rendering a table the code already knows:

- every HTTP route in `src/server/main.ts` and `src/server/admin.ts`, with the grant that guards it and the file:line;
- every connector method and its budget class from `src/server/connector.ts` + `src/server/limits.ts`;
- every extension, and which tools and prompt sections it contributes;
- every hook and the limits that apply to it;
- every projection row kind (`src/shared/contract.ts`) and who may see it.

`npm run gen:surface -- --check` in CI, exactly like `verify-vendor.mjs` and `prove:connector` already work here.

**Cost**: two days. **Payoff**: mason's stated failure mode is "a new route without a `requireGrant` is unauthenticated by
omission" (`AGENTS.md` §6) — a generated table with the grant column makes that omission visible in the diff instead of in
an incident. Same for a tool that shows up in the registry without a marker, or a projection field added without a
whitelist entry.

### T3. One home per fact, and a budget per file

**dsh does**: a tier table that names, for each place a fact can live, what belongs there and what does not
(`docs/AGENTS.md`): root `AGENTS.md` = standing orders only; `architecture.md` = the map; `docs/subsystems/` = type
definitions; Agent Notes = the why; `cookbook/` = procedures with numbered verify steps; package README = the contract.
Then word ceilings per file (`scripts/doc-budgets.manifest.json`, root `AGENTS.md` ≤ 2,080, `architecture.md` ≤ 2,400)
with `pnpm run verify-doc-budgets` failing the build. The stated remedy when a file goes over is: relocate, condense,
raise only with a justification in the PR.

**mason would**: write the tier table for mason (there are seven places a fact can live: `AGENTS.md` for standing orders,
`GLOSSARY.md` for vocabulary, `docs/adr/` for decisions, `docs/research/` for evidence, `docs/*-PLAN.md` for plans not yet
built, `docs/SPEC.md` for the milestone specification, and `src/**` comments for local contracts), and a
`scripts/doc-budget.mjs` with a manifest of ceilings. Start by freezing today's sizes, then ratchet down.

**Cost**: half a day for the script, a day to relocate. **Payoff**: `AGENTS.md` is the file every fresh agent reads first,
and it is ~2,660 words; every word there is paid for in every session that reads it.

### T4. Name the capability, declare the dependency, own the state

**dsh does**: a plugin declares `inject: ['tools']` and stays PENDING until the service exists; registrations are effects
that unwind on unload; the repo's own rule is "Give shared state an owner. Hang shared state on a service or instance. A
module-level cache, a singleton, a global `WeakMap` … hides that owner" (`packages/AGENTS.md`).

**mason would**: not a framework. Three smaller things:

1. **A `capabilities` table** — one module that names every ambient capability a section or tool may read (house paths,
   integrations, permissions, hooks, prompt) and passes it explicitly. Today two of them are module-level `let`s
   (`src/server/house.ts:96`, `src/server/integrations.ts:412`), with a real reason documented in both: prompt sections
   are installed at import time and cannot be handed arguments (`house.ts:90-95`). So the first step is a `Services`
   record threaded to `render(input, context)` call sites, not a rewrite.
2. **Declared dependencies in the extension table.** `Extension` has no service lookup; coordination is by string name —
   `hooks: {task: string, handlers: object}`, `wraps: {tool: string}` (`types.ts:363-369`). A typo in a task name is
   silent. A boot check that every installed extension's `hooks[].task` and `wraps[].tool`/`.section` name exists is a
   ten-line test with a real bug class behind it.
3. **A disposer rule** for anything registered per conversation, so `selection` changes cannot leave a listener or a
   socket behind. mason already disposes MCP catalogs and Chord watches by hand; the rule makes it a review question
   instead of a habit.

**Cost**: two to three days. **Payoff**: modesty — this is the part of Cordis that survives when the framework does not.

### T5. Treat the model-visible surface as an artifact with a budget

**dsh does**: a test enumerates every model-visible string the bundle can produce — prompt parts, both skills, every card,
every notice, one tool error — and a char budget caps prompt + tool definitions per role
(`tests/model-surface.spec.ts:36-40,360-365`). Banned-phrase tests carry the rule each phrase broke, with a deliberately
empty tolerated list (`:53-60`). And a stated ordering rule: generated, config-derived text goes **last**, so a settings
change reprices only the tail, not the prefix.

**mason would**:

- Extend `test/prompt.test.ts` from "the sections are in this order" to "this is the whole model-visible surface": the
  prompt, every tool description, every untrusted-text fence, every refusal sentence a connector can receive.
- Add a char ceiling for prompt + tool schemas, and the rule that a ceiling only goes up with a justification.
- Pin the ordering: any section derived from mutable configuration goes after everything stable. mason already does this
  in spirit — `prompt.ts` says the identity section is "fixed for the conversation so the cached prefix holds" — and
  `test/cache-telemetry.test.ts` measures the cache. Making it a rule with a test is what stops the next section from
  landing in the middle.

**Cost**: a day. **Payoff**: mason's prompt is one file with one owner, which is the right shape; the missing piece is the
budget, and the budget is what forces the next addition to argue for itself.

### T6. The attention rules, in the proactive prompt

**dsh does**: writes the noise budget as sentences with a gate behind each. Silence is the default; one question at a
time in a structured field; confirm once and name the object; never announce an unfinished result; "100 words is a hard
ceiling, not a writing target" (`prompts/replies.md:27`).

**mason would**: take three of them into `PROACTIVE_GUIDELINES` (`src/server/prompt.ts:42-48`), which already says "Act,
do not ask permission… Report once. If nothing needs attention, say so in one line":

- never announce that you are starting; the next thing you send is a result or a question;
- when a turn needs a decision, ask one question, and put it in the reply rather than in working notes;
- a failure is reported as a failure, and a partial result says what is missing.

**Cost**: one revision, one test asserting the sentences are present. **Payoff**: small but real, and it is the kind of
line that only matters when the agent is wrong — which is when it matters most.

**Not** the 100-word ceiling: for a one-person assistant with one reader, a hard cap would truncate the answer he asked
for. dsh pays that cost because a mistake there lands in a colleague's chat. `[judgement]`

### T7. When unattended work arrives, the shape to reach for

mason does not run unattended work yet (`docs/ENV-PLAN.md`, `docs/adr/0009`). If it does, dsh's Mandate is the design to
copy: an accept mints an immutable record of *why* the work is allowed and *how far* it can go, a wider scope needs a new
record, and a resume revalidates the record against current policy (`dsh-superagent docs/001-domain.md`, "Mandate"). Plus
the stage table: one stored stage, first matching row wins, one panel label per stage, and the panel shows only what waits
for a person (`dsh-superagent docs/003-execution.md`).

mason's seed for this is already in the transcript: `app.permission` and `app.permission-answer`, with "the first answer
final" (`AGENTS.md` §7). The gap is that a grant is per call, not per piece of work, so nothing today survives a restart
as "this was allowed".

One warning from the same source: the superagent's Mandate records a `scope`, and that scope is only a string the model
wrote — nothing compares an action to it (`03-the-superagent-as-a-bundle.md` §7). A grant worth having is one a program can
check against, or it is a comment. If mason ever builds this, the scope has to be a predicate over tool calls, not a
paragraph.

**Cost**: a milestone, not a task. **Payoff**: it is the difference between an agent that asks and an agent that can be
trusted with a queue.

### T8. The two-level split, if a turn ever outgrows the reader

The design article's own example is a personal agent: one chat page, a worker per topic behind it (§2.2). The measured
reason is not throughput but stability: a single session that decides per turn whether to delegate has a long tail
(p95 29.5 min against 15.7), and it pays for the split in cache reads (23.2M against 6.1M tokens per run). `[article]`

mason's turns are short by construction — the reader waits, the reply is one message. Copying the split now would buy a
tail mason does not have, at four times the tokens. Revisit when a turn can outlive a person's patience, or when hooks
start queueing behind each other. `[judgement]`

## 3. What does not transfer, and why

| dsh idea | Why not in mason |
|---|---|
| Third-party plugins loaded into the process; a marketplace; the agent installing its own plugins | Every way in must pass a credential check, and a plugin runs with the agent's own authority, behind every gate. dsh's answer is "use a dedicated OS account"; mason's is "there is no such door" (`AGENTS.md` §6). Loading a bundle would be an unauthenticated way to change what the agent can do. |
| HMR, profiles, bundles, `cordis.patch.yml` layers | These exist so one install serves many apps and many experimenters. mason ships one composition as code. A patch language is one more surface to secure, and `--dump-config`-style patching has no operator who wants it. |
| Team-editable prompt parts, versions, "Default updated" diffs | The operator already edits `service/soul.md` and `agent/profile.md` directly; the file *is* the override, with git as the version history. Re-building a versioned override layer over files would be a second, worse source of truth. |
| 379 packages, one service per micro-concern | mason is 14.7k lines. The split buys parallel ownership, not correctness, and it costs a build graph. |
| i18n pairs for every doc | One operator, one language. |
| A purpose-typed `reply` with four purposes | mason has exactly one reader and one channel. The distinction that matters — "this needs him" versus "this reports to him" — already exists as the approval door. |
| The 100-word chat ceiling | See T6. |
| A watchdog *agent session* that fixes the system with tools | Attractive and premature: it presumes the system can rewrite itself. mason's `run-retry.ts` plus derived status cover the failure that actually happens (a run that dies). |

## 4. What I would do next, in order

1. **`docs/ARCHITECTURE.md`** with the where-new-behaviour-goes table (T1). One PR, docs only, no code risk.
2. **`npm run gen:surface`** with a `--check` in CI (T2). Start with the two columns that matter: route × grant, and
   extension × tool × section.
3. **`docs/AGENTS.md` tier table plus `doc-budget.mjs`** (T3), freezing today's sizes.

Those three are the whole of "easier to contribute" for a codebase this size, and none of them depends on the other two.
T4 and T5 are the code-side pair; T6 is a prompt edit that can ride along with anything.

Anything that needs a framework — activation ordering, revertible effects, per-context services — should wait until mason
has a second composition to justify it. `[judgement]`
