# What does one connector-authored contribution cost in resident-prefix tokens — a 400–600-character prompt section, a command vocabulary entry, and an MCP tool's schema after `tool_search` promotes it?

## Answer

All three prices, computed with the method mason already uses (`chars / 4`, the divisor ADR-0007's `promptTokens` is
built on and the one pi-durable hard-codes for its own codemode budget), rounded up:

| Contribution | Measured characters | Tokens @4 (mason's convention) | Tokens @3.5 (pi-ai's own estimator) |
|---|---|---|---|
| A 400-char prompt section, tagged, one key | 423 (400 + 21 frame + 2 join) | **106** | 121 |
| A 600-char prompt section, tagged, one key | 623 (600 + 21 frame + 2 join) | **156** | 178 |
| A command vocabulary entry, *person-typed* (pi `registerCommand`, mason's `/stop`) | 0 — dispatcher table, never in the prompt | **0** | 0 |
| A command entry carried as a skill-index line (one line + XML frame) | 203 for `telegram` + a 60-char description | **51** (of which 24 is XML overhead) | 58 |
| A command entry the *model* can call (i.e. a tool) | — | = a tool's price, below | — |
| `mcp__telegram__send_message` declaration, promoted by `tool_search` | 612 | **153** | 175 |
| `mcp__telegram__list_chats` declaration, promoted | 185 | **46** | 53 |
| `tool_search` itself (paid every turn, whether or not anything is loaded) | 346 | **87** | 99 |

So one connector's section **and** one command, the A/B shape, costs about **106–156 tok/turn resident** for the section
plus 0 for a person-typed command — call it **110–160 tok per connector per turn**, forever, on every bot. The C shape
(today's MCP face) costs **~10 tok** for its description line plus the shared 87 tok for `tool_search`, and then
**46–153 tok once per promoted tool**, which stays in the offered tool list for the rest of the conversation [4][9][10].
The crossover is therefore concrete: **promoting one small MCP tool costs about as much as one 600-char section, and
stays until compaction; a 400–600-char section is cheaper than promoting two tools and dearer than promoting none.**
The loaded-tool figure the sibling notes called decisive is 46–153 tok for mason's own connector — but the same figure
for real third-party MCP servers runs **200–950 tok per tool** on Anthropic's published accounting, which is the case
deferral exists to avoid.

## Claims

1. **mason's cost convention is `chars / 4`, applied to section text, and it is the same convention the vendor uses for
   its own prompt budget.** ADR-0007's `CapabilityCost.promptTokens` is documented as *"What it adds to every turn of
   every bot that has it, in tokens: the section it owns, or a skill's one line in the index. A test pins this to the
   text it describes, so the number a person reads is the number the prefix pays."* [1]. pi-durable's codemode section
   budget uses the same divisor: `const CHARS_PER_TOKEN = 4;` beside `export const DEFAULT_CODEMODE_INLINE_BUDGET = 3000;`
   [2]. **Support:** direct. **Confidence:** high.

2. **A second, official divisor exists in the same repo and is 3.5, so every `/4` number in these notes is ~12–14%
   optimistic.** `vendor/pi/packages/ai/src/utils/estimate.ts:15`: `const CHARS_PER_TOKEN = 3.5;`, and a tool's cost in
   pi-ai's own context accounting is the JSON of its declaration divided by it: `return estimateTextTokens(safeJsonStringify(tools));`
   [3]. Neither is a tokenizer run. **Support:** direct (code), interpretation (the size of the gap). **Confidence:** high.

3. **A section's price is its text *plus* a tag frame *plus* a two-character join, and the existing convention omits
   both.** `renderSections` wraps tagged sections as `` `<${section.key}>\n${text}\n</${section.key}>` `` and
   `getSystemMessageText` joins the rendered sections with `"\n\n"` [2][3]. For an 8-character key that is 21 chars
   (5 tok); for `github-issues` it is 31 chars (8 tok). Measured: `GENERATIVE_UI_POINTER` is **306** characters, and
   ADR-0007 prices `generative_ui` at **77** tokens — which is 308/4, i.e. the text only, no frame [1][5].
   **Support:** direct (code, measurement), interpretation (that the ADR's number is text-only). **Confidence:** high.

4. **A person-typed command costs nothing in the resident prefix, in both mechanisms.** pi: `pi.registerCommand()` adds
   to `commands: Map<string, RegisteredCommand>` [6], which the interactive mode dispatches; `system-prompt.ts` lists
   skills and docs and never commands [7]. mason: the closed set lives in `events.ts`
   (*"a closed set, because every name here is a method the console can call too"* [8]) and an integration's `commands`
   list is read from `service/integrations.json` at boot [9]; `grep -n command src/server/prompt.ts` returns nothing, and
   `promptSectionKeys()` is `preamble, cwd, proactive_guidelines, team, skills, profile, generative_ui, integrations,
   codemode, delivery` [5]. **Support:** direct. **Confidence:** high.

5. **If a command must instead be *listed* for the model, the cheap shape is the skill index: ~51 tok for a typical
   entry, 24 of which is fixed XML.** `formatSkillsForPrompt` emits five lines per skill
   (`<skill>`, `<name>`, `<description>`, `<location>`, `</skill>`), 97 characters of markup with empty fields [11];
   measured 203 chars end-to-end for `telegram` + a 60-character description + a 60-char path = 51 tok @4. Anthropic's
   own published price for the same shape is *"~100 tokens per Skill"* for level-1 metadata, and *"until a Skill is
   triggered, only its name and description occupy context"* [12]. mason's own skills section uses exactly this renderer
   (`formatSkillsForPrompt` imported from `@earendil-works/pi-coding-agent` in `src/server/extensions/skills.ts` [13]).
   **Support:** direct (pi's format, measurement), source statement (Anthropic). **Confidence:** high.

6. **The command-vocabulary item in `docs/CONNECTOR-PROTOCOL.md` has no way to be free once the mechanism is code: a
   model-invocable command is a tool, and a tool costs its JSON.** The protocol's own words: *"A budget of 400–600
   characters. Longer is a skill, and skills are loaded on demand."* [14] — the contract already prices the two shapes
   against each other. **Support:** interpretation (from the contract text plus the two measured shapes).
   **Confidence:** medium.

7. **A promoted MCP tool costs its whole declaration — name, server description, and the JSON Schema `zod` produces —
   and mason's own connector sits at the cheap end.** Measured by converting `integrations/telegram/src/mcp.ts`'s zod
   schemas with the same `zod-to-json-schema` the server ships (`{ target: "jsonSchema7", $refStrategy: "none" }`):
   `mcp__telegram__send_message` serialises to **612 chars** (464 of them the parameter schema), `mcp__telegram__list_chats`
   to **185** (no parameters). `createMcpTool` passes the server's `inputSchema` through `toParameters` unchanged
   (`"...schema, type: schema.type ?? "object", ..."`) [4], so nothing shrinks it. **Support:** direct (measurement,
   code). **Confidence:** high for these two tools.

8. **That figure is not universal: real MCP servers are 200–950 tok per tool.** Anthropic's API docs:
   *"A typical multiserver setup (GitHub, Slack, Sentry, Grafana, and Splunk) can consume ~55k tokens in definitions
   before Claude does any work"* [15]; Claude Code's SDK docs: *"Tool definitions can consume large portions of the
   context window (50 tools can use 10-20K tokens)"* [16]. That is 200–400 tok/tool on the second figure and ~950 tok/tool
   averaged over ~58 tools on the first. mason's telegram tools (46–153) are 1.3–4× cheaper than the first band because
   their schemas are three parameters with one-line descriptions. **Support:** direct (quotes), interpretation (the
   arithmetic). **Confidence:** high on the quotes, medium on the per-tool derivation.

9. **Deferral's fixed price is `tool_search`'s own description, 87 tok, and it is deliberately fixed so the deferred set
   cannot move the prefix.** `TOOL_SEARCH_DESCRIPTION` measures 346 characters; its comment says *"Fixed, so it does not
   change while deferred tools are registered, for example as MCP servers connect."* [17] The same design appears in the
   vendor docs: Anthropic keeps the search tool resident (*"~500 tokens"*) and strips deferred tools *"from the rendered
   tools section before the cache key is computed"* [15][18]. **Support:** direct (measurement, quote).
   **Confidence:** high.

10. **A promoted tool's price is paid for the rest of the conversation, not once.** `offeredTools` appends
    loaded deferred tools after the kept ones (*"Loaded deferred tools follow in load order, so loading one appends to
    the declared tools"*) [10], and the declaration then rides in the offered tool list of every later request until
    compaction removes it. Anthropic says the same of its own mechanism: loaded tools *"stay available for subsequent
    turns until the SDK compacts the messages where the agent discovered them"* [16]. **Support:** direct (code and
    quote). **Confidence:** high.

11. **Mason does not double-charge a promoted MCP tool through codemode.** The codemode section filters on the
    registration flag, not on the offered set: `input.agent.callable.filter((tool) => !tool.name.startsWith(CODEMODE_INTERNAL_PREFIX) && tool.deferred !== true)`
    [2]. An MCP tool is registered `deferred: true` [4], so it never appears in the codemode text even after promotion —
    its only cost is the native declaration. **Support:** direct (code). **Confidence:** high.

12. **In the A/B shapes, a connector's section cannot be added without editing a pinned array, which is a review cost as
    well as a token cost.** `test/prompt.test.ts:693` asserts the exact list of section keys, and the test's comment
    states the invariant: *"The point of `prompt.ts`: nothing else may add a section, so reading one file tells you
    everything the agent is told. A new extension that quietly contributes prompt text would pass every other test in
    this file."* [5][19]. **Support:** direct. **Confidence:** high.

13. **One connector, priced two ways, for brief item 7.** A design with one 500-char section + one person-typed command +
    two telegram-shaped tools costs **~135 tok/turn** if the tools are always offered, **~135 tok/turn** if they are never
    used and promoted on demand (**~135 + 46–153** in the turns after promotion), and **132 tok/turn + 0 tools** if the
    section is dropped for a skill line. A design that offers *no* section but keeps the MCP face costs **97 tok/turn**
    cold (line 10 + `tool_search` 87). **Support:** researcher inference from claims 1, 4, 7, 9, 10.
    **Confidence:** medium — arithmetic is exact, the design shapes are assumed.

## Sources

- [1] `docs/adr/0007-capabilities-are-listed-once-in-code.md` (proposed; `CapabilityCost`, `promptTokens: 77` for `generative_ui`) — file:///home/denis/dev/mason/docs/adr/0007-capabilities-are-listed-once-in-code.md — accessed 2026-10-30 — docs
- [2] `vendor/pi/packages/durable/src/codemode/describe.ts` (`CHARS_PER_TOKEN = 4`, `DEFAULT_CODEMODE_INLINE_BUDGET = 3000`, `codemodeSection`) — file:///home/denis/dev/mason/vendor/pi/packages/durable/src/codemode/describe.ts — accessed 2026-10-30 — vendor
- [3] `vendor/pi/packages/ai/src/utils/estimate.ts` (`CHARS_PER_TOKEN = 3.5`, `estimateToolsTokens`) and `.../ai/src/utils/text.ts` (`getSystemMessageText`, `"\n\n"` join) — file:///home/denis/dev/mason/vendor/pi/packages/ai/src/utils/estimate.ts — accessed 2026-10-30 — vendor
- [4] `src/server/mcp.ts` (`toParameters`, `createMcpTool`, `deferred: true`) — file:///home/denis/dev/mason/src/server/mcp.ts — accessed 2026-10-30 — primary
- [5] `src/server/prompt.ts` (constants, `renderIntegrations`, `PROMPT_SECTIONS`, `promptSectionKeys`) — file:///home/denis/dev/mason/src/server/prompt.ts — accessed 2026-10-30 — primary
- [6] `vendor/pi/packages/coding-agent/src/core/extensions/types.ts` (`commands: Map<string, RegisteredCommand>`) and `docs/extensions.md` (*"Add a `/` command | `pi.registerCommand()`"*) — file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/docs/extensions.md — accessed 2026-10-30 — vendor
- [7] `vendor/pi/packages/coding-agent/src/core/system-prompt.ts` (sections: docs, skills, cwd — no command listing) — file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/system-prompt.ts — accessed 2026-10-30 — vendor
- [8] `src/server/events.ts` (`COMMAND_KIND`, the closed command set) — file:///home/denis/dev/mason/src/server/events.ts — accessed 2026-10-30 — primary
- [9] `src/server/integrations.ts` (`readCommands`, `commandsFor`) — file:///home/denis/dev/mason/src/server/integrations.ts — accessed 2026-10-30 — primary
- [10] `vendor/pi/packages/durable/src/harness/agent.ts` (`offeredTools`, `deferred` split, `toolsAdded`) — file:///home/denis/dev/mason/vendor/pi/packages/durable/src/harness/agent.ts — accessed 2026-10-30 — vendor
- [11] `vendor/pi/packages/coding-agent/src/core/skills.ts:358-388` (`formatSkillsForPrompt`) — file:///home/denis/dev/mason/vendor/pi/packages/coding-agent/src/core/skills.ts — accessed 2026-10-30 — vendor
- [12] Agent Skills — overview (progressive disclosure table: *"~100 tokens per Skill"*, *"only its name and description occupy context"*) — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md — accessed 2026-10-30 — primary docs
- [13] `src/server/extensions/skills.ts` (imports `formatSkillsForPrompt` from `@earendil-works/pi-coding-agent`) — file:///home/denis/dev/mason/src/server/extensions/skills.ts — accessed 2026-10-30 — primary
- [14] `docs/CONNECTOR-PROTOCOL.md` § The prompt section — file:///home/denis/dev/mason/docs/CONNECTOR-PROTOCOL.md — accessed 2026-10-30 — docs
- [15] Tool search tool (*"~55k tokens in definitions"*, tool-search tool *"~500 tokens"*) — https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool.md — accessed 2026-10-30 — primary docs
- [16] Scale to many tools with tool search (Claude Agent SDK) (*"50 tools can use 10-20K tokens"*, tools stay until compaction) — https://code.claude.com/docs/en/agent-sdk/tool-search.md — accessed 2026-10-30 — primary docs
- [17] `vendor/pi/packages/durable/src/tool-search/tool-search.ts` (`TOOL_SEARCH_DESCRIPTION`) — file:///home/denis/dev/mason/vendor/pi/packages/durable/src/tool-search/tool-search.ts — accessed 2026-10-30 — vendor
- [18] Tool reference (`defer_loading` and prompt caching) — https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference — accessed 2026-10-30 — primary docs (read via search summary; not re-fetched)
- [19] `test/prompt.test.ts:684-718` (the pinned section list) — file:///home/denis/dev/mason/test/prompt.test.ts — accessed 2026-10-30 — primary

## Conflicts

- **Two divisors in the same repository.** mason's convention and ADR-0007's `promptTokens` use 4; pi-ai's own context
  accounting uses 3.5 (`estimate.ts:15`), and pi-durable's codemode budget uses 4 again [1][2][3]. Every token figure in
  these notes inherits a 12–14% spread from that choice. Reported, not resolved: the notes should state which divisor
  they used, or state a range.
- **ADR-0007's `promptTokens` does not include what the prefix actually pays for a tagged section.** It prices
  `generative_ui` at 77 = 308/4, while the constant measures 306 characters and the rendered section is 306 + 31 frame +
  2 join = 339 chars = 85 tok [1][3][5]. The field's own doc comment says *"the number a person reads is the number the
  prefix pays"* — for a tagged section it is not. Same for the sibling note's 133-char integrations pointer: measured
  here at 131 (the difference is a trailing newline in whichever copy was counted).
- **Per-tool cost spans an order of magnitude across sources.** mason's own telegram tools: 46–153 tok. Anthropic:
  200–400 tok/tool at 50 tools, ~950 tok/tool averaged over a five-server 58-tool setup [15][16]. Not a contradiction —
  schema verbosity is the variable — but it means "an MCP tool costs N tokens" is not a number, and any ADR figure must
  say which server's tools it was measured on.
- **Skill-metadata price: 51 tok measured vs ~100 tok documented.** pi's XML index gives 51 tok for a short entry; Anthropic
  states ~100 tokens per Skill for its own metadata block [11][12]. Both are "one line-ish"; the difference is the
  description's length and the markup. Use 50–100 as the band.

## Unanswered

- **No tokenizer was run.** `node_modules/@earendil-works` is empty in this checkout (the `scripts/link-vendor.mjs`
  symlinks are absent), so `src/server/prompt.ts` and the vendor modules could not be imported; the section figures come
  from extracting the exported template literals and evaluating them (`DEFAULT_SOUL` 478, `PROACTIVE_GUIDELINES` 1003,
  `TEAM_GUIDELINES` 334, `DELIVERY_INVARIANT` 429, `GENERATIVE_UI_POINTER` 306, `INTEGRATIONS_POINTER` 131 — the last two
  reproduce the notes' 308 and 133 to within a newline, so the extraction is sound). No tiktoken or Claude tokenizer was
  available offline and no provider call was made. A real tokenizer could move any number here by ±15%; the 3.5/4 spread
  is the error bar, and it should be stated as such in the ADR.
- **Only one real MCP tool set was measured.** The telegram connector's three tools are the cheap extreme. Whether a
  typical operator-supplied MCP server costs 153 or 950 tok per tool is undetermined for mason's own deployments; the
  honest ADR line is a band with the two observations named.
- **No measurement of a *second* command shape.** Nothing here prices a command that the model must choose between
  several of (a dispatch tool with an `action` enum, say), which is a common MCP pattern and would cost a schema of its
  own.
- **Whether a connector-authored section would be capped** like `profile` (`PROFILE_MAX_CHARS = 4_800`, `capText`) is
  unstated in `docs/CONNECTOR-PROTOCOL.md`; the contract's 400–600 characters has no enforcement code, so the price of
  enforcing it (a truncation rule, a boot refusal, a test) is not measured.
- **Cache behaviour of a growing tool list was not measured.** Claim 10 is code-read, not observed: whether a promoted
  tool re-prices the whole prefix or only the tool block on the next turn depends on the provider adapter and on how the
  `pi.system` patch is sent; the vendor's own docs (for Anthropic's API, not for pi's) say deferred tools are stripped
  before the cache key, which suggests the promotion is the expensive turn and later turns are cached [15][18].

## Queries

Web (2 searches, 4 page fetches, all primary docs):
- `Anthropic tool search tool docs tool definitions consume tokens MCP deferred loading` (provider: exa) — found [15], [16], [18]; the 55K and 10-20K figures, plus the "stays until compaction" sentence.
- `Anthropic Agent Skills progressive disclosure "name and description" preloaded into context tokens` (provider: exa) — the search itself returned mostly GitHub issues (rejected: secondary, and about a display bug), but pointed at the docs page fetched next.
- `curl` `https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool.md` — verbatim 55K sentence confirmed at line 43.
- `curl` `https://code.claude.com/docs/en/agent-sdk/tool-search.md` — verbatim 10-20K sentence confirmed at line 13.
- `curl` `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md` — the `~100 tokens per Skill` row and the "only its name and description occupy context" sentence.
- `curl` `https://www.anthropic.com/research/advanced-tool-use` — fetched, but the page is a JS payload; nothing was quoted from it. The per-server breakdown (GitHub 35 tools ~26K) appeared only in a search summary and is **not** used as evidence.
- `curl` `https://platform.claude.com/docs/en/agents-and-tools/mcp-connector.md` — fetched to look for the per-server breakdown; it is not there, so it was dropped.

Local (the actual evidence base for every number):
- Extracted and evaluated `prompt.ts`'s six exported template literals and `untrusted.ts`'s `UNTRUSTED_RULE` with a
  throwaway Node script (deleted); char counts as listed in Unanswered.
- `node -e` arithmetic for the frame (`2*len(key)+5`), the `"\n\n"` join, and the 4 / 3.5 conversions.
- `node` in `integrations/telegram/` with its own `zod` (3.25.76) and `zod-to-json-schema`: `send_message` params 464
  chars, whole declaration 612; `list_chats` 33 / 185. Script deleted after the run.
- Reproduced `formatSkillsForPrompt`'s five-line XML shape and measured a representative entry: 203 chars, 97 of markup.
- `grep -n` for `command` in `src/server/prompt.ts` (none), `CHARS_PER_TOKEN` across `vendor/pi` (three sites, two
  values), `promptTokens` outside the ADR (none — the field is proposed, not built).
- Reads: `src/server/{prompt,mcp,integrations,events}.ts`, `src/server/extensions/skills.ts`,
  `vendor/pi/packages/durable/src/{codemode/describe.ts,harness/agent.ts,harness/prompt.ts,tool-search/tool-search.ts}`,
  `vendor/pi/packages/ai/src/utils/{estimate.ts,text.ts}`, `vendor/pi/packages/coding-agent/src/core/{skills.ts,system-prompt.ts}`,
  `docs/CONNECTOR-PROTOCOL.md`, `docs/adr/0007-*.md`, `test/prompt.test.ts:670-735`.
