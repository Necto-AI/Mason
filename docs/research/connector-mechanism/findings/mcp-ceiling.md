# What can MCP 2025-11-25 actually carry for a mason connector, and where is the ceiling that makes a connector want to be code instead?

## Answer

MCP 2025-11-25 carries exactly one of the four things `docs/CONNECTOR-PROTOCOL.md` says a connector has: the tools face. It can also *carry the bytes* of a prompt section, a reply, an entry payload and a pushed notice — but every one of those primitives makes the **server** the author and the **request** the unit of work, and mason's connector contract needs the operator to be the author and a fact to be able to arrive with no turn in flight. Two gaps are not extension-shaped: the connector can offer, never *declare* (authority over the prompt, the command vocabulary and the entry kind stays mason's, by design), and it cannot speak first with an identity (MCP has no authenticated server→host door, and the SEP that asked for one — SEP-1006 — was closed `dormant` on 2025-11-05 for lack of a sponsor). Everything MCP genuinely adds beyond tools (`sampling`, `elicitation`, `logging`, `roots`) is now deprecated or replaced as of the 2026-07-28 revision, so a connector built on MCP's client-facing half is built on a shrinking surface. A connector that needs prompt sections, routing, commands, state and ingest is asking for host-side authority — which is code, or it is mason's config, and MCP is neither.

## Claims

**A. The primitives, their direction, and what mason actually pulls.** (`mason today` column: [25] `src/server/mcp.ts`, [26] `src/server/events.ts`; grep over `src/` finds no other MCP method.)

| # | Primitive (2025-11-25) | Direction | What it carries | mason today | Src |
|---|---|---|---|---|---|
| 1 | `tools/list`, `tools/call` | client→server request, result back | JSON-Schema'd callables; result is typed content blocks plus optional `structuredContent` | **Yes, and only this.** "its `tools/list` registered as deferred tools. Boot is the only moment this happens" | [8][25] |
| 2 | `instructions` (InitializeResult) | server→client, once per session | one opaque string of server-authored guidance | **No.** pi-mcp exposes it (`get instructions()`), mason never reads it | [5][29] |
| 3 | `prompts/list`, `prompts/get` | client→server | user-selected message templates ("slash commands"); result is *messages* | **No** | [9] |
| 4 | `resources/list` / `read` / `templates/list` | client→server | application-controlled context blobs addressed by URI | **No** | [10] |
| 5 | `resources/subscribe` + `notifications/resources/updated` | client subscribes, server notifies | "that URI changed" — no payload, read is a second step | **No** | [10] |
| 6 | `notifications/{tools,prompts,resources}/list_changed` | server→client, one-way | "my list changed" | **No**, and mcp.ts forbids the consequence: the tool list *is* prompt prefix | [8][9][10][25] |
| 7 | `sampling/createMessage` (+ `tools`, `toolChoice` new in 2025-11-25) | server→client **request** | a whole model call, nested inside a server's own feature | **No** — mason declares no client capabilities at all | [11][29] |
| 8 | `elicitation/create` (`form`, `url`) | server→client **request** | a question for a person: flat primitive schema, or a URL to open | **No** | [12] |
| 9 | `roots/list` | server→client request | the client's filesystem roots | **No** | [5][3] |
| 10 | `notifications/message` (`logging`) | server→client | syslog-levelled structured slog | **No** | [14] |
| 11 | `notifications/progress` | both, bound to a live request's token | progress numbers for that request | **No** — `callTool(..., { timeoutMs })` passes no `onProgress` | [15][25] |
| 12 | `completion/complete` | client→server | argument autocomplete | **No** | [9][10] |
| 13 | `tasks/*` (experimental in this revision) | both | durable request handles: create, poll, result, cancel | **No** | [13] |
| 14 | `_meta` | both | namespaced extension metadata | **Dropped on purpose:** "`_meta` is dropped as the coding agent drops it" | [4][25] |

**B. What a server can push unsolicited, and what it cannot.**

| Can (2025-11-25) | Quote / rule | Src |
|---|---|---|
| Open a channel the client did not ask a question on | "The client MAY issue an HTTP GET to the MCP endpoint... allowing the server to communicate to the client, without the client first sending data via HTTP POST" | [6] |
| Send requests and notifications unrelated to any in-flight request | "The server MAY send JSON-RPC requests and notifications on the stream. These messages SHOULD be unrelated to any concurrently-running JSON-RPC request from the client." | [6] |
| Announce list changes | only if it declared `listChanged`, and only `SHOULD` | [8][9][10] |
| Announce a resource change | only for a URI that client subscribed to | [10] |
| Emit log notifications | after the `initialized` notification | [5][14] |
| Ask for a model call / a person's input | `sampling/createMessage`, `elicitation/create` — **capability-gated on the client** | [11][12] |
| Report task status, URL-elicitation completion | `MAY`, never relied upon | [12][13] |

| Cannot | Quote / rule | Src |
|---|---|---|
| Get an answer to a notification | "Notifications are sent from the client to the server or vice versa, as a one-way message. The receiver MUST NOT send a response." | [4] |
| Make the host *do* work and learn the result | no server→client request executes host work; sampling asks the model, elicitation asks the person | [11][12] |
| Read the conversation | "Servers should not be able to read the whole conversation, nor "see into" other servers" | [3] |
| Speak as a person | `Role: "user" \| "assistant"`; no identity, no roster, no surface | [16] |
| Be believed about itself | "Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers." | [16] |
| Reach a host that is not connected | no webhook/callback anywhere in the spec; a server can only answer a connection it has | [6] |
| Push a payload on a subscription | `notifications/resources/updated` carries the `uri` only | [10] |

**C. The mismatch list — one row per thing a mason connector needs.**

| Need | Can MCP express it? | Evidence | Src |
|---|---|---|---|
| A prompt section approved by the operator | **No.** MCP can carry the *text* three ways (`instructions`, `prompts/get`, `resources/read`) and every one makes the server its author. Prompts are "designed to be **user-controlled**"; the whole primitive is "the user being able to explicitly select them for use". Mason's rule is the opposite: "It is injected once per turn, from the file, never from the remote server". | partial carrier, wrong author | [9][27] |
| A reply tool with routing | **Half.** A tool can be the *landing pad* and return an id, and mason's contract says exactly that ("`reply` dispatches to the origin connector's declared reply tool"). But routing needs the turn's origin and the room, and the server sees neither: "Servers receive only necessary contextual information". The router must stay mason's, because "a prompt must never name a vendor's tool". | partial | [3][27] |
| A command vocabulary like `/stop` | **No.** A `prompt` is the slash-command-shaped primitive, but its only effect is to return messages — it cannot invoke a host method, and the actor is the person choosing it, not the model. As a tool it is model-controlled, which is the wrong actor for mason's reason: "a chat should reach exactly what a person at a console can reach". | no | [7][9][26] |
| A state subscription to the projection | **No.** `resources/subscribe` is the *client* subscribing to the *server's* URIs; there is no direction in which a server asks the host for host state. Today the console gets it over Chord, not MCP. | no | [10][28] |
| Typed entry kinds in the projection | **Data yes, meaning no.** MCP carries typed content blocks and `structuredContent`, but no host-transcript vocabulary; `_meta` is the only "kind" slot and mason drops it. In mason, only the projection may name a kind: "a transcript item exists only because something here names it". | no | [8][16][32] |
| Ingest that runs when no turn is happening | **No.** The only unsolicited server→host channel is notifications, which "MUST NOT" be answered, and none of them means "a person said something". SEP-1006 asked for the reverse call and was closed: "Since this has not found a sponsor since July. I will close this for now" (dsp-ant, 2025-11-05; label `dormant`). Today this travels entirely outside MCP, as an HMAC'd POST to `/api/events/<integration>`. | no | [4][23][26] |
| A tool whose output the model must not read | **No.** The protocol has no "not for the model" field. The nearest hint is `annotations.audience`, whose "Valid values are `user` and `assistant`" — a hint, with no "never". The channel *exists* in pi's harness ("`structuredOutput` for programs", "The model never sees structured output"), but that split is the **host's** projection, not a declaration the server can make; and mason currently shows the model the result anyway. | no | [10][16][30][25] |

**D. Claim lines.**

- MCP's three server primitives divide by who controls them, and the only one mason can use is the model-controlled one; prompts and resources are referenced nowhere in `src/` [7][9][25] — "Tools | Model-controlled | Functions exposed to the LLM to take actions" — direct
- mason's MCP client declares no client capabilities, so `sampling`, `elicitation`, `roots` and `tasks` cannot fire at it even in principle [29] — "const capabilities: ClientCapabilities = { ...this.options.capabilities }" and mason passes no `capabilities` — partial
- Any client-facing MCP feature is opt-in per host, and mainstream agent harnesses ship without it: opencode advertises none [24] — "No `capabilities` object passed to `new Client(...)` — opencode advertises nothing at `initialize`" — direct
- The one thing mason would want most — a server that starts something — was proposed as a SEP and closed for lack of a sponsor [23] — "Currently, the ModelContextProtocol (MCP) is designed as a one-way protocol" — direct
- That direction is still unshipped as of the latest roadmap, where it is a *priority*, not a spec [20] — "server-initiated events (webhooks and channels, so clients aren't left polling for results)" — direct
- A server may not be answered when it speaks first [4] — "The receiver MUST NOT send a response." — direct
- A server may not see the conversation, which is what routing and prompt sections would require [3] — "Full conversation history stays with the host" — direct
- A server's self-description is explicitly untrusted by the protocol [16] — "Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers." — direct
- mason deliberately ignores `list_changed`, because the tool list is the prompt prefix [25] — "Boot is the only moment this happens, because the tool list is prompt prefix" — direct
- The spec says the opposite policy — servers SHOULD notify and clients SHOULD re-list [8] — "When the list of available tools changes, servers that declared the `listChanged` capability SHOULD send a notification" — direct
- 2025-11-25's only escape hatch is a bag of `experimental` capability entries; a formal `extensions` capability field postdates it [18] — "Add `extensions` field to `ClientCapabilities` and `ServerCapabilities`" — direct
- The revision this brief examines is already superseded; the current one removes sessions and server-initiated requests [18][19] — "replaces the previous approach of sending server-initiated requests, such as `roots/list`, `sampling/createMessage`, or `elicitation/create`" — direct
- Sampling, logging and roots are deprecated in the current revision [18] — "new implementations should not add support for them" — direct
- So the *carrying capacity* is not the binding constraint; the **authority** is. mason already states the ceiling in its own ADR [27] — "an MCP server that could write into the system prompt would be writing instructions an operator never approved" — direct
- mason's connector contract already answers this by moving three of four channels off MCP [28] — "A process, not a page. It speaks at most four channels to mason" — direct
- Ingest is the sharpest gap: no MCP primitive can deliver a fact with no turn in flight, and none carries a sender identity independent of the session [4][6][26] — "one trigger, one hook" over a "versioned envelope... signature" — partial
- The pi harness can keep a result from the model, but only because the *host* decides, not because the server declares it [30] — "The model never sees structured output, so its call stands" — direct
- **Researcher inference:** therefore a connector needing prompt sections, commands, routing, state and ingest is asking for host-side authority, and no MCP extension can grant authority over the host's own prompt — that is a config file or it is code [27][28] — inferred

## Sources

[1] Specification, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25.md — spec revision 2025-11-25, accessed 2026-10-30 — primary
[2] Key Changes, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/changelog.md — same, accessed 2026-10-30 — primary
[3] Architecture, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/architecture/index.md — accessed 2026-10-30 — primary
[4] Base Protocol Overview, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/basic/index.md — accessed 2026-10-30 — primary
[5] Lifecycle, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle.md — accessed 2026-10-30 — primary
[6] Transports, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/basic/transports.md — accessed 2026-10-30 — primary
[7] Server Features Overview, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/server/index.md — accessed 2026-10-30 — primary
[8] Server / Tools, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/server/tools.md — accessed 2026-10-30 — primary
[9] Server / Prompts, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/server/prompts.md — accessed 2026-10-30 — primary
[10] Server / Resources, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/server/resources.md — accessed 2026-10-30 — primary
[11] Client / Sampling, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/client/sampling.md — accessed 2026-10-30 — primary
[12] Client / Elicitation, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation.md — accessed 2026-10-30 — primary
[13] Utilities / Tasks, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks.md — accessed 2026-10-30 — primary
[14] Utilities / Logging, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging.md — accessed 2026-10-30 — primary
[15] Utilities / Progress, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress.md — accessed 2026-10-30 — primary
[16] Schema Reference, 2025-11-25 — https://modelcontextprotocol.io/specification/2025-11-25/schema.md — accessed 2026-10-30 — primary
[17] Blog: "One Year of MCP: November 2025 Spec Release" — https://blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/ — published 2025-11-25, accessed 2026-10-30 — vendor blog (release announcement; also the source of the "extensions" concept, pre-dating any `extensions` capability field)
[18] Key Changes, 2026-07-28 — https://modelcontextprotocol.io/specification/2026-07-28/changelog.md — spec revision 2026-07-28, accessed 2026-10-30 — primary
[19] Blog: "The 2026-07-28 Specification" — https://blog.modelcontextprotocol.io/posts/2026-07-28/ — published 2026-07-28, accessed 2026-10-30 — vendor blog
[20] Blog: "The New MCP Roadmap" — https://blog.modelcontextprotocol.io/posts/mcp-roadmap/ — published 2026-08-22, accessed 2026-10-30 — vendor blog
[21] Extensions Overview — https://modelcontextprotocol.io/extensions/overview.md — accessed 2026-10-30 — docs (current tree; describes the post-2026 extension lifecycle, not the 2025-11-25 one)
[22] Skills over MCP extension — https://modelcontextprotocol.io/extensions/skills/overview.md — accessed 2026-10-30 — docs (the closest thing to a *server-contributed* prompt section: instructions read through `resources/read`, with host-side approval)
[23] SEP-1006 "Bidirectional Tool Calls in Model Context Protocol" — https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1006 — opened 2025-07-19, closed 2026-02-08, labels include `dormant`; fetched via api.github.com — primary
[24] opencode issue #28567 "[FEATURE]: Full MCP client capabilities" — https://github.com/anomalyco/opencode/issues/28567 — created 2026-05-21, fetched via api.github.com — primary
[25] mason `src/server/mcp.ts` — local, 404 lines, read 2026-10-30 — primary (the running code)
[26] mason `src/server/events.ts` — local, 184 lines, read 2026-10-30 — primary
[27] mason `docs/adr/0006-connectors-are-full-duplex-peers.md` — local, dated 2026-10-26, status Proposed — primary
[28] mason `docs/CONNECTOR-PROTOCOL.md` — local, marked "proposed" — primary
[29] `vendor/pi/packages/mcp/src/client.ts` and `protocol/types.ts` — local; `LATEST_PROTOCOL_VERSION = "2025-11-25"`, `SUPPORTED_PROTOCOL_VERSIONS` down to `2024-11-05` — primary
[30] `vendor/pi/packages/durable/src/harness/tool.ts` and `harness/types.ts` — local; the `output` / `structuredOutput` / `details` three-channel split — primary
[32] mason `src/server/projection.ts` — local; the transcript whitelist ("The rule is a whitelist, not a filter") — primary
[31] Rejected/deprioritized: pulsemcp.com "Mind the MCP Client Capability Gap" — 403 Cloudflare, could not verify; the claim it supports is carried instead by [24] and by mason's own code. Also rejected: chatforest.com and connector.zone explainers on event-driven MCP (secondary, cite primaries I fetched directly).

## Conflicts

1. **The spec's `list_changed` policy vs mason's boot-once policy — a real, deliberate disagreement.**
   Spec [8]: "When the list of available tools changes, servers that declared the `listChanged` capability SHOULD send a notification".
   mason [25]: "Boot is the only moment this happens, because the tool list is prompt prefix: a surface that changed when a server reconnected would re-price the prefix mid-conversation".
   This is mason declining a SHOULD. It is not a spec bug and not a mason bug — it is the point where the two designs cannot both be satisfied, and any connector mechanism has to pick.

2. **The brief's revision is not the current revision.** The task fixes the subject at 2025-11-25. The site's release post [19] says: "Today, we're officially pushing the release button on the next version of the MCP specification, 2026-07-28" (2026-07-28), and that revision changes the shape of every client-facing feature this analysis touches (sessions removed, server-initiated requests replaced, sampling/logging/roots deprecated). Both statements are true; the second bounds the first. Recorded, not resolved.

3. **mason's own docs disagree with each other about how many channels a connector has.** `docs/adr/0003-integrations-are-services.md` (per the brief) makes an integration a service with two faces; `docs/CONNECTOR-PROTOCOL.md` [28] says "It speaks at most four channels to mason" (events, tools, state, reply), and ADR-0006 [27] proposes adding them. That is the disagreement this run exists to settle, not a factual conflict I can resolve here.

4. **Where a server-authored prompt section may come from.** mason [27]: "never from the remote server". The MCP project is meanwhile building the opposite idea — Skills over MCP [22]: "Serving them over MCP keeps those instructions with the service they describe", with approval moved host-side ("applies any required user approval before loading it into model context"). Not a contradiction in fact — both put a lock on it — but the locks are in different places: mason's is the operator's file, MCP's is the host's consent UI. Worth naming separately when the ADR argues its trust model.

## Unanswered

- **Whether honouring `list_changed` would actually re-price the prefix in pi-durable.** I read mcp.ts's claim and the deferred-tool mechanics but did not run the harness; whether a mid-session `tools/list` refresh invalidates the cached prefix, or only the deferred index, is unverified. This is the single most decision-relevant unknown for candidate C: if a list change is cheap, one of gap 1's blockers softens.
- **Whether pi-mcp would even surface `notifications/message` / `list_changed` to mason as-is.** `McpClient` has `onNotification(method, listener)` and `setRequestHandler(method, handler)`, and mason calls neither; I did not check how pi-mcp dispatches a notification with no listener (drop? queue? log?). Unverified.
- **The status of the "Events" proposal** (modelcontextprotocol/modelcontextprotocol issue #611, 2025-05-30) — I saw it only as a search excerpt; whether it has a sponsor today, and whether it overlaps SEP-1006's revival (the Feb 2026 comments on [23] ask to revive it), was not established. This is where the next round should look for "will MCP ever carry ingest".
- **Per-client capability matrices.** The Apify `mcp-client-capabilities` registry and PulseMCP's analysis are the obvious primaries for "no host implements MCP's client half"; the PulseMCP page returned 403 and I did not fetch the Apify one. The claim in this file rests on [24] plus mason's own code, which is enough for mason but not for the ecosystem-wide sentence.
- **Whether `instructions` is honoured by any host in a way mason could imitate.** The spec defines it as one optional string; [24]'s gap list and the PulseMCP excerpt both suggest hosts ignore it. Not verified against a host that does.
- **Cost.** No measurement of what a prompt section or a command vocabulary costs in tokens for the two candidate mechanisms. Out of scope here, but the ADR's cost section will need it.

## Queries

web_search calls actually run (provider: exa):
1. `MCP limitation server cannot initiate a conversation turn client only reacts to user`
2. `"model context protocol" server "push" notification host wake agent unsolicited no way`
3. `PulseMCP "client capability gap" MCP clients do not implement sampling elicitation notifications`

Primary pages fetched directly with curl (not via search): every `modelcontextprotocol.io/specification/2025-11-25/*.md` and `2026-07-28/changelog.md` (the `.md` suffix serves clean spec source — the HTML is a JS shell), `extensions/overview.md`, `extensions/skills/overview.md`, `blog.modelcontextprotocol.io/posts/2025-11-25-first-mcp-anniversary/`, `.../posts/mcp-roadmap/`, `.../archives/`, plus `api.github.com` for issues 1006 and opencode 28567. Local reads: `src/server/mcp.ts`, `src/server/events.ts`, `src/server/projection.ts`, `docs/adr/0006`, `docs/CONNECTOR-PROTOCOL.md`, `vendor/pi/packages/mcp/src/client.ts`, `vendor/pi/packages/mcp/src/protocol/types.ts`, `vendor/pi/packages/durable/src/harness/tool.ts`, `.../harness/types.ts`.
