# Tool design principles and tool↔UI pairing — research findings

> Deep-research run: grokbot lecture insights → mason. Date: 2026-10-18. Model: deepseek-v4.1-flash (max thinking).

## Summary

Tool design has converged on four rules that are now backed by provider documentation, not taste: keep the tool list stable across turns, keep each definition small, make state changes reviewable, and write errors that name the next action. The cache argument is the hard one: Anthropic's cache hierarchy is `tools → system → messages`, and "modifying tool definitions (names, descriptions, parameters) invalidates the entire cache" [1]. There is now a protocol-level escape hatch — mid-conversation tool additions that leave the `tools` array untouched — and pi already implements it for models that support it [1]. Tool↔UI pairing has also standardized: MCP Apps (SEP-1865) renders a `ui://` HTML resource in a sandboxed iframe, splits tools by `model`/`app` visibility, and gives the UI two channels — `ui/message` (post to chat) and `ui/update-model-context` (state the model must see) [4]; OpenAI's ChatGPT apps now use that same bridge [5]. Approval flows fill the remaining gap: Vercel AI SDK `toolApproval` [6], OpenAI Agents SDK `needs_approval` + serializable interruptions [7]. Mason is in good shape on rule two (its largest definition, pi's `edit`, is ~1.1K chars; the rest are 350–970) and unbuilt on rules one and three: the `generateSandboxedUi` toggle changes the tool list mid-conversation, and there is no approval path at all.

## Key findings

1. **Changing the tool list is the most expensive edit in the prompt.** Anthropic: tools cache → system cache → messages cache, and a tool definition change invalidates all three; tool *choice*, images and system-instruction additions are cheaper [1]. Their `inline-tools-2026-09-15` beta lets a server add or change a tool mid-conversation with a `tool_addition` block in a mid-conversation system message while leaving `tools` "exactly as you first sent it", so "the cached prefix still matches" [1].

2. **pi implements that beta, so the rule is a policy choice, not a platform limit.** `INLINE_TOOLS_BETA = "inline-tools-2026-09-15"` (`vendor/pi/packages/ai/src/api/anthropic-messages.ts:195`), enabled by `nativeToolChanges` only where the model compat allows it (`:1195`). Where it does not, `resolveTranscript()` collapses every system message into one leading message (`packages/ai/src/utils/transcript.ts:108`) and rebuilds the prefix, so a changed section costs the message cache. pi puts Anthropic `cache_control` markers on the system prompt, the last tool definition and the last content block (`anthropic-messages.ts:1224`, `:1528`, `:1658`).

3. **Section changes are cheap only because pi appends instead of rewriting.** Sections are diffed and written as a `pi.system` entry with a per-section patch map (`packages/durable/src/harness/prompt.ts:9`, `:66`). That keeps the transcript append-only, but the provider-side order still decides the cache cost: on providers without mid-conversation sections the collapsed prefix breaks at the first changed section. Volatile text (hook payloads, timestamps, "what changed" notes) belongs in the newest message, never in a section.

4. **The 4,000-character rule is a budget, and real tools sit around it.** grokbot states ≤4,000 chars per tool. Anthropic measured GitHub's 35 MCP tools at ~26K tokens (~740 tokens ≈ ~3K chars per tool), a five-server setup at 58 tools ≈ 55K tokens, and 134K tokens seen before one internal optimization [3]. So 4K is a ceiling just above the industry average, and far above pi: instantiating its definitions gives (description + serialized schema) `edit` 1102, `grep` 962, `read` 607, `find` 539, `bash` 466, `ls` 397, `write` 352 chars. mason's `generateSandboxedUi` is 110 chars of description plus a 6-parameter schema, with its teaching text in a 2,327-char prompt section (`src/server/extensions/sandboxed-ui.ts:9`, `:22`, `:51`).

5. **Fewer, workflow-shaped tools beat endpoint wrappers.** Anthropic: prefer `search_contacts`/`message_contact` over `list_contacts`, `schedule_event` over `list_users` + `list_events` + `create_event`; "more tools don't always lead to better outcomes" [2]. OpenAI: namespace related tools, use enums "to prevent invalid states", offload work to code, combine functions always called in sequence, and "aim for fewer than 20 functions available at the start of a turn" [8].

6. **Actionable errors are documented twice, in both directions.** MCP separates protocol errors from tool-execution errors and says execution errors "contain actionable feedback that language models can use to self-correct and retry"; clients SHOULD pass them through [9]. Anthropic shows a helpful error next to an unhelpful one as a steering device, alongside truncation guidance [2]. pi is mixed: `read` truncation ends with `[N more lines in file. Use offset=X to continue.]` (`vendor/pi/packages/coding-agent/src/core/tools/read.ts:199`) and `edit` overlap says "Merge them into one edit or target disjoint regions." (`edit-diff.ts:346`), but a missing file yields `Could not edit file: <path>. Error code: ENOENT.` (`edit.ts:181`) and a stale offset yields `Offset N is beyond end of file (M lines total)` (`read.ts:164`) — neither names the fix.

7. **State changes should be their own tool, and the tool should be annotatable.** MCP's `ToolAnnotations` (`readOnlyHint`, `destructiveHint` default `true`, `idempotentHint`, `openWorldHint` default `true`) exist precisely so hosts can gate and label risky calls — but they are "hints" and must be treated as untrusted unless the server is trusted [9][10]. pi's equivalent is `ToolRegistration` metadata: `replay: "safe" | "unsafe"` (default unsafe), `executionMode`, `callers`, `deferred`, `outputLimits` (`vendor/pi/packages/durable/src/harness/types.ts:293`). Both are the mechanism a UI reads to decide what needs a card.

8. **Tool results have three audiences, and grokbot's SendToUser rides on the UI channel.** pi-durable already separates `output` (model), `structuredOutput` (programs), and `details` (UIs) (`types.ts:154`), and `ToolControl` offers `addTools`, `handoff`, and `terminate` — the last is grokbot's "the last message can end the turn without a model call" (`types.ts:137`).

9. **Tool↔UI protocols have converged on iframe + two channels.** MCP Apps (SEP-1865) defines a `ui://` HTML resource, `_meta.ui.visibility: ["model" | "app"]` (hosts MUST NOT offer `["app"]`-only tools to the model), a sandbox proxy, and two UI→host messages: `ui/message` (send content to the host's chat interface, which "also trigger[s] follow-ups") and `ui/update-model-context` (state for future turns, which the host SHOULD pass to the model and MAY show the user) [4][13]. OpenAI's Apps SDK states it "implements the open MCP Apps standard" and adds the approval subtlety: if a tool needs approval, the widget must not assume `toolInput` exists on first render — "ChatGPT may wait to populate `window.openai.toolInput` … only after the user approves the call" [5].

10. **Approval is a first-class framework primitive now.** Vercel AI SDK replaced `needsApproval` with `toolApproval` per tool: `'not-applicable' | 'approved' | 'denied' | 'user-approval'`, emitted as `tool-approval-request` / `tool-approval-response` parts; manual approval costs two model calls and the denial is reported back to the model [6]. OpenAI Agents SDK: `needs_approval=True` or a callable policy, pending calls surface as `RunResult.interruptions`, `RunState` is serializable so a paused run can be stored and resumed, decisions are per-call (`state.approve(interruption)`) or sticky (`always_approve=True`), and callable policies "fail closed" when arguments cannot be safely parsed [7].

11. **The generator's own security rules matter more than any UI framework.** MCP elicitation is form mode (flat schema, primitives only, accept/decline/cancel) or, since 2025-11-25, URL mode for out-of-band interaction — servers MUST NOT request "passwords, API keys, access tokens, or payment credentials" via form mode, and clients MUST show the full URL, must not pre-fetch it, and must not open it without consent [11]. Sampling carries the same clause: there SHOULD always be a human in the loop who can deny [12]. That is grokbot's "the password never reaches the model", written as a protocol MUST.

12. **Approvals need server-side state.** OpenAI's HITL guide: keep the snapshot in server storage, send the reviewer only tool details plus opaque IDs, authenticate the reviewer out of band ("possession of a run ID or decision ID is not authorization"), validate decisions against server-held pending items, and use an atomic owner-checked transition so a replay cannot resume the same snapshot twice [7].

## How grokbot does it (from lecture notes)

Four tool tips: don't add or remove tools between turns (unavailable tools return an error); keep each description and schema under ~4,000 characters; use a dedicated tool for saving state instead of shell commands "so reviewers can see what's changing"; and write errors that say what to do next — "The computer is asleep. Use Shell or Read to wake it, then try again." The cache section generalizes the first rule: the tool definitions, system prompt and first message stay byte-identical until the next summary, "if a deploy changes a tool description, running conversations get a note instead of the new text", and a cache miss is treated as a bug.

Tool↔UI pairing is the other half: one `SendToUser` tool delivers to desktop, web, mobile, Slack, email and voice, with the model's own prose never shown, quiet allowed, rich payloads (text, files, multiple choice, secure password entry) and a turn that can end without another model call. Purpose-built controls attach where seeing or approving matters — sign-in forms (1Password fills only the asking site; the password never reaches the model), payment approval cards, email draft review with Send/Discard, quick-reply reactions.

## Tool-design checklist for mason

Each box names the rule, its evidence, and how mason enforces it.

- [ ] **The tool list is fixed for the life of a conversation.** Not `configure()` on a UI toggle; unavailable capability returns an explainable error. Evidence: [1], finding 2. Enforce with a test that the tool names offered before and after `setSandboxedUiEnabled` are identical.
- [ ] **Availability failures name the fix and the tool to use.** Evidence: [2][9], finding 6. Enforce in review; the error text is the only part of the tool the model reads at its worst moment.
- [ ] **`description + schema ≤ 4,000 chars`, measured, per tool.** Evidence: [3], finding 4. Enforce with a registry-walking test that prints the total surface.
- [ ] **Instruction text lives in a section; volatile text lives in the newest message.** Evidence: [1], finding 3. Enforce by review: sections must be derivable from files or constants, never from `Date.now()` or hook payloads.
- [ ] **Every state change the user might review is a named tool, not a shell line.** Evidence: grokbot; MCP annotations [9][10], finding 7. Enforce: memory/skills/routines get `memorySave`, `skillInstall`, `routineUpsert`-style tools whose arguments render in a card or row.
- [ ] **Each tool declares its blast radius** (`readOnlyHint` analogue, pi's `replay`, execution mode) so the UI can decide what needs a card. Evidence: [9][10], finding 7.
- [ ] **Human-facing payload goes in `details`; the model gets a short `output`; programs get `structuredOutput`.** Evidence: pi `types.ts:154`, finding 8.
- [ ] **A turn-ending and channel-rising message path exists** (`sendToUser` + `terminate`). Evidence: grokbot, pi `types.ts:137`.
- [ ] **Anything that sends, installs, spends, or rewrites the agent's own configuration goes through approval, and approval is server-owned.** Evidence: [6][7][11], findings 10–12.
- [ ] **Tool loading is deferred only when the surface justifies it (≳10 tools).** Evidence: [3][8], finding 5.

## Mason applicability

**What mason already has.** Five tools at most: `CodingTools` (`read`, `write`, `edit`, `bash` through pi-env) plus `generateSandboxedUi` when enabled (`src/server/runtime.ts:29`, `BASE_EXTENSIONS`). The web client already has one purpose-built card: `WIDGET_TOOL = "generateSandboxedUi"` is special-cased in the pure transcript model (`src/web/lib/transcript-model.ts:26`), rendered by `WidgetCard` + `SandboxedUiCard` with a live `sendPrompt` bridge into `AgentService.submit` (`SandboxedUiCard.tsx:175`; `docs/UI-PLAN.md` §2.5 — a widget is the only trace piece that survives settlement). Everything else renders as a `ToolRow` with icons from `src/web/lib/tool-view.ts:53`. Client→server is eight methods (`src/shared/contract.ts`); no approvals concept exists in pi-durable or mason.

**Gap 1 — the tool list is not stable.** `setSandboxedUiEnabled` adds/removes both a tool *and* its 2,327-char section mid-conversation. That is exactly the edit Anthropic says invalidates all three cache levels [1], and on providers without mid-conversation tool changes pi collapses the transcript and rebuilds the prefix. Fix: keep `generateSandboxedUi` registered always, and when the client cannot render it return an error that names the fix ("Widget rendering is off for this conversation. Answer in text, or ask the user to enable widgets in the session bar."). The section can then also stay stable.

**Gap 2 — no approval primitive.** The pieces exist in pi-durable and are unused: `wrapTool(tool, wrapper)` to intercept `bash`/`write`/`edit` (`vendor/pi/packages/durable/src/harness/define.ts:34`), `api.details()` for a UI payload, `api.commit()` + `api.watchDoc()` (`types.ts:205`, `:915`, `WatchHandle` at `:898`) or `createTask`/`waitForTask` to park a call until a decision lands, `memo` + `replay: "safe"` to survive a restart, `ToolControl.terminate` to end a turn without another model call. One wrinkle: the view mounts a fixed five documents (`packages/durable/src/harness/view.ts:48`), so an approval document cannot ride `ConversationView.docs`. Mirror pending approvals into mason's own Chord state next to `agentStatus` (already derived in `src/server/main.ts`), and keep the decision path server-owned per OpenAI's rules [7].

**Gap 3 — the card mechanism is hardcoded.** Approval controls need the same treatment a widget already gets: a piece kind that survives settlement, a card renderer, and a client action. Generalize the `call.name === WIDGET_TOOL` check into a small tool→card registry in `src/web/lib/`, keeping it DOM-free so `test/transcript-model.test.ts` still covers it.

**SendToUser: adopt it, but not as a replacement for prose.** grokbot's model (prose is private, `SendToUser` is the only channel) buys channel routing, quiet turns, rich payloads and a turn-ending call. Making it *the* channel would cost mason the whole streaming path (`StreamText`, live bubbles, `pi.live.generation`), which is the main UX. The cheap version fits today: a `sendToUser` tool whose `details` carry the rendered message (kind `reply | notify`, optional `channel`), `control: { terminate: true }` for hook-driven turns, and a `message` piece kind rendered like a widget but with no iframe — the raw tool row shows only in debug. Rule of thumb: streamed prose answers a live conversation; `sendToUser` carries anything that must arrive when nobody is watching, plus anything that needs files, choices or a channel.

**Which tools need approval first.** Not payments (none exist) and not `generateSandboxedUi` (already sandboxed, reversible, and its result is the arguments). Order by blast radius: (1) self-edits — `write`/`edit` touching `SOUL.md`, `AGENTS.md`, skills or `hooks.json`, since those rewrite the agent's own prompt and schedule; (2) outbound messages and email when those tools land; (3) installs (`npm`/`pip`/`git clone` into the workspace) via a `bash` pattern gate; (4) writes outside the workspace and anything over the configured SSH target (`src/server/env.ts:22`). Bulk-gating all `bash` would gut the product, so gate *classes of effect*, not tools.

## Recommended actions

1. **[now]** Make `generateSandboxedUi` always registered and return an actionable error when rendering is off; keep its section installed with the base extensions. Add `test/harness-env.test.ts` coverage for the error path (`src/server/extensions/sandboxed-ui.ts`, `src/server/runtime.ts`).
2. **[now]** Add a tool-budget test: walk a registry snapshot, assert `description.length + JSON.stringify(parameters).length ≤ 4000` per tool and print the total. Cheap, and it is the check that will catch a runaway description later.
3. **[now]** Rewrite the two weak pi error paths mason depends on as a mason-side `wrapTool` (`read` offset beyond EOF, `edit` missing file) so both name the next action, per §6.
4. **[next]** Replace `WIDGET_TOOL` with a `CARD_TOOLS` map plus a shared `cardTool(name)` predicate; keep it DOM-free and extend `test/transcript-model.test.ts` with a second card type.
5. **[next]** Design `wrapTool`-based approval with a `pending approvals` Chord state cell, a `decideApproval` method on `AgentService`, a timeout that denies (fail closed, like [7]), and a decision record the tool reads back through `memo` so a restart cannot double-approve. Write the decision rule as an ADR: gate self-edits and outbound effects, not `bash` in the workspace.
6. **[next]** Build `ApprovalCard` on the new card mechanism: a diff or args preview, Allow/Deny, and the reason string shown to the approver.
7. **[next]** Add `sendToUser` with `details`-carried content, `kind`, optional `channel`, and `terminate` for hook-driven turns; render it as a `message` piece. Route email/Slack adapters later without changing the tool.
8. **[later]** Install `tool_search` once mason passes ~10 tools (memory, skills, routines, MCP) — not before; pi treats loading as a deliberate act that writes `modelTools` (`packages/durable/src/tool-search/tool-search.ts:3`, `packages/durable/src/harness/agent.ts:84`).
9. **[don't]** Don't add a widget/approval card per tool; don't let a tool description carry instruction text that belongs in a section; don't gate every shell command.

## Open questions

- grokbot's 4,000-char ceiling has no published source; it is consistent with measured MCP averages (~3K chars/tool) [3] but remains a lecture figure.
- Whether mason can park an approval without touching vendor/pi: a task-based design (`createTask` + `waitForTask`) needs a way for the server to commit a decision into a pending task from outside its invocation. Untested; the doc-mirroring route is the fallback.
- `https://platform.openai.com/docs/guides/function-calling` and `developers.openai.com` are Cloudflare-blocked from this environment; both were read through Wayback captures, so quotes are from the live text but the URL is the archive.
- ChatGPT's exact approval-then-render timing ([5]) is documented for `window.openai`; MCP Apps' own spec says less about approval, so hosts may differ.
- LangGraph's interrupt/checkpointer docs could not be fetched (redirect stub), so the framework survey rests on Vercel AI SDK and OpenAI Agents SDK only.

## Sources

1. https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching (via https://web.archive.org/web/2026/https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
2. https://www.anthropic.com/engineering/writing-tools-for-agents
3. https://www.anthropic.com/engineering/advanced-tool-use
4. https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
5. https://developers.openai.com/apps-sdk/build/chatgpt-ui/ (via https://web.archive.org/web/2026/https://developers.openai.com/apps-sdk/build/chatgpt-ui/)
6. https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling and https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx
7. https://openai.github.io/openai-agents-python/human_in_the_loop/
8. https://platform.openai.com/docs/guides/function-calling (via https://web.archive.org/web/2026/https://platform.openai.com/docs/guides/function-calling)
9. https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/server/tools.mdx
10. https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts
11. https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/client/elicitation.mdx
12. https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/client/sampling.mdx
13. https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/17-mcp-apps.mdx
14. `vendor/pi/packages/ai/src/api/anthropic-messages.ts`
15. `vendor/pi/packages/ai/src/utils/transcript.ts`
16. `vendor/pi/packages/durable/src/harness/types.ts`
17. `vendor/pi/packages/durable/src/harness/prompt.ts`
18. `vendor/pi/packages/durable/src/harness/view.ts`
19. `vendor/pi/packages/durable/src/harness/define.ts`
20. `vendor/pi/packages/durable/src/harness/agent.ts`
21. `vendor/pi/packages/durable/src/tool-search/tool-search.ts`
22. `vendor/pi/packages/coding-agent/src/core/tools/{read,bash,edit,edit-diff,write}.ts`
23. `src/server/extensions/sandboxed-ui.ts`, `src/server/extensions/agent-identity.ts`, `src/server/runtime.ts`, `src/server/main.ts`, `src/server/env.ts`
24. `src/shared/contract.ts`, `src/web/lib/transcript-model.ts`, `src/web/lib/tool-view.ts`, `src/web/components/{ToolRow,WidgetCard,SandboxedUiCard,MessageRow}.tsx`
25. `docs/UI-PLAN.md`, `docs/SPEC.md`, `test/transcript-model.test.ts`, `test/harness-env.test.ts`
26. `.scratch/grokbot-insights/SOURCE-grokbot-lecture.md`
