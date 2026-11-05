# What is actually measured when an agent writes and later reuses its own procedures: Voyager's skill library and curriculum, Reflexion's self-reflection memory, SICA (Self-Improving Coding Agent), ACE / Agentic Context Engineering playbooks, and any 2026 follow-up. For each give the mechanism that made the artifact get reused, the number with its benchmark, and the failure the authors admit.

## Answer
Every one of these papers measures the same quantity: the **paired pass-rate delta of putting the artifact back into the prompt/index versus not** — never "did the model write it", only "did having it change the next episode's score". The mechanism that made the artifact get reused was never the instruction to write it; it was a read path the turn could not skip — Voyager retrieves top-5 skills by embedding on every task, Reflexion concatenates the buffer into the next trial, SICA's meta-agent must go through an archive-explorer sub-agent, ACE's bullets carry IDs plus helpful/harmful counters that the Generator is asked to mark. And the 2026 measurements overturn the 2023 story: model-authored skills land **below** the no-skill baseline (−8.1 to −11.5pp), and library growth costs up to 21pp because of retrieval/selection error, not context length.

## Claims

### Voyager (arXiv 2305.16291, May 2023)
- Voyager's headline numbers are exploration deltas, not reuse deltas. [1] — "It obtains 3.3x more unique items, travels 2.3x longer distances, and unlocks key tech tree milestones up to 15.3x faster than prior SOTA." — direct
- The write is gated on external verification, not on the model's judgement that it learned something. [1] — "we commit the program to the skill library (...) and query the automatic curriculum for the next milestone", reached only once "a self-verification module confirms the task completion" — direct
- The read path is automatic and unconditional: description-embedding index, top-5 injected into the code-gen prompt. [1] — "we perform querying to identify the top-5 relevant skills" — direct
- Ablation: removing the library causes the curve to flatten, i.e. the library is load-bearing for compounding. [1] — "Voyager w/o skill library exhibits a tendency to plateau in the later stages." — direct
- Quantified reuse effect (zero-shot generalization, new world, Table 2, prompting iterations to solve, fewer is better): Voyager 19/18/21/18 vs Voyager-without-skill-library 36/30/27/26 across Diamond Pickaxe / Golden Sword / Lava Bucket / Compass. [1] — "Numbers are prompting iterations averaged over three trials." — partial (numbers read off Table 2; the paper does not phrase this as a "reuse" number)
- Admitted failure 1: the curriculum hallucinates tasks that cannot be done. [1] — "The automatic curriculum occasionally proposes unachievable tasks. For example, it may ask the agent to craft a 'copper sword'" — direct
- Admitted failure 2: skills can simply fail to be produced, and self-verification is unreliable. [1] — "there are still cases where the agent gets stuck and fails to generate the correct skill" — direct
- Admitted failure 3: cost. [1] — "The GPT-4 API incurs significant costs. It is 15x more expensive than GPT-3.5." — direct

### Reflexion (arXiv 2303.11366, Mar 2023, v4 Oct 2023)
- Headline number is HumanEval pass@1 with self-generated tests. [2] — "Reflexion achieves a 91% pass@1 accuracy on the HumanEval coding benchmark, surpassing the previous state-of-the-art GPT-4 that achieves 80%" — direct
- Cross-benchmark deltas on 2023-era toy/small benchmarks. [2] — "over strong baselines by 22% in AlfWorld, 20% in HotPotQA, and 11% on HumanEval" — direct
- The critical ablation isolates reflection *text* from mere trajectory memory — this is the closest thing in the literature to "does the written artifact matter, or just the retry?" [2] — "self-reflection improves learning by an 8% absolute boost over the episodic memory learning advantage" — direct
- The reuse mechanism is a small fixed-size buffer concatenated into the next trial's prompt, not retrieval — and the size cap is stated as a prompt-window concession. [2] — "To avoid very long prompt windows that may exceed the maximum limit, we truncate the agent's memory to the last 3 self-reflections (experiences)" — direct
- Admitted failure 1: memory is a sliding window of 1-3 items because of context limits. [2] — "we limit long-term memory to a sliding window with maximum capacity" — direct
- Admitted failure 2: it dies on tasks needing exploration, and the reflections degrade to nothing useful. [2] — "the agent does not generate helpful, intuitive self-reflections after failed attempts" (WebShop, terminated after 4 trials) — direct
- Admitted failure 3: local minima / no formal guarantee. [2] — "it may still succumb to non-optimal local minima solutions" — direct

### SICA — A Self-Improving Coding Agent (arXiv 2504.15228, Apr 2025)
- Headline: self-editing the agent's own code lifts a real SWE benchmark, not a toy. [3] — "We find performance gains from 17% to 53% on a random subset of SWE Bench Verified" — direct
- Per-iteration table (Table 1, 15 iterations, Sonnet 3.5 v2 + o3-mini reasoning agent): SWE-Bench Verified 50-question subset 0.17 at iter 0 → 0.51 at iter 15 (peak 0.47 at iter 9, and it dips to 0.14 at iter 1); LiveCodeBench 50q 0.65 → 0.71; synthetic file-edit 0.82 → 0.91; symbol-locate 0.35 → 0.40; per-problem cost $1.91 → $1.70. [3] — "Table 1: Performance per iteration: the benchmark accuracy numbers correspond to a synthetic file editing benchmark and symbol location (codebase navigation) benchmark, SWE-Bench Verified, and LiveCodeBench" — partial (values transcribed from Table 1; the abstract's "53%" does not appear in the table, which ends at 0.51)
- The reuse mechanism is not retrieval but *selection plus a mandatory read*: the best-scoring past agent becomes the meta-agent that edits the current one. [3] — "SICA takes the best performing agent from the archive up until this point as the meta-agent" — direct
- The read is delegated to a dedicated `archive_explorer` sub-agent with comparison tools, whose summary lands in the main context. [3] — "a 'archive analysis' tool, which facilitates extracting high-level summary statistics about each agent iteration in the archive" — direct
- Admitted failure 1: the model cannot reliably generate good improvement ideas. [3] — "One key difficulty was getting the LLM-based agent to autonomously come up with truely novel, innovative, feasible and interesting modification ideas" — direct
- Admitted failure 2: path dependency — the archive of failures does not prevent the model repeating the same theme. [3] — "the initial feature ideas would often heavily influence later feature ideas as variations on the same theme" — direct
- Admitted failure 3: much of the measured gain is speed/cost, which the benchmark does not really measure. [3] — "much of the initial improvement we report arises from features speeding up file editing and agent cost" — direct
- Cost of the whole self-improvement run. [3] — "The API cost of the 15 iteration run was approximately $7,000." — direct

### ACE / Agentic Context Engineering (arXiv 2510.04618; ICLR 2026; v3 Mar 2026)
- Headline: paired with/without-playbook delta on agent and finance benchmarks. [4] — "+10.6% on agents and +8.6% on finance, while significantly reducing adaptation latency and rollout cost" — direct
- AppWorld, DeepSeek-V3.1, average over test-normal/test-challenge: ReAct 42.4 → ReAct+ACE offline 59.4 (+17.0), online+offline-warmup 59.5 (+17.1). [4] — "It boosts accuracy on the AppWorld benchmark by up to 17.1%" — partial (per-cell numbers from Table 1)
- Why the artifact survives: itemized bullets with stable IDs and *use counters*, not a prose summary. [4] — "metadata, including a unique identifier and counters tracking how often it was marked helpful or harmful" — direct
- The reuse signal is explicit per-use feedback: the Generator must flag which bullets helped or misled. [4] — "the Generator highlights which bullets were useful or misleading, providing feedback that guides the Reflector" — direct
- The key anti-collapse mechanism is that merging is done by non-LLM deterministic logic, so the model never rewrites the whole playbook. [4] — "The Curator then synthesizes these lessons into compact delta entries, which are merged deterministically into the existing context by lightweight, non-LLM logic" — direct
- Measured failure that motivated it (context collapse, AppWorld step 60→61). [4] — "it collapsed to just 122 tokens, with accuracy dropping to 57.1—worse than the baseline accuracy of 63.7 without adaptation" — direct
- Admitted failure 1: it needs a strong Reflector; weak/noisy reflection poisons the playbook. [4] — "A limitation of ACE is its reliance on a reasonably strong Reflector" — direct
- Admitted failure 2: many tasks do not need a rich playbook at all. [4] — "not all applications require rich or detailed contexts" — direct
- Admitted failure 3: without reliable feedback (e.g. no GT labels on finance) adaptation can degrade below baseline. [4] — "both ACE and other adaptive methods such as Dynamic Cheatsheet may degrade" — direct

### 2026 follow-ups — these are the numbers that matter for harness design
- SkillsBench (87 tasks, 8 domains, 18 model-harness configs, paired design): curated skills work. [5] — "Curated Skills raise the average pass rate from 33.9% to 50.5% (+16.6 percentage points; 25.5% normalized gain)" — direct
- The same benchmark's self-generated arm is the strongest negative result in this literature: the agent authors skill packs with `skill-creator`, then uses them. [5] — "Self-generated Skills land below the no-Skills baseline on all three configurations (-8.1 pp on Claude Code + Opus 4.7, -11.3 pp on Codex + GPT-5.5, -11.5 pp on Gemini CLI + Gemini 3.1 Pro)" — direct
- While curated skills on those same three configs add +18.2 to +24.8 pp. [5] — "while curated Skills add +18.2 to +24.8 pp on the same configurations" — direct
- Why self-written skills fail — three named mechanisms, all about the reuse path not the write path. [5] — "generated packs the solver never discovers, creator-side authoring that displaces solver work, and confidently wrong pack content" — direct
- Granularity finding: focus beats completeness. [5] — "Focused Skills with at most three modules outperform larger or exhaustive bundles" — direct
- And: prose is worthless, specifics are not. [5] — "Comprehensive prose is essentially flat while focused documentation yields larger aggregate lift (+0.7 pp vs. +19.0/+21.5 pp)" — direct
- Library scaling hurts, and the cause is selection. [6] — "performance degrades as libraries grow -- by up to 21% when scaling from a small set of helpful skills to a 202-skill library" — direct
- The decomposition matters for design: it is mis-selection, not context bloat. [6] — "the context overhead effect remains small and indistinguishable from zero" — direct
- Library Drift (FAGEN@ICML 2026 workshop) restates the self-authored result and names the lifecycle failure. [7] — "LLM-authored skills deliver +0.0pp gain while human-curated ones deliver +16.2pp" — direct
- Its mechanism claim. [7] — "unbounded skill accumulation without outcome-driven lifecycle management causes retrieval degradation, false-positive injections, and performance stagnation" — direct
- Its fix, and the size of the fix (MBPP+ hard-100, 100 rounds). [7] — "lifts held-out pass@1 from a 0.258 baseline to a late-window mean of 0.584 (rolling gain +0.328)" — direct
- Sentry (Oct 2026) is the sharpest anti-playbook result: a playbook kept in context is worse than the same lessons fetched on demand. [8] — "kept in the agent's context, they misfire when their failure is absent, and removing them from an evolving playbook improves performance" — direct
- Controlled confirmation — existence in the prompt actively hurts. [8] — "exposing the full playbook to the agent lowers performance even when relevant lessons remain available on demand" — direct
- Margin of the conditional-retrieval design over context-evolution baselines. [8] — "37% on average" vs "the strongest runtime-intervention baseline" — partial (the 39% figure is over the stronger context-evolution baseline on 2 of the benchmarks)
- EvoHunt (Jun 2026) is the optimistic counter-case for automated playbook *acquisition* in a domain with a hard verifier. [9] — "playbook evolution raises end-to-end exploits for Codex/GPT5.4-xhigh 6x, from 1.1% to 6.2%" — direct
- Its transfer result, i.e. the artifact is reusable by a different model/harness. [9] — "Qwen3.6-27B improves from 2.4% to 6.5%, Qwen3.6-35B-A3B from 1.1% to 4.6%" — direct

### Cross-cutting (researcher synthesis)
- In all four original papers the artifact only gets reused because something in the loop indexes it and injects it without asking: embeddings top-5 (Voyager), a 1-3 item appended buffer (Reflexion), best-agent-in-archive selection (SICA), ID-addressed bullets the Generator must mark (ACE). None of them relies on the model choosing to consult its own notes. [1][2][3][4] — inferred
- The measured quantity in every case is "score with artifact minus score without", which is why all four papers can report a gain while their own ablations show the *writing act* is not what did the work. Reflexion's 8pp (reflection vs raw trajectory) and SkillsBench's −8pp (self-authored vs nothing) are the two cleanest separations of write-path from read-path. [2][5] — inferred
- 2026 evidence splits by verification: playbooks evolve and transfer when a deterministic verifier scores each update (EvoHunt exploits, SICA unit tests, ACE execution feedback, SkillsBench pytest), and go negative or flat when there is no such gate (SkillsBench self-generated, Sentry in-context playbook, Library Drift unmanaged accumulation). [5][7][8][9] — inferred

## Sources
[1] Voyager: An Open-Ended Embodied Agent with Large Language Models — https://arxiv.org/abs/2305.16291 — accessed 2026-11-05 — paper (v1 2023-05-25; v2 2023-10-19)
[2] Reflexion: Language Agents with Verbal Reinforcement Learning — https://arxiv.org/abs/2303.11366 — accessed 2026-11-05 — paper (v1 2023-03-20; v4 2023-10-10)
[3] A Self-Improving Coding Agent (SICA) — https://arxiv.org/abs/2504.15228 — accessed 2026-11-05 — paper (v2 2025-05-16; NeurIPS 2025 preprint)
[4] Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models (ACE) — https://arxiv.org/abs/2510.04618 — accessed 2026-11-05 — paper (v1 2025-10-06; v3 2026-03-29; ICLR 2026)
[5] SkillsBench: Benchmarking How Well Agent Skills Work Across Diverse Tasks — https://arxiv.org/abs/2602.12670 — accessed 2026-11-05 — paper (v4, 2026-02-13)
[6] More Skills, Worse Agents? Skill Shadowing Degrades Performance When Expanding Skill Libraries — https://arxiv.org/abs/2605.24050 — accessed 2026-11-05 — paper (v2, 2026-05-21)
[7] Library Drift: Diagnosing and Fixing a Silent Failure Mode in Self-Evolving LLM Skill Libraries — https://arxiv.org/abs/2605.19576 — accessed 2026-11-05 — paper (v3, 2026-05-19; FAGEN@ICML 2026 workshop)
[8] Sentry: Learning to Recover from LLM Agent Failures at Test Time — https://arxiv.org/abs/2610.02994 — accessed 2026-11-05 — paper (2026-10-02)
[9] Transferable Self-Evolving Playbooks for Agentic Security Auditing (EvoHunt) — https://arxiv.org/abs/2606.16420 — accessed 2026-11-05 — paper (2026-06-15)

Rejected/deprioritized: arXiv 2611.04180 (Validation-Gated ML Pipeline Synthesis) — adjacent "self-evolving skills" claim, ML-AutoML domain, no reuse ablation useful here. arXiv 2605.10990 (Skill Drift Is Contract Violation) — good precision numbers but it is maintenance/CI tooling, not a reuse measurement. arXiv 2608.06196 / 2607.10113 / 2605.13716 — surveys and retrieval-comparison papers; useful later for retrieval design, not for this section's numbers. Blog summaries of Voyager/Reflexion: skipped by instruction.

## Conflicts
- **Self-authored skills: zero vs negative.** Library Drift cites SkillsBench as "+0.0pp gain" for LLM-authored vs "+16.2pp" for human-curated [7], but the current SkillsBench v4 aggregate reports strictly negative self-generated deltas (−8.1 / −11.3 / −11.5 pp) and +16.6 pp for curated [5]. Most likely a version/condition difference (Library Drift cites an earlier aggregate; SkillsBench v4 evaluates the self-generated arm on only the three "dedicated-harness" configurations). Treat the direction as agreed and the magnitude as version-dependent. SkillsBench itself hedges: "its deficit mixes content quality with skill-discovery and creator/solver interference effects" [5].
- **Playbook in context vs on demand.** ACE [4] measures large gains from keeping the evolving playbook in context; Sentry [8] measures that same choice as harmful and reports gains from never letting the full playbook into context. ACE's own context-collapse case study [4] is an admission in Sentry's direction. These are compatible only if the mechanism is update discipline plus conditional exposure, not in-context presence.
- **Does library growth hurt via selection or via context length?** [6] find context overhead "indistinguishable from zero" and blames selection. ACE [4] attributes collapse to context/rewrite loss. Different artifacts (skill library vs evolving playbook) — not a direct contradiction, but the two are often cited as if interchangeable.

## Unanswered
- **No paper measures write-rate or read-rate as an outcome.** Nothing here reports "what fraction of the agent's own artifacts were later retrieved and used", except SkillsBench's Skill Invocation Rate for curated skills [5]. Every number in this section is a downstream score delta. If the brief needs "does the model actually consult its notes", that instrument does not exist in these papers.
- **Voyager has no direct "with vs without skill library" on the same exploration task** — only the ablation curve in Fig. 9 and the zero-shot Table 2 iteration counts [1]. Anyone quoting "3.3x / 15.3x" as a skill-library effect is over-reading; those are Voyager-vs-baselines, not library-vs-no-library.
- **Reflexion's numbers are 2023 toy benchmarks** (AlfWorld 134 tasks, GPT-3; HumanEval with self-generated tests). No 2025-2026 replication of the 91% figure found; do not present as current.
- **SICA's figure is noisy and unpaired.** Table 1 shows SWE-Bv dropping to 0.14 at iteration 1 and 0.17 at iteration 2 before recovering; the abstract's "17% to 53%" does not match Table 1's iteration-15 value of 0.51 [3]. Unresolved which number is intended.
- Did not establish: whether "skill shadowing" [6] is fixed by better descriptions (Voyager's index is description-embedding based) or only by routing metadata; and whether EvoHunt's positive acquisition result [9] is down to the hard verifier, the security domain, or the three-agent evaluator/reviser loop.
- Looked for but did not find: a 2026 paper doing a paired write/read ablation on an agent's *own* harness prompt (as opposed to a skill library or playbook). Nearest is Sentry [8].

## Queries
- (web_search unavailable — Exa provider returned `API error 403` on all four attempts; all retrieval done via curl against arxiv.org, export.arxiv.org API, and arxiv.org/html)
- curl https://arxiv.org/abs/{2305.16291,2303.11366,2504.15228,2510.04618}
- curl https://arxiv.org/html/{same four} then strip tags → grepped for "limitation|fail|ablation"
- export.arxiv.org/api/query?search_query=abs:"skill library" AND abs:agent&sortBy=submittedDate
- export.arxiv.org/api/query?search_query=ti:"skill library"&sortBy=submittedDate (surfaced 2605.24050, 2605.19576, 2605.10990, 2608.06196, 2607.10113)
- export.arxiv.org/api/query?search_query=ti:SkillsBench
- export.arxiv.org/api/query?search_query=abs:"evolving playbook" (surfaced 2610.02994 Sentry, 2606.16420 EvoHunt)
- curl https://arxiv.org/abs/{2605.24050,2605.19576,2605.10990,2610.02994,2606.16420}
- curl https://arxiv.org/html/2602.12670 (SkillsBench full text, for the self-generated-skills arm)
