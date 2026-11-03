# Research: a harness for a 27B-class local model

Researched 2026-11-03. Scope: models at **Qwen 3.8 27B level** — dense 27B or ~30B MoE, 20–35B total, quantized, on one
machine — against a frontier model of the same day (Claude Opus 5 / 5.5 class). Everything below 10B is out of scope
unless it is the only published measurement of a mechanism.

The question: what changes in a harness and its system prompt when the model behind it is a local 27B rather than a
frontier model, and what is measured rather than repeated?

Evidence labels: **[documented]** = stated by the project's own docs, model card or source; **[measured]** = a third
party published numbers with a method; **[vendor claim]** = marketing or a blog's own headline; **[inference]** = my
reasoning from the above, stated by no source.

## Files

| File | What is in it |
|---|---|
| [`01-evidence.md`](01-evidence.md) | How much a harness is worth at the 27B class, measured: same-model/same-benchmark spreads, the harness-as-one-model-generation rule, and where the numbers are weak |
| [`02-harnesses.md`](02-harnesses.md) | What four harnesses actually built for local models do — Perplexity Computer, LM Studio Bionic, Mingbird, Pi/Hermes — plus the automated harness-adaptation literature |
| [`03-qwen38-27b.md`](03-qwen38-27b.md) | The target model on its own terms: context, thinking, sampling, the tool-call dialect, the hybrid-attention cache cost, and the warnings Qwen wrote down |
| [`04-open-questions.md`](04-open-questions.md) | What none of this answers, ranked by how much a wrong guess costs |

## The findings that matter

1. **The same 27B model spans 5 to 16 points across harnesses, on one machine, with only the harness changed.**
   Perplexity ran Qwen 3.8 27B through their own harness, Pi and Hermes on one DGX Spark: 82.6 / 77.6 / 74.0 on their
   knowledge-work bench, and 66.7 / 50.2 / 43.9 on BrowseComp. Pi also burned 2.82M tokens on BrowseComp against 852k for
   theirs. (`01`, §1)

2. **Qwen's own numbers for this model were earned in Claude Code.** Terminal-Bench 2.1: 73.0 for Qwen 3.8 27B against
   78.2 for Opus 4.6 Max, in the same harness. In Perplexity's harness the same model scored 59.6. A cross-source
   comparison, so not a controlled result — but it points the same way: at 27B the harness is worth as much as the model.
   (`01`, §2)

3. **Harness spread is smaller at the frontier than at 27B, and it is not one-way.** Same model, two harnesses on
   Terminal-Bench 2.1: 2.8 to 8.1 points for frontier models. Nothing about "the vendor's own CLI wins" holds —
   Gemini 3 Pro scores 8.1 points *higher* in a generic harness. (`01`, §3)

4. **The harness is worth roughly one model generation, and no more.** A synthesis of the 2022–2026 evidence puts a
   competent harness at a 2–6x multiplier over a naive baseline, closing knowledge and single-turn tool syntax almost
   fully, and closing *nothing* on multi-turn coherence or long-horizon autonomy. (`01`, §4)

5. **Every local harness converges on the same four moves**: a small static prompt and a small core tool set;
   capabilities deferred to on-demand skills; deterministic code owning the loop while the model only proposes the next
   action; and a verification gate the model cannot wave through. (`02`, §1–§4)

6. **Tool and skill count is the most reproducible failure axis.** Selecting from 10 tools runs near 78%; from ~100,
   near 40%; from 741, 13.6% (speaker-reported, no published method). Retrieval shortlisting
takes 13.6% to 43.1% in a paper that does publish one. Expanding a skill library from a known-good
   set to 202 costs up to 21% pass rate, and the cause is wrong-skill selection, not the extra context. (`02`, §5)

7. **Verification must be executable, and self-review is not verification.** Adding a finish gate that re-reads the task
   and checks the artifact is the only mechanism that survived ablation (+0.10 paired). Model self-correction without
   ground truth is *negative* (95.5 → 89.0 on GSM8K across rounds). (`01`, §5; `02`, §3)

8. **Qwen 3.8 27B has three properties a generic harness will trip over**: thinking is on by default and preserved
   across turns, so the trajectory carries prior turns' reasoning tokens; the tool-call dialect is XML
   (`<function=…><parameter=…>`), not JSON; and its hybrid Gated-DeltaNet attention cannot rewind a partially cached
   prompt without checkpoints, so prefix-cache discipline is a correctness *and* a speed concern. (`03`, §2, §4, §5)

9. **Reasoning effort is not a dial that goes up.** In the Holistic Agent Leaderboard, higher reasoning settings reduced
   accuracy in 21 of 36 runs. Qwen's own card warns that *lowering* effort on multi-turn agentic tasks can increase
   total time and failures. Perplexity ran the whole comparison at `medium`. (`01`, §6; `03`, §3)

10. **On one machine, parallelism is a cost, not a win.** A local server shares one context across parallel slots, and
    forward passes from N children thrash each other's caches. The fan-out harness that is free on an API is a queue and
    a latency tax on a 27B. (`03`, §5; `04`, §3)

## What this does not settle

No source compares complete harnesses on a 27B with everything but the prompt held fixed. The two clean comparisons
(Perplexity's three-harness run, Terminal-Bench's same-model rows) each vary several things at once, and neither
publishes enough configuration to reproduce. The honest position: the direction is well established and the magnitude
per mechanism is not. `04` lists what would have to be measured to fix that.
