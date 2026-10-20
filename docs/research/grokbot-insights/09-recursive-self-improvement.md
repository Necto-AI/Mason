# Recursive self-improvement: agent editing its own harness and prompts — research findings

> Deep-research run: grokbot lecture insights → mason. Date: 2026-10-18. Model: deepseek-v4.1-flash (max thinking).

## Summary

The state of the art has replaced "prove the rewrite is safe" with "measure it, keep the lineage, sandbox the run". The Darwin Gödel Machine is the clearest formulation: a self-modification is kept only when it empirically improves a downstream score, every variant stays in an archive, and the loop runs in a sandbox with a narrow edit scope [1]. Products ship the small version: Claude Code's agent writes its own skills and memory files, and those files carry their own evals [10][12]. For mason the ladder is not "how autonomous is the agent" but "what evidence gate does each self-edit layer pass", with the gate (policy hook + evals) outside the agent's write scope.

## Key findings

1. **Empirical validation, not proofs.** Schmidhuber's Gödel machine rewrites its own code once it has a proof the rewrite is useful [3]; the DGM's authors state that proving most changes beneficial is impossible in practice, and replace the proof with benchmark validation plus open-ended exploration of an archive of agents [1]. Scores rose from 20.0% → 50.0% (SWE-bench) and 14.2% → 30.7% (Polyglot); one run on SWE-bench takes about two weeks of compute [1].
2. **Research self-modification comes with an explicit safety envelope:** isolated sandboxes, strict time limits, scope restricted to the agent's own codebase and evaluation harnesses, monitoring of code changes, and a complete auditable lineage enabling rollback [1]. The paper names "an unmodifiable part of the system to be able to evaluate and halt the rest" as a design worth exploring [1].
3. **Self-improvement experiments measure their own escape attempts.** STOP runs an LM-written improver that improves itself, and evaluates how often the generated code bypasses the sandbox [4]. Voyager commits a skill to its library only after a separate critic model verifies success; retrieval is by embedding over program descriptions (top-5); skills are compositional and transfer to a new world [2].
4. **Verbal self-feedback is the cheap version of the loop**: Reflexion keeps an episodic memory of reflections instead of updating weights (91% vs 80% pass@1 HumanEval for the GPT-4 baseline) [6]; Self-Refine iterates output → feedback → refinement with ~20% absolute average improvement across seven tasks [5]. ADAS shows the archive pattern for agent design: agents defined in code, discovered by a meta agent, transferable across domains and models [7].
5. **Agents can improve their own tools against evals.** Anthropic reports pasting eval transcripts into Claude Code to refactor tool implementations; gains on held-out sets went beyond manually written "expert" tools [15]. Grokbot's harness fix, one level down.
6. **Anthropic's eval practice is the operational form of grokbot's inner loop** [11]: capability evals ("what can it do", low pass rate) stay separate from regression evals ("does it still work", ~100% pass rate, fed by graduated capability cases); 20–50 tasks from real failures is a good start; build balanced sets (behaviour *should* and *should not* fire); grade the outcome, not the tool-call path; read transcripts before trusting scores.
7. **Skill-level evals already have a file format.** Claude Code's `skill-creator` stores test cases in `evals/evals.json`, writes pass/fail with evidence to `grading.json`, aggregates with-skill vs. without-skill pass rate, time and tokens into `benchmark.json`, runs a blind A/B between two skill versions "so you can confirm an edit is an improvement before committing it", and tunes `description` with generated should-trigger / should-not-trigger prompts [10].
8. **Agents authoring their own behavior files is shipping practice, with review**: `/verify` records its own recipe to `.claude/skills/verify/SKILL.md` [10]; memory files are edited directly (`/memory`, `#`), with review periodically as best practice [12]; the Agent Skills post tells users to "ask Claude to capture its successful approaches and common mistakes into reusable context and code within a skill" [9]. Skills bundle instructions *and* code, and are only as trustworthy as their source [9].
9. **pi already models the approval boundary for prompt/skill files.** Project-level `skills/`, `prompts/`, `SYSTEM.md`, `APPEND_SYSTEM.md` are trust-gated resources (`vendor/pi/packages/coding-agent/src/core/trust-manager.ts:32`). pi loads skills by name and description, with the file read on demand (`vendor/pi/packages/coding-agent/src/core/skills.ts:358`).
10. **pi-durable already has the enforcement seam.** `ToolHooks.beforeTool` may return `{ block }` ("the first `block` wins… A throw blocks", `vendor/pi/packages/durable/src/harness/types.ts:778`); `wrapTool` can rewrite a tool's behaviour (`vendor/pi/packages/durable/src/harness/define.ts:34`). Prompt sections are re-rendered per request and diffed into the transcript as `pi.system` entries (`vendor/pi/packages/durable/src/harness/prompt.ts:66`), so editing `SOUL.md` mid-conversation takes effect at once, is recorded as a section patch, and changes the prompt prefix from that point on.
11. **pi ships a behavioural eval package to copy from, and a faux provider to start with.** `vendor/pi/packages/evals` runs vitest-evals suites in isolated Docker arms (unprivileged UID, root-owned eval files, fresh home/workspace per run), compares two arms and reports lift. The faux provider accepts a `FauxResponseFactory` that sees the prompt (`vendor/pi/packages/ai/src/providers/faux.ts:109`), which makes deterministic prompt-contract tests possible; `test/harness-env.test.ts` already scripts faux responses and reads the rendered sections.

## How grokbot does it (from lecture notes)

Memory is a file, "tell it once", and a pass after each turn adds and replaces facts. The inner loop is daily: something goes wrong → turn it into an eval → fix harness, prompt, or inference → check the evals → ship. The outer loop is quarterly: evals guide training, and new behaviours become new evals. "Delete the product": build as little scaffolding as you can and remove what the model no longer needs. Safety is layered on the same files: new routines need the user's OK, a dedicated state-saving tool so reviewers see changes, memories as information rather than instructions, and a separate model reviewing risky actions before they run (no answer in 15 seconds means blocked).

## Mason applicability

**The ladder, concretely:**

| Layer | Written by | Gate |
|---|---|---|
| Memory, notes, `.scratch` | agent | tool call visible in the transcript, no review |
| Instruction-only skills | agent | its trigger evals pass, edit visible in git |
| Skills with code, routines | agent drafts | Denis acks; enabling a routine goes through `toggleHook` |
| Prompt/policy files (`SOUL.md`, `PROACTIVE_GUIDELINES`) | agent drafts, Denis merges | diff plus eval report |
| Harness `src/`, guardrail, evals | agent drafts a PR | Denis reviews; guardrail and eval files are never agent-writable |
| `vendor/pi` | only Denis | submodule pinned |

**Already there.** A durable harness whose prompt is replayed from `pi.system` entries (`src/server/runtime.ts:157`); hooks with `fireCount` (`src/server/hooks.ts`); a self-heal loop (`src/server/run-retry.ts`); owner-only control methods (`src/shared/contract.ts:55`); an isolated execution seam (`src/server/env.ts` → `pi-env` daemon); offline scripted-model tests (`test/harness-env.test.ts`).

**Missing and needed before any ladder works.** (a) No write boundary: `workspaceDir` defaults to `process.cwd()` (`src/server/runtime.ts:127`, the repo) and `env.absolutePath` accepts absolute paths (`vendor/pi/packages/durable/src/tools/path-utils.ts`), so "never touch src/" is only a prompt sentence. (b) No policy hook: no `beforeTool` gate, no approval method on `AgentService`. (c) No memory or skills extension: pi-durable ships only `read/write/edit/bash` (`vendor/pi/packages/durable/src/tools/index.ts:39`), so grokbot's rungs (a) and (b) must be built. (d) Hook definitions are code (`builtinHooks()`, `src/server/hooks.ts:207`), so agent-authored routines need file-based definitions first. (e) No behaviour evals: `npm test` covers transport, transcript model and retry only.

**Deliberately not build.** Open-ended harness search (DGM-style) is a research project with a two-week loop and a benchmark that does not exist for a personal assistant; the practical version is a small regression corpus plus PR review. Anthropic's stance is to find the simplest solution and add complexity only when it demonstrably improves outcomes [8]. Also skip agent-writable guardrail code, self-merge, and mid-run prompt mutation (it invalidates the prompt cache and splits the agent's footing mid-turn).

## Recommended actions

1. **[now]** Define writable roots in one place: `memory/`, `skills/`, `routines/`, `.scratch/`, `.data/`, and the workspace; read-only: `src/`, `scripts/`, `test/`, `vendor/`, `devenv.*`, `package*.json`. Enforce with a `beforeTool` hook that blocks writes outside the roots and returns what to do instead ("open a draft branch/PR"). Test it with the faux provider.
2. **[now]** Make the boundary real, not advisory: run the `pi-env` daemon as a dedicated user with the repo mounted read-only (`npm run dev` stays Denis's). The hook is the message; filesystem permissions are the guardrail.
3. **[now]** Add `test/behavior.eval.test.ts` to `npm test`, no provider keys: 5–10 scenarios from fixed failures, asserting rendered sections, scripted tool calls, and committed entries. Start with: a hook produces exactly one message; a failed run is retried once; disabled hooks don't fire; the guardrail blocks `src/` writes; sections stay byte-stable within a turn.
4. **[now]** Open the failure intake: `.scratch/evals/inbox.md` plus a GitHub issue per real failure (label `ready-for-agent`) with the raw failure and expected behaviour. Every Denis correction lands there before it lands in memory.
5. **[next]** Build the memory extension (profile + dated log, a dedicated `remember` tool, one prompt section) and the skills extension (loader plus name/description/location listing, read on demand).
6. **[next]** When skills land, ship each agent-authored skill with `evals/<skill>/cases.json`: should-trigger and should-not-trigger prompts, one isolated run per case, pass/fail plus tokens beside the skill. Instruction-only skills auto-land once both sets pass; skills that add scripts or tools need Denis's ack.
7. **[next]** Convert routines to data files (`routines/<name>.md` with frontmatter) loaded at startup, so the agent can draft a routine; enabling stays behind the owner-only `toggleHook`.
8. **[next]** Add a weekly LLM-graded eval run (pi-evals style, 20–50 tasks, graders = outcome check + transcript metric + one conciseness rubric). Graduate every fixed failure into the deterministic suite.
9. **[later]** Add the auto-review gate for calls leaving the writable roots (`git push`, network sends) with a timeout that blocks, plus an `AgentService` approval method a blocked call can wait on.
10. **[later]** Schedule the "delete the product" pass: monthly, ablate one prompt section, skill or tool, run the evals, keep the deletion when scores hold, and log prompt tokens per section.
11. **[don't]** Let the agent edit the guardrail extension, the eval runner, or the eval corpus; those are the unmodifiable part. **[don't]** Self-merge a harness PR, or run a self-modification loop without rollback (git revert) and lineage (commit + eval report via the `pr` skill's Evidence section).

## Open questions

- `agentskills.io` (the eval format referenced by Claude Code) is unreachable from this host; the format is known only through the Claude Code docs summary [10].
- How much of mason's behaviour the faux provider alone can grade is unmeasured; the split between deterministic contract evals and model-graded evals must be found empirically.
- No primary source was found for the specific practice "an agent maintains its own AGENTS.md"; the adjacent, sourced facts are `/init` generating the file [13], memory editing with `/memory` and `#` [12], and the portable format itself [14].
- Whether `pi-env`'s daemon can run as a distinct user out of the box is unverified; so are the cost and latency of a nightly model-graded suite.

## Sources

1. https://arxiv.org/abs/2505.22954 — Darwin Gödel Machine (abstract; full text §5, §6, Appendix I)
2. https://arxiv.org/abs/2305.16291 — Voyager (abstract; full text §2.2, §2.3)
3. https://arxiv.org/abs/cs/0309048 — Gödel Machines (Schmidhuber)
4. https://arxiv.org/abs/2310.02304 — Self-Taught Optimizer (STOP)
5. https://arxiv.org/abs/2303.17651 — Self-Refine
6. https://arxiv.org/abs/2303.11366 — Reflexion
7. https://arxiv.org/abs/2408.08435 — Automated Design of Agentic Systems (ADAS)
8. https://www.anthropic.com/engineering/building-effective-agents (read via https://web.archive.org/web/2026/)
9. https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills (read via https://web.archive.org/web/2026/)
10. https://code.claude.com/docs/en/skills (read via https://web.archive.org/web/20261017030754/)
11. https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents (read via https://web.archive.org/web/20261016200944/)
12. https://docs.claude.com/en/docs/claude-code/memory (read via https://web.archive.org/web/20251104190923/)
13. https://www.anthropic.com/engineering/claude-code-best-practices (read via https://web.archive.org/web/20260125031707/)
14. https://agents.md/ (read via https://web.archive.org/web/20261018000351/)
15. https://www.anthropic.com/engineering/writing-tools-for-agents (read via https://web.archive.org/web/20261017103554/)

Repo paths read:

- `vendor/pi/packages/evals/README.md`, `vendor/pi/packages/evals/package.json`
- `vendor/pi/packages/coding-agent/src/core/skills.ts:358`, `.../core/trust-manager.ts:32`, `.../core/resource-loader.ts:1228`
- `vendor/pi/packages/durable/src/harness/types.ts:778`, `.../harness/define.ts:34`, `.../harness/prompt.ts:66`, `.../tools/index.ts:39`, `.../tools/path-utils.ts`
- `vendor/pi/packages/ai/src/providers/faux.ts:109`
- `src/server/runtime.ts`, `src/server/hooks.ts`, `src/server/run-retry.ts`, `src/server/extensions/agent-identity.ts`, `src/shared/contract.ts`, `test/harness-env.test.ts`, `docs/SPEC.md`, `AGENTS.md`
