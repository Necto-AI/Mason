# Aligning agent behavior with prompting (behavior policy) — research findings

> Deep-research run: grokbot lecture insights → mason. Date: 2026-10-18. Model: deepseek-v4.1-flash (max thinking).

## Summary

Best practice: a small, high-altitude behavior policy in the stable system prompt, plus trigger-local
instructions in the trigger itself — heuristics and a few canonical examples, not brittle if-else
chains [1]. For a proactive agent the core policy is an attention budget: interrupting costs far more
than agent work, and models over-interrupt by default (~52% false alarm for GPT-4o on a proactive
benchmark [12]). Grokbot encodes this as one `SendToUser` tool, "quiet is allowed", and a cost ladder
ending in "ask you". Prompt-only substitutes for SFT/RL: small evals grown from failures, few-shot
harness examples, validated tool schemas, and terminal tools that end a turn without another model
call. For mason: ship a file-backed `behavior_policy` section (`POLICY.md`) next to `SOUL.md`, add a
terminal `send_to_user` tool to make quiet mechanical, keep the policy deletable.

## Key findings

1. **Right altitude beats rule volume.** Anthropic's context-engineering guidance: hardcoded
   if-else prompts are fragile; vague prompts give no signal. The optimum is "specific enough to
   guide behavior effectively, yet flexible enough to provide strong heuristics" [1]. Use structured
   sections and canonical few-shot examples; "minimal set of information" does not mean short, it
   means non-redundant [1].

2. **Production agents are steered by heuristics plus evals.** Anthropic's multi-agent system was
   fixed mainly by prompt changes: explicit effort budgets ("simple fact-finding: 1 agent, 3–10 tool
   calls"), an explicit update discipline ("early agents … distracted each other with excessive updates"), ~20
   initial test queries, and an LLM-judge rubric (accuracy, completeness, tool efficiency) [2].
   Start with small samples; a prompt tweak can move success from 30% to 80% [2].

3. **Claude Code / Claude 4 show explicit, model-specific behavior text.** Claude Code docs recommend
   treating `CLAUDE.md` "like any frequently used prompt", tuning with emphasized words, and
   conservative permissions with an allowlist [3]. Claude 4 prompts spell out tone: concise on simple
   asks, no unrequested bullet lists, skip flattery, "avoids peppering the human with questions" [4].
   Lesson: behavior is versioned prompt text, not code — and it changes per model [4].

4. **OpenAI Codex encodes the same pattern.** The base prompt carries personality ("concise, direct,
   and friendly"), a preamble/progress-update cadence with examples, and persistence ("keep going
   until the query is completely resolved … do NOT guess") [5]. Its Guardian policy is a separate
   review prompt with a risk taxonomy and outcome rules ("deny broad destructive actions … without
   proof of user authorization"; destructive egress is high risk) [6]. Escalation asks carry a
   justification and a `prefix_rule` so approvals become reusable [6].

5. **Interruption has a price; encode it as expected utility.** Horvitz's Notification Platform:
   "attention-sensitive costs of disruption are subtracted from estimates of the value of alerting,
   yielding a net value of alerting a user for each channel" [9]. SRE formalizes the same test for
   pages: urgent, actionable, actively or imminently user-visible; "paging a human is a quite
   expensive use of an employee's time", and alert noise causes real pages to be ignored [10].
   Microsoft's human-AI guidelines list "time services based on context" as guideline #3 [11].

6. **Models default to over-helping.** ProactiveBench: GPT-4o-mini predicts an unnecessary task with
   64.7% false alarms; GPT-4o drops from 51.9% to 36.4% false alarms only when allowed three candidate
   tasks, and fine-tuned open models still "provide as much assistance as possible" [12]. A
   "don't ping unless you must" policy therefore needs a mechanical backstop, not just an instruction.

7. **Ask-first rules need a trigger list.** OpenAI's agent guide: human intervention on failure
   thresholds and high-risk/irreversible actions [7]. Operator confirms actions that "affect the state
   of the world" (purchases, email) with ~92% recall on its risky-action eval, and pauses when the
   user leaves (watch mode) [8]. The cost ladder must never shortcut these.

8. **Prompt-only substitutes for SFT/RL.** (a) Evals grown from real failures — "every bot that
   doesn't work well becomes an eval" (lecture notes); Anthropic's small-sample method [2]. (b)
   Canonical few-shot harness examples in the prompt [1]. (c) Format constraints as schemas: pi
   validates tool arguments against TypeBox before `execute()` and validates `structuredOutput`
   against a declared schema (`vendor/pi/packages/durable/src/harness/types.ts:291`, `docs/spec.md:2900`).
   (d) Turn termination without an extra model call: pi-durable tool results may request
   `control: { terminate: true }`; when every call of a round requests it, the run ends at the final
   boundary, no follow-up generation (`vendor/pi/packages/durable/src/harness/generation.ts:646`,
   `types.ts:139`) — exactly grokbot's "one less step".

## How grokbot does it (from lecture notes)

- **Cost ladder**: what it knows → app API → web search → signed-in browser → full desktop → ask you.
  Each rung slower, more expensive, riskier. A broken connector is not a reason to bypass it with the
  browser; report and ask.
- **SendToUser**: one tool for reaching the user across channels; the model's raw text/thinking is
  never shown; quiet is allowed (no news = no message); the final message can end the turn without
  another model call. Work tools (Shell, Files, Browser, …) never speak to the user directly.
- **Queue discipline**: the user in a 1:1 chat interrupts or stops; everyone else (hooks, helpers,
  Slack) goes to the back of the line, with quick messages batched into one turn.
- **Automatic review**: a separate model checks risky actions; no answer in 15 s = blocked.
  Memories are information, not instructions; outbound messages and new routines need approval.
- **[D:]** The ladder is the "lazy/senior developer" policy: raise the model's internal cost of
  bugging the user until autonomy feels like a colleague. Triage/subagents keep the main conversation
  sparse ("the key to essentially infinite context").
- **[D:]** Assume models get smarter and "delete the product": build as little around them as possible.

Interpretation: grokbot's behavior policy is data (files), a tool boundary (`SendToUser`), a queue
(batching), and a review model — not a monolithic system prompt. Mason can adopt the text and the
tool boundary now; the review model and attention model can wait.

## Mason applicability

**Already present.** `AgentIdentity` renders `preamble` from `SOUL.md` (or `DEFAULT_PREAMBLE`) and a
`proactive_guidelines` section for `[EVENT HOOK: …]` turns (`src/server/extensions/agent-identity.ts:9`).
pi-durable re-renders and diffs sections, writing them as `pi.system` entries that the debug UI shows
(`vendor/pi/packages/durable/src/harness/prompt.ts:25,66,122`; `docs/SPEC.md` §4.3) — policy edits are
reviewable and cache-stable between changes. Hooks carry a `promptTemplate` and submit with
`whenBusy: "followUp"` (`src/server/hooks.ts:117-122`), and the queue supports steer/follow-up modes
(`vendor/pi/packages/durable/docs/spec.md:2361`), currently `one-at-a-time` by default
(`vendor/pi/packages/durable/src/harness/agent.ts:70`). The turn-termination control exists but is
unused by mason.

**Missing.**
1. No behavior policy distinct from identity. `SOUL.md` is voice/persona; interruption rules and the
   cost ladder have no home, and `builtinHooks` does not reference any policy.
2. No mechanical "quiet". Every assistant text reaches the UI, so a hook that finds nothing still
   yields a message (and, without a terminal tool, a second model call to phrase it).
3. No behavior evals. Mason's tests are wiring tests against the faux provider
   (`test/chord-e2e.test.ts`); nothing checks "stayed quiet", "asked before sending", or ladder choice.

**Where the policy lives.** Not `APPEND_SYSTEM.md`: mason never builds pi's coding-agent system
prompt — pi's `appendSystemPrompt` is just its `addendum` section
(`vendor/pi/packages/coding-agent/src/core/system-prompt.ts:172`). Mason's equivalent of that file is
a named section. Recommended: a workspace `POLICY.md` read like `SOUL.md` into a `behavior_policy`
section (same extension or a new `behavior-policy.ts`), with the text below as the built-in default.
Per-hook policies stay in each hook's `promptTemplate` — trigger-local facts, not duplicated global
rules. This keeps one policy source, matches grokbot's "everything is a file" and Denis's "agents
manage their own state", and degrades gracefully: if the model ignores it, the harness (queue,
approval tool) still constrains it.

### Draft policy text (`POLICY.md` default)

```markdown
# POLICY — how I spend the user's attention

Quiet is normal. My work is cheap; the user's attention is not.

## Cost ladder (cheapest first)
1. What I already know (conversation, memory/notes).
2. Workspace files and tools (read, grep, bash): check, don't guess.
3. A service's API, CLI, or connector.
4. Web search.
5. A signed-in browser, then the full desktop.
6. Ask the user.
Stop at the cheapest rung that can finish the job. If a connector is broken, report it — don't
walk around it with the browser. Never climb to a riskier rung to avoid asking when the action is
irreversible or outbound. When a hook authorizes the work, act instead of asking.

## Messaging
- No news = no message. If nothing needs the user, end the turn without messaging them.
- One message per event, related findings batched into it. No progress narration.
- Reasoning stays private. Anything the user must know goes in the message, not in thinking or
  tool output. Tool chatter is not a channel to the user.
- Say what happened, what I need, or nothing: no "I'll investigate" followed by silence, no
  restating the prompt, no padding a check-in into a report.
- Priority order worth interrupting for: (1) something the user asked for is done or blocked;
  (2) something broke and gets worse if ignored; (3) a decision only they can make; (4) a concrete,
  timely opportunity. Everything else waits for natural contact.

## Ask first, always
- Anything outbound: messages, email, payments, posts.
- Destructive or hard to reverse: deletes beyond task scope, history rewrites, credential changes.
- Logins, verification codes, captchas: stop and hand over the screen.
- Spending money or acting visibly for other people.
Ask once, precisely: what I will do, to what, and why; then wait.

## Working style
- Read before editing, verify before claiming, state uncertainty plainly.
- Prefer one good pass over five rushed ones; spend tokens to save the user time.
- Fix root causes; leave the workspace tidy; don't start unrelated work.
- Conflicts, highest wins: explicit user request > hook prompt > this file.
- If a line here makes me slower or noisier than it should, say so — this file is text and can change.
```

## Recommended actions

1. **[now]** Add `POLICY.md` (workspace) + a `behavior_policy` section to `agent-identity.ts`
   (or a `behavior-policy.ts` extension), defaulting to the text above, and point the built-in hook
   prompts at it ("if nothing needs attention, end quietly"). Test: the section appears in the system
   message and a file edit produces a `pi.system` patch (`test/harness-env.test.ts` already tests
   `SOUL.md` the same way).
2. **[next]** Add a terminal `send_to_user` tool: appends the user-visible message and returns
   `control: { terminate: true }` (`vendor/pi/packages/durable/src/harness/generation.ts:646`). A
   hook run that never calls it produces no user-visible message. This makes quiet mechanical and
   saves the follow-up model call.
3. **[next]** Grow a small behavior eval set (10–20 scenarios, real model): quiet when clean, report
   when a build breaks, ask before an outbound email, ladder choice when a connector fails. Follow
   pi's `packages/evals` pattern (`vendor/pi/packages/evals/README.md`); keep faux wiring tests separate.
4. **[next]** Decide batching for proactive triggers: hook bursts currently place one-at-a-time
   (`agent.ts:70`). Either set `followUpMode: "all"` or coalesce in `HooksManager` so three hook fires
   in a minute become one turn (grokbot's "3 quick messages → 1 turn").
5. **[later]** Only if evals show over-triggering: structured hook metadata (priority, quiet hours,
   per-hour budget) and a preference file; don't build an interruption classifier first.
6. **[later]** Few-shot canonical hook messages in the policy file if message quality (not frequency)
   is the failure mode.
7. **[don't]** Fine-tuning/RL, per-hook policy files, or if-else urgency logic. Policy text plus
   evals first; expect to delete lines as models improve.

## Open questions

- Does a prompt-only "quiet" hold for always-on agents, or is the `send_to_user` tool the real
  mechanism? No primary source measures this; ProactiveAgent suggests prompts alone under-restrain [12].
- Whether to keep assistant text user-visible at all. Grokbot hides model text behind `SendToUser`;
  mason's UI renders it. A tool boundary is a UI change, not just a prompt change.
- Self-editing `POLICY.md` invalidates the cached prompt prefix. Grokbot treats cache misses as bugs;
  how often may mason rewrite its own policy before that matters? (Caching details are Brief 05.)
- Model-specific variants: Claude 4 and Codex ship different behavior text per model family [4][5].
  Mason has one policy for any provider — acceptable, or should the section be conditional?
- Judging taste: LLM-judge rubrics work for factual research [2]; message relevance needs a rubric
  and human spot-checks before it can gate changes.

## Sources

1. Anthropic, "Effective context engineering for AI agents" — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (read via https://web.archive.org/web/20250929172515/)
2. Anthropic, "How we built our multi-agent research system" — https://www.anthropic.com/engineering/built-multi-agent-research-system (read via https://web.archive.org/web/20250920/)
3. Anthropic, "Claude Code: Best practices for agentic coding" — https://www.anthropic.com/engineering/claude-code-best-practices (read via https://web.archive.org/web/20250420034405/)
4. Anthropic, "Release notes: system prompts" (Claude 4 Opus/Sonnet) — https://docs.claude.com/en/release-notes/system-prompts (read via https://web.archive.org/web/20251001081935/)
5. OpenAI Codex base instructions — https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/prompts/base_instructions/default.md; gpt_5_2 prompt — https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/gpt_5_2_prompt.md
6. OpenAI Codex Guardian policy — https://raw.githubusercontent.com/openai/codex/main/codex-rs/prompts/templates/guardian/policy.md; approval policy — .../permissions/approval_policy/on_request.md
7. OpenAI, "A practical guide to building agents" — https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
8. OpenAI, "Computer-Using Agent system card" — https://cdn.openai.com/operator_system_card.pdf
9. E. Horvitz, "Models of Attention in Computing and Communication", CACM 46(3), 2003 — https://interruptions.net/literature/Horvitz-CACM03-p52-horvitz.pdf
10. Google SRE Book, ch. 6 "Monitoring Distributed Systems" — https://sre.google/sre-book/monitoring-distributed-systems/
11. Microsoft, "Guidelines for Human-AI Interaction" — https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/Guidelines-for-Human-AI-Interaction-camera-ready.pdf
12. X. Zheng et al., "Proactive Agent" (ProactiveBench), arXiv:2410.12361v3 — https://arxiv.org/abs/2410.12361
13. Repo: `vendor/pi/packages/coding-agent/src/core/system-prompt.ts`, `vendor/pi/packages/durable/src/harness/{prompt,generation,types,agent}.ts`, `vendor/pi/packages/durable/docs/spec.md`, `vendor/pi/packages/evals/README.md`
14. Repo: `src/server/extensions/agent-identity.ts`, `src/server/hooks.ts`, `docs/SPEC.md`, `test/harness-env.test.ts`
