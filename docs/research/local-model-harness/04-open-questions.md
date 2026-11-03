# 4. What is not settled, and what it would cost to settle

## §1 Decisions the evidence ranks clearly enough to act on

Ranked by how much evidence is behind them, strongest first. "Act on" means: if you get this wrong, the literature says
you lose more than the choice is worth.

1. **Keep the static prefill small and the core tool set small; defer the rest.** Four independent harnesses do it
   (`02` §7), tool-count degradation is the most reproduced finding in this space (`02` §6), and on Qwen 3.8 the tool
   list is literally system-message prefill (`03` §4). Highest confidence in this document.
2. **Own the loop in code.** The model proposes; deterministic code decides what runs, what is shown, when to stop, and
   whether the thing is finished. Perplexity's sentence — "the orchestrator is deterministic harness code, not an LLM" —
   is the consensus position.
3. **Gate completion on the artifact, not on the model's opinion.** Executable guards: +0.10 paired. Self-review without
   an oracle: negative. This is the one mechanism that survived ablation in the only paper that ran one.
4. **Never parse one tool-call dialect strictly.** Convert, or drop calls silently. Qwen 3.8's is XML; a harness written
   for JSON fails closed in the worst way, which is silently.
5. **Under 3 points is noise.** Terminal-Bench's own intervals are ±1.2–1.7. Any claim that harness A beats harness B by
   2 points is a claim about a coin.

## §2 Where the evidence runs out

- **No controlled harness comparison exists for a 27B with only the prompt varied.** Perplexity's run (`01` §1) changes
  prompt, tools, skills, sandbox and orchestration together; Terminal-Bench's rows (`01` §3) change prompt, tools,
  budgets and effort. The magnitude per mechanism is unknown. Everything in §1 is directional.
- **Thinking preservation has no published ablation.** Qwen recommends on; the mechanism costs context linearly in turn
  count; nobody published the delta on an agent loop. This is a coin flip dressed as a default.
- **Reasoning effort has no ablation on this model.** Perplexity used `medium` throughout and did not report what
  `xhigh` or `low` would have done. HAL says the direction is not monotonic on other models.
- **Quantization has no agentic benchmark at 27B.** The 1.4-point figure is an 8B on tool-call syntax. Long-chain
  degradation is asserted and unmeasured.
- **Nobody has published a number for "number of subagents on one GPU."** The parallel-slot facts are documented
  (`03` §5); the performance curve is not.

## §3 The cheap measurements, in the order I would trust them

These are experiments, not a plan. Each is small enough to run on the hardware already sitting there.

1. **Same scenario set, three prompts, one model.** `evals/run.ts` already runs the production prompt registry against
   `llama-server/Qwen3.8-27B` with `--repeat`. What it cannot currently answer is "was that the prompt or the model":
   the six scenarios pin behaviour, not prompt variants. A variant dimension — one prompt file, N edits, same
   scenarios — is the highest-value thing missing, because it is the only way to get a controlled number out of a
   single machine.
2. **Static prefill, counted.** Tokens of system prompt plus tool schemas, per model, printed by a test. Mingbird pins
   this at 797 tokens and fails CI on growth; that discipline is the cheapest guard against the failure mode everyone
   agrees on. Without a count, "minimal prompt" is a vibe that erodes one useful sentence at a time.
3. **Thinking on vs preserved vs off**, on the same trajectory: LKWB-style multi-step scenario, three runs each, measure
   wall time and pass. This is the decision with the most context budget behind it and the least evidence.
4. **Q4_K_M vs Q6_K** on the same scenarios. Two runs, and it either shows up as schema violations or it does not.
5. **Children on one machine, 1 vs 2 vs 4**, wall time per completed task. Answers whether fan-out is a feature or a
   queue.

Each of these needs three things the repo does not currently have for the local case: a wall-clock number per turn (not
tokens), a pass/fail that is about the artifact rather than the message, and a repeat count high enough to see past the
noise the Mingbird authors measured — same-night replications moved their arm means by 0.069.

## §4 The questions that are specific to a *local* harness, and that no source answers

If the local model is going to be a subagent rather than the whole agent, the evidence says less and the questions
change shape:

- **Is a subagent the right unit at all?** Every escalation number published is about *advisor* calls — one question,
  text back, no tool authority (`02` §1). A subagent with its own tool loop and its own context is a different object,
  and the closest published result is the multi-turn wall: coherence is the axis where 27B-class models are furthest
  from frontier (`01` §4). A local child is most defensible where its whole job is one bounded artifact with a check at
  the end.
- **What does the parent hand it?** A local child that has to reconstruct intent from a shared transcript pays the
  context cost twice — once in the parent, once in the child — on a machine where context is the bottleneck. The
  opposite design (a self-contained brief, no shared history) is what the harness-adaptation literature's "plan
  skeleton plus reduced tool set" is doing (`02` §5), but nobody has measured it for subagents.
- **Who verifies?** If the parent is also local, the reviewer is the same model with the same blind spots — the
  self-correction result applies (`01` §5). If the parent is frontier, the local child's output can be checked cheaply
  and the split is the FrugalGPT cascade. That asymmetry, not raw capability, is probably the argument for a local
  subagent tier.
- **Does the harness need to be *different*, or just *smaller*?** The honest summary of this whole body of work: the
  local harnesses differ from the general ones less in ideas than in budget discipline — fewer tools, shorter prompt,
  more deterministic code, a gate at the end. The one place they differ in kind is turning MCP servers into CLI tools
  (`02` §1). Whether that is a real structural insight or a symptom of a small prefill budget is untested.

## §5 One warning about the framing

"The harness is not the model. It is worth roughly one model generation, which is a great deal, and it is not more than
that." That is the best-calibrated sentence I found in any of these sources, and it cuts against spending a quarter
tuning a prompt. The same evidence says the boundary moves twice a year: `01` §4's synthesis puts the laptop ceiling at
Sonnet-class and roughly twelve months behind frontier, with METR horizons doubling every 105 to 210 days. A harness
built to compensate for a specific 27B's specific blind spots is a harness with an expiry date, and the maintenance bill
for model swappability is real — "every swap re-tunes prompt formats, tool-call dialects, context budgets and retry
behavior."

The version of the work that outlives the model is the one in §1: small budget, code-owned loop, executable gates,
tolerant parsing. None of those are about Qwen 3.8 27B.
