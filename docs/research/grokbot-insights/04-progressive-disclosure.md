# Progressive disclosure: skills, tools, memory notes — research findings

> Deep-research run: grokbot lecture insights → mason. Date: 2026-10-18. Model: deepseek-v4.1-flash (max thinking).

## Summary

The settled pattern is a three-level capability model: always-loaded **metadata** (name + "use this when…"), **bodies** loaded on demand (`SKILL.md`, tool schema, doc), and **resources** loaded only when referenced [1][4]. Tool search applies the same idea to tools: keep hot tools declared, defer the rest, let the model search a registry [4][6]. Impact is large at scale: ~85% fewer tool tokens and tool-selection accuracy rising 49%→74% (Opus 4) and 79.5%→88.1% (Opus 4.5) on MCP evals [4]; selection degrades past 30–50 tools [6]; OpenAI recommends fewer than 20 upfront [8]. Below ~10 tools deferral costs a step and buys nothing [4]. For mason: pi ships both mechanisms, but mason wires neither. Its prompt is a fixed block (4 tools + 3 short sections, ≈915 tokens) with no capability index, so every future procedure lands in `SOUL.md` or a code constant and is paid for on every request.

## Key findings

1. **Skills are three levels, with published numbers.** Level 1 metadata is ~100 tokens per skill and always loaded; Level 2 is the `SKILL.md` body, "under 5k tokens" recommended and under 500 lines; Level 3 is `scripts/`, `references/`, `assets/`, loaded only when read or run [1][20]. The spec caps `name` at 64 chars and `description` at 1024 chars, requires the description to say *what* and *when*, and forbids consecutive hyphens [2]. pi enforces both limits and turns violations into warnings, not failures (`vendor/pi/packages/coding-agent/src/core/skills.ts:11`, `:92`, `:117`).

2. **The format is cross-vendor, so it is not a bet.** Claude (Code, API, claude.ai), OpenAI's Skills API (uploaded bundles mounted into shell/Agents sandboxes), and pi all consume the same `SKILL.md` frontmatter [1][3][10]. OpenAI repeats the routing rule: "During skill discovery, the model sees the skill's name and description" [10].

3. **The description is the router, and it is testable.** Guidance: imperative phrasing ("Use this skill when…"), user intent not implementation, err on pushy, name contexts where the user does not name the domain [9]. The Agent Skills guide recommends ~20 eval queries (8–10 positive, 8–10 near-miss negative), 3 runs each, trigger-rate threshold 0.5, train/validation split [9]. Claude Code's 1,536-char cap per listing entry means the first sentence carries the weight [3].

4. **Tool search has concrete economics.** Mark tools `defer_loading: true`; the model sees only the search tool plus non-deferred tools; matches expand into full definitions [4][6]. Anthropic's example: 58 tools ≈ 55K tokens of definitions, past 100K with more servers; tool search cut an internal case from ~77K to ~8.7K tokens (~85%), preserving 95% of context [4]. It also fixes selection errors between similar names (`notification-send-user` vs `notification-send-channel`) [4]. The maximal version is code execution: the model writes a script and only its output returns to context, 150K→2K tokens in Anthropic's MCP example [18].

5. **Deferral has a floor and a ceiling.** Use it when definitions exceed ~10K tokens, there are 10+ tools, or selection is already failing; it is "less beneficial" below 10 tools, when all tools are used every session, or when definitions are compact [4]. OpenAI: "Aim for fewer than 20 functions available at the start of a turn… Use tool search to defer large or infrequently used parts of your tool surface" [8]. Claude Code auto-defers MCP tools only once their descriptions exceed 10% of the context window [5].

6. **"Names first, details on demand" is a distinct middle rung.** OpenAI keeps a deferred *function's* name and description in context and defers "mostly the parameter schema"; a namespace or MCP server collapses to one name + description [7]. It recommends namespaces with <10 functions and warns models are "primarily trained to search those surfaces" [7]. pi's `deferred` is coarser: the tool disappears entirely until `tool_search` loads it (`vendor/pi/packages/durable/src/harness/types.ts:322`, `agent.ts:248`). pi therefore has no built-in names-only listing, though the harness exposes the list (`Agent.deferred`, `types.ts:456`).

7. **Production clients cap the listing.** Claude Code budgets the skill listing at 1% of the context window, drops descriptions of the least-invoked skills when over budget, and caps each entry's `description + when_to_use` at 1,536 chars [3]. MCP tool descriptions loaded through tool search are truncated at 16,384 chars (up from 2,048) [5]. MCP itself only offers `tools/list` with cursor pagination and leaves the interaction model to the client [11]. pi's `formatSkillsForPrompt` has no such cap: it emits every visible skill with name, description and path (`skills.ts:358`).

8. **Retrieval quality, not the idea, is the weak link.** ToolRet (7.6K tasks, 43K tools) shows IR models strong on conventional benchmarks "exhibit poor performance on ToolRet", and low retrieval quality "degrades the task pass rate of tool-use LLMs" [12]. RAG-MCP reports >50% fewer prompt tokens and selection accuracy 43.13% vs 13.62% [13]. Tool-DE shows tool documentation is under-documented and that expanding it improves retrieval [14]; HYSET shows set-level retrieval beats scoring tools one by one [15]; SkillRet (16,129 real skills) shows skill retrieval "remains far from solved" at scale [16]. Author for recall, then measure retrieval before trusting a ranker.

9. **Authoring limits are guardrails, not platform rules.** grokbot's "each tool's description and schema under 4,000 characters" is stricter than any vendor cap and consistent with the failure modes above: long descriptions dilute the router, short ones under-retrieve [12][14]. Anthropic adds: namespace related tools, keep responses token-efficient, and prompt-engineer descriptions deliberately [17].

## How grokbot does it (from lecture notes)

Everything is a file: `memory/profile.md` always in prompt, dated log lines, `skills/<name>/SKILL.md` with "Use this when…", routines as prompt + schedule. Skills "load only when needed, so having many is cheap". Tool details follow the same ladder: "names first, details on demand" against a prompt budget of system prompt + tool details + tool names + conversation + free space, plus a tool search tool. Long outputs go to files and the context keeps the path; instructions become skills and the prompt keeps a one-line pointer; old memories stay searchable while only the most important facts sit in the prompt. The system prompt holds a *snapshot* of memory and routines, so the agent knows what exists without carrying the bodies. [21]

The insight is not "add skills" but "make the prompt an index": the model should always know *that* a capability exists and *when* it applies, never *how* it works until it asks.

## Mason applicability

**What pi already has**

- Skills: filesystem discovery, spec validation, `disable-model-invocation`, XML prompt rendering — `vendor/pi/packages/coding-agent/src/core/skills.ts:168` (`loadSkillsFromDir`), `:358` (`formatSkillsForPrompt`), exported at `packages/coding-agent/src/index.ts:324`.
- Tool search: BM25 over name, description and schema text (plus namespace text in the coding agent); matches are loaded for the next request — `vendor/pi/packages/durable/src/tool-search/tool-search.ts:90`, `vendor/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:119`.
- Deferred tools: `deferred?: true`, excluded until named in `modelTools.add`; loading is recorded in the transcript and survives fork/resume — `packages/durable/src/harness/types.ts:322`, `agent.ts:248`.
- Codemode as the heavier alternative: 3,000-token inline declaration budget, `searchTools()` inside scripts (`packages/coding-agent/docs/codemode.md:50`).
- Docs-on-demand precedent: the coding agent's prompt carries only paths plus "read only when the user asks about pi itself" (`packages/coding-agent/src/core/system-prompt.ts:162`).
- Sections are diffed and patched, so a changed section appends a `pi.system` entry (`packages/durable/src/harness/prompt.ts:9`, `:66`).
- `ExecutionEnv.listDir` exists (`packages/durable/src/env/index.ts:244`), so a skill index can be scanned in a remote workspace.

**What mason wires**

`BASE_EXTENSIONS = [CodingTools, AgentIdentity]` (`src/server/runtime.ts:33`). Four tools, three sections: `preamble` (whole `SOUL.md` or default), `cwd`, `proactive_guidelines` (`src/server/extensions/agent-identity.ts:33`). No skills, no tool search, no docs pointer, no hook index. Measured fixed cost: preamble 394 chars + guidelines 547 chars (~235 tokens); four tool declarations 2,715 chars (~680 tokens). The opt-in `sandboxed-ui` extension adds 2,319 chars of instructions (~580 tokens) plus an 881-char schema (~220 tokens) on every request while enabled (`src/server/extensions/sandboxed-ui.ts:22`, `:49`, `:62`).

Gaps, by cost:

1. **No skills.** Procedure has nowhere to go except `SOUL.md` (read whole, no cap) or a code constant. The marginal cost of every new capability is "always in the prompt".
2. **`SOUL.md` is unbounded** (`agent-identity.ts:22`). It is profile, procedure and the only extension point, so it will accrete both. There is no separate profile/log/notes split, so nothing tells the agent which facts must stay resident and which can be looked up.
3. **The 580-token widget style guide is always on** while the feature is on, though widgets are occasional.
4. **Hooks are invisible.** They carry names and descriptions (`src/server/hooks.ts:11`) and appear in the UI, but never in the prompt. The agent sees `[EVENT HOOK: name]` only when one fires, so it cannot reason about which routines exist.
5. **Mason's docs are not pointed at.** `AGENTS.md`, `docs/SPEC.md`, `docs/UI-PLAN.md`, `docs/agents/*` are readable but undiscoverable.
6. **No listing budget or lint.** pi would inject 200 skills without complaint.

Do **not** install `tool_search` for today's four or five tools: the coding tools are used every turn, and the only deferrable tool is 220 tokens. That is below every vendor threshold [4][8].

## Recommended actions

**[now] 1. Add a skills extension with three seed skills.** `src/server/extensions/skills.ts`: scan `skills/**/SKILL.md` through `input.env` (`listDir`, so SSH workspaces work), render one section shaped like pi's. Seed `skills/daily-brief`, `skills/workspace-check`, `skills/generative-ui`. Test: prompt snapshot contains name+description+path only; the body enters context only when read.

**[now] 2. Add a docs pointer section.** ~4 lines in `agent-identity.ts`: where `AGENTS.md`, `docs/SPEC.md`, `GLOSSARY.md`, `docs/agents/` live; "read only when asked about mason itself". ~50 tokens; same pattern as pi's `docs` section and Anthropic's just-in-time retrieval [17][19].

**[now] 3. Add a routines index.** Pass `HooksManager` into an extension and render enabled hooks as `name — description` (~15 tokens each). This is grokbot's routine snapshot and makes proactive behavior legible without exposing prompt templates.

**[next] 4. Split the widget instructions.** Keep 4 rules inline (parameter order, call last, fluid layout, never collect credentials); move design tokens, sandbox limits and `Websandbox` API to `skills/generative-ui/SKILL.md`. Target ≤200 resident tokens instead of 580.

**[next] 5. Add names-first deferral when a second connector lands.** If `input.agent.deferred` is non-empty, render `name — first description line`; install `createToolSearchExtension()` only then. Test with a fake 20-tool extension: names visible, search loads ≤8, declarations grow after the call.

**[next] 6. Add a skills lint and budget test.** Assert name/description length, unique names, a "Use…when" clause, and a rendered section under N chars (4,000 ≈ 1,000 tokens, ~20–30 skills). Claude Code's 1% budget implies that order of magnitude [3]. Fail the test, not the prompt.

**[later] 7. Close the authoring loop.** After a correction, the agent writes or patches a skill (grokbot: "instructions become skills"). Needs `skills/` as a convention plus review; `write`/`edit` already exist.

**[later] 8. Replace BM25 only with evidence.** Keep the `ToolRanker` seam; measure recall on a real library first. ToolRet and SkillRet show off-the-shelf retrievers under-perform at scale [12][16].

**[don't] 9. Don't defer the four coding tools.** Every-turn tools pay a search round-trip for no saving [4].

**[don't] 10. Don't let `SOUL.md` become the skill directory.** Cap it (~2k chars) and move procedures out, or the profile becomes the bloat this brief is about.

**[don't] 11. Don't build a second router.** No skill-trigger classifier, no auto-summarizing skill bodies into the prompt; vendors train models for description-based routing [7][9].

## Open questions

- `pi-durable` has no skills extension; skills live only in `pi-coding-agent`. Intentional split or pending work is undocumented in `vendor/pi`.
- No public measurement of pi's BM25 `tool_search` recall on realistic libraries.
- Anthropic's "degrades past 30–50 tools" is model-specific and not reproduced for mason's models; treat as directional.
- Claude Code docs say the skill listing budget is 1% of context; a changelog entry announced 2%. Effective default is unclear.
- Repo skills (`skills/`, versioned) vs workspace skills (user-editable) depends on the memory work in brief 03.

## Sources

1. https://agentskills.io/specification
2. https://agentskills.io/specification#progressive-disclosure
3. https://code.claude.com/docs/en/skills
4. https://www.anthropic.com/engineering/advanced-tool-use
5. https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
6. https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
7. https://developers.openai.com/api/docs/guides/tools-tool-search
8. https://developers.openai.com/api/docs/guides/function-calling
9. https://agentskills.io/skill-creation/optimizing-descriptions
10. https://developers.openai.com/api/docs/guides/tools-skills
11. https://modelcontextprotocol.io/specification/2025-06-18/server/tools
12. https://arxiv.org/abs/2503.01763
13. https://arxiv.org/abs/2505.03275
14. https://arxiv.org/abs/2510.22670
15. https://arxiv.org/abs/2607.25718
16. https://arxiv.org/abs/2605.05726
17. https://www.anthropic.com/engineering/writing-tools-for-agents
18. https://www.anthropic.com/engineering/code-execution-with-mcp
19. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
20. https://agentskills.io/skill-creation/best-practices
21. `.scratch/grokbot-insights/SOURCE-grokbot-lecture.md`
22. `vendor/pi/packages/coding-agent/src/core/skills.ts`
23. `vendor/pi/packages/coding-agent/src/core/system-prompt.ts`
24. `vendor/pi/packages/durable/src/tool-search/tool-search.ts`
25. `vendor/pi/packages/durable/src/harness/types.ts`
26. `vendor/pi/packages/durable/src/harness/agent.ts`
27. `vendor/pi/packages/durable/src/harness/prompt.ts`
28. `vendor/pi/packages/durable/src/env/index.ts`
29. `vendor/pi/packages/coding-agent/src/extensions/tool-search/tool.ts`
30. `vendor/pi/packages/coding-agent/docs/codemode.md`
31. `src/server/runtime.ts`
32. `src/server/extensions/agent-identity.ts`
33. `src/server/extensions/sandboxed-ui.ts`
34. `src/server/hooks.ts`
