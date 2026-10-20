# Subagents, triage, and delegation for the main agent — research findings

> Deep-research run: grokbot lecture insights → mason. Date: 2026-10-18. Model: deepseek-v4.1-flash (max thinking).

## Summary

Orchestrator-worker is the settled shape: a user-facing agent keeps the conversation, hands self-contained tasks to helpers with their own context windows, and receives a bounded report — never the helper's transcript. pi has **no** Task/subagent tool, but `pi-durable` already supplies every primitive and its own spec contains the helper pattern twice: a foreground subagent is an owned conversation owned by the calling tool task; a persistent helper is a background anchor task + owned conversation + a registry document + reporter tasks. Triage also exists already: the inbox is FIFO by submission ID, and `steer` vs `followUp` decides *when* an item is placed (mid-run vs next turn) — that is grokbot's "user skips the line / helpers to the back", minus priority. Mason should build helpers **in-process on the durable Harness**, not as `pi` CLI subprocesses: durability, the UI to-do list, abort cascades, and per-helper execution environments all come from the ownership tree.

## Key findings

1. **pi has no native subagent mechanism.** Built-in tools are `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `powershell` (`vendor/pi/packages/coding-agent/src/core/tools/index.ts`); built-in extensions are `llama.cpp`, `codemode`, `tool-search`, `mcp` (`vendor/pi/packages/coding-agent/src/extensions/index.ts:8`). What exists is *nested tool calls*: a tool can run another tool and wait (`ctx.executeTool()`, `vendor/pi/packages/coding-agent/src/core/nested-tool-calls.ts:1-8`).

2. **`pi-durable`'s spec prescribes the subagent implementation.** "A foreground subagent conversation is explicitly owned by its tool task" — the tool creates the child in `commit()`, dedupes by `scanConversations({ ownerTaskId })` on replay, submits with a `requestId` derived from its task ID, waits for settlement, returns the child's answer as its tool output, and publishes `api.details({ conversationId })` so a UI can attach to the child (`vendor/pi/packages/durable/docs/spec.md:3272-3317`). "A persistent background subagent outlives the parent's turns and can be messaged, steered, stopped, and listed later": a background conversation-owned anchor task owns the child conversation, a document maps name → conversation, and each message is a background reporter task that submits to the child and posts the answer into the parent with `whenBusy: "followUp"` (`spec.md:3319-3360`).

3. **Lifecycles are free from the ownership tree.** Abort flows down owner edges; background tasks are boundaries unless aborted directly via `Conversation.abort(context, { background: true })` (`vendor/pi/packages/durable/docs/spec.md:2173-2240`; `.../src/harness/types.ts:111-118`). A conversation stays usable after its owner finishes — "for example to interrogate a finished subagent" (`spec.md:2223-2228`) — which is exactly "check on a helper after it reported". A conversation runs one run at a time (`pi.live.run`, `spec.md:2318-2330`), so "one task at a time" per helper is the default, not a policy to implement.

4. **Triage is a placement rule, not a priority number.** The inbox holds items "in ID order"; there is no priority field (`spec.md:2298`, `.../src/harness/inbox.ts:11-27`). `whenBusy: "steer"` queues an item for the next `postTools` boundary — placed into the *current* run, between tool rounds; `"followUp"` is placed only at the `final` boundary and starts the next run (`vendor/pi/packages/durable/src/harness/types.ts:61-77`, `spec.md:2360-2372`). `steeringMode` / `followUpMode` are `"all" | "one-at-a-time"`, default `one-at-a-time` (`.../src/harness/agent.ts:70-71`); `"all"` selects every queued item of that mode at one boundary → **that is the "3 quick messages → 1 turn" batch**. A `requestId` deduplicates within a conversation (`spec.md:2340`). Display-only writes land immediately, ahead of queued items.

5. **Claude Code subagents** are markdown personas with their own context window, custom system prompt, a tool allowlist, and a model alias or `inherit`; project `.claude/agents/` beats `~/.claude/agents/`, CLI `--agents` sits between them. Automatic delegation is driven by the `description` field ("use PROACTIVELY"/"MUST BE USED"). Built-ins: general-purpose (Sonnet, all tools), Plan (read-only research in plan mode), Explore (Haiku, strictly read-only, `quick|medium|very thorough`). Subagents **cannot spawn subagents**. Each invocation gets an `agentId` and a transcript `agent-{agentId}.jsonl`, resumable via a `resume` parameter. Same page's caveat: subagents "start off with a clean slate each time they are invoked and may add latency as they gather context" [1].

6. **Anthropic's multi-agent research system** (the orchestration numbers): the lead spawns 3–5 subagents in parallel; subagents use 3+ tools in parallel; up to 90% time reduction on complex queries; multi-agent used ~15× chat tokens vs ~4× for single agents; it won 90.2% over a single agent on breadth-first research but the post warns "most coding tasks involve fewer truly parallelizable tasks than research". Delegation quality is a prompt problem: each subtask needs "an objective, an output format, guidance on the tools and sources to use, and clear task boundaries", plus explicit effort scaling (simple: 1 agent, 3–10 tool calls; comparison: 2–4 agents, 10–15 calls each). Synchronous execution is named as a known bottleneck [2].

7. **OpenAI Agents SDK** distinguishes the two patterns explicitly: *handoffs* transfer control to a specialist for the rest of the turn; *agents as tools* (`Agent.as_tool()`) keep the manager in control of the user-facing conversation — recommended "when a specialist should help with a bounded subtask but should not take over". A nested run does not inherit the parent's conversation state; `parameters` gives the nested agent structured input; `custom_output_extractor` reshapes/validates what the parent receives (the report contract); `needs_approval` gates the nested run; `on_stream` observes it [3][4].

8. **Mason today is one conversation.** `openAgentRuntime` opens one root conversation and every hook submits there with `whenBusy: "followUp"` (`src/server/runtime.ts:176-196`, `src/server/hooks.ts:122`). `envFor` already keys environments by `(conversationId, cwd)` (`src/server/env.ts:60-72`) and the pi-env `Connection` multiplexes concurrent requests by id (`vendor/pi/packages/env/src/connection.ts:139-246`), so helpers can run tools in parallel on distinct directories with no new plumbing. Nothing in mason spawns a helper; Denis's ad-hoc `pi -p` subagents leave no durable record.

## How grokbot does it (from lecture notes)

Main agent = user-facing interface + orchestrator; it "keeps its conversation sparse and succinct", which Denis annotated as "[the] key to essentially infinite context". Helpers are general, computer-use (one task at a time), video, and a cloud coding agent in its own VM. The main agent "gets back a short report". The UI shows a to-do list of every request, with check-on-helper, message-a-helper, and stop-all. Same rules for message handling: the user's 1:1 message skips the line and can interrupt or stop the turn; helper results, quick-message batches, and routines go to the back of the line, and a running turn works on one batch at a time. Interpretation: helpers exist for two reasons — context isolation and a resource boundary (a browser/desktop is serialized; a VM is a separate trust domain) — and "one task at a time" is a lock on the shared screen, not a model limitation.

## Mason applicability

**Already there.** Owned conversations and the task tree; `TaskRuntime.conversation()`, `ctx.createTask`, `ctx.details`, `ctx.commit` (`vendor/pi/packages/durable/src/harness/types.ts:180-260`, `spec.md:2808-2880`); task-graph watch for a to-do list (`Harness.watchTaskGraph`, `spec.md:4761-4800`); the steer/followUp queue that the web client already renders (`src/shared/contract.ts`, `QueuedRows.tsx`); per-conversation execution environments.

**Missing.** A helper tool with dedup + report contract; a helper definition (instructions, model, tool subset, cwd) that survives; the reporter path (helper → parent message); steer/stop/message of a live helper from the UI; the `followUpMode: "all"` batch setting; delegation policy in the prompt.

**Do not build.** A second agent loop; a scheduler; a file-based persona registry like `.claude/agents/` (skills and `instructions` already carry text, and mason deliberately keeps configuration in code + documents); nesting helpers deeper than one level (Claude Code forbids it for a reason: cost and coordination explode, `spec.md:2223` is the only escape hatch needed — talk to a finished helper); shelling out to `pi -p` for helpers inside mason's workspace (loses durability, replay-safety, the UI, and shares nothing with the parent's documents).

## Recommended actions

1. **[now]** Set `followUpMode: "all"` and `steeringMode: "one-at-a-time"` in the Harness settings (`src/server/runtime.ts`). Effect: rapid-fire user messages batch into one successor run; a deliberate Steer still lands at the next tool boundary. Test: two `whenBusy: "followUp"` submits while busy → one run with both inputs.
2. **[now]** Add the delegation policy to `PROACTIVE_GUIDELINES` (`src/server/extensions/agent-identity.ts`): the main agent keeps user-facing answers, decisions, and coordination; it hands off work that is >N tool calls, bulk reading, long-running, or needs a different cwd. Every handoff must state objective, output format, and what not to do.
3. **[now]** Write `src/server/extensions/use-helper.ts`: the spec's foreground subagent tool (`spec.md:3284-3317`), `replay: "safe"`, dedupe by `scanConversations({ ownerTaskId: ctx.taskId })`, `configure` the child with `extensions: { remove: [UseHelper] }` plus `instructions`, submit with `requestId: "helper:" + taskId`, wait, return the child's final assistant text. Publish `ctx.details({ conversationId })`.
4. **[now]** Fix the report contract in the helper's instructions: final message only, `TL;DR` (≤3 lines) → what changed/where (paths, not contents) → verification performed → blockers/open questions. Cap what the parent ingests: read the child's last entry, never its transcript. Mirrors the triage skill's `AGENT-BRIEF.md` (pi-setup, `skills/engineering/triage/`).
5. **[next]** Persistent helper: anchor task + owned conversation + name document + reporter tasks (`spec.md:3319-3360`), giving message/steer/stop/list after the parent's turn ends.
6. **[next]** UI: helper rows from `watchTaskGraph()` (kind, phase, owned conversation), a link into the child's conversation view, and "stop all helpers" = `root.abort(ctx, { background: true })`.
7. **[next]** Triage rules by channel, not by model: 1:1 user → `steer`/`followUp`; hook and helper reports → `followUp`; routines → `followUp`; only "should I delegate this?" is model-judged.
8. **[later]** A remote-workspace helper: give one helper conversation its own env target (SSH/container) seeded from an application document, per `spec.md:850-870` — the cloud-coding-agent analogue.
9. **[later]** Route `/triage`'s read-only half (list `needs-triage`/unlabeled/`needs-info` buckets) into a scheduled hook; keep labels, briefs, and closures human-gated. The skill is `disable-model-invocation: true` by design.
10. **[don't]** Nest helpers, spawn helpers via `pi -p` for in-workspace work, or build a second orchestration layer above the task tree.

## Open questions

- grokbot's exact report format and size budget — the notes only say "a short report".
- Whether a Steer can interrupt mid-generation or only at tool-round boundaries; the spec places it at `postTools`, so a steer during a long single generation still waits (verify with a test).
- Claude Code's Task-tool schema is inferred from the docs' programmatic `resume` example; the full parameter list is behind the same site that is unreachable from this network (Anthropic domains resolve to a sinkhole IP here; the doc was read via `web.archive.org`).
- Whether helper completion should wake the main agent automatically or only report; the durable spec's reporter task implies automatic, but it is unimplemented in mason.
- How the web client should mount a helper's conversation view (second Chord state per child conversation) — deferred to the UI plan.
- No primary source found for grokbot's implementation of "user skips the line"; pi has no priority field, so mason emulates it with placement timing only.

## Sources

- `vendor/pi/packages/durable/docs/spec.md` (lines 2173-2240, 2223-2228, 2271-2420, 2808-2880, 3272-3360, 4761-4800)
- `vendor/pi/packages/durable/src/harness/types.ts`, `inbox.ts`, `agent.ts`, `submissions.ts`, `harness.ts`
- `vendor/pi/packages/coding-agent/src/core/tools/index.ts`, `core/nested-tool-calls.ts`, `extensions/index.ts`, `cli/args.ts`, `modes/print-mode.ts`, `modes/rpc/rpc-types.ts`
- `vendor/pi/packages/env/src/connection.ts`
- `src/server/runtime.ts`, `src/server/hooks.ts`, `src/server/env.ts`, `src/server/extensions/agent-identity.ts`, `src/shared/contract.ts`
- `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`
- `~/.pi/agent/git/github.com/DenisSud/pi-setup/skills/engineering/triage/SKILL.md`, `AGENT-BRIEF.md`
- [1] https://code.claude.com/docs/en/sub-agents (read via https://web.archive.org/web/2025id_/https://docs.claude.com/en/docs/claude-code/sub-agents)
- https://github.com/anthropics/claude-code — `plugins/plugin-dev/skills/agent-development/SKILL.md`
- [2] https://www.anthropic.com/engineering/multi-agent-research-system (read via web.archive.org)
- [3] https://openai.github.io/openai-agents-python/multi_agent/
- [4] https://openai.github.io/openai-agents-python/tools/ and /handoffs/
