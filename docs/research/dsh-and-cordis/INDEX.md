# DeepSeek Harness and the superagent — what the plugin model buys, and what mason should take

Goal: understand how `dsh` (DeepSeek Harness) and `dsh-superagent` are built — the Cordis plugin model, the harness
composition, the domain design, the prompts — and decide which of it makes mason more composable, more expandable and
easier to contribute to. Asked 2026-11-03; mason's goal is different (one deployment, one bot), so the answer separates
transfer from non-transfer.

**Sources**: two repositories cloned and read at their current `main`/`master` — `deepseek-ai/deepseek-harness`
(379 packages, ~143k lines, framework vendored and patched 20 times) and `deepseek-ai/dsh-superagent-prototype`
(~15.2k lines, 9 design docs, 13 prompt files, 2 skills) — plus the design article *Exploring Super-agent Design*
(DeepSeek Harness team, 2026-11-01) and the Cordis paper `arXiv:2608.25512` (2026-08-26). Everything cited to a file and
line was read in the clone; the two prose sources are marked `[article]` / `[paper]` where they are the only evidence.

## Read this first

If you read one file, read [`05-what-mason-can-take.md`](05-what-mason-can-take.md): eight transfers ranked by value over
cost, a table of what deliberately does not transfer and why, and the three things worth doing next. If you read two, add
[`04-the-superagent-prompts.md`](04-the-superagent-prompts.md) — the prompting is the part that is cheap to copy and the
part that is hardest to derive from first principles.

## The files

| File | What it covers |
|---|---|
| [01-cordis-the-plugin-model.md](01-cordis-the-plugin-model.md) | The framework under dsh, from the vendored source: five primitives, dependency-driven activation, five dispatch modes, composition layers, the authoring rules the repo enforces, and the costs it admits (concurrent disposers, silent PENDING, patch misses as warnings, type safety by declaration merging only) |
| [02-how-dsh-assembles-a-harness.md](02-how-dsh-assembles-a-harness.md) | Profiles, bundles and patch layers; the six core packages; the turn sequence; the tool pipeline's four hooks; prompt assembly; the "where new behavior goes" table; and the documentation machinery that makes a 143k-line repo contributable |
| [03-the-superagent-as-a-bundle.md](03-the-superagent-as-a-bundle.md) | The application: ten domain concepts and the rule each keeps, the authorization ladder (gate → strength → Mandate → revalidation), the stage table and worker slots, the idempotency key per hop, the panel's three questions, and what it costs to ship all that as three YAML rows and two presets |
| [04-the-superagent-prompts.md](04-the-superagent-prompts.md) | The prompt inventory, verbatim; assembly order and why the generated section is last; the behaviour rules as written; which rule has a gate behind it and which has only prose; team overrides and versions; skills; the three techniques that look load-bearing |
| [05-what-mason-can-take.md](05-what-mason-can-take.md) | The transfer analysis: what mason already does better, eight ranked transfers with cost and risk, a non-transfer table, and the next three steps |

## Cross-cutting conclusions

1. **The composability is bought with a runtime, and the runtime has a price.** Cordis means any capability can be
   declared and replaced, and it also means disposers that run concurrently, a PENDING state that is indistinguishable
   from a typo, patches whose misses are log lines, and type safety that exists only as long as an `import type {}` line
   does. dsh pays it because 379 packages and a plugin marketplace need it. mason does not, and should not.
2. **What "extensible" actually bought them is a split, not a framework.** The superagent's composition is data (three
   rows, two presets) and its domain is code (~15k lines). Nobody forked the harness to build an application on it. That
   split — composition as data at the edge, behaviour as code behind it — is the transferable idea, and mason already has
   half of it: `Extension` with a per-conversation selection, plus connectors as the out-of-process edge.
3. **The contribution win comes from documentation machinery, not from architecture.** A tier table that gives every fact
   one home, word budgets enforced by a script, generated catalogs that cannot go stale, cookbook procedures with verify
   steps, and real-composition tests. All cheap; all directly applicable at mason's size.
4. **"Model-visible means logged" is the invariant worth stealing.** dsh derives every model request from an append-only
   session log, and everything else (fork, resume, transcript, telemetry) derives from the same commits. mason already
   derives its wire view from the durable log; it does not yet treat the *prompt and tool schemas* as part of that
   surface.
5. **Prompt discipline is a budget plus an inventory plus a gate per rule.** dsh counts characters including tool JSON,
   enumerates every model-visible string in one test, and makes sure the rules that matter have code behind them — with
   one admitted exception (the review-round cap) that is prose only. The rules themselves (silence by default, one
   question in a structured field, stop for impact) are written for a multi-person team; for one person the *structure*
   transfers and the *volume* does not.
6. **The always-on parts mason already has are the ones dsh's design paper lists as hard.** Full-duplex interaction,
   compute/state separation, execution environments detached from the loop, credentials that never enter the context:
   mason has all four (`docs/SPEC.md` §4, `pi-env`, the connector protocol, `env -i`). What mason lacks is the two-level
   split and the watchdog — and the article's own numbers say the split trades 4× the cache reads for a shorter tail, which
   is a bad trade until a turn can outlive the reader.
7. **The honest caveat.** `dsh-superagent` is a research prototype, "not production-ready software", much of it written by
   coding agents; its measurements are synthetic (~300 generated messages, coding simulated by a sleep) and measure
   scheduling, not work quality. It is a good design to read and a bad thing to assume works.

## What this run changed

Nothing yet — this is a research run, and the proposals in [`05`](05-what-mason-can-take.md) §4 are ranked suggestions,
not decisions. The three that would change the repository:

1. `docs/ARCHITECTURE.md` with a where-new-behaviour-goes table (docs only).
2. `npm run gen:surface` — routes × grants, extensions × tools × sections — with `--check` in CI.
3. `docs/AGENTS.md` tier table plus a per-file word budget script.

If any of them is taken, the ADR that records why belongs in `docs/adr/` and this page should say what it decided, in the
manner of [`../README.md`](../README.md).

## Working material

The raw note sets the files above were written from — with per-claim citations, the discarded sources, and the
verification gaps — are in `.scratch/dsh-research/` (gitignored): `01-raw-cordis.md`, `03-raw-superagent.md`,
`04-raw-prompting.md`. There is no `02` raw set: the reader delegated to survey the harness architecture was terminated
mid-run and wrote nothing, so [`02`](02-how-dsh-assembles-a-harness.md) was written directly from
`docs/architecture.md`, `docs/subsystems/`, `docs/AGENTS.md`, `packages/AGENTS.md`, the bundle patches and the cookbook.
That is why `02` cites documents rather than source lines: the documents in this repository are the authority for the
composition, and the source is cited only where a number or a mechanism needed checking.

The clones the notes cite are throwaway copies in `/tmp/dsh-research/`; nothing in this directory depends on them still
existing, because every claim cites a path inside the repositories themselves.

## Versions read

`deepseek-harness` at `master` (vendored Cordis 4.0.0-rc.11 plus 20 logged local patches; `docs/` carries both English and
Chinese for every page). `dsh-superagent-prototype` at `main`, version `0.1.0`, `engines.dsh: ^0.2.1-alpha.2`. Both are
alpha: expect the file paths to move, and treat a line citation as a pointer into a revision rather than into a promise.
