# 2. What the harnesses built for local models actually do

Four shipped or published harnesses, plus the literature that tries to search the space automatically. The point of
reading them side by side is that they converge — independently, for different budgets — on the same small set of
moves.

## §1 Perplexity Computer: the harness is code, the model only proposes

From *A Local-First Agent for Private Knowledge Work*, 2026-08-25. **[vendor claim]** throughout, with the measured
deltas in `01` §1. <https://www.perplexity.ai/hub/blog/a-local-first-agent-for-private-and-cost-effective-knowledge-work>

Their stated principle is the one worth copying: *the model and harness are designed together*. "General-purpose
harnesses assume a frontier model that can absorb long contexts, navigate a broad tool surface, and plan over long
horizons. Local models are less reliable under those demands."

The design, in their order:

1. **Context efficiency is the whole game.** "Although on-device models such as Qwen 3.8 27B offer context windows of
   260K tokens, we found empirically that they begin to struggle beyond 100K tokens." Therefore: a minimal system
   prompt, a small set of core tools, everything else deferred into skills that "load and unload throughout the
   trajectory", plus compaction of stale context.
2. **Connectors become CLI tools, not MCP servers.** "These are usually exposed to a harness as MCP servers, whose
   large tool definitions consume a substantial share of the context. Instead, we converted the most-used MCPs into
   compact, easy-to-use command-line tools, supplemented with custom skills." This is the single biggest structural
   difference from a standard MCP-first harness, and it is motivated purely by prefill budget.
3. **Self-verification, hook-triggered.** Triggered by the model *or* by hooks watching trajectory health. "Verification
   adds extra steps, but it greatly improves final results and substantially narrows the gap to frontier models."
4. **An OS-level sandbox that fails closed.** "If the sandbox is unavailable, the harness disables itself before any
   tool calls rather than degrading to unsandboxed execution." They name Pi and Hermes as running commands with the
   user's permissions by default.
5. **A deterministic orchestrator.** "The orchestrator is deterministic harness code, not an LLM: it maintains the loop,
   assembles context, and enforces policy. The local model proposes the next action." This is the sentence to keep.
6. **Advisor escalation.** The local model decides when it wants help; the orchestrator retains tool authority, selects
   the context, runs a PII classifier, and shows the user what would leave the device. The advisor returns *text only*
   — no tool access, no files, no reply channel.

Advisor escalation, measured on Terminal-Bench 2.1 (89 tasks), is the most useful cost number in the whole file:

| Arm | Score | Cost per rollout |
|---|---|---|
| Qwen 3.8 27B, fully local | 59.6% | $0 |
| Qwen 3.8 27B executing + Opus 5 advisor | 73.0% (13.5pp) | $0.415 |
| Claude Opus 5 alone, same harness | 82.4% | $0.65 |

That is roughly three-fifths of the frontier gap for about two-thirds of the frontier cost. It is also the argument for
the shape of a *subagent* harness specifically: local does the work, frontier answers questions about the work.

## §2 LM Studio Bionic: the model proposes, deterministic code disposes of the dangerous part

Bionic (July 2026) is LM Studio's separate agent app for open models, local or cloud. It ships skills (August), a local
OpenAI-compatible API, sub-sessions inside projects, and — the interesting part — **Auto Review** (August 27, 2026).
**[documented]** <https://lmstudio.ai/blog/how-auto-review-works>

Auto Review is a two-stage command approval pipeline, and the first stage has no model in it:

- **Shell Judge**: parses the command to an AST (`mvdan/sh` for sh/bash/zsh, PowerShell's own parser), extracts a
  `ShellCapability` — the worst case the command can do — and matches it against a ruleset of known-safe
  command-and-argument combinations. Strictly an allowlist: an unrecognized AST node is reported `unknown` and
  rejected. It tracks variable values through "finite alternatives" (up to 1,000) so `base=$(git merge-base HEAD main);
  git diff $base` is judged on what `$base` can be, including `--output=/sensitive/file`. Environment assignment of any
  kind is rejected outright.
- **Shell Reviewer**: only for what the Judge cannot clear. A separate subagent scores the command on three orthogonal
  axes — risk (`low`/`high`/`too_destructive`), authorization (`explicitly_no`/`neutral`/`explicitly_yes`), correctness —
  and **is never told the passing threshold, only the rubric**. Correctness feedback goes back to the main model.
- Reported clearing rate: **~82% of commands approved without an LLM call**, which the author labels anecdotal rather
  than a benchmark.

The transferable idea is not the shell parser. It is: **push the decisions that can be made deterministically out of the
model, and give the model's judgment to a fresh context that was not the one that wrote the command.** The main agent
reviewing its own command is the same defect as the model grading its own work (`01` §5).

BionicBench v0.1 (18 tasks: coding, repo instructions, images, Word/PowerPoint/Excel editing, PDFs) is a *model*
comparison at fixed harness — Muse Glimmer 30B 83.3%, Gemma 4 31B 77.7%, Qwen 3.6 27B 77.7% — so it says nothing about
harness design. **[vendor claim]** Worth knowing it exists as a shape: artifact-checked, not answer-checked.

LM Studio also shipped KV-cache checkpointing in the MLX engine "for repeated, long-context agentic workflows"
(blog index, 2026). **[vendor claim, headline only]** — the detail page 404s. The direction matters more than the claim:
the inference engine is being tuned for *agent loops*, where the same long prefix is re-processed turn after turn.

## §3 Mingbird: ten mechanisms, and an honest ablation

arXiv:2610.02001, *A Local-First Agent Harness Enabling Small Open Models to Complete Real Tasks* (2026-10-01).
**[measured, self-built benchmark]** <https://arxiv.org/html/2610.02001>

Scope is 2–35B open models on Ollama — the 27B is inside its range but the paper's centre of mass is smaller. Its value
here is the mechanism list and the ablation discipline.

| # | Mechanism | Failure it targets |
|---|---|---|
| 1 | Flat prefill, net-zero budget; static prefill pinned at **797 tokens** in v1.6.0 by unit test, CI enforces zero growth | prefill crowding, instruction-following degradation |
| 2 | Chat/task layering: chat gets a minimal prefill and terminates after the answer | "tool-demonstration loop" — answering casual talk by calling tools |
| 3 | Finish gate: before accepting completion, re-read the task verbatim and verify delivery point by point; re-inject the plan after compaction | silent abandonment, false completion, plan drift |
| 4 | Signature-level anti-loop: tool + normalized arguments, trips at ≥6 identical calls or ≥15 consecutive calls with no output | repetition |
| 5 | Format rescue: converts the three recurring malformed-call shapes (placeholder-quoted, bare-JSON, double-quoted pseudo-calls); a rejection always carries the next executable action | a strict parser discarding a real call, collapsing the turn |
| 6 | Edit safety: `.bak` per write, model-issuable rollback, alternating-destructive-edit guard | a bad edit it cannot recover from |
| 7 | Resilience: UTF-8 with replacement, empty generation → hard reset, think-tag shells treated as empty, kill-resume checkpoints | encoding faults, empty turns, terminated runs |
| 8 | Security boundary by normalized path, credential paths gated, subagents denied by default | writes outside the working directory |
| 9 | Capability surface, admitted only if it fits under the 797-token budget | — |
| 10 | 441 CI tests including the prefill net-zero assertion and the detector thresholds | regression of 1 and 4 |

Reported: LRAB 0.886 against goose 0.631, opencode 0.479, agent-mini 0.405; τ²-bench 0.856 against 0.791 and 0.737.

The ablation is the honest part: same-night replications move an arm's mean by up to 0.069 — the size of every nominal
single-trial delta — and all task-level bootstrap intervals cross zero. Only the **finish gate** survives in direction
after excluding a common-cause task; the one batch-matched comparison gives the executable completion guards **+0.10
paired**. So: the mechanism list is a good menu, the score table is not evidence for any individual item.

## §4 Pi and Hermes: the general harnesses, measured

Pi (badlogic/pi-mono, now earendil-works/pi) is the minimal-harness position, stated as a principle: "if I don't need it,
it won't be built. And I don't need a lot of things." Its shipped coding-agent system prompt is ~15 lines for four tools
(`read`, `bash`, `edit`, `write`) plus a pointer to its own docs. **[documented]** —
<https://mariozechner.at/posts/2025-11-30-pi-coding-agent/>

Perplexity's measurement (`01` §1) says what that buys and costs with a 27B: **fastest on document work (176 s/task),
second on knowledge work (77.6%), 16.5 points behind a tuned harness on BrowseComp, at 3.3x the tokens.** The
interpretation that fits: a minimal harness gives the model freedom over its own strategy, which a 27B spends badly on
open-ended multi-hop work and adequately on bounded artifact work. **[inference]**

Hermes (Nous Research) lands below Pi on knowledge work and research with the same model, and above it on documents
(34.6% to 13.9%, but at 108 s against Pi's 410 s). Neither is *bad*; both are general.

## §5 The automated-harness-adaptation literature: what a harness can absorb

*Better Harnesses, Smaller Models: Building 90% Cheaper Agents via Automated Harness Adaptation*,
arXiv:2607.08938 (2026-07-09). **[measured, secondary — models are 3–8B active / 8–30B total]** —
<https://arxiv.org/html/2607.08938v1>

It builds a framework, then a meta-agent that diagnoses failures and proposes harness adaptations, and runs it over 7
business tasks × 3 SLM families.

The framework is the useful artifact: failures indexed by the capability that broke, adaptations indexed by the harness
component they change.

| Failure mode | What it looks like | Adaptation that addresses it |
|---|---|---|
| tool-use | wrong tool, malformed call, wrong usage — worst when the tool set is large or schemas are complex | wrap recurring sequences into higher-level tools; filter unused tools; tailor schemas to the model |
| instruction-following | violates requirements, format, workflow — worst when instructions are long and complex | reinforce the constraint outside the model's output; enforce programmatically in a hook |
| knowledge | invents assumptions the task left implicit; follows a sub-optimal workflow | add context, offload to external storage, decompose into agents |
| long-context | forgets earlier instructions, repeats failed actions, is distracted by irrelevant observations | progressive disclosure, compression, prune observations |
| planning / reasoning | cannot decompose, no backtracking, premature answer | provide a plan skeleton; deterministic orchestration |

Findings:

- Optimized harnesses improved **16 of 21** task–model pairs; **7** closed the SLM–LLM gap; the best recovered **89.7%
  of LLM performance at 4% of the cost**.
- Successful adaptations most often addressed instruction-following (81%) and knowledge (81%) failures, via adding
  context (86%), creating new tools (43%), managing tools (29%).
- **Adaptation helps most on repetitive workflows** (+21.1% going from the most diverse task setting to the least) and
  **most for the stronger base model** (+48.8% vs +15.5%). A harness absorbs task difficulty; it does not replace
  missing capability.
- The stated trade-off, which is the design constraint for everything else here: "adding contexts is straightforward
  and often effective, but it can lead to new failures on long-context and instruction-following due to growing context
  complexity… There is no one-size-fits-all solution."

That last point is the argument against a big, universal local prompt. The same paper's worked example — a budget
approval agent — went from 75.0% to 98.3% by giving it *a plan skeleton, a reduced tool set, and enforced constraints
in hooks*.

## §6 The most reproducible numbers: tool and skill count

Independent of model size, this is where the evidence is densest.

- **Full-catalog tool selection**: ~78% at 10 tools, ~40% at ~100, 13.6% at 741 (speaker-reported, details not published).
- **Retrieval shortlisting**: RAG-MCP took tool-selection accuracy from **13.62% → 43.13%** and cut prompt tokens by
  more than half (Gan & Sun, 2025-05).
- **Enterprise catalog**: on 584 tools across 110 agents, routing F1 on under-specified requests drops **16–23 points**
  as the catalog scales, and an oracle analysis finds **10 points of that is a pure confusion gap** — even with perfect
  retrieval, the model picks wrong when many similar options are visible. Embedding shortlisting recovers 10–11.
  (arXiv:2606.17519)
- **Choosing the shortlist depth**: on BFCL (370 tools), a learned policy reaches 90.3% coverage with **7.4 tools shown**
  against 90.8% for always showing 50. Downstream choice accuracy with the gold tool present: 93.1% at 2.2 tools vs
  87.1% at 5. (arXiv:2605.24660)
- **Fewer tools also means a smaller prompt benefit is not the main effect** — with the gold tool always present, wide
  lists still cost 6 points of accuracy. It is confusion, not tokens. **[measured]**
- **Skills behave like tools, but worse**: expanding a library from a known-helpful set to 202 skills costs up to **21%
  pass rate**, and the decomposition attributes it to **skill shadowing** (picking the wrong skill more often) while
  "context overhead remains small and indistinguishable from zero". (arXiv:2605.24050) A wrong skill is worse than a
  wrong tool call because it injects plausible wrong instructions instead of failing loudly. **[inference from their
  argument]**

The practical read: an index of skills or tools in a prompt is a *selector*, and selection accuracy falls with
cardinality well before the prompt gets expensive. Twenty sharply-scoped skills beat two hundred good ones.

## §7 What all four agree on

1. A **small static prompt** and a **small core tool set**, with everything else loaded on demand. Perplexity: minimal
   prompt + skills. Mingbird: 797 tokens, CI-enforced. Bionic: skills. Pi: ~15 lines of prompt for four tools.
2. **Deterministic code owns the loop.** The model proposes; the harness decides what is allowed, what is shown, what
   happens next. Mingbird's judge, Bionic's Shell Judge, Perplexity's orchestrator, Pi's plain loop with a hard
   iteration cap.
3. **A gate before completion**, re-reading the task rather than asking the model if it is done.
4. **Machine-checkable structure** — a sandbox, a path boundary, an AST, a schema — instead of an instruction telling
   the model to behave.
5. **Escalation as a designed feature**, not an apology (see `04` for why this matters for subagents specifically).
