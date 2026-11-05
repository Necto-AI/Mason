# Compare the shipped instructions for the user-owned conventions file: Claude Code's CLAUDE.md and its memory shortcut (the '#' gesture, /memory), AGENTS.md as used by Codex and others, Cursor rules, and the agentskills.io standard. Quote the wording on what belongs there, how a conflict with the current request is resolved, and whether the model writes the file or asks first.

## Answer

Every shipped system surveyed splits the same way: durable conventions live in a human-authored markdown file at a fixed path, injected at session start, and conflicts are resolved by *wording*, not by enforcement — "explicit user chat prompts override everything" (AGENTS.md FAQ) and "Direct system/developer/user instructions ... take precedence over AGENTS.md instructions" (Codex's shipped prompt). Claude Code is the only one that splits the two authorities into two files with two authors — CLAUDE.md ("Who writes it: You") versus auto memory ("Who writes it: Claude") — and the only one whose docs concede the file is advice: "Claude treats them as context, not enforced configuration." In none of the four does the model write the *user's* conventions file unprompted: Codex's `/init`, Cursor's `/create-rule`, and Claude Code's `/init`/`prompt-audit` are all user-invoked and, in two cases, explicitly propose-before-writing. agentskills.io is out of scope by design — it specifies a *skill* directory (`SKILL.md` + `scripts/`, `references/`, `assets/`) and says nothing about a user profile or memory file, so it is the one layout that answers "where does a procedure go" but not "where does a fact about the user go".

## Claims

- Claude Code's stated rule for what belongs in CLAUDE.md: "Keep it to facts Claude should hold in every session: build commands, conventions, project layout, 'always do X' rules." [1] — direct
- And its spillover rule, which is the profile-vs-skill boundary in one sentence: "If an entry is a multi-step procedure or only matters for one part of the codebase, move it to a skill or a path-scoped rule instead." [1] — direct
- Claude Code's trigger list for adding to CLAUDE.md is event-shaped, not value-shaped: "Claude makes the same mistake a second time … You type the same correction or clarification into chat that you typed last session." [1] — direct
- CLAUDE.md's author is the human, in the docs' own words: "You write these files in plain text; Claude reads them at the start of every session." [1] — direct
- Claude Code splits author by file in a table: CLAUDE.md "**Who writes it** | You", auto memory "**Who writes it** | Claude" [1] — direct
- Auto memory is the one system here where the model writes a persistent file without being asked: "As it works, Claude saves four kinds of notes for itself." [1] — direct
- Its four note types are `user` ("your role, expertise, and working preferences"), `feedback`, `project`, `reference` [1] — direct
- Auto memory is explicitly deduplicated against the human file: "It also skips anything your CLAUDE.md files already say." [1] — direct
- Auto memory is also budgeted by the harness, not by the prompt: "The first 200 lines of MEMORY.md, or the first 25KB, whichever comes first, are loaded at the start of every conversation." [1] — direct
- Over-budget writes are refused at the tool boundary, which is a stronger mechanism than asking nicely: "Claude Code returns an error telling Claude to rewrite the index" [1] — direct
- The model touches CLAUDE.md only when told to: "To add instructions to CLAUDE.md instead, ask Claude directly, like 'add this to CLAUDE.md'" [1] — direct
- Claude Code's bootstrap asks rather than overwrites: "If a CLAUDE.md already exists, `/init` suggests improvements rather than overwriting it." [1] — direct
- Its instruction-file audit is propose-only by design: "nothing in your files changes until you ask Claude to apply them." [1] — direct
- Claude Code's conflict rule is the weakest of the four — it disclaims rather than rank: "Claude treats them as context, not enforced configuration." [1] — direct
- Same page, on compliance: "CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself." [1] — direct
- And on conflicting instruction files: "if two instructions contradict each other, Claude may pick one arbitrarily" [1] — direct
- User-level vs project rules in Claude Code are deliberately unranked: "Neither set overrides the other: if a user rule and a project rule conflict, Claude may follow either one" [1] — direct
- The `#` gesture, as shipped in May 2025: "The fastest way to add a memory is to start your input with the # character" [2] — direct
- It routed to a human-confirmed destination: "You'll be prompted to select which memory file to store this in." [2] — direct
- The `#` gesture is no longer in the current memory page; `/memory` now opens files and toggles auto memory: "/memory command lists your CLAUDE.md, CLAUDE.local.md, and other memory file locations across user and project scopes." [1] — partial (absence is evidence; see Unanswered)
- The current replacement for `#` is natural language, not a sigil: "When you ask Claude to remember something … Claude saves it to auto memory." [1] — direct
- AGENTS.md's conflict answer, the single clearest line in this set: "The closest AGENTS.md to the edited file wins; explicit user chat prompts override everything." [3] — direct
- AGENTS.md's mechanic, stated as a promise to the reader: "Agents automatically read the nearest file in the directory tree, so the closest one takes precedence" [3] — direct
- AGENTS.md's contents guidance is a README analogy, not a taxonomy: "Think of AGENTS.md as a README for agents" and lists "build steps, tests, and conventions" [3] — direct
- Codex's shipped system prompt repeats the precedence rule at the front of the prompt, in the "AGENTS.md spec" section: "Direct system/developer/user instructions (as part of a prompt) take precedence over AGENTS.md instructions." [4] — direct
- Codex's prompt enumerates what belongs, in one line: "Some examples might be: coding conventions, info about how code is organized, or instructions for how to run or test code." [4] — direct
- Codex's prompt also sets the scope/obligation rule: "For every file you touch in the final patch, you must obey instructions in any AGENTS.md file whose scope includes that file." [4] — direct
- Codex's prompt says the near files are already paid for, so don't re-read: "The contents of the AGENTS.md file at the root of the repo and any directories from the CWD up to the root are included with the developer message" [4] — direct
- Codex's `/init` prompt is ask-first in the strongest form — a flat prohibition on writing: "Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it." [5] — direct
- Codex's `/init` prompt carries a length target: "Keep the document concise. 200-400 words is optimal." [5] — direct
- Codex enforces a byte budget in code, with a recovery message: "Trim your project instructions to fit the budget. If you need to keep them all, increase `project_doc_max_bytes`." [9] — direct
- Codex ignores its own budget past the project root: "We do **not** walk past the project root." [9] — direct
- Codex's code also names a local overlay file the docs site never mentions: "Preferred local override for AGENTS.md instructions" / `AGENTS.override.md` [9] — direct
- Claude Code deliberately does not honour those overlay names: "**Not read**: `AGENTS.local.md`, `AGENTS.override.md`, or anything under a `.agents/` directory" [1] — direct
- Claude Code ranks CLAUDE.md above AGENTS.md by default: "An `AGENTS.md` and a `CLAUDE.md` or `CLAUDE.local.md` in your working directory or above it | Your `CLAUDE.md` files only" [1] — direct
- Cursor's stated purpose for rules is domain knowledge and standards: "Encode domain-specific knowledge about your codebase … Standardize style or architecture decisions" [6] — direct
- Cursor's "what to avoid" list is the most explicit negative guidance of the four: "Copying entire style guides: Use a linter instead." and "Documenting every possible command" [6] — direct
- Cursor's adoption trigger matches Claude Code's: "Start simple. Add rules only when you notice Agent making the same mistake repeatedly." [6] — direct
- Cursor's precedence is a total order across scopes, unlike Claude Code's: "Rules are applied in this order: Team Rules → Project Rules → User Rules … earlier sources take precedence when guidance conflicts." [6] — direct
- Cursor, like Claude Code, makes rule *inclusion* partly a model decision: "Agent reads the description and pulls the rule in when relevant" [6] — direct
- Cursor's model writes a rule only on request, and the doc frames it as a user action: "Yes, you can ask the agent to create a new rule for you." [6] — direct
- Cursor's `/create-rule` is user-invoked generation: "Agent generates the rule file with proper frontmatter and saves it to `.cursor/rules`." [6] — direct
- Cursor has a hard per-file size ceiling by convention: "Keep rules under 500 lines" [6] — direct
- Cursor's user-scope rule file is UI-only, not a path: "User Rules are global preferences defined in Customize → Rules that apply across all projects." [6] — direct
- agentskills.io's file layout is a procedure container, not a profile: `SKILL.md` (required) plus `scripts/`, `references/`, `assets/` [7] — direct
- The spec has no field for user facts — the only frontmatter fields are about the skill: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` [7] — direct
- Its progressive-disclosure budget is the tightest of the four: "Metadata (~100 tokens) … Instructions (< 5000 tokens recommended) … Keep your main `SKILL.md` under 500 lines." [7] — direct
- The spec delegates "what belongs" to a prose test: "A skill should teach the agent *how to approach* a class of problems, not *what to produce* for a specific instance." [8] — direct
- The spec's `description` field is the retrieval trigger, so it must name conditions: "Should include specific keywords that help agents identify relevant tasks" [7] — direct
- The spec tells you to split rather than shrink: "Consider splitting longer `SKILL.md` content into referenced files." [7] — direct
- No surveyed source states "the current request wins" *for the model* in the same breath as the conventions file; the closest are the AGENTS.md FAQ and Codex prompt, both addressed to readers/agents in the abstract [3][4] — inferred (the ranking is stated, but not one product documents the runtime behaviour)

## Sources

[1] How Claude remembers your project — Claude Code Docs — https://code.claude.com/docs/en/memory.md — accessed 2026-11-05 — primary (page `dateModified` 2026-11-04); the Markdown variant of the docs serves the full body to curl, unlike the JS-rendered HTML page
[2] Manage Claude's memory — Anthropic docs, archived 2025-05-31 — http://web.archive.org/web/20250531182717/https://docs.anthropic.com/en/docs/claude-code/memory — primary, archived; the only place the `#` gesture's shipped wording survives
[3] AGENTS.md — https://agents.md/ — accessed 2026-11-05 — vendor/standard (stewarded by the Agentic AI Foundation, LF Projects); FAQ carries the conflict rule
[4] openai/codex — `codex-rs/core/gpt_5_2_prompt.md`, "## AGENTS.md spec" — https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/gpt_5_2_prompt.md — accessed 2026-11-05 — vendor, shipped system prompt
[5] openai/codex — `codex-rs/tui/assets/prompt_for_init_command.md` — https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/assets/prompt_for_init_command.md — accessed 2026-11-05 — vendor, shipped `/init` prompt
[6] Rules — Cursor Docs — https://cursor.com/docs/rules — accessed 2026-11-05 — vendor docs (page canonical is `/docs/rules`; `/docs/context/rules` 308s)
[7] Specification — Agent Skills — https://agentskills.io/specification.md — accessed 2026-11-05 — standard (`dateModified` 2026-08-09 on the site; the `.md` variant is the full spec)
[8] Best practices for skill creators — Agent Skills — https://agentskills.io/skill-creation/best-practices.md — accessed 2026-11-05 — standard
[9] openai/codex — `codex-rs/core/src/agents_md.rs` — https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/agents_md.rs — accessed 2026-11-05 — vendor source code; where the byte budget and overlay filenames actually live

## Conflicts

**AGENTS.md promises "closest wins" for every adopter; Claude Code overrides that with its own filename hierarchy.**
- agents.md: "Agents automatically read the nearest file in the directory tree, so the closest one takes precedence" [3]
- Claude Code: "An `AGENTS.md` and a `CLAUDE.md` or `CLAUDE.local.md` in your working directory or above it → Your `CLAUDE.md` files only" [1]. Claude Code also refuses the overlay filenames Codex's own source designates as the local override (`AGENTS.override.md`) [9]: "**Not read**: `AGENTS.local.md`, `AGENTS.override.md`, or anything under a `.agents/` directory" [1].

**Precedence vs. no precedence.**
- Codex prompt: "Direct system/developer/user instructions (as part of a prompt) take precedence over AGENTS.md instructions." [4]; agents.md: "explicit user chat prompts override everything" [3]
- Claude Code, same situation: "if two instructions contradict each other, Claude may pick one arbitrarily" [1], and between user and project rules "Neither set overrides the other" [1]. Cursor instead imposes a total order — "Team Rules → Project Rules → User Rules … earlier sources take precedence" [6].

**Model-writes-it.**
- Claude Code auto memory: "As it works, Claude saves four kinds of notes for itself." [1] — no approval step described.
- Claude Code for CLAUDE.md itself, Codex for AGENTS.md, Cursor for rules: all user-invoked only — "do not overwrite or modify it" [5], "you can ask the agent to create a new rule for you" [6], "ask Claude directly, like 'add this to CLAUDE.md'" [1].

**Size budgets disagree by an order of magnitude** — 200-400 words for a Codex-generated AGENTS.md [5], "target under 200 lines per CLAUDE.md file" [1], "Keep rules under 500 lines" [6], `< 5000 tokens` / 500 lines for a `SKILL.md` [7], 200 lines / 25KB for a loaded `MEMORY.md` [1]. Not a contradiction so much as five different ceilings for what is nominally the same job.

## Unanswered

- **Whether the `#` gesture still works in Claude Code.** It is documented in the 2025-05-31 archive [2] and absent from the 2026-11-04 memory page [1], whose section headings no longer include it and whose replacement is natural-language "remember that…". I searched the shipped `CHANGELOG.md` (https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md, ~10k lines) for `memory`, `prefix`, `remember`, `quick` and found no removal entry — the file's entries are short and numerous, so an unlabelled removal is plausible. The 2025-10-07 Wayback snapshot of the page is JS-only (862 chars of text) and could not be read to narrow the window. Treat "removed" as unconfirmed; treat "not in current docs" as confirmed.
- **What Claude Code and Cursor actually put in their system prompts about these files.** Both are closed-source at that layer. Cursor only exposes the category — "Rules: project and user rules included in the prompt" on https://cursor.com/docs/agent/prompting — not the wording. So the "conflict with the current request" answer for these two rests on vendor documentation, not on prompt text.
- **Whether any of them tells the model to *update* the conventions file after a correction.** Claude Code documents the human-side trigger ("Claude makes the same mistake a second time") and the model-side capture for auto memory, but nothing instructs the model to promote a repeated correction into CLAUDE.md [1]. Cursor's "When you see Agent make a mistake, update the rule" [6] is addressed to the human. This is the gap the pi design would have to fill itself.
- **agentskills.io has no profile/memory artefact.** Checked the full spec [7] and the doc index at https://agentskills.io/llms.txt (10 pages: overview, specification, clients, quickstart, best-practices, optimizing-descriptions, evaluating-skills, using-scripts, adding-skills-support). Nothing on user-owned files. Whether a client is expected to *pair* a skill library with a memory file is unspecified — an absence, not a conflict.
- **OpenAI's Codex docs site (developers.openai.com/codex/*) returns 403 to curl** from this host, so the official user-facing AGENTS.md page was not read. Its content was reconstructed from the shipped prompt and source in the repo instead [4][5][9], which is arguably better evidence but does not cover the "how should a human write it" guidance.
- **Hermes's "declarative facts, not instructions to yourself" rule is another researcher's item** and is not covered here.

## Queries

- `web_search("Claude Code CLAUDE.md memory \"#\" shortcut /memory documentation")` — failed (Exa 403 auth)
- `web_search("AGENTS.md specification agents.md what goes in it")` — failed (Exa 403 auth)
- `web_search("Claude Code removed \"#\" shortcut quick memory CLAUDE.md changelog", provider=searxng)` — returned only claude.com marketing pages, no useful hit
- (direct fetches, no search: `code.claude.com/docs/en/memory.md`, `code.claude.com/docs/en/{commands,interactive-mode}.md`, `agents.md`, `cursor.com/docs/rules`, `agentskills.io/{specification,best-practices}.md`, `agentskills.io/llms.txt`, `raw.githubusercontent.com/openai/codex/main/codex-rs/{tui/assets/prompt_for_init_command.md,core/gpt_5_2_prompt.md,core/src/agents_md.rs}`, archive.org snapshot of the 2025 Claude Code memory page)
