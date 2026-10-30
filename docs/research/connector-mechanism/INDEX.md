# Which mechanism should let a mason connector add code to mason?

Goal: Denis finds the connector model limiting — an integration is a config entry plus a container that speaks MCP and
posts signed events, and ADR-0003 forbids per-connector code in `src/` — and wants connectors to work more like pi
extensions: a thing that adds to the codebase. This run finds the mechanism, read-only.

**79 cited sources**: 21 files in this repo, 4 GitHub issues, 13 files in the pinned `vendor/pi` checkout, and 41
primary web documents (Home Assistant contributor docs, the Claude Code plugin and mods docs, VS Code's extension
manifest and validator source, the MCP 2025-11-25 specification, Node/Deno/isolated-vm). Every load-bearing claim was
re-read against its source by a separate auditor — see [`audit.md`](audit.md).

## The short answer

**Hybrid: one contribution model, two loaders, no third tier.**

- `defineConnector()` returns a data-first object — `{ name, host, trust, tools, sections, hooks, commands, close() }`
  — validated once by an `install()` that owns the invariants.
- **Loader 1** `src/connectors/<name>/`, named in a closed `CONNECTORS` array, compiled with the server.
- **Loader 2** `service/connectors/<name>/`, imported at boot by an explicit path named in a service-owned
  `connectors.json`. Never at runtime, never by a glob.
- Code mason does not trust gets **neither** loader and stays where it is: out of process, MCP for tools, one signed
  POST for events.

The gap is not tools — every MCP tool is already `deferred` and costs nothing until `tool_search` promotes one. What a
config entry cannot supply is everything else a chat connector needs: an operator-authored prompt section, a declared
reply route, an entry kind in the transcript, and a lifecycle. MCP cannot carry those: `prompts` are
"designed to be user-controlled", and the SEP asking for server→client calls was closed dormant.

The one sentence Denis is being asked to redline is ADR-0007 §6: "a directory glob is not a list — you cannot read the
menu without running the code". Loader 2 breaks it deliberately. Issue #16 only ever forbade *runtime* install.
[`report.md`](report.md) checks the recommendation against all 22 invariants and names exactly two strains.

## The three findings that decide it

1. **The prompt section is what code buys, and it is cheap.** At 400–600 characters a section costs 106–156 tokens per
   turn (char/4) — about one promoted medium MCP tool. A connector whose *tools* get promoted is the expensive one,
   not a connector with words.
2. **No isolation substitutes for review.** `node:vm` "is not a security mechanism"; a worker thread shares the
   filesystem and `process.env`; Deno states the structural fact — code on one thread shares one privilege level.
   `isolated-vm` is in maintenance mode with a critical guest→host escape through 7.0.0. The only real boundary is a
   process, and a process is the protocol option again.
3. **Claude Code's capability table bounds verbs, not reach.** `$.fs` reads "An absolute path is used as given";
   Anthropic's own doc concedes that with `Read(.env)` denied "a mod can still read that file with `$.fs.read`". Copy
   its manifest containment and the enumerability of its contribution list; do not copy the promise.

## What the run found that is not the answer

- **`docs/CONNECTOR-PROTOCOL.md` promises a refusal the code does not perform.** It says an entry using `state` or
  `reply` "refuses the boot with the field's name"; `validate()` spreads unknown keys through, so writing
  `"reply": "send_message"` today is accepted, ignored and preserved. Only the envelope's `v` is enforced.
- **ADR-0003 and ADR-0006 disagree about what an integration is**, and ADR-0006 never marks ADR-0003 superseded. A
  reader cannot tell whether "no per-integration code" still stands.
- **`CAPABILITY-PLAN.md` and ADR-0007 disagree about whether a capability may be off**, and the file that would settle
  it (`src/server/capabilities.ts`) does not exist.

## What remains open

Whether a boot-time import is *forbidden* or merely *unmentioned* — that is the decision, not a research question. No
measured lines of code or schedule for a contribution API. No tokenizer was run: token figures carry a 12–14% band
(char/4 versus pi-ai's char/3.5). Nobody has measured whether a mid-session `tools/list` refresh would actually
re-price the prefix. The `state` channel (issue #62) is a mason commit with a new principal whatever loader wins.

## The files

| File | What it is |
|---|---|
| [`brief.md`](brief.md) | The question as it was given to the run, and how the report would be judged |
| [`report.md`](report.md) | The deliverable: recommendation, invariants, placement, loading, trust, versioning, migration, cost |
| [`audit.md`](audit.md) | Every load-bearing claim re-fetched and checked: 13 supported, 1 partial, 1 at the wrong URL (now fixed) |
| [`findings/`](findings/) | The eleven note files the report was written from, one per sub-question, with verbatim quotes |
