# 1. How much a harness is worth at the 27B class

## §1 The one comparison that holds the model still: three harnesses, one 27B, one machine

Perplexity published this on 2026-08-25 in *A Local-First Agent for Private Knowledge Work*. Their local agent,
Computer, is compared against Pi and Hermes **with Qwen 3.8 27B as the model in all three**, on one NVIDIA DGX Spark,
at `medium` reasoning, before any post-training. Only the harness differs. **[measured]** —
<https://www.perplexity.ai/hub/blog/a-local-first-agent-for-private-and-cost-effective-knowledge-work>

| Benchmark | Computer | Pi | Hermes |
|---|---|---|---|
| Local Knowledge Work Bench, 53 tasks × 3 trials | **82.6%** | 77.6% | 74.0% |
| BrowseComp, 1,266 tasks | **66.7%** | 50.2% | 43.9% |
| ParseBench-100 (multimodal documents) | **65.1%** | 13.9% | 34.6% |
| LKWB tokens per task | 520k | 681k | 634k |
| LKWB wall time per task | 218 s | **176 s** | 292 s |
| BrowseComp tokens per task | 852k | 2.82M | 1.01M |
| BrowseComp wall time per task | 402 s | 826 s | 1,021 s |

Three things to take from the table, in order of how much they cost to ignore:

- **Knowledge work: 5 points between the tuned harness and Pi. Research: 16.5 points, and 3.3x the tokens.** The gap
  is not a constant. It scales with how much of the work is multi-step retrieval, where tool choice and context
  pruning compound over many turns.
- **Pi is fast on exactly the bench it is good at.** 176 s against 218 s on knowledge work, then 826 s against 402 s on
  BrowseComp and 410 s against 61 s on ParseBench. Its speed is bought with tokens, and on local hardware tokens *are*
  seconds. The two axes are not separable.
- **Documents are where a generic harness collapses.** ParseBench is multimodal document understanding: charts 76.5%
  vs 2.5% for Pi, tables 72.7% vs 11.0%, text 87.9% vs 29.7%. Qwen 3.8 27B is natively multimodal (it carries a vision
  encoder, `03` §1); a text-first harness never asks the model to look. This is a harness property, not a model one.

The same post also reports post-training on top of the same base: PPLX 27B, trained *inside* Computer, reaches 85.4% on
the same bench at 678k tokens. **[vendor claim]** — no held-out method published yet, and the point for us is the
ordering: harness first, then weights.

## §2 Qwen's own numbers for this model were earned in Claude Code

Qwen's model card for Qwen3.8-27B reports agentic benchmarks run **in the Claude Code harness** (WebArena-Verified on
the OSWorld scaffold). Terminal-Bench 2.1 comes out at **73.0**, against **78.2 for Opus 4.6 Max**. SWE-bench Pro comes
out *ahead* of Opus 4.6 Max, 61.7 to 53.4. **[documented]** —
<https://huggingface.co/Qwen/Qwen3.8-27B>

Perplexity's Computer harness put the same model at **59.6% on Terminal-Bench 2.1**. **[measured]** — same URL as §1.

13.4 points for the same model on the same benchmark, from the harness. Not a controlled measurement: different
quantization, different hardware, different effort setting, one of the two numbers is the vendor's own eval, and
Terminal-Bench tasks have a history of punishing one harness's sandbox harder than another's. Read it as a bound on
*how much is possible*, not as "Claude Code is 13 points better". The controlled comparison in §1 says 5 to 16 points
depending on task shape, and that is already enough to reorganize a design around.

The useful half of the observation is the direction of it: **Claude Code is a bash-first harness with a handful of
tools and a short prompt.** Its shape is close to what every local-first harness independently converged on (`02`), and
far from a harness that offers a wide typed tool surface. **[inference]**

## §3 At the frontier the same lever is smaller — and it does not point one way

Terminal-Bench 2.1 ranks *agent × model pairs*, so the same model appears under different harnesses. Rows where two
harnesses exist for one model: **[measured, uncontrolled submissions]** — <https://www.tbench.ai/news/terminal-bench-2-1>
and <https://tbench.ai/leaderboard>

| Model | Harness A | Harness B | Gap |
|---|---|---|---|
| GPT-5.5 | Codex CLI 83.1 | Terminus 2 78.0 | 5.1 |
| Gemini 3 Pro | Terminus 2 73.9 | Gemini CLI 65.8 | **8.1** (generic harness wins) |
| Claude Opus 4.7 | Claude Code 68.9 | Terminus 2 66.1 | 2.8 |
| Gemini 3.1 Pro | Gemini CLI 65.8 | Terminus 2 65.6 | 0.2 (inside ±1.7 noise) |

On Terminal-Bench 2.0 the same model across six CLIs spread 11.4 points: Droid 63.1, Letta Code 59.1, Terminus 2 57.8,
Goose 54.3, Claude Code 52.1, OpenHands 51.9, OpenCode 51.7. And on 2.1's fixed task set, Claude Code with Opus 4.6 went
58.0 → 70.1 while Terminus 2 went 62.9 → 63.8, *flipping* which harness led with the model unchanged. Part of that is
broken tasks hitting one harness harder. It is still a harness effect, and it is the kind you only see on your own
tasks.

Two rules fall out. **A harness is not better in general; it is better for a model on a task.** And **differences under
3 points are not differences** — the leaderboard's own intervals are ±1.2 to ±1.7.

## §4 The rule of thumb: a harness is worth about one model generation

The best synthesis of the literature I found is Manazir Ali, *How Far Agent Scaffolding Takes a Weak LLM* (2026-07-05),
which reviews roughly 30 sources from 2022 to mid-2026 and grades the "wrap a weak model in a strong harness" bet.
**[measured, secondary]** — <https://manazir.dev/work/the-harness-is-not-the-model>

Its closability matrix, which is the most useful single table I found for answering "what can the harness actually
absorb":

| What the harness is asked to substitute for | Verdict | Anchor |
|---|---|---|
| Knowledge | closes almost fully | Atlas 11B beats PaLM 540B on NaturalQuestions (Izacard 2022) |
| Single-turn tool-call format | closes | ToolACE-8B above GPT-4-class on BFCL; Qwen3-32B 75.7% on BFCL v3 |
| Narrow tasks with a cheap verifier | multiplies, given an oracle | SWE-bench 2% → 12.47% (SWE-agent) → 33.2% (Agentless, Verified) — different task sets, weights fixed |
| Multi-turn coherence | model-bound; decomposition mitigates | BFCL multi-turn: Qwen3-4B 35.3%, 1.7B 16.9%, 0.6B 1.4% vs ~90% for a Sonnet-class model |
| Long-horizon autonomy | model-bound; widest gap | 50–100x METR time-horizon spread |
| Cost | closes | 98% cost reduction at matched accuracy with a cascade |

Headline: **one model generation, 2–6x over a naive baseline.** Once a competent harness exists, swapping the model
dominates every other intervention.

Also here, from the same paper, two results worth carrying because they are counter-intuitive:

- The Agent-Computer Interface ablation inside SWE-agent was worth **10.7 points on its own**, at fixed weights. The
  interface *is* the harness.
- `mini-swe-agent`, a deliberately 100-line ReAct loop over plain bash, exceeds **74% on SWE-bench Verified with a
  frontier model**, beating far heavier scaffolds. Harness returns compress as the model strengthens; at the frontier
  the best harness is close to a no-op. **The 27B is exactly where returns are still large, and a heavyweight harness
  designed against a frontier model is exactly the wrong thing to hand it.** **[inference]**

Caveat on the whole section: these are cross-paper numbers with different models in different years. Use the shape,
not the decimals.

## §5 Verification: executable gates work, self-review does not

- **Self-correction without ground truth is capability-negative.** Huang et al. (ICLR 2024): GPT-4 on GSM8K degrades
  95.5 → 91.5 → 89.0 across correction rounds. Reflection loops pay only where an oracle stops them.
- **A completion gate is the mechanism that survived ablation.** Mingbird's leave-one-mechanism-out: finish gate
  −0.098, verification feedback −0.048, anti-loop −0.015, flat prefill −0.003 — directional only, single trials, and
  the authors say so. The one batch-matched comparison, full stack vs text-reread alone, gives the executable
  completion guards **+0.10 paired** across three replications (+0.096, +0.133, +0.056). `02` §3 has the mechanism.
- **Perplexity's self-verification is triggered by hooks, not by the model's judgment about whether it feels done**:
  "a set of hooks that monitor the health of the trajectory and request self-verification when something goes wrong."
  **[vendor claim]**, but it is a mechanism statement, not a results claim.

The distinction that matters: *re-reading the task and checking the artifact* is verification. *Asking the model
whether its answer is good* is not, and is measurably harmful.

## §6 Reasoning effort and other knobs are not monotonic

The Holistic Agent Leaderboard (HAL) ran 21,730 rollouts across 9 models and 9 benchmarks and found **harness-knob
effects non-monotonic, with higher reasoning settings reducing accuracy in 21 of 36 runs**. **[measured]** —
arXiv:2510.11977

Qwen's own model card says the same thing from the other side: for multi-turn agentic tasks, *lowering*
`reasoning_effort` "does not always reduce overall task completion time" and may cause "insufficient analysis, more
failures, retries, and higher total latency and token use". **[documented]** (`03` §3)

So: neither "more thinking" nor "less thinking" is the local default. It is per-model, per-task, and must be measured.
Perplexity ran their entire 27B comparison at `medium`, not at the model's default `xhigh` — and did not publish an
ablation, so we do not know whether that was the right call.

## §7 What this evidence cannot carry

- No source holds everything but the prompt fixed on a 27B. §1 changes prompt, tools, skills, sandbox and orchestration
  at once; §3 changes prompts, tools, budgets and effort and says so.
- The harness-adaptation paper (`02` §5) uses models with 3–8B active parameters — a tier below a dense 27B. Its
  *direction* (harness helps most on repetitive workflows and on the stronger model of the pair) is worth carrying; its
  percentages are not transferable.
- Mingbird (`02` §3) proves a 2B can be dragged up a lot by harness code. That is the least relevant result here. Its
  one transferable finding is which *class* of mechanism paid off, which is why it is in this document at all.
- Everything from the vendors — Qwen's own TB number, Perplexity's 85.4%, LM Studio's 82% auto-approval, Mingbird's
  LRAB — is the vendor's own eval of the vendor's own thing.
