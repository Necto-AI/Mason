# What invariants must any connector mechanism in mason satisfy, stated as numbered rules each backed by a verbatim quote with file:line?

## Answer

Twenty-two numbered rules, each quoted from mason's own docs or code at a file:line, plus nine tensions between them. The
three that bind hardest are R1 (the prompt prefix is byte-identical between two turns of one build), R2/R3 (the tool
surface is resolved at boot and never mid-conversation), and R17/R18 (issue #16's two rejections: no runtime loader, no
config file listing compiled-in code). Together they forbid any contribution that appears after the process starts, so a
connector mechanism must take effect at a build boundary and be absent from every turn in between — and issue #16's
rejection is of *runtime install*, not of boot-time resolution, which is the one gap the documents leave for the report
to argue.

## Claims

Rules are stated as: **rule.** Forbids: … [source] — "verbatim quote" — file:line — direct|partial|inferred.

R1. **The prompt prefix must be byte-identical between two turns of one build.** Forbids: any contribution whose bytes, ordering or presence varies inside a conversation — live health, per-turn counters, a tool list that grows on reconnect. [1] — "Health is server state and never a prompt section: it varies between turns, and the resident prefix must be byte-identical between two turns of one build." — src/server/integrations.ts:22-23 — direct
R2. **The tool surface and the prompt section are resolved at boot; a change is a restart.** Forbids: a connector registering tools mid-conversation, and a reconnect or container restart that changes what the model can do between two messages. [1] — "a list that changed under a running turn would re-price the prefix and change what the model can do between two messages" — src/server/integrations.ts:12-13 — direct
R3. **MCP tools are reached once at boot and live with the process; every one is `deferred`, so two boots of one build are byte-identical in what is offered.** Forbids: eager per-turn `tools/list`, undeffered tool schemas in the prefix, a tool list that differs between two boots of one build. [2] — "Boot is the only moment this happens, because the tool list is prompt prefix" — src/server/mcp.ts:5-6 — direct
R4. **The prompt's integration lines are sorted, so two renders of one file are the same bytes.** Forbids: a prompt section whose order depends on file order, insertion time, or which connector answered first. [4] — "One line per enabled integration with a tools face, sorted by name, so two renders of one file are the same bytes" — src/server/prompt.ts:93-94 — direct
R5. **Every prompt section has exactly one owner, declared in `prompt.ts`, in order; no extension contributes a section elsewhere.** Forbids: a connector that registers its own prompt section, and two owners of one section (ADR-0007 makes this an explicit test: "a section with two owners"). [4] — "No other extension contributes a section, and the agent carries no `instructions` of its own, so this list is the whole prompt" — src/server/prompt.ts:8-9 — direct
R6. **Prompt text about a connector is operator-authored from a service-owned file, never supplied by the remote server.** Forbids: a connector's own self-description (`tools/list` prose, a `description` it sends) becoming system-prompt text; a remote-controlled prompt. [14] — "injected once per turn, from the file, never from the remote server: an MCP server that could write into the system prompt" — docs/adr/0006-connectors-are-full-duplex-peers.md:35 — direct
R7. **Extension selection is per-conversation, stored, and repaired on every open by appending what it lacks.** Forbids: an explicit stored list used verbatim (it would silently drop a newly added base extension), and a connector-only selection that omits `delivery`. [3] — "no conversation may be without `delivery`, and a conversation whose stored array predates any of them" — src/server/runtime.ts:411-412 — direct
R8. **`delivery` is unconditional: it is the floor, not a choice.** Forbids: any contribution allowed to make a bot unable to reach its reader; a connector that becomes the only reply path. [3] — "`delivery` is unconditional: it is the only way the agent reaches the reader, so no conversation may be without it." — src/server/runtime.ts:42-43 — direct
R9. **The home is split `agent/` (mounted into the tool machine) vs `service/` (never mounted), as a mount boundary, not a mode; home `0700`, files `0600`.** Forbids: connector config, secrets or enablement in any path a tool can write; a permission-bit argument standing in for the volume split. [5] — "The split is a mount boundary, not a permission mode: `bash` can talk its way around a mode." — src/server/house.ts:26-28 — direct
R10. **A connector's own enablement is service-owned, so a tool cannot grant itself a capability.** Forbids: writing connector capability/config into `agent/`, or any path the bot can rewrite with `write`/`bash`. [1] — "The file is service-owned (`service/integrations.json`), never a path inside `agent/`: a tool that could rewrite its own capability is not a capability a person chose." — src/server/integrations.ts:9-10 — direct
R11. **Every way in goes through `auth.ts`; a new entry point is unauthenticated until it calls `authenticate`, and the default answer is no.** Forbids: a connector-owned route, socket or network-reaching tool that does not pass the owner gate — and adding to the two named exceptions rather than justifying one. [18] — "A new entry point — another route, another socket, another tool that reaches the network — is unauthenticated until it calls `authenticate`, and the default answer is no." — AGENTS.md:30 — direct
R12. **A trigger secret is not a token, and the command vocabulary is closed in code.** Forbids: a connector credential that can read, claim or call a method; a connector-named verb added to the command set by config. [7] — "The commands mason acts on, and the whole of them: a closed set, because every name here is a method the console can call too" — src/server/events.ts:55-56 — direct
R13. **After the door, every caller spends from a stated budget in `limits.ts`, keyed per caller and per kind of spend.** Forbids: a new contribution path with no budget of its own, and charging a refusal (an undeclared word, a malformed command) against an action's budget. [8] — "a sender that can fire without a bound is a sender that can spend Denis's budget and fill his transcript" — src/server/limits.ts:6-7 — direct
R14. **The projection is a whitelist: reasoning, tool calls, tool arguments, tool output and raw entries never cross the wire.** Forbids: a connector's new entry kind or tool output reaching any client before `projection.ts` names it; a connector subscribing to the raw conversation rather than the projection. [9] — "Everything the model does — reasoning, tool calls, tool arguments, tool output, usage, the raw entries — stays here, on the server." — src/server/projection.ts:4-7 — direct
R15. **There is one bot, one home, one conversation.** Forbids: per-connector homes or conversations, a peer registry, cross-bot routing, a second conversation opened for a second surface. [13] — "mason is one bot for one person and a small room on one host: one identity, one home, one conversation, one set of tools" — docs/adr/0004-mason-is-a-headless-backend.md:10 — direct
R16. **A capability a bot cannot be allowed to lack is not optional-by-config, or the bot is born mute.** Forbids: making the floor (reply, transcribe-to-be-answered, look-up) arrive as a config entry whose absence is a working-looking bot; note the reconciliation in ADR-0007 §1 (`core: true`, "no file can take it away", docs/adr/0007-…:43) — a config file may *name* a core capability but may not remove it. [16] — "Transcription, OCR and search must not be integrations — a new bot would be born mute, blind and unable to look anything up" — docs/CAPABILITY-PLAN.md:26-27 — direct
R17. **Rejection 1 (issue #16): no loader that imports code at runtime.** Forbids: dynamic `import()` of operator-supplied paths inside the server process, a directory walked for modules, jiti, "install this extension" as a tool call — the stated reasons being privilege and the mid-conversation tool list. [19] — "a loader means dynamic `import()` of arbitrary paths inside the server process, which is a plugin system with the server's own privileges" — issue #16 (gh issue view 16), §"Rejected, with the reason", bullet 1 — direct (issue body has no file:line; the same rejection with a file:line is docs/adr/0007-capabilities-are-listed-once-in-code.md:288-292, "a directory glob is not a list — you cannot read the menu without running the code")
R18. **Rejection 2 (issue #16): no config file listing which compiled-in extensions are on.** Forbids: the operator file as the installer of *code*; a typo that drops `delivery` producing a bot that cannot speak. What is allowed instead is a closed catalog in code plus a file that names ids from it (ADR-0007), which is why this rule is about compiling-in, not about naming. [19] — "A typo that drops `delivery` produces a bot that cannot speak, and the startup repair would silently rewrite it into something nobody can predict." — issue #16, §"Rejected, with the reason", bullet 2 — direct
R19. **Growth is one entry and its code; the catalog is closed — no directory to drop a file into, no import by convention.** Forbids: convention-based discovery, an unreviewed stray file becoming a contribution, a connector added by `cp` rather than by a commit. [15] — "The catalog is closed. A capability is an entry in `CAPABILITIES`; there is no directory to drop a file into and no import by convention." — docs/adr/0007-capabilities-are-listed-once-in-code.md:258 — direct
R20. **Off must restore the prompt byte-for-byte and leave no container, skill or selected tool behind; off costs nothing.** Forbids: a disabled connector that still appears in the prefix, still dials, still ships a container, or leaves a stale copy of a skill promising an absent tool. [15] — "Off must restore the prompt byte-for-byte and leave no container, skill or selected tool behind." — docs/adr/0007-capabilities-are-listed-once-in-code.md:267 — direct
R21. **A broken optional service degrades; broken configuration refuses the boot.** Forbids: conflating the two — a redeploying container stopping mason, or a config that names something this build does not have booting into a door that accepts and drops. [2] — "Nothing here is fatal by default. A container that is down removes its tools, says so in one line and in `/api/integrations`, and the boot carries on" — src/server/mcp.ts:16-18 — direct; and [3] — "A trigger's hook is a name in a file, so a build that does not define it must refuse rather than start." — src/server/runtime.ts:442 — direct
R22. **The connector declares; it does not discover or negotiate powers at runtime.** Forbids: a connector acquiring a channel or a permission by asking, a manifest that grows fields at runtime, protocol-level capability negotiation as the trust mechanism. [17] — "Declare, do not discover. The entry is written by an operator" — docs/CONNECTOR-PROTOCOL.md:38 — direct

### Tension list

- **R2/R3 (boot-time tool list) vs any connector that wants its tools to appear when it does.** Today the tool surface is
  reached once, at boot, "with one retry per server, because mason and an integration's container usually restart together"
  (src/server/mcp.ts:8-10). A connector loaded by mason but restarted independently has no way back into the tool list
  without a mason restart. A marker on the entry can say a reload happened, but R1 says the *prefix* may not move, so the
  tool list cannot change under a conversation even at a mason restart.
- **R1/R2 vs R19 (the catalog is closed).** Adding a connector's tools and section is cheap once per build and
  forbidden once per conversation. The mechanism's whole lifecycle question is therefore "where is the build boundary",
  not "how do we reload".
- **R17 (no runtime loader) vs the ask in the brief (a connector that adds to the codebase).** Issue #16 rejects
  *runtime* install, explicitly because `install()` publishes immediately and `selectExtensions` runs on every
  preparation — a mid-conversation tool list. It does not say a boot-time import of a reviewed module is impossible; it
  says the coding agent has that machinery "because it is a CLI whose job is to run arbitrary local code. mason is not."
  The distance between "boot-time import" and "runtime install" is a judgement the report has to make, not a quote.
- **R7/R8 (unconditional floor, repaired by appending) vs R20 (off costs nothing).** The repair silently rewrites stored
  user state — "The repair cannot tell a legacy doc from a deliberate narrowing of the selection, so it silently rewrites
  user state" (docs/SPEC.md:242). Anything a connector mechanism makes unconditional inherits that licence to rewrite;
  anything it makes optional must be droppable without pruning anybody's stored document (the ADR-0007 route).
- **R14 (whitelist owned by `projection.ts`) vs a connector contributing entry kinds.** A connector cannot make its own
  kind visible: the server must add the branch, which means the connector's UI contribution is a mason commit, always —
  even in a mechanism where the connector is external.
- **R5/R6 (one prompt file; operator-authored text) vs ADR-0006's per-connector `prompt` paragraph.** ADR-0006 §3 puts
  prompt text in `integrations.json`. That is reconciled today only by treating the integrations section as "a rendering
  of something the prompt does not own" (docs/SPEC.md §3.2) with a 400–600 character budget, and it is the one place a
  connector's own words approach the system prompt.
- **R15 (one bot, one conversation) vs ADR-0006's full-duplex peer and fan-out.** A connector may read the projection and
  may be named in `also`, but a second person sharing one bot is refused by ADR-0001/0004 and named as a separate ADR in
  ADR-0006's costs.
- **R16 (no born-mute bot) vs ADR-0007's "nothing optional is on by default".** The only reason `delivery` is safe is
  that it is not in the catalog at all: it is in `BASE_EXTENSIONS`. Any connector mechanism that puts its contributions
  behind a per-bot selection repeats the argument ADR-0007 had to settle, and must answer which of its contributions are
  `core`.
- **R17/R18 (no loader, no code config) vs R16/R22 (operator declares what a bot has).** The repo's settled shape is: the
  operator chooses among things that are already compiled, and chooses nothing that is not. A connector mechanism that
  lets the operator add a *module* crosses a line no ADR has yet drawn.

## Sources

[1] src/server/integrations.ts — /home/denis/dev/mason/src/server/integrations.ts (386 lines; header doc comment 1-24) — accessed 2026-10-30 — primary (running code)
[2] src/server/mcp.ts — /home/denis/dev/mason/src/server/mcp.ts (404 lines; header 1-27) — accessed 2026-10-30 — primary
[3] src/server/runtime.ts — /home/denis/dev/mason/src/server/runtime.ts (462 lines; 41-75, 205-240, 405-462) — accessed 2026-10-30 — primary
[4] src/server/prompt.ts — /home/denis/dev/mason/src/server/prompt.ts (173 lines; 1-17, 86-104) — accessed 2026-10-30 — primary
[5] src/server/house.ts — /home/denis/dev/mason/src/server/house.ts (790 lines; header 1-40) — accessed 2026-10-30 — primary
[6] src/server/auth.ts — /home/denis/dev/mason/src/server/auth.ts (426 lines; header 1-29; `authenticate` at 355) — accessed 2026-10-30 — primary
[7] src/server/events.ts — /home/denis/dev/mason/src/server/events.ts (184 lines; 55-61) — accessed 2026-10-30 — primary
[8] src/server/limits.ts — /home/denis/dev/mason/src/server/limits.ts (137 lines; header 1-11) — accessed 2026-10-30 — primary
[9] src/server/projection.ts — /home/denis/dev/mason/src/server/projection.ts (250 lines; header 1-12) — accessed 2026-10-30 — primary
[10] docs/SPEC.md — /home/denis/dev/mason/docs/SPEC.md (850 lines; 242, 284-288, 306-309, 320-325, 450-466) — accessed 2026-10-30 — docs (the spec, authoritative after the code)
[11] docs/adr/0002-split-home.md — /home/denis/dev/mason/docs/adr/0002-split-home.md — accessed 2026-10-30 — docs
[12] docs/adr/0003-integrations-are-services.md — /home/denis/dev/mason/docs/adr/0003-integrations-are-services.md (3, 16-18, 26) — accessed 2026-10-30 — docs
[13] docs/adr/0004-mason-is-a-headless-backend.md — /home/denis/dev/mason/docs/adr/0004-mason-is-a-headless-backend.md (10, 106-107) — accessed 2026-10-30 — docs
[14] docs/adr/0006-connectors-are-full-duplex-peers.md — /home/denis/dev/mason/docs/adr/0006-connectors-are-full-duplex-peers.md (35, 46-47, 95) — accessed 2026-10-30 — docs (Proposed)
[15] docs/adr/0007-capabilities-are-listed-once-in-code.md — /home/denis/dev/mason/docs/adr/0007-capabilities-are-listed-once-in-code.md (43, 160-172, 258, 267, 272, 288-296) — accessed 2026-10-30 — docs (Proposed)
[16] docs/CAPABILITY-PLAN.md — /home/denis/dev/mason/docs/CAPABILITY-PLAN.md (18-34) — accessed 2026-10-30 — docs
[17] docs/CONNECTOR-PROTOCOL.md — /home/denis/dev/mason/docs/CONNECTOR-PROTOCOL.md (32, 38, 56) — accessed 2026-10-30 — docs (Proposed)
[18] AGENTS.md — /home/denis/dev/mason/AGENTS.md (rule 6 at line 30, rule 7 at 31) — accessed 2026-10-30 — docs (the binding instruction file)
[19] issue #16 — `gh issue view 16` in /home/denis/dev/mason — accessed 2026-10-30 — primary (the issue body; no file:line, sections quoted by heading)
[20] docs/adr/0001-mason-defines-one-bot.md — /home/denis/dev/mason/docs/adr/0001-mason-defines-one-bot.md (3-7) — accessed 2026-10-30 — docs
[21] docs/adr/0005-there-is-no-interface-type.md — /home/denis/dev/mason/docs/adr/0005-there-is-no-interface-type.md — accessed 2026-10-30 — docs (Proposed)
[22] docs/adr/0008-three-yandex-integrations-one-container.md — /home/denis/dev/mason/docs/adr/0008-three-yandex-integrations-one-container.md — accessed 2026-10-30 — docs (Proposed)

## Conflicts

1. **CAPABILITY-PLAN vs ADR-0007 on whether a capability may be off.** CAPABILITY-PLAN.md:18-19 — "mason's own
   capabilities ship in code, so every bot has them. A capability nobody has to configure is a capability no bot can
   silently lack." ADR-0007:163 — "Missing, or `{}`: core only. Nothing optional is on, which is the requirement stated as
   a default." ADR-0007 says it keeps CAPABILITY-PLAN's motive ("Rejected as the default, kept as the motive",
   ADR-0007:293-294) and answers with a catalog plus a per-bot file. Not a stale doc: CAPABILITY-PLAN:33-34 says the ADR
   "designs the answer … None of it is in the tree". **The conflict is live**: the file that would resolve it
   (`src/server/capabilities.ts`) does not exist, so the rule a connector mechanism must obey is undecided between
   "every bot has it" and "nothing optional is on".
2. **ADR-0003 vs ADR-0006 on what an integration is.** ADR-0003:26 — "No extension is written per integration. The only
   per-integration artefacts are a container, a config entry and a secret." ADR-0006:35 gives every entry an
   operator-authored prompt section, and ADR-0006:46-47 gives a connector `state` capabilities including
   `projection`/`tools`. ADR-0006 does not name ADR-0003 as superseded; it says it "finishes the job" ADR-0003 and
   ADR-0005 started. A reader cannot tell from the two files whether ADR-0003's "no per-integration code" still stands.
3. **ADR-0003:18 "Every integration is optional by default" vs ADR-0003:16 "The enabled set is resolved at boot" plus
   the boot refusals.** An integration is optional as a *process* and mandatory as *config*: `assertTriggersHaveHooks`
   refuses the boot for an enabled entry naming a hook this build does not define (src/server/runtime.ts:442-461). The
   two consequences are in the same ADR and pull in opposite directions about what "optional" means.

## Unanswered

- **Whether a boot-time import of operator-supplied code is forbidden or merely unmentioned.** Issue #16 rejects a
  "loader that reads a list and installs extensions at runtime" and a "config file listing which compiled-in extensions
  are on". ADR-0007:288-292 rejects a plugin directory "imported at boot" — but its reason is that *capabilities* are
  first-party and compile-time, not a principle about boot import. I looked in docs/SPEC.md, all eight ADRs,
  docs/CONNECTOR-PROTOCOL.md, docs/CAPABILITY-PLAN.md and the headers of the nine named source files; no document states
  the boot-import case on its own. This is the gap the report must fill, and it cannot be closed by quotation.
- **Whether `capabilities.json` and `src/server/capabilities.ts` exist in the tree.** ADR-0007 is Proposed;
  docs/CAPABILITY-PLAN.md:33-34 says "there is no `capabilities.ts`, no reader for such a file, and no such route". So R16
  and R19/R20 are *proposed* invariants, not running ones, and a connector mechanism cannot appeal to them as enforced.
- **Whether ADR-0006's `prompt` field, `speaks`, `capabilities`, `reply`, `also` and `state` are read by any code.** I read
  the header of src/server/integrations.ts and the `Integration` interface start (lines 41-45: `tools` with `url` and
  `required`); the ADR-0006/0005 fields are not in the part I read and the docs call the whole contract "proposed"
  (docs/CONNECTOR-PROTOCOL.md:1-6). A sibling should confirm against the full interface whether `prompt` is read, because
  R6 depends on it.
- **What a connector's prompt section does to the cache arithmetic.** No document prices a per-connector section the way
  ADR-0007 prices `generative-ui` at 77 tokens (ADR-0007, `cost.promptTokens`); the CONNECTOR-PROTOCOL budget is
  "400–600 characters" (docs/CONNECTOR-PROTOCOL.md:55) with no token figure.
- **Whether `delivery` can be reached by a connector at all under ADR-0006.** ADR-0006 §1 removes `send_to_user` as a
  mason-owned channel; docs/SPEC.md §3.3/§3.4 and src/server/extensions/delivery.ts still specify the gate and the tool.
  I did not resolve which is in the tree — src/server/runtime.ts:54 still installs `Delivery` in `BASE_EXTENSIONS`, so the
  code is on ADR-0005's side, not ADR-0006's.
- **No web sources.** This sub-question was assigned read-only and local ("do not research other products"), so no
  `web_search` was run; the search-discipline budget was not spent. Everything above is a primary read of this repository.

## Queries

None — no web queries were run, by instruction (local-only, read-only angle). The reads issued instead, in order:

1. `cat docs/research/connector-mechanism/brief.md`
2. `sed -n '1,200p' docs/SPEC.md`; `sed -n '200,470p' docs/SPEC.md`; `sed -n '470,850p' docs/SPEC.md`
3. `cat docs/adr/0001…0003`, `0004…0005`, `0006…0008`
4. `cat docs/CAPABILITY-PLAN.md`, `cat docs/CONNECTOR-PROTOCOL.md`
5. `for f in src/server/{runtime,prompt,integrations,mcp,house,auth,events,limits,projection}.ts; do sed -n '1,45p' $f; done`
6. `grep -n "BASE_EXTENSIONS|extensionList|unconditional|repair|selectExtensions|assertTriggersHaveHooks" src/server/runtime.ts`
7. `sed -n '205,240p' runtime.ts`, `sed -n '405,462p' runtime.ts`, `sed -n '41,80p' runtime.ts`
8. `grep -n "MASON_DATA|0700|0o600" src/server/house.ts`, `grep -n "COMMAND_NAMES" src/server/events.ts`
9. `grep -n "byte-identical|read once at boot|prefix is byte-stable|whitelist, not a filter" docs/SPEC.md`
10. `grep -n` across ADR-0001/0002/0003/0004/0006/0007 and AGENTS.md for the quoted sentences
11. `gh issue view 16`
