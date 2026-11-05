# Self-improvement — prompting a model to run its own harness (research run, 2026-11-05)

Goal: find out what makes a model actually use the self-improvement affordances it is given — writing a skill,
extending itself with a script, maintaining a `profile.md`, logging what it did, and reading those notes back
later — rather than answering from the context window and leaving the files untouched. The answer was wanted as
prompt text and mechanism, not as a framework to adopt.

**138 unique URLs**, nearly all primary: the Hermes Agent and OpenBot source at pinned commits, arXiv papers, and
the shipped docs of Claude Code, Codex and agentskills.io. The search backend returned 403 on most queries, so the
field-report base is one product's issue tracker plus a handful of Hacker News comments; the report says so itself
in "What remains open" and the audit repeats it.

## Read this first

If you read one file, read [`report.md`](report.md): the short answer, the mechanism table, the measured numbers,
the failure modes with quotes, the `profile.md` comparison, and fifteen lines of prompt text at the end. Then
[`audit.md`](audit.md), which re-fetched the load-bearing citations: 12 of 15 supported, 2 absent, 1 partial, plus
five must-fixes and a list of what it could not check.

## What this adds to what mason already has

[`../always-on-agents/04-hermes-agent.md`](../always-on-agents/04-hermes-agent.md) already records Hermes's memory
sizes (2,200 / 1,375 chars, frozen at session start), the `memory` tool's shape, `nudge_interval: 10`, and the
curator's states. This run is the prompt layer behind those numbers, and the parts mason has no note on:

- the shipped prompt lines verbatim, each classified as a mandatory read, an unconditional write, an offer, or a
  precedence rule (`findings/hermes-system-prompt.md`);
- where the write volume actually comes from: a background review fork that fires on tool iterations, re-runs on the
  same model, and is told "Be ACTIVE — most sessions produce at least one skill update"
  (`findings/hermes-skill-loop.md`);
- the refusals that keep the library from rotting, which are tool-schema guards and a no-model lifecycle, not
  sentences: a 60-character description cap, delete only with `absorbed_into`, read-before-write, 14 days to stale
  and 30 to archived;
- what the 2026 measurements say, which is the part that decides a design: self-authored skills land **below** the
  no-skill baseline (−8.1 to −11.5pp) while curated ones add +16.6pp, and library growth costs up to 21pp through
  selection rather than context length (`findings/papers-self-written-skills.md`);
- the read path with numbers: an index in the prompt plus a body on demand costs ~8.7K tokens against ~77K for
  loading everything, and raises accuracy 49% → 74% (`findings/retrieval-architecture.md`);
- what each shipped product does with the user-owned file, and the fact that none of them lets the model rewrite it
  unprompted (`findings/product-profile-patterns.md`);
- why an audit trail cannot be the agent's notebook, and which log an agent actually re-reads
  (`findings/action-logs.md`);
- what broke for people running this in 2026, with issue numbers (`findings/field-reports.md`).

## The files

| File | What it is | Sources |
|---|---|---|
| [`brief.md`](brief.md) | The question, restated with the scope edges: what a good answer had to contain, what was out of bounds, which sources count as authoritative. Written before the fan-out. | — |
| [`report.md`](report.md) | The deliverable: short answer, Hermes's shipped prompt, mechanism table with cost per mechanism, trigger wording as values versus conditions, measured numbers, failure modes, `profile.md` table, fifteen lines of prompt text, what remains open. | 138 |
| [`audit.md`](audit.md) | The citation audit: per-claim verdict with the supporting sentence, five must-fixes, and the sources it could not fetch. Read the "Could not check" list before quoting an issue number. | — |
| [`findings/`](findings/) | Eleven searcher notes, each with claims, verbatim quotes and numbered sources. `gap-1` to `gap-3` are the second round the coverage judge ordered. | — |

## The one finding worth carrying

**A write is only as durable as the read path that announces it.** Everywhere adoption happens in this material, the
write is fired by something the model cannot skip (a counter that spawns a review pass, a schema that refuses a
malformed write, a scheduled transition with no model in it) and the read is fired by text injected at turn start.
Skills the agent wrote that no harness index announced were never listed, read or mentioned in 10 of 12 audited
trajectories. "The model may call it" is the design smell.

## What is still open

- **Nobody has measured whether these prompts get followed.** Hermes ships no adoption metric; the one documented
  prompt rewrite there was forced by a provider content filter, not by a number. The only read-rate instrument in
  the corpus covers curated skills, not an agent's own notes.
- Whether a read-rate predicts a write-rate. Supported by mechanism, unmeasured as a correlation.
- Whether a self-written skill has ever beaten an explicit instruction in the same turn. Every report found is
  store-versus-store or memory-versus-earlier-preference; the risk is real but inferred, not observed.
- The sabotage number in the trigger report (`1.00` → `0.56`) is still attached to a page the audit could not
  confirm contains it. Treat it as unverified until someone opens the link.
