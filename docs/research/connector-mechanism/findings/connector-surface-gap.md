# What does a mason connector contribute today, file by file, and what would it need to contribute if a connector could carry code?

## Answer
Today a connector contributes exactly one thing to the model's context — a single `description` line that `prompt.ts`
renders into the resident `integrations` section — plus a set of MCP tools that are all `deferred` and therefore cost no
prefix tokens until `tool_search` loads one; everything else it does (a fire, a command, health) is outside the prompt by
construction. Everything that is *not* a tool or a fire — where the answer goes, which words a chat may say, what the
reader sees as a row, what a chat renders while the agent works — mason had to invent itself, and it invented each one
with a hardcoded name (`mcp__telegram__send_message`), a closed tuple (`["stop","compact","clear","status"]`) or a fixed
whitelist (`projection.ts`), because a config entry cannot supply behaviour. The seams a code-carrying connector would
want already exist one level down — `defineExtension({tools, hooks})`, `PROMPT_SECTIONS`, `HooksManager.define`,
`COMMAND_NAMES`, `TranscriptItemSchema`, the `opened` unwind list — but every one of them is reached by a hardcoded
import in `runtime.ts` or a hand-maintained array, and none is reachable from `service/integrations.json`.

### 1. Today's contribution surface: entry key or envelope field → channel → who instantiates it → cost per turn

Character counts are measured from the source; the ~4-chars-per-token conversion is mason's own convention
(`docs/adr/0007-capabilities-are-listed-once-in-code.md` prices `generative_ui` at 77 tokens for a 308-char section), not
a provider tokenizer run — see Unanswered.

| Entry key / envelope field | Channel | Who instantiates it | Cost per turn |
|---|---|---|---|
| `enabled` (`boolean`, required) | gates both faces; read through `live()` | `integrations.ts:60`, `validate()` `integrations.ts:148-190` | 0 |
| `description` (`string`, required iff `tools` present) | prompt section `integrations` | `prompt.ts:153` → `renderIntegrations()` `prompt.ts:100-112` | **resident prefix**: 133-char pointer (~33 tok) + one `name: description` line per enabled integration with tools (~10 tok each) |
| `tools.url` (`http(s)`) | MCP Streamable HTTP client, one per integration | `mcp.ts` `connectIntegrations()` `mcp.ts:302`, called once from `runtime.ts:220` | 0 in the prefix while deferred; boot pays `tools/list`; a loaded tool's full schema joins the prefix for the rest of the branch [13] |
| `tools.required` (`boolean`) | boot policy: refuse vs. drop | `mcp.ts:340-358` | 0 |
| `trigger.hook` (`string`) | fire → `HooksManager.fire()` | door `main.ts:519-625`; validated at boot by `assertTriggersHaveHooks` `runtime.ts:448` | 0 prefix; the hook's template and payload become the turn's **user message** — measured 1,522 chars generic / 1,623 chars person variant for `team-chat`, 183–411 for the others (`hooks.ts:385-450`) |
| `trigger.secret` (`≥32 chars`) | HMAC-SHA256 over raw bytes, `x-mason-signature` | `events.ts:29`, `verifySignature()` `events.ts:83` | 0 |
| `commands[]` (`stop\|compact\|clear\|status`) | `kind:"command"` envelopes → `runCommand` | `integrations.ts:69` + `readCommands()` vs `events.ts:59`; dispatch `main.ts:386` | 0 prefix; `/compact` is a model call; own budget `command:<name>` 6/min (`limits.ts:33`) |
| envelope `v` (`1`) | contract version | `readEnvelope()` `events.ts:98` | 0 |
| envelope `id` (≤200, one line) | identity → `explicitRequestId(hook, "<name>:<id>")` | `main.ts:616` | 0 |
| envelope `kind` (token ≤64) | label; `"command"` is the only verb | `readEnvelope()` `events.ts:119`; rendered by `formatPrompt()` `hooks.ts:286` | one line `Event: <kind>` **inside the fired turn only** |
| envelope `payload` (≤2,000) | fenced untrusted text (8,000-char fence cap) | `untrusted.ts:40` `fenceUntrusted` from `hooks.ts:284` | per fire only |
| *any unknown key* | survives rewrite, ignored | `validate()` `integrations.ts:148-190` spreads `...raw` | 0 |
| *health — not a key* | `/api/integrations` JSON only | `integration-status.ts` registry, written by `mcp.ts`, read at `main.ts:684` | **0 by rule**: "nothing here is ever rendered into a prompt" |

Per-connector surface in `src/server/`, by size: `integrations.ts` 386 + `events.ts` 184 + `mcp.ts` 404 +
`integration-status.ts` 65 = **1,039 lines**; the per-connector knowledge that leaked *outside* those files is the subject
of §4.

### 2. What mason had to invent outside MCP because a connector is only configuration

| Invention | Where | Why the config/MCP pair could not carry it |
|---|---|---|
| A prompt presence | `prompt.ts:100-112` (`renderIntegrations`), `INTEGRATIONS_POINTER` `prompt.ts:89` | MCP `prompts` are user-invoked templates; a server cannot write a host's system prompt [12] |
| Reply routing | `hooks.ts:310` `DELIVERY_TOOL_NAME = /\bmcp__[a-z0-9-]+__send_message\b/g`, `deliveryToolOf`/`deliveryToolForTurn` `hooks.ts:338-357` | Nothing in MCP marks one of a server's tools as "the answer"; mason reads it back out of the hook's prose |
| The delivery gate | `extensions/delivery.ts:233-247` (`deliveryGate` `onYield`), reminder text in `src/shared/contract.ts:34-56` | A connector cannot make the model speak; only a `GenerationTask` hook in mason can |
| Command vocabulary | `events.ts:59` `COMMAND_NAMES`, `readCommand()` `events.ts:154`, dispatch `main.ts:386-420`, budget `limits.ts:24-33` | MCP is mason→server request/response; `/stop` arrives *while* a turn runs, from the other direction, mid-flight |
| Admission policy (who waits where) | `admission.ts:46-52` `whenBusyFor("hook")` | Derived from the entry *kind*, not from the connector; a connector has no say |
| Entry kinds in the reader's transcript | `projection.ts:9-12` whitelist; `TranscriptItemSchema` union `contract.ts:161-190`; `MESSAGE_TOOL`/`WIDGET_TOOL`/`HOOK_ENTRY_KIND` `contract.ts:13-15` | A connector cannot add a row to what the reader sees; the wire has a closed union |
| State subscription / presence | **absent**; nearest neighbours are `integration-status.ts` (health) and the Chord `AgentService` remote in `contract.ts:202-237`, which is the console's and owner-token-only | MCP has no mason→connector push of transcript/status/tools; the typing indicator lives inside the connector (`integrations/telegram/src/typing.ts`) and is started/stopped by its own poller and `send_message` |
| Identity of the speaker | `roster.ts`; `[from <name>]` prefix in `contract.ts:124-158` | The envelope has an integration name, not a person; mason writes the author itself |
| Untrusted-text fencing | `untrusted.ts` (`UNTRUSTED_OPEN`, `UNTRUSTED_RULE`, 8,000-char cap) | MCP tool results are not fenced; an event payload is spliced into an instruction |
| Fire identity and dedup | `hooks.ts:248-272` `explicitRequestId` / `scheduledRequestId` / `gestureRequestId` | MCP calls are not durable; a fire becomes a durable submission with a permanent request id |
| Per-connector budgets | `limits.ts:8-40`, keyed `integration:<name>` and `command:<name>` | Nothing in MCP or the JSON entry bounds spend |
| Boot refusal policy | `assertTriggersHaveHooks` `runtime.ts:448-470`; `required` in `mcp.ts:351-360` | The config file cannot know whether a name the operator wrote is a hook this build defines |
| Tool naming | `mcp.ts:157-166` `createMcpToolName`, 64-char cap + SHA-256 suffix | Provider tool-name rules and script callability are mason's constraints, not MCP's |

### 3. If a connector were code: each thing it would want, and the seam that already exists

"Shape" is: **parameter** (a value a caller passes today), **function** (a public callable the connector could be handed),
**hardcoded** (an import or a literal list in mason's source with no injection point).

| What a connector would want to add | Seam that exists today | Shape |
|---|---|---|
| Tools | `defineTool` → `defineExtension({ tools })`; installed via `BASE_EXTENSIONS` `runtime.ts:49-63` or the per-boot list `runtime.ts:267-272`; selection is a parameter (`options.extensions`, `options.selection`, stored `AgentDoc.extensions`) | **function** + **parameter** |
| A boot-time resource it owns (socket, sandbox, timer) | per-boot factory returning `{ extension, close }` — `createCodemode()` `extensions/codemode.ts:36`, `connectIntegrations()` → `McpTools.close()`; unwound by the single `opened` list `runtime.ts:230-233` | **function** — the best-fitting template in the tree |
| A prompt section | `PROMPT_SECTIONS` array `prompt.ts:137-160`, `section(key, fn)` | **hardcoded list**: "No other extension contributes a section" (`prompt.ts:8`); a section's *position* is its array index |
| A prompt section in a position that matters | `CODEMODE_SECTION` is imported and placed by hand precisely because installing the vendor extension would place it by extension order | **hardcoded** — and `extensions/codemode.ts:45-64` steals the renderer out of a **probe extension** built at module load |
| A hook definition / timer | `HooksManager.define()` `hooks.ts:94`; `setEnabled`, `fire` are public | **function** |
| The set of builtin hooks | `builtinHooks()` `hooks.ts:385`, called once at `runtime.ts:258` | **hardcoded import** |
| A hook template variable | `formatPrompt()` `hooks.ts:278-300` replaces `{{hook}} {{date}} {{payload}}` only | **hardcoded** string replace |
| A trigger kind (dispatch on `kind`) | none — `trigger.hook` is a name; `kind` is "a label for the log and the prompt, never a dispatch key" (`hooks.ts:39-43`) | **parameter** (a name), no dispatch |
| A command word | `COMMAND_NAMES` tuple `events.ts:59`, `isCommandName` `events.ts:135`, `runCommand` switch `main.ts:392-420` | **hardcoded** — vocabulary *and* dispatch; `integrations.ts:261-283` refuses a boot naming anything else |
| A row kind in the reader's transcript | `projectTranscript` if-chain over `entry.kind` and `call.name` `projection.ts:83-215`; `TranscriptItemSchema` closed union `contract.ts:161-190` | **hardcoded** both sides of the wire |
| Reply routing (where the answer goes) | `deliveryToolForTurn()` reading the hook's own instruction `hooks.ts:350`; refusal text `delivery.ts:75-88` | **hardcoded regex over a vendor tool name** |
| A state subscription (status / projection / tools / presence) | none for connectors; the console's Chord remote `contract.ts:202` with a single `owner` variant | **hardcoded** remote definition; no connector principal |
| Presence (typing dots) | none in `src/server/` | **absent** |
| A status surface beyond health | `integrationSummaries()` `integration-status.ts:49-64`; route `main.ts:684` | **hardcoded** route + fixed `IntegrationSummary` fields |
| Ingest work in mason's process | `api.env` (`RemoteExecutionEnv`) inside `execute()`; `agent/` mounted, `service/` never | **function**, but no connector-scoped handle or lifetime |
| A skill shipped with it | `discoverSkills(env, roots)` `extensions/skills.ts:58`, roots `[currentHouse().skillsDir]` `prompt.ts:147` | **parameter** (roots array) |
| Avoiding a nested call / declaring structured output | `nestedRefusal` `extensions/nested.ts:36`; `structuredOutputSchema` in `mcp.ts:196` | **function** / **parameter** |
| A capability listing with cost declared | `docs/adr/0007` proposes `src/server/capabilities.ts`; **the file does not exist** (`ls src/server` — absent) | **absent / proposal** |

### 4. Where the current design visibly hurts

1. **mason's server knows a vendor's tool name.** `hooks.ts:307-310`: *"So this is a convention over names rather than a
   name: a second integration's hook is answered by *its* message tool, and nothing here changes when one is declared."*
   The mechanism is `const DELIVERY_TOOL_NAME = /\bmcp__[a-z0-9-]+__send_message\b/g`. Issue #60 states the same thing as
   a defect: *"no vendor's tool name in `src/server/` (today it says `mcp__telegram__send_message`)"* [15].
2. **The resident delivery rule had to be made vague because it could not be true.** `prompt.ts:58-64`: *"It used to say
   `send_to_user` is the one channel — true in the console, false in a turn an event hook started … A resident section
   naming the tool that cannot arrive is worse than a vague one: the model follows it, and the call it makes is refused."*
   A connector that could contribute its own section would not need the section to hedge.
3. **The tool had to override the prompt.** `delivery.ts:13-15`: *"the person in the chat heard nothing at all. A prompt
   cannot fix that — the tool's description wins — so `execute()` refuses it in a hooked turn"*. Two mechanisms
   (description text + an error result) exist because routing is a convention rather than a declared fact.
4. **A 1,522–1,623-character vendor-specific instruction sits in mason's source, and one builtin hook is dead code.**
   `hooks.ts:381` (`personChatTemplate`) names `mcp__telegram__send_message` and `mcp__telegram__send_file` inline;
   `hooks.ts:408`: *"Inert until a configuration names it: no shipped configuration fires it, though an integration's
   trigger may. It stays as the natural target for a relay that compacts a repository's events into one trigger
   delivery."* Issue #61 is the fix: *"the Telegram entry's section replaces the prose currently hardcoded in the
   `team-chat` hook, so `src/server/hooks.ts` keeps one generic template"* [16].
5. **Vendor shapes are hand-copied and provenance is admitted in the comment.** `mcp.ts:76-82`: *"Copied, not imported,
   and hand-kept in step with the coding agent's `…/extensions/mcp/tools.ts`"* — and `MCP_OUTPUT_MAX_BYTES` is *"kept
   equal on purpose"* (`mcp.ts:63`). `extensions/codemode.ts:50`: *"It comes from a probe extension built once here,
   because the vendor does not export the renderer itself"*. A contribution surface with a real registration path would
   not need either copy or probe.
6. **Health needed a module-global mutable registry because a connector has no object to hang it on.**
   `integration-status.ts:10-12`: *"It is a registry rather than a return value because the boot that connects and the
   request that reports happen in different places, and the route is answered long after the connect has settled."*

## Claims
- The whole per-integration surface is configuration, by design [1] — "no TypeScript module, no extension, no client code per system" — direct
- The entry has five known keys and one switch [1] — "it is the only switch, and a face that is present is on" — direct
- The description is the connector's entire presence in the model's context [1] — "the prompt names it and describes it, and carries no schema" — direct
- Unknown entry keys are preserved; that nothing reads them makes them silently inert [1] — "A key mason does not know survives a rewrite, here as everywhere in this file" — partial
- The integrations prompt section costs 133 chars of pointer plus one line per integration [6] — "One line per enabled integration with a tools face, sorted by name, so two renders of one file are the same bytes" — inferred (the characters were measured; the token figures are 4-chars-per-token arithmetic, not a tokenizer run)
- MCP tools cost no prefix tokens while deferred [4] — "Every MCP tool is `deferred`." — direct
- `tool_search`'s own description is fixed so the deferred set cannot move the prefix [13] — "Fixed, so it does not change while deferred tools are registered, for example as MCP servers connect." — direct
- Boot is the resolution point because the tool list *is* the prefix [4] — "the tool list is prompt prefix: a surface that changed when a server reconnected would re-price the prefix" — direct
- Health is deliberately the one thing kept out of the prompt [5] — "Nothing else does, and nothing here is ever rendered into a prompt" — direct
- The command vocabulary is closed and deliberately equals what the console can do [2] — "a closed set, because every name here is a method the console can call too" — direct
- Reply routing is a hardcoded regex over a vendor-shaped MCP tool name [3] — "So this is a convention over names rather than a name" — direct
- Delivery routing had to be enforced in `execute()` because a prompt cannot win [10] — "A prompt cannot fix that — the tool's description wins" — direct
- The resident delivery section admits it was previously wrong [6] — "It used to say `send_to_user` is the one channel — true in the console, false in a turn an event hook started" — direct
- Only `prompt.ts` may contribute a prompt section [6] — "No other extension contributes a section, and the agent carries no `instructions` of its own" — direct
- The reader's transcript is a closed whitelist, not an extension point [7] — "a new entry kind or a new tool cannot leak by default — it is invisible until this file says so" — direct
- A 1,522–1,623-character vendor-named instruction lives in `hooks.ts` for the chat hook [3] — "answer it there with mcp__telegram__send_message" — direct (verbatim inside the template; length measured)
- One builtin hook ships with no configuration that fires it [3] — "Inert until a configuration names it: no shipped configuration fires it" — direct
- The extension seam is a boot list plus a per-conversation stored selection that is repaired [14] — "A conversation has a stored extension selection that is repaired at boot" — direct
- Code mode's prompt section is extracted from a probe extension because the renderer is not exported [20] — "It comes from a probe extension built once here, because the vendor does not export the renderer itself" — direct
- MCP's `prompts` primitive is user-invoked, so it cannot supply a host's system-prompt section [12] — "Prompts are designed to be user-controlled, meaning they are exposed from servers to clients" — direct
- The contract doc promises a boot refusal for `reply`/`state` that the code does not perform [11][1] — "an entry that uses `state` or `reply` without a mason that knows them refuses the boot" vs. code that spreads unknown keys through — partial (code read, refusal not exercised)

## Sources
[1] `src/server/integrations.ts` (386 lines) — file:///home/denis/dev/mason/src/server/integrations.ts — accessed 2026-10-30 — primary
[2] `src/server/events.ts` (184 lines) — file:///home/denis/dev/mason/src/server/events.ts — accessed 2026-10-30 — primary
[3] `src/server/hooks.ts` (439 lines) — file:///home/denis/dev/mason/src/server/hooks.ts — accessed 2026-10-30 — primary
[4] `src/server/mcp.ts` (404 lines) — file:///home/denis/dev/mason/src/server/mcp.ts — accessed 2026-10-30 — primary
[5] `src/server/integration-status.ts` (65 lines) — file:///home/denis/dev/mason/src/server/integration-status.ts — accessed 2026-10-30 — primary
[6] `src/server/prompt.ts` (173 lines) — file:///home/denis/dev/mason/src/server/prompt.ts — accessed 2026-10-30 — primary
[7] `src/server/projection.ts` (250 lines) — file:///home/denis/dev/mason/src/server/projection.ts — accessed 2026-10-30 — primary
[8] `src/server/main.ts` (836 lines; event door 505-620, `runCommand` 386-420, `/api/integrations` 684) — file:///home/denis/dev/mason/src/server/main.ts — accessed 2026-10-30 — primary
[9] `src/server/runtime.ts` (462 lines; `BASE_EXTENSIONS` 49, boot list 267-278, `assertTriggersHaveHooks` 433) — file:///home/denis/dev/mason/src/server/runtime.ts — accessed 2026-10-30 — primary
[10] `src/server/extensions/delivery.ts` (253 lines) — file:///home/denis/dev/mason/src/server/extensions/delivery.ts — accessed 2026-10-30 — primary
[11] `docs/CONNECTOR-PROTOCOL.md` (proposed contract; four channels, prompt section, versioning) — file:///home/denis/dev/mason/docs/CONNECTOR-PROTOCOL.md — accessed 2026-10-30 — docs
[12] Model Context Protocol specification — Prompts / Overview (2025-11-25) — https://modelcontextprotocol.io/specification/2025-11-25/server/prompts — accessed 2026-10-30 — docs
[13] `vendor/pi/packages/durable/src/tool-search/tool-search.ts` — file:///home/denis/dev/mason/vendor/pi/packages/durable/src/tool-search/tool-search.ts — accessed 2026-10-30 — vendor
[14] `docs/adr/0007-capabilities-are-listed-once-in-code.md` (proposed; names the empty seams) — file:///home/denis/dev/mason/docs/adr/0007-capabilities-are-listed-once-in-code.md — accessed 2026-10-30 — docs
[15] Issue #60 "Connector contract v1: voice, origin, reply router, and the end of send_to_user" — https://github.com/DenisSud/mason/issues/60 — accessed 2026-10-30 — primary
[16] Issue #61 "Each connector declares a prompt section" — https://github.com/DenisSud/mason/issues/61 — accessed 2026-10-30 — primary
[17] Issue #62 "Connectors subscribe to the state they render: status, projection, presence, tools" — https://github.com/DenisSud/mason/issues/62 — accessed 2026-10-30 — primary
[18] Issue #69 "A second chat connector (Slack or email) is the real test of the contract" — https://github.com/DenisSud/mason/issues/69 — accessed 2026-10-30 — primary
[19] `src/shared/contract.ts` (wire contract: `MESSAGE_TOOL`, `HOOK_ENTRY_KIND`, `TranscriptItemSchema`, `AgentService`) — file:///home/denis/dev/mason/src/shared/contract.ts — accessed 2026-10-30 — primary
[20] `src/server/extensions/codemode.ts` (66 lines) — file:///home/denis/dev/mason/src/server/extensions/codemode.ts — accessed 2026-10-30 — primary

## Conflicts
- **Doc promises a refusal that the code cannot produce.** `docs/CONNECTOR-PROTOCOL.md` § Versioning: *"The connector
  contract's own version is the file's: an entry that uses `state` or `reply` without a mason that knows them refuses the
  boot with the field's name, which is the same refusal a bad hook name gets today."* The code: `integrations.ts`
  `validate()` returns `{ ...raw, enabled, … }` — every unknown key is carried through, and the file's header states *"A
  key mason does not know survives a rewrite, here as everywhere in this file."* Writing `"reply": "send_message"` into
  `service/integrations.json` today is accepted, ignored, and preserved. Read from source; the refusal was not exercised
  (no write allowed in this run), but there is no branch in `validate()` that could produce it.
- **`docs/CONNECTOR-PROTOCOL.md` describes four declared channels and a 400–600-char `prompt` field; the code has none of
  them.** Protocol: *"`state: ["status", "projection", "presence", "tools"]`"*, *"`reply: "<tool name>"`, optional
  `also: ["<connector>"]`"*, *"A budget of 400–600 characters."* Code: `Integration` declares `enabled`, `description`,
  `tools`, `trigger`, `commands` and nothing else (`integrations.ts:58-72`); `grep speaks|capabilities|reply:|state:`
  over `src/server/*.ts` finds no such field.
- **Issue #60 says "the end of `send_to_user`"; the code today is the opposite.** `prompt.ts` `DELIVERY_INVARIANT` and
  `delivery.ts` both treat `send_to_user` as a channel that must be *refused* in hooked turns, i.e. it was already
  demoted in behaviour while its name remains the console's tool. Not a contradiction so much as a half-landed change;
  recorded because the doc and the labels disagree about how many channels exist.

## Unanswered
- **Token counts are estimates.** Every number in §1 is a character count from source divided by four, mason's own
  convention per ADR-0007 ("`promptTokens: 77`" for a 308-char section). No provider tokenizer was run, and no eval
  (`npm run eval`) was executed — it costs real tokens and the brief forbids spending.
- **What a *loaded* MCP tool costs in the prefix.** `mcp.ts` says a loaded tool joins the offered list via
  `control.addTools`, and `tool-search.ts` says loaded tools "stay offered on that branch, also after a compaction", but I
  did not measure a real tool's schema size. If a mechanism keeps MCP as a face, this is the one number that decides
  whether deferral is doing its job.
- **Whether `deferred` tool metadata reaches the wire at all** beyond the `tool_search` description. `tool-search.ts`
  fixes its description and reads `agent.deferred` server-side, which implies zero wire cost — but `deferred` is
  registered on the extension, and I did not trace `ToolRegistration.deferred` through `vendor/pi/packages/durable/src/
  harness/` to confirm nothing serializes the deferred list into a request.
- **No seam at all for presence or connector-side state push.** Issue #62 asks for `state: ["status","projection",
  "presence","tools"]`; I found no partial implementation anywhere in `src/server/`, and the Chord `AgentService` remote
  has a single `owner` variant with no connector principal (`contract.ts:202`). Whether Chord could host a second variant
  for a connector is a question for the mechanism, not answered here.
- **What `integrations.json` costs a person to learn.** I counted keys (5) and CLI verbs (`add|remove|enable|disable|
  secret|commands|list` in `scripts/integration.ts`) but did not measure onboarding time or error rates.
- **Not read:** `src/server/auth.ts`, `house.ts`, `run-retry.ts`, `resident.ts`, `status.ts` beyond the integration bits;
  `test/*.test.ts` (so the "tests pin this" claims in comments are taken as stated, not verified); ADR-0003/0005/0006
  reasoning (a sibling covers it).

## Queries
Web: one search, because this sub-question is answered from the repository and the sibling covers external systems.
- `Model Context Protocol specification 2025-11-25 server features prompts resources tools client features sampling roots elicitation` (provider: exa) — used only for the `prompts`-are-user-invoked claim [12].

Local reads (the actual evidence base):
- `cat src/server/integrations.ts`, `events.ts`, `integration-status.ts`, `mcp.ts`, `hooks.ts`, `prompt.ts`, `projection.ts`,
  `roster.ts`, `admission.ts`, `limits.ts`, `untrusted.ts`, `runtime.ts`, `extensions/{delivery,memory,codemode,sandboxed-ui,nested,skills}.ts`
- `sed -n '386,460p' src/server/main.ts`; `sed -n '480,700p' src/server/main.ts`; `sed -n '740,800p' src/server/main.ts`
- `grep -n` for entry keys, `COMMAND_NAMES`, `DELIVERY_TOOL_NAME`, `PROMPT_SECTIONS`, `BASE_EXTENSIONS`, `unconditionalExtensionNames`, `speaks|capabilities|reply:|state:`
- `gh issue view 60 | 61 | 62 | 69`
- `node -e` character counts of `DEFAULT_SOUL`, `PROACTIVE_GUIDELINES`, `TEAM_GUIDELINES`, `DELIVERY_INVARIANT`,
  `GENERATIVE_UI_POINTER`, `INTEGRATIONS_POINTER`, `UNTRUSTED_RULE`, and the five `builtinHooks()` templates
- `cat docs/CONNECTOR-PROTOCOL.md`; `sed -n '1,140p' docs/adr/0007-capabilities-are-listed-once-in-code.md`
- `wc -l src/server/*.ts src/server/extensions/*.ts integrations/telegram/src/*.ts`
