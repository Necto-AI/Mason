# Compaction, branch summarization, and prompt caching — research findings

> Deep-research run: grokbot lecture insights → mason. Date: 2026-10-18. Model: deepseek-v4.1-flash (max thinking).

## Summary

The field converged on one discipline: keep a byte-stable prefix (system prompt + tool definitions + early context), append-only history, and let compaction be the *only* rewrite. Compaction is cheapest when it reuses the parent request's cache ("cache-safe fork"), is best scheduled while the cache is warm (idle compaction) and is a measured, alertable event (Anthropic "declares SEVs" on hit-rate drops). pi already implements the provider-side mechanics (cache breakpoints, mid-conversation system messages, durable compaction with blocking/background thresholds, fork semantics) — missing are grokbot's *timing* (summarize while idle and warm), cache observability/warming, and branch summarization as a durable primitive. Most important conclusion: **do not add in-conversation branches to pi-durable**; concurrent work threads belong in forked conversations with a report-back protocol.

## Key findings

**Compaction**

1. **pi's coding-agent compaction is threshold + cut-point based.** Trigger: `contextTokens > contextWindow - reserveTokens` (`reserveTokens: 16384`); keep `keepRecentTokens: 20000` verbatim; cut only at user/assistant messages, never tool results; mid-turn cuts get their turn prefix summarized separately (`vendor/pi/packages/coding-agent/src/core/compaction/compaction.ts:112-128,401-520`). Summary format: Goal / Constraints / Progress / Decisions / Next Steps / Critical Context; serialized as text so the model doesn't continue the conversation; tool results truncated to 2000 chars; thinking omitted; file lists appended (`.../compaction/utils.ts`). Recursive runs use an update prompt that preserves the previous summary (`.../compaction/compaction.ts:555-608`).
2. **Session-tree branch summarization exists only in the coding agent.** `SessionManager.branch()/branchWithSummary()` makes the coding session an entry tree with `parentId`; navigating away summarizes the abandoned path (`vendor/pi/packages/coding-agent/src/core/session-manager.ts:1574-1627`, `.../compaction/branch-summarization.ts`).
3. **pi-durable compaction is a durable task, not a code path in the agent loop.** `CompactionTask` runs `select → summarize → retry`; the summary is a `pi.compaction` entry whose `head` marks the first kept entry (append-only prefix replacement), placed directly when a generation owns it or as a write submission admitted at a boundary otherwise (`vendor/pi/packages/durable/src/harness/compaction.ts`, `.../entries.ts`). Defaults: blocking above `contextWindow - 16384`; background once above `contextWindow - 16384 - 32768`; `keepRecentTokens` 20 000 (`.../harness/agent.ts:27-32`, `.../harness/generation.ts:318-340`). The summary request is a standalone serialized prompt with `cacheRetention: "none"` — deliberately not a cache-safe fork (`.../harness/compaction.ts:64-100,175`).
4. **Claude Code compacts with a cache-safe fork and can idle-compact before the cache expires.** Its summarization request carries the same system prompt, tools and history, with the summary instruction appended as a final user message, so the parent's cached prefix is reused; `/compact` "costs the most when you resume an old session" (cold cache). On the 1-hour TTL it can compact an idle conversation shortly before expiry (`idleCompaction`). Auto-compaction fires near the limit (~967K tokens on 1M-window models). After compaction it re-injects system prompt, CLAUDE.md/auto memory, git status, plan, invoked skills, and re-reads up to five recently modified files (`code.claude.com/docs/en/context-window#what-survives-compaction`). Anthropic's guidance: maximize recall first, iterate on precision; tool-result clearing is the lightest safe form; aggressive compaction loses context "whose importance only becomes apparent later" (`anthropic.com/engineering/effective-context-engineering-for-ai-agents`).
5. **Provider-native compaction now exists and should be preferred where available.** Anthropic: on-demand `compaction: {type: "summarize"}` (beta `compact-2026-09-04`; keeps recent turns; background mode; signed block sent back first) or threshold compaction via `context_management.edits: [compact_20260112]` (input-token trigger, min 50 000, default 150 000, optional `pause_after_compaction`). OpenAI Codex CLI: auto-compact thresholds, speculative/background compaction (`async_compaction_threshold_percent`), remote (server-side) compaction, and token-budget compaction that installs a fresh window without summarization (`codex-rs/core/src/compact.rs`, `.../state/auto_compact_window.rs`, `.../session/async_compaction.rs`, `.../prompts/templates/compact/prompt.md`).
6. **Compaction quality is a selection problem; repeated compaction drifts.** pi's structured format, previous-summary folding and file lists mitigate it (findings 1–3); summary-of-summary loss remains the risk ([inference]: no controlled personal-agent study found). Durable state outside the transcript is the complement.

**Prompt caching**

7. **Provider semantics differ enough to change policy** (all verified against primary docs):
   - **Anthropic**: opt-in `cache_control` breakpoints (max 4; auto-caching uses one slot); reads look back ≤20 blocks; 5-min TTL refreshed free on hit, 1-hour TTL at 2× write cost; writes 1.25×, reads 0.1× (0.05×/0.025× on newest models); 1024–2048-token minimums.
   - **OpenAI**: automatic ≥1024 tokens; exact prefix match, routed on a first-~256-token hash plus `prompt_cache_key` (< ~15 req/min per key before overflow); in-memory 5–10 min inactive, max 1 h; `prompt_cache_retention: "24h"` on select models.
   - **DeepSeek**: automatic disk cache, no TTL control (cleared within hours to days); hits require matching a *persisted* prefix unit; `prompt_cache_hit_tokens`/`miss_tokens` in usage.
8. **pi-ai already implements the provider discipline.** Anthropic: `cache_control` on system blocks, the last tool definition, and the last user/system message (`vendor/pi/packages/ai/src/api/anthropic-messages.ts:1220-1240,1528-1550,1658`), 1-hour TTL under `cacheRetention: "long"`. OpenAI: `prompt_cache_key = sessionId` and `prompt_cache_retention: "24h"` under `long` (`.../api/openai-responses.ts:362`, `.../api/openai-completions.ts:828-833`). Summary requests opt out of cache writes.
9. **pi-durable's context assembly was built around cache stability.** `leadWithSystem()` moves the baseline system message to the front because "a later tool change rewrites the request's tool list and invalidates the whole prompt cache" (`vendor/pi/packages/durable/src/harness/context.ts:215-238`). `planSystemEntries()` emits minimal section patches; later system messages survive as mid-conversation system messages where supported, otherwise `resolveTranscript()` collapses them into the leading message — a full invalidation (`.../harness/prompt.ts:66-140`, `vendor/pi/packages/ai/src/utils/transcript.ts:108-120`). Forks get a fresh `pi.provider` session id (`.../harness/provider.ts:11-23`) and inherit parent entries up to the fork point via storage parent-chain walks (`.../storage/sqlite/storage.ts:296-330`).
10. **The operating discipline is documented and sounds exactly like the lecture.** Claude Code's blog: "we run alerts on our prompt cache hit rate and declare SEVs"; layout: static system+tools → CLAUDE.md → session context → conversation; no timestamps in the static prompt; never shuffle tool order; never add/remove tools (plan mode is a tool; deferred stubs for tool search); deliver updates as `<system-reminder>` messages, not prompt edits; don't switch models; "fork operations need to share the parent's prefix". Its `/usage` line reports cache share, misses with a likely cause ("tool definitions changed"), expected rebuilds (compaction/tool-result clearing) and warm/cold state.

**Branching**

11. **Two incompatible branch models exist in `vendor/pi`.** Coding-agent: an in-session tree with leaf switching and on-navigation branch summaries. pi-durable: one append-only entry stream per conversation; "branches" are new **conversations** (`conversation.fork(at)`) that inherit the parent's prefix by reference, copy fork-policy documents, get their own inbox/tasks, and cannot write into the parent.
12. **pi-durable already covers the concurrent-input half.** One run at a time per conversation; inputs queue in `pi.inbox` as `steer`/`followUp`/`write`, placed at `postTools`/`final` boundaries by `applyBoundary()` (`vendor/pi/packages/durable/src/harness/inbox.ts:70-125`). Missing: multiple active leaves in one conversation, and any return/merge path from a fork.
13. **Consequences for "one branch per input".** (a) The scheduler, boundary admission and UI sequence numbers assume one active head — concurrent generations need harness surgery, not an entry kind. (b) Caches are per prefix and routing key: leaf switches rewrite the tail from the fork point, so alternating leaves destroys hit rate; separate forked conversations each keep their own warm prefix (with a fresh provider identity, so OpenAI routing resets). (c) Returning a branch's result requires a branch-summary entry (summary + source ids) plus file-op extraction — machinery that exists only in `branch-summarization.ts` today. (d) Merge summaries drift; keep reports short and state-file-anchored.

## How grokbot does it (from lecture notes)

Compaction runs "while you're away": ~10 minutes after a big (>100k-token) turn, while the provider cache is still warm (the summary request reuses the same prefix), unless background work will wake the agent soon; the last few user-visible messages stay verbatim; a too-long turn can be summarized mid-turn. Cache discipline: stable prefix (tool defs + system prompt with memory snapshot + first message), append-only history, newest message last, per-section hashing, deploys note running conversations instead of mutating them, prompt pre-warmed when the user opens the chat. Denis's note adds: use pi's branching + branch summarization for concurrent inputs *as separate branches*, with the conflicts-between-threads design unresolved. Note: grokbot itself never runs concurrent turns in one conversation; helpers are separate agents returning short reports.

## Mason applicability

**Already there:** pi-durable auto-compaction (threshold/overflow/background; manual via `AgentService.compact`, `src/server/main.ts:119-121`, `src/server/status.ts:41`); pi-ai cache mechanics; cache-token accounting in the web usage panel (`src/web/components/DebugBits.tsx`); hook inputs with `app.hook` entries and `whenBusy: "followUp"` (`src/server/hooks.ts`); SOUL.md/preamble as a `pi.system` section (`src/server/extensions/agent-identity.ts`).

**Gaps:**
- **No idle-time compaction.** Background compaction only starts when a generation prepares; nothing compacts a warm conversation during a quiet period (the grokbot/Claude Code `idleCompaction` case).
- **No cache policy choice.** Mason never sets `cacheRetention`/`prompt_cache_retention`; pi-ai defaults to the 5-minute TTL unless `PI_CACHE_RETENTION=long`.
- **No cache health or warming.** No hit-rate/miss-cause view, no expected-rebuild classification — though usage per assistant entry plus `pi.system` patch entries contain the ingredients. `cache-warmer.ts` has the economics model; pi-durable/mason have nothing.
- **No branch summarization for durable conversations.** No fork-return entry kind; no way for a fork's result to enter the parent as a summary rather than raw messages.
- **`SOUL.md` is re-read on every render.** Editing it mid-conversation emits a `pi.system` patch; on models without native mid-conversation system messages this collapses into the leading message and invalidates the cache (and newer Claude models' thinking blocks).

**Do not build:** in-log branch trees in pi-durable; per-turn tool pruning; a custom summarizer when a provider-native compaction path exists for the configured model; heavy infra for memory (keep grokbot's "summaries + files as durable state" principle).

## Recommended actions

1. **[now] Set an explicit cache retention policy.** Pass `cacheRetention: "long"` in `HarnessSettings.stream` (or document `PI_CACHE_RETENTION=long`) so Anthropic gets 1-hour caches and OpenAI-compatible providers get `prompt_cache_retention: "24h"` where supported. An always-on agent idles past 5 minutes constantly; 2× writes beat re-prefill.
2. **[now] Add cache-health telemetry.** Derive from assistant usage (`cacheRead`/`cacheWrite`/input): hit share, last miss with time and size, expected-rebuild flag when the last miss follows a compaction or `pi.system` patch. Expose in the debug sheet (Claude Code's `/usage` line is the model) and use it as the regression signal for prompt changes.
3. **[now] Treat mid-conversation prompt mutation as an incident.** Freeze the `AgentIdentity` preamble per conversation (first render) or deliver SOUL edits as a boundary message; record an expected rebuild when `setSandboxedUiEnabled` flips. Add a test: two consecutive requests with no state change produce identical leading system messages/tools.
4. **[next] Idle compaction while warm.** A maintenance path (reuse `HooksManager` timers) admits a compaction task when the root conversation is idle for N minutes and above `contextWindow - reserveTokens - backgroundTokens`; skip when a hook is armed to fire soon; count it as an expected rebuild. Verify the summary lands before the next user turn.
5. **[next] Cache warming on user activity.** Add a `warm` signal (chat opened/typing); replay the last request with minimal output when expected savings clear a threshold, mirroring `cache-warmer.ts` economics (pi-ai's `isReplayable` guards Anthropic thinking-budget keying). Off by default; measure.
6. **[next] Make summaries carry durable state.** Extend the summary prompt (via `beforeCompact`/custom instructions) with pointers to memory files/logs, so the summary stays short without losing facts the files hold.
7. **[later] Fork-per-workstream + report-back protocol.** Prototype: a scheduled hook runs in a conversation forked at the root's head; its final answer returns to the parent as one message. Measure context/cache/cost vs. running it in the root. This is the answer to Denis's note — concurrency lives in the scheduler, not in one log.
8. **[later] Branch-summary entry for merge points.** If fork-per-workstream pays off, add an entry kind (`app.branch-summary`) with summary + source ids + file ops, reusing `branch-summarization.ts` collection/serialization. The parent stays linear.
9. **[later] Provider-native compaction behind a capability flag.** Prefer Anthropic on-demand/background compaction or OpenAI remote compaction when the catalog advertises it; keep the local summary otherwise.
10. **[don't] Don't build multi-leaf conversations in pi-durable now.** One-run-at-a-time, boundary admission, UI ordering and cache affinity all depend on the single active head; revisit only if a concrete workflow requires interleaving edits in one conversation.

## Open questions

- Controlled evidence on compaction drift for personal agents — no primary study found; "maximize recall first" is Anthropic guidance, not measurement.
- Anthropic's background-compaction mechanism (how the block is swapped in while work continues) is known only from the overview table; treated as [inference] here.
- OpenAI server-side compaction is evidenced from Codex source, but no public API documentation was reachable.
- Whether OpenAI's fresh `prompt_cache_key` per fork helps or hurts (routing stability vs. the ~15 req/min overflow limit) is unresolved; measure before changing `provider.ts`. The same experiment should tell whether DeepSeek's best-effort, hours-to-days cache makes its missing TTL controls a real cost issue.

## Sources

- https://platform.claude.com/docs/en/build-with-claude/prompt-caching (Wayback snapshot 2026-10-18)
- https://platform.claude.com/docs/en/build-with-claude/compaction (2026-10-12)
- https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand (2026-09-28)
- https://platform.claude.com/docs/en/build-with-claude/compaction-threshold (2026-10-10)
- https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages (2026-10-12)
- https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything (2026-04-30)
- https://code.claude.com/docs/en/prompt-caching (2026-10-17)
- https://code.claude.com/docs/en/context-window (2026-10-17)
- https://code.claude.com/docs/en/model-config (2026-10-17)
- https://code.claude.com/docs/en/costs (2026-10-18)
- https://platform.openai.com/docs/guides/prompt-caching (Wayback snapshot 2026-02-08)
- https://api-docs.deepseek.com/guides/kv_cache
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (2026-10-17)
- github.com/openai/codex: `codex-rs/core/src/compact.rs`, `codex-rs/core/src/state/auto_compact_window.rs`, `codex-rs/core/src/session/async_compaction.rs`, `codex-rs/core/src/compact_token_budget.rs`, `codex-rs/core/src/compact_remote_v2*.rs`, `codex-rs/prompts/templates/compact/prompt.md`
- `vendor/pi/packages/coding-agent/src/core/compaction/{compaction,utils,branch-summarization}.ts`, `vendor/pi/packages/coding-agent/src/core/{session-manager,cache-warmer}.ts`
- `vendor/pi/packages/durable/src/harness/{compaction,generation,context,prompt,agent,provider,inbox}.ts`, `vendor/pi/packages/durable/src/entries.ts`, `vendor/pi/packages/durable/src/session/transaction.ts`, `vendor/pi/packages/durable/src/storage/{memory,sqlite/storage}.ts`
- `vendor/pi/packages/ai/src/api/{anthropic-messages,openai-responses,openai-completions}.ts`, `vendor/pi/packages/ai/src/utils/transcript.ts`
- mason: `src/server/{runtime,hooks,main,status}.ts`, `src/server/extensions/agent-identity.ts`, `src/web/components/DebugBits.tsx`, `docs/SPEC.md`
