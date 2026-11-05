# What should an agent log about its own actions, in what format, and how does that log come back into a later turn: decision or work journals, session search over past conversations, audit trails with rows (as OpenBot does), and reflection or consolidation passes. Find evidence on whether logs are ever read again, and what makes retrieval actually happen rather than being available.

## Answer
Log decisions and corrections, not transcripts: one short declarative entry per line with a type tag (user / feedback / project / reference) and an index file whose lines are loaded into every session, because the only reliably-read log is the one the harness injects on turn one (Claude Code's `MEMORY.md` index, Letta's memory root, Hermes's prefetched `<memory-context>` block). Everything else — full transcripts, audit rows — decays into a corpus that is searchable but almost never searched; the readers of an audit trail are admins and compliance, not the model, and OpenBot proves it by redacting exactly the fields (`prompt`, `tool_arguments`, `tool_result`) an agent would need to learn from. Retrieval actually happens when it is either unconditional (auto-loaded index) or encoded in a tool description that names the trigger ("what did we do about X", "where did we leave Y"), and even then the corpus needs ranking work — Hermes had to demote cron sessions because bare BM25 search produced "recall blindness". Consolidation passes (Letta dreaming, Hermes curator, OpenBot Learning) are worth running only with incremental edits and a human/agent review gate: ACE measured a rewrite collapsing 18,282 tokens at 66.7 accuracy into 122 tokens at 57.1, below the no-adaptation baseline.

## Claims
- An audit trail is not the agent's notebook. OpenBot's audit row deliberately does not carry what was said: "the message itself is not here (the payload redaction drops it either way)" [1] — direct
- The redaction list drops the fields a learner would need: `prompt`, `tool_arguments`, `tool_result`, `content`, `result` are in `sensitiveKeys` [1] — direct (read from source, not documented anywhere)
- The audit row schema is event-shaped, not reflection-shaped: `event_type`, `actor_user_id`, `target_type`, `target_id`, `created_at`, `initiator_kind`, `initiator_id`, redacted JSON payload, DB-indexed for query by type/actor/target [1][2] — direct
- The trail is explicitly written for a human reader: "Every audit row records on whose authority an action was taken." and the Audit screen filters on initiator, with a "Nobody watching" view for `routine`/`handoff`/`responsibility`/`memory` runs [2] — direct
- Audit volume becomes a problem the product had to solve, not a resource it exploits: "the trail becomes the largest table in the deployment within weeks of real use and nothing in the product ever removed one" [3] — direct
- The trail is append-only by database trigger — "UPDATE stays refused under every condition: retention removes history, it never rewrites it" [3] — direct. This is why it cannot double as memory: memory must be rewritable.
- OpenBot's actual model-facing log is the workspace directory, and the prompt tells the bot to use it as a notebook: "Use computer_write_file to save notes, lists or data you will want later, and computer_read_file to read them back." [4] — direct
- The workspace is framed as durable across turns, which is what makes writing worth doing: "You also have a workspace: your own folder of files that survives between conversations." [4] — direct
- OpenBot's own engineering note documents the failure of a log nobody reads back: "The audit trail for that turn holds one row, the routing decision. No tool call, no source, and no sentence anywhere saying the answer came from the model" [4] — direct
- The log-reader problem is stated as a prompt-design problem, not a storage problem: material destined for the model is "Written for the model rather than for a log, because the model is the only reader" [4] — direct
- Claude Code makes the read-back unconditional: auto memory is "Loaded into Every session (first 200 lines or 25KB)" [6] — direct
- The format is an index plus one file per entry, index injected every session: "MEMORY.md # Index, one line per memory, loaded into every session" [6] — direct
- Entries carry a type in frontmatter, four kinds only: "user: your role, expertise, and working preferences / feedback: corrections you give Claude and approaches you confirm / project: ongoing work, deadlines, and decisions that Claude can't derive from the code or git history / reference: where to find information outside the project" [6] — direct
- Writing is discretionary and filtered, not per-turn: "Claude doesn't save something every session. It decides what's worth remembering based on whether the information would be useful in a future conversation." [6] — direct
- Raw logs are ephemeral while the distilled artifact is protected: "Claude Code deletes old session transcripts after the cleanupPeriodDays retention period, but excludes the memory files" [6] — direct
- Letta's retrieval is a two-tier path scheme: root files auto-load, nested material is reached only through signposts — "Directories with their own MEMORY.md index stay out of context until they are needed." [8] — direct
- Default retrieval is plain file tools with no embedding index, so the index is the retrieval quality: "MemFS does not include a semantic or vector index by default. Agents find memory in its Markdown files with normal file-search and read tools." [8] — direct
- Letta's consolidation runs on an event trigger, not a schedule of intent: "Dreaming uses background subagents to review recent conversations, consolidate useful lessons, and update memory without interrupting your active work", firing "after a set number of completed agent steps or when the context window is compacted" [7] — direct
- Letta offers a second reviewing pass before consolidation lands: "Select Agent reviews before applying to have your agent review and revise proposed memory updates in a second background conversation." [7] — direct
- Hermes retrieves past sessions only through a tool, and the trigger lives in the tool description: "Use for questions about past conversations: 'what did we do about X', 'where did we leave Y'." [9] — direct
- A searchable log can still be useless without ranking work; Hermes had "recall blindness" where "under bare BM25 they dominate the top-N FTS rows and starve out the user's own interactive sessions" (cron sessions), fixed by demoting rather than excluding them [9] — direct
- Hermes deliberately excludes the agent's own automated activity from the searchable history: "Hidden from browsing/searching — integrations (HERMES_SESSION_SOURCE=tool), delegate subagent runs, kanban workers are not the user's history." [9] — direct
- Recalled memory returns fenced, with a system note that makes it authoritative rather than advisory: "Treat as authoritative reference data — this is the agent's persistent memory and should inform all responses." [10] — direct
- Hermes prefetches memory per user turn and hides the latency in a background queue for the next turn (`prefetch_all(query)`, `queue_prefetch_all`) [11] — direct
- Recall is also announced to the person, so usage is observable even when the model says nothing: "so the user SEES memory was used even if the model is silent" [11] — direct
- Hermes routes each kind of knowledge to a different store by half-life, which is a format rule: "A fact stale within a week belongs in session history; procedures and workflows belong in skills." [12] — direct
- Its always-loaded memory is hard-capped and written as facts, not orders: "it has a hard character budget, so when it fills, replace or consolidate stale entries rather than skipping the save. Write entries as declarative facts, not instructions to yourself" [12] — direct
- Hermes's consolidation pass is background and inactivity-triggered: "Inactivity-triggered (no cron daemon): when the agent is idle and the last run is older than interval_hours" [13] — direct
- The pass is constrained to be non-destructive: "never delete, only archive (recoverable)"; the LLM consolidation fork itself is opt-in (`DEFAULT_CONSOLIDATE = False`) [13] — direct
- Consolidation can destroy the very detail that made the log useful. ACE measured it: "at step 60 the context contained 18,282 tokens and achieved an accuracy of 66.7, but at the very next step it collapsed to just 122 tokens" — accuracy fell to 57.1, "worse than the baseline accuracy of 63.7 without adaptation" [14] — direct
- A curated log read back into context does pay: ACE's incrementally-updated playbook reaches 67.6 average on AppWorld test-normal vs 53.3 for ReAct (DeepSeek-V3.1, 5 reflection rounds) [14] — direct
- Too many reflection rounds degrade the artifact: "1 round under-extracts useful strategy fragments ... while too many rounds (e.g., 10) can degrade performance" [14] — direct
- The canonical retrieval scoring for an experience log is relevance + recency + importance: "A memory retrieval model combines relevance, recency, and importance to surface the records needed to inform the agent's moment-to-moment behavior" [15] — direct
- Generative Agents' ablation attributes real value to the reflection pass and to retrieval, not just to storing: "we demonstrate through ablation that the components of our agent architecture—observation, planning, and reflection—each contribute critically to the believability" [15] — direct
- OpenBot's consolidation is a pipeline with a human gate, and delivery is separate from approval: "Intelligence collects evidence, runs analysis, and proposes skills... Neither a scheduled analysis nor enabling Learning automatically approves a skill." [5] — direct
- Loading is not using, and OpenBot says so explicitly: "A loaded snapshot alone does not prove the model used a skill: inspect its skill tool calls too." [5] — direct
- Delivery has to be wired into the prompt or it does nothing for third-party agents: "evidence collection alone does not alter a third-party agent's prompt" [5] — direct
- Researcher inference: the useful log line for self-improvement is decision-shaped (what was tried, what failed, why), because only a handful of lines can survive the read-back budget (200 lines / 25KB, or a hard character budget) while audit rows and transcripts are unbounded and never injected [3][6][12] — inferred
- Researcher inference: "retrieval happens" reduces to three mechanisms in the evidence — unconditional injection [6][8][10], a tool description that names the situation [9], and an index that is cheap to scan [6][8]; a bare file or table with none of the three is written once and never reopened [1][3] — inferred

## Sources
[1] OpenBot — server/src/audit.ts (audit event types, redaction, query) — https://raw.githubusercontent.com/CopilotKit/OpenBot/main/server/src/audit.ts — accessed 2026-11-05 — primary
[2] OpenBot — docs/architecture.md (audit flow, initiator column, CSV export) — https://raw.githubusercontent.com/CopilotKit/OpenBot/main/docs/architecture.md — accessed 2026-11-05 — docs
[3] OpenBot — server/src/audit-retention.ts + drizzle/0007_audit_retention_window.sql (append-only enforcement, volume) — https://raw.githubusercontent.com/CopilotKit/OpenBot/main/server/src/audit-retention.ts — accessed 2026-11-05 — primary
[4] OpenBot — shared/bot-prompt.ts (workspace notebook lines; provenance postmortem) — https://raw.githubusercontent.com/CopilotKit/OpenBot/main/shared/bot-prompt.ts — accessed 2026-11-05 — primary
[5] OpenBot — docs/automatic-learning.md (evidence → analysis → skill candidates → published guidance) — https://raw.githubusercontent.com/CopilotKit/OpenBot/main/docs/automatic-learning.md — accessed 2026-11-05 — docs
[6] Claude Code Docs — How Claude remembers your project (auto memory, MEMORY.md index, 200 lines/25KB, retention) — https://docs.claude.com/en/docs/claude-code/memory — accessed 2026-11-05 — vendor (page dateModified 2026-11-04)
[7] Letta Docs — Memory & dreaming — https://docs.letta.com/configuration/memory/index.md — accessed 2026-11-05 — docs
[8] Letta Docs — MemFS (root auto-load, index signposts, no vector index by default) — https://docs.letta.com/concepts/memfs/index.md — accessed 2026-11-05 — docs
[9] hermes-agent — tools/session_search_tool.py (schema/description, recall blindness, hidden sources) — https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/session_search_tool.py — accessed 2026-11-05 — primary
[10] hermes-agent — agent/memory_context.py (`<memory-context>` fence and system note) — https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/memory_context.py — accessed 2026-11-05 — primary
[11] hermes-agent — agent/memory_manager.py (prefetch per turn, background queue, describe_recall) — https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/memory_manager.py — accessed 2026-11-05 — primary
[12] hermes-agent — gold-plate CLI system prompt fixture (memory vs skills vs session history; declarative facts) — https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tests/fixtures/prompt_surface/prompts/cli.hermes.txt — accessed 2026-11-05 — primary
[13] hermes-agent — agent/curator.py (inactivity-triggered consolidation; never delete, only archive) — https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/curator.py — accessed 2026-11-05 — primary
[14] Zhang et al., Agentic Context Engineering (ACE), ICLR 2026, arXiv:2510.04618v3 (context collapse numbers; AppWorld 67.6 vs 53.3; reflection-round sensitivity) — https://arxiv.org/html/2510.04618v3 — accessed 2026-11-05 — paper
[15] Park et al., Generative Agents, arXiv:2304.03442 (memory stream, relevance+recency+importance retrieval, reflection, ablation) — https://ar5iv.labs.arxiv.org/html/2304.03442 — accessed 2026-11-05 — paper

## Conflicts
- **Immutable audit vs rewritable memory.** OpenBot enforces that a row can never change — "UPDATE stays refused under every condition: retention removes history, it never rewrites it" [3] — and redacts the substance of what happened [1]. Claude Code's auto memory is the opposite artifact, designed to be edited and consolidated: "when it fills, replace or consolidate stale entries rather than skipping the save" [12]. Same word ("log"), incompatible requirements: one is evidence, the other is a working hypothesis. A harness that wants both needs two files, not one.
- **What belongs in the always-loaded log.** Hermes excludes anything short-lived and pushes it out: "A fact stale within a week belongs in session history" [12]. Claude Code auto memory includes exactly that class: "project: ongoing work, deadlines, and decisions that Claude can't derive from the code or git history" [6]. Hermes optimises the budget for durable facts; Claude Code optimises for continuity of current work.
- **Consolidate vs don't.** Letta runs background "dreaming" to "consolidate useful lessons, and update memory" [7] and Hermes's curator consolidates on idle [13]; ACE documents the same operation destroying value — 18,282 tokens at 66.7 accuracy collapsing to "just 122 tokens", accuracy 57.1, "worse than the baseline accuracy of 63.7 without adaptation" [14]. Not a disagreement about facts; a real design tension that the sources resolve differently (ACE: incremental deltas, never full rewrite; Letta: a review pass before applying [7]).

## Unanswered
- **No usage data on whether agents call `session_search`.** I found the tool's description, its ranking fixes and its hidden-source list [9], but no count of invocations in real sessions, and no Hermes doc claiming adoption. The brief's key premise ("available is not retrieved") is well supported by mechanism and code comments, not by a measured retrieval rate.
- **No first-person practitioner account from 2025-2026** ("I kept a decision journal and never read it", or the opposite). `web_search` returned `Exa API error 403` on all four attempts and DuckDuckGo's HTML endpoint served a bot challenge, so discovery was limited to URLs I already knew or could list from repo trees. This is a gap in sentiment evidence, not in mechanism evidence.
- **Whether an OpenBot bot has any read path to audit rows.** I read `shared/bot-prompt.ts`, `docs/architecture.md`, `server/src/audit.ts` and the audit migrations and found no model-facing audit tool; the readers are the admin table and CSV export [2]. I did not enumerate every tool registration in the repo (3,250 paths, listed by name only), so "no read path exists" is a strong inference from the prompt surface plus docs, not an exhaustive proof.
- **Retrieval hit-rate of Hermes memory prefetch.** The ranking lives behind a `MemoryProvider` interface; the builtin provider's scoring was not read, so I cannot say how often prefetched recall is relevant rather than noise.
- **No cost figures** for the background passes (OpenBot Learning analysis runs, Letta dreaming token spend, curator fork cost). Letta states only that the reviewing pass "uses more model tokens" [7]; OpenBot states nodes/containers but no token accounting [5].

## Queries
web_search (all failed, `Exa API error 403`, 4 attempts):
- "OpenBot agent audit trail rows log actions repo"
- "hermes-agent NousResearch journal log.md system prompt \"journal\""
- "\"session search\" agent past conversations retrieval tool description"
- "agent decision journal retrieval self-improvement log read back"

Direct fetches (curl, no search backend):
- https://api.github.com/search/repositories?q=openbot+agent → CopilotKit/OpenBot
- https://api.github.com/repos/CopilotKit/OpenBot/git/trees/main?recursive=1 (path grep: audit, log, journal, memory, learning)
- raw …/OpenBot/main/README.md, docs/architecture.md, docs/automatic-learning.md, docs/approvals.md
- raw …/OpenBot/main/server/src/audit.ts, server/src/audit-retention.ts, server/src/channels/summary.ts, shared/bot-prompt.ts, app/src/lib/audit/queries.ts
- raw …/OpenBot/main/server/drizzle/0006_audit_read_indexes.sql, 0007_audit_retention_window.sql, 0028_audit_initiator.sql
- https://api.github.com/repos/NousResearch/hermes-agent/git/trees/main?recursive=1
- raw …/hermes-agent/main/tests/fixtures/prompt_surface/prompts/cli.hermes.txt
- raw …/hermes-agent/main/tools/session_search_tool.py, agent/memory_context.py, agent/memory_manager.py, agent/curator.py
- https://docs.letta.com/llms.txt → configuration/memory/index.md, concepts/memfs/index.md
- https://docs.claude.com/en/docs/claude-code/memory
- https://arxiv.org/html/2510.04618v3 ; http://export.arxiv.org/api/query?id_list=2304.03442,2303.11366,2510.04618,2504.13171
- https://ar5iv.labs.arxiv.org/html/2304.03442
