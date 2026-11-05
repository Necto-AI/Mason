# In Hermes, how is memory written and read: which files under ~/.hermes/memories/, what exactly is injected at session start and whether it is a frozen snapshot or live, the memory tool's schema and size limits, the rule that memory is the narrow exception to skills, and whether a distinct user-profile artifact exists or the profile is only memory entries. Include what happens when the budget fills.

Evidence basis: full local clone of `NousResearch/hermes-agent` at commit `1f91da2a277093c6909542d8c725c0c52fae4628` (2026-10-25). I re-fetched
`raw.githubusercontent.com/.../main/website/docs/user-guide/features/memory.md`, `tools/memory_tool.py` and `agent/prompt_builder.py` and got
byte-identical line counts (555 / 477 / 1750), so the clone matches `main` as of access. All quotes below are from those files.
Web search was unavailable in this run (Exa returned HTTP 403 auth error on both calls); no outside source is cited, and none is needed —
the code and the docs are the primary artifacts.

## Answer
Memory is two plain-text files, `~/.hermes/memories/MEMORY.md` (agent notes, 2200 chars) and `~/.hermes/memories/USER.md` (user profile, 1375 chars),
each a `§`-delimited list of free-form entries. At session start the store is loaded from disk and rendered into the **volatile tier** of the
three-tier system prompt (after the skills index) as a header + usage percentage + the entries — and that rendered string is cached as a
**frozen snapshot**, so writes made mid-session hit disk but never change the prompt; the snapshot is re-captured only on compaction and session
switch. Writing is one tool, `memory`, with `target: memory|user` and an atomic `operations` list of `add`/`patch`/`remove` (no `read`, no
`replace`); the char limit is enforced only on the batch's final state, and when a lone add would overflow the tool **errors, echoing the current
entries**, telling the model to reissue one batch that frees space and adds in the same call — it never auto-compacts or auto-deletes.
`USER.md` is a genuinely distinct file with its own budget and its own enable flag, but not a distinct artifact *type*: it is memory entries
under a different header, written by the same tool, while `SOUL.md` (personality) is the separate, human-owned file.

## Claims

- Two files make up memory, with different budgets: MEMORY.md 2,200 chars (~800 tokens), USER.md 1,375 chars (~500 tokens). [1] — "**MEMORY.md** | Agent's personal notes … 2,200 chars (~800 tokens)" / "**USER.md** | User profile … 1,375 chars (~500 tokens)" — direct
- Both live in `~/.hermes/memories/` and are injected as a frozen snapshot at session start. [1] — "Both are stored in `~/.hermes/memories/` and are injected into the system prompt as a frozen snapshot at session start." — direct
- Memory is per-profile: a non-default profile reads its own dir, not the root one. [1] — "`hermes -p work` … reads `~/.hermes/profiles/work/memories/`, not `~/.hermes/memories/`" — direct
- Effective dir is profile-scoped and resolved per call, so HERMES_HOME can switch after import. [3] — "Profile-scoped memories dir, resolved per call (HERMES_HOME may switch after import)." — direct
- Two agents must not share one Hermes home: writes compound into state nobody authored. [1] — "two writers sharing one home will compound each other's entries into state neither of them (nor you) authored" — direct
- Format on disk is entries joined by a section-sign delimiter on its own line; a bare "§" inside an entry survives because parsing splits on the full delimiter. [4] — `ENTRY_DELIMITER = "\n§\n"` and "splits on the FULL delimiter so a bare \"§\" survives" — direct
- Injection is a rendered block: 46 `═` rules, a header naming the store plus live usage pct/count, then the entries. [1] — "MEMORY (your personal notes) [67% — 1,474/2,200 chars]" — direct
- The header strings are exactly two, one per target. [4] — `"memory": "MEMORY (your personal notes)", "user": "USER PROFILE (who the user is)"` — direct
- An empty store renders nothing at all, so the block is absent from the prompt rather than empty. [4] — `if not entries: return ""` … `if block: parts.append(block)` — direct
- Prompt is assembled in three cache tiers; memory sits in the **volatile** tier, last, after the skills index. [6] — "``volatile`` (skills index, memory, user profile, external memory block, timestamp line, runtime environment hints)" — direct
- Order inside volatile is skills index first, then MEMORY.md, then USER PROFILE, then plugin sections. [6] — `volatile_parts: list[str] = [skills_prompt, *_memory_parts(agent)]` — direct
- The prompt as a whole is cached on the agent and only rebuilt after compression. [6] — "Assemble the full prompt; cached on ``agent._cached_system_prompt`` and only rebuilt after compression." — direct
- Frozen means: the injected bytes come from a load-time snapshot dict, not from live entries. [4] — "Frozen load-time snapshot (NOT live state — mid-session writes don't touch it, preserving the prefix cache)" — direct
- Live state is effectively append-only-per-turn from the model's view: tool results report live usage, the prompt does not. [1] — "changes are persisted to disk immediately but won't appear in the system prompt until the next session starts" — direct
- The snapshot IS re-captured at two boundaries — compaction and session switch — because both call `invalidate_system_prompt`, which reloads from disk. [6] — "Also reloads memory from disk so the rebuilt prompt captures any writes from this session" — direct
- Call sites for that refresh: `agent/conversation_compression.py:3096` and `hermes_cli/cli_session_switch.py:37` both call `_invalidate_system_prompt()`. [6] — code lines — direct (grep)
- Practical consequence: a long gateway chat that never compacts or resets never sees its own mid-session writes, which is why the docs tell you to `/new` at task boundaries. [1] — "Inside a single session none of that machinery has a reason to run" / "Fresh memory entries also stay invisible to the running session because of the frozen snapshot above." — direct
- There is no read action; the model is expected to have memory already in context. [1] — "There is no `read` action — memory content is automatically injected into the system prompt at session start." — direct
- Tool name is `memory`; schema requires `target` (enum `memory`|`user`) and `operations` (array). [3] — `"required": ["target", "operations"]` — direct
- Each operation is `{action, content?, old_text?}` with `action` enum `add`|`patch`|`remove`. [3] — `"action": {"type": "string", "enum": ["add", "patch", "remove"]}` — direct
- `replace` was deliberately removed because models used it as find-and-swap and wiped sibling facts; it now errors pointing at `patch`. [1] — "It overwrote the whole matched entry, and models used it as a find-and-swap, which wiped the other facts in multi-fact entries." — direct
- `patch` replaces only a span that must occur exactly once in the matched entry; `remove` deletes the whole entry, both located by unique substring. [1] — "`patch` replaces only the `old_text` span inside the matched entry and keeps everything else." — direct
- Matching is typography-tolerant (curly quotes, dashes, re-wrapped lines folded) so a re-emitted entry still matches. [4] — "Models re-emit an entry with straight quotes for curly ones, '-' for an em dash, unwrapped lines" — direct
- One batch call is the intended shape: all changes to one target atomically, limit checked on the final result only. [3] — "The batch applies atomically and the char limit is checked only on the FINAL result" — direct
- The batch-first design exists precisely so the model can free space and add in one call. [3] — "a single call can remove/patch stale entries to free room AND add new ones, even when an add alone would overflow" — direct
- A top-level target is mandatory; a per-operation target different from the top-level one is rejected before writing or staging. [1] — "Missing or null targets, and a target inside an operation that differs from the top-level one, return an error before writing" — direct
- Limits are plain config ints, not tokens, and defaults live in config_defaults. [8] — `"memory_char_limit": 2200, # ~800 tokens at 2.75 chars/token` / `"user_char_limit": 1375` — direct
- Budget = characters, not tokens, explicitly "model-independent". [4] — "budgets are in chars (model-independent)" — direct
- The system prompt states the exception rule verbatim, as the memory guidance block, injected only when the `memory` tool is loaded. [5] — see the full paragraph quoted under Conflicts/Notes; generator is `build_memory_guidance` — direct
- The rule: skills come first; memory is only for facts that apply to every session regardless of task. [5] — "Memory is the narrow exception for facts that apply to EVERY session regardless of task (who the user is, environment facts, standing conventions with no task home)" — direct
- The stated reason is the budget, and the stated remedy is consolidation, not skipping the save. [5] — "it has a hard character budget, so when it fills, replace or consolidate stale entries rather than skipping the save" — direct
- Routing rule for task knowledge is explicit and names the tool: write it into the skill you used or built. [5] — "record it in the skill you used or built for the task (skill_manage), where it loads only when relevant" — direct
- The shipped CLI prompt carries this same paragraph verbatim in the stable tier. [7] — "Skills come first: when you learn something while doing a task — a procedure, a pitfall, and the user's preferences and corrections for that kind of work" — direct
- Declarative-facts-not-instructions rule, with the ✓/✗ pair. [7] — "Write entries as declarative facts, not instructions to yourself: 'User prefers concise responses' ✓ — 'Always respond concisely' ✗" — direct
- The reason given for that rule is that imperatives get re-read as directives and can override the current request. [5] — "imperative phrasing gets re-read as a directive in later sessions and can override the user's current request" — direct
- Freshness rule: a fact that will be stale within a week belongs in session history, not memory. [5] — "A fact stale within a week belongs in session history; procedures and workflows belong in skills." — direct
- The tool schema repeats the same routing rule in its WHEN clause, so it exists twice (prompt + tool description). [3] — "WHEN: only for facts that apply to EVERY session regardless of task" — direct
- Schema SKIP list explicitly excludes task progress, completed-work logs and TODO state, routing them to `session_search`. [3] — "SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, completed-work logs, temporary TODO state (use session_search for those)." — direct
- The schema's IF FULL clause tells the model the exact recovery protocol. [3] — "IF FULL: an add is rejected with the current entries shown. Reissue as ONE batch that removes or shortens enough stale entries and adds the new one together." — direct
- The prompt states memory's cost, not a capability: injected every turn, therefore must stay small. [3] — "memory is injected into every turn and must stay small" — direct
- A user profile IS a distinct file with its own budget, own enable flag, own header — but written by the same tool. [1] — "Every tool call requires a top-level `target`: `"memory"` for agent notes or `"user"` for the user profile." — direct
- The profile is therefore "memory entries under a second header", not a separate artifact/schema. [1][4] — same tool, same `§` format, same patch/remove semantics, only the file and limit differ — inferred
- Profile and notes are independently switchable; disabling one narrows the advertised target enum and rejects writes to that file. [1] — "The tool schema advertises only the `user` target, and direct or staged writes to disabled `MEMORY.md` are rejected." — direct
- Disabling both removes the tool AND its prompt guidance block, so the model is never told about a tool it cannot use. [1] — "the `memory` tool is dropped from the schema and its guidance block is dropped from the system prompt" — direct
- `SOUL.md` is the genuinely separate, human-owned artifact, and it does not feed the profile. [2] — "`SOUL.md` and `USER.md` are separate systems that never feed each other." — direct
- SOUL.md occupies prompt slot #1 (stable tier); USER.md is memory and rides in volatile. [2] — "Slot #1 of the system prompt, at session start" — direct
- BUDGET FULL: no auto-compaction, no silent dropping — the write fails with a structured error. [1] — "Memory does **not** auto-compact: when a write would exceed the limit, the `memory` tool returns an error instead of silently dropping entries." — direct
- The overflow error is arithmetic and prescriptive: states overage, states the batch protocol, echoes `current_entries`. [1] — "adding this entry (250 chars) would exceed the limit by 153 chars. Retry as ONE 'operations' batch that removes or shortens (patch) stale entries" — direct
- Patches are bound too: a lengthening patch can overflow, so the retry must shorten it or drop another entry. [1] — "a patch that lengthens an entry can still overflow, so the new text must be shortened (or another entry removed) to fit" — direct
- Failed batch retries do NOT echo `current_entries` (deliberate: echoing made each retry grow the context it was meant to shrink). [4] — "the caller already holds the inventory, so echoing it made each consolidation retry grow the context it was invoked to shrink" — direct
- Retry cap: after 3 failed consolidation attempts in one turn the tool returns a terminal stop instead of the retry recipe. [4] — "Stop retrying memory calls — leave memory unchanged for now and continue with your reply to the user." — direct
- The cap value is 3 consecutive failures per turn, reset by any success and by `reset_consolidation_failures()` at turn start. [4] — `_MAX_CONSOLIDATION_FAILURES_PER_TURN = 3` — direct
- The header's usage percentage is the pressure signal the model is told to act on before it hits the wall. [1] — "When memory is above 80% capacity (visible in the system prompt header), consolidate entries before adding new ones." — direct
- Over-limit files written by external writers still load (warned, not truncated), and further adds are blocked until under the limit. [4] — "Entries stay loaded; further additions are blocked until it is back under the limit." — direct
- A hand-written file without `§` delimiters is treated as drift: the write is refused and a `.bak` snapshot is made rather than silently losing text. [4] — "Refusing to write {path.name}: it holds an entry larger than the whole store's char limit" — direct
- Writes are atomic temp-file+rename under an exclusive `.lock` file, so concurrent writers cannot truncate each other. [4] — "Atomic temp-file + rename: readers never see a truncated file" — direct
- So the dir holds MEMORY.md, USER.md, `<file>.lock` and occasional `<file>.bak.<ts>` drift snapshots; staged approvals live elsewhere, in `<HERMES_HOME>/pending/memory/<id>.json`. [4][9] — `_pending_path` returns `get_hermes_home() / "pending" / subsystem / f"{pending_id}.json"` — partial (code, not documented)
- Duplicate adds are rejected as success-with-message, not error. [1] — "If you try to add content that already exists, it returns success with a 'no duplicate added' message." — direct
- Entries are scanned for injection/exfiltration before write, and again at load for the prompt snapshot only. [4] — "Threat hits are replaced by a ``[BLOCKED: …]`` placeholder in the SNAPSHOT only" — direct
- `write_approval: true` gates both foreground and background writes; outside the interactive CLI they are staged under `/memory pending`. [1] — "everywhere else — messaging platforms, scripts, and the background self-improvement review — writes are **staged** for review" — direct
- The background review stages `patch`/`remove` even with the gate off, pinning the exact target entry so a changed entry refuses the approval. [1] — "A staged `patch` or `remove` (the background review stages these even with the gate off) records the full entry it targets" — direct
- Writes also arrive via a periodic nudge, not only the model's discretion: a post-turn memory review fires every N user turns. [8] — `"nudge_interval": 10,  # Periodic built-in memory review` — direct
- The nudge is turn-counted and gated on the tool being live. [8] — "if agent._turns_since_memory >= agent._memory_nudge_interval: … return True" — direct
- Users can edit memory entries directly through the journey surface, not only the model. [1] — "`hermes journey edit <node>` — Open the node's content (a skill's `SKILL.md` or the memory chunk) in `$EDITOR`." — direct

## Sources
[1] Hermes docs — Persistent Memory (`website/docs/user-guide/features/memory.md`) — https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md — accessed 2026-11-05 — docs (in-repo, authoritative; 555 lines, verified identical on `main`)
[2] Hermes docs — Which File Does What? (`website/docs/user-guide/which-file-does-what.md`) — https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/which-file-does-what.md — accessed 2026-11-05 — docs
[3] `tools/memory_tool.py` — MEMORY_SCHEMA (the `memory` tool definition, verbatim description + parameters) — https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py — accessed 2026-11-05 — primary (code)
[4] `tools/memory_tool_store.py` — MemoryStore: delimiter, limits, frozen-snapshot dict, overflow/retry-cap/drift/lock logic — https://github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool_store.py — accessed 2026-11-05 — primary (code)
[5] `agent/prompt_builder.py` — `build_memory_guidance()`, the function that generates the "narrow exception" prompt paragraph — https://github.com/NousResearch/hermes-agent/blob/main/agent/prompt_builder.py — accessed 2026-11-05 — primary (code)
[6] `agent/system_prompt.py` — three-tier assembly (`build_system_prompt_parts`), `_memory_parts`, `invalidate_system_prompt` — https://github.com/NousResearch/hermes-agent/blob/main/agent/system_prompt.py — accessed 2026-11-05 — primary (code)
[7] Gold-plate rendered CLI system prompt (`tests/fixtures/prompt_surface/prompts/cli.hermes.txt`) — the memory paragraph as it actually reaches the model — https://github.com/NousResearch/hermes-agent/blob/main/tests/fixtures/prompt_surface/prompts/cli.hermes.txt — accessed 2026-11-05 — primary (fixture)
[8] `hermes_cli/config_defaults.py` + `agent/agent_init.py` — default limits, `nudge_interval`, enable flags wiring — https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/config_defaults.py — accessed 2026-11-05 — primary (code)
[9] `tools/write_approval.py` — where staged memory writes are persisted (`<HERMES_HOME>/pending/memory/<id>.json`) — https://github.com/NousResearch/hermes-agent/blob/main/tools/write_approval.py — accessed 2026-11-05 — primary (code)

## Conflicts

**1. Docs vs code: "frozen at session start" vs re-captured mid-session.** Both doc pages say the snapshot does not refresh mid-session (they repeat it three times, so it is a deliberate promise to the reader):
[1] — "The system prompt injection is captured once at session start and never changes mid-session."
[2] — "the system prompt doesn't refresh mid-session, so the *injected* memory block still shows the session-start state."
But `build_system_prompt_parts`' own docstring says "Never re-rendered mid-session" while `invalidate_system_prompt` — called from `agent/conversation_compression.py:3096` and `hermes_cli/cli_session_switch.py:37` — does:
[6] — "Also reloads memory from disk so the rebuilt prompt captures any writes from this session."
Resolution (my inference, not stated anywhere): the promise holds *between* rebuilds; a compaction or session switch is a rebuild, and memory written earlier in that session becomes visible after it. The docs' "start a new session" fix is therefore true for CLI (every invocation is a new session) but understates what happens on a compacting gateway chat.

**2. Docs vs tool schema: is "completed work" memory-worthy?** The doc's save-list and the schema's skip-list directly contradict each other, and they are the two places the model reads:
[1] docs "Save These" — "**Completed work:** 'Migrated database from MySQL to PostgreSQL on 2026-01-15' → save to `memory`"
[3] schema SKIP — "completed-work logs, task progress, temporary TODO state (use session_search for those)"
Same docs page also lists "**Completed task diary entries**" as memory content under the `memory` target ([1] "Completed task diary entries"). My reading: the doc prose is older than the schema, which is the text actually injected on every turn — so the schema wins in practice. Not resolved by any text I found.

**3. Docs vs code: how much does an over-limit file break?** [1] frames the limit as hard ("the `memory` tool returns an error instead of silently dropping entries"), and [4] confirms nothing is dropped — but code adds a path the docs don't describe: an externally-written oversized file *loads anyway* ("Entries stay loaded; further additions are blocked until it is back under the limit."), i.e. the prompt can carry a block over its own budget until the model fixes it.

## Unanswered

- **Adoption numbers.** Nothing anywhere in the repo measures how often the model actually calls `memory` vs claims it did. The docs assert the failure mode and its demographic without a number: [1] "Small local models (roughly under 30B parameters) and models with weak tool-calling do this often — they produce the confirmation without the tool call." The <30B threshold is unmeasured in-repo; treat as vendor claim.
- **Where the 80% consolidation instruction actually comes from.** The 80% advice appears in docs prose ([1]) and the header shows the percentage ([4]), but I found no code that injects the "consolidate above 80%" sentence into the prompt — the model must infer it from the header. Looked in `agent/prompt_builder.py`, `agent/system_prompt.py`, `tools/memory_tool.py`, `tools/memory_tool_store.py`. If it is absent, the pressure signal is a number with no instruction attached, which is worth knowing for the parent's design question.
- **Whether `USER.md` is ever auto-populated at install.** Empty stores render nothing ([4]); nothing seeds USER.md. Whether the background review writes it unprompted (vs only on user-stated preferences) is described only as "may quietly save a memory" ([1]); no per-target breakdown.
- **Multi-fact entry degradation.** Docs claim `replace` was removed because models wiped sibling facts ([1]), but no measurement of how often `patch` now leaves entries half-updated.
- **Web corroboration.** Two `web_search` calls both failed with a provider auth 403 (Exa). No external practitioner reporting on Hermes memory behaviour was reachable; everything above is repo-internal.
- **Prompt-wording archaeology.** `agent/prompt_builder.py` carries a long comment saying Anthropic's server-side filter rejected the *skills* nudge wording "After completing a complex task (5+ tool calls)…" on subscription OAuth credentials, surfacing as a billing-shaped HTTP 400, and that the memory paragraph's phrasing survived only because it was reworded. Relevant to the parent's "trigger wording" section, out of my sub-question's scope: [5] "Bisected against the live API: that sentence alone reproduces the 400 and removing it alone clears it". Not verified by me beyond the comment itself.

Extra material worth passing upstream, since the parent's brief asks for verbatim prompt lines:
- Full injected memory paragraph, stable tier, cli.hermes.txt [7]: "You have persistent memory, carried across sessions and loaded into each new session's context; the memory tool's schema defines what belongs there. Skills come first: when you learn something while doing a task — a procedure, a pitfall, and the user's preferences and corrections for that kind of work — record it in the skill you used or built for the task (skill_manage), where it loads only when relevant. Memory is the narrow exception for facts that apply to EVERY session regardless of task (who the user is, environment facts, standing conventions with no task home); it has a hard character budget, so when it fills, replace or consolidate stale entries rather than skipping the save. Write entries as declarative facts, not instructions to yourself: 'User prefers concise responses' ✓ — 'Always respond concisely' ✗ (imperative phrasing gets re-read as a directive in later sessions and can override the user's current request). A fact stale within a week belongs in session history; procedures and workflows belong in skills."
- Note the sentence order: capability → privilege skills → demote memory → budget+remedy → format rule → freshness rule. The demotion happens *before* the budget, so the model reads "memory is small" as a consequence, not an excuse.
- Memory guidance is emitted by `_tool_guidance_block` **only if** "memory" is in `agent.valid_tool_names` ([6]) — the prompt text is a function of the toolset, so the guidance and the schema can never disagree about which stores exist.

## Queries

- `Hermes Agent NousResearch MEMORY.md USER.md memory tool 2200 characters` (Exa 403 auth, no results)
- `hermes-agent "memories" frozen snapshot system prompt prefix cache USER.md` (Exa 403 auth, no results)
- (all remaining evidence gathered from the local clone + raw.githubusercontent fetches of `main`; no further web queries were useful given both searches failed)
