# The adjacent field — OpenClaw (OSS), Instinct (closed beta), the enterprise control plane, and the substrate they all cite

> Research note, 2026-10-26. OpenClaw is an MIT-licensed self-hosted personal-agent runtime, Instinct a closed invite-only consumer assistant, and Microsoft Agent 365 with Entra Agent ID the governance layer above them, all citing the same standards. 32 primary sources, one flagged secondary.
> Written for docs/research/always-on-agents/. Facts carry their source; [inference] marks reasoning, not evidence.

## What it is

Both named leads are real products, and they are not the same kind of thing.

- **OpenClaw** is an open-source (MIT) self-hosted personal-agent runtime: one long-lived **Gateway** process on your own machine that owns every messaging surface and routes each inbound message to an **agent** with its own workspace, credentials and session store [4][8][15]. 393,051 GitHub stars, last push 2026-10-25, MIT [15].
- **Instinct** is a closed, invite-only consumer assistant operated by **Spear Street Technology, Inc. d/b/a Instinct**, whose entire public surface is one marketing page plus a Terms of Service and a Privacy Policy. It texts and calls, and it drives "a phone and computer in the same way that you do" [18][19][20]. No docs, no security page, no pricing (checked: `instinct.com/security`, `/docs`, `/faq` return the bare app shell).
- Wired's Muse review of 2026-09-20 described Muse as a mainstream version of agents "already popular in Silicon Valley for automating personal tasks, like OpenClaw and Instinct" [1].

The third thing worth naming is not a competitor but the layer above both: **Microsoft Agent 365**, sold as "the control plane for agents" — registry, agents map, analytics, policy-template onboarding, "observe, govern, and secure every agent" [21], with **Microsoft Entra Agent ID** as the identity system underneath it [22].

## Axis findings

### OpenClaw — 1. Product model

- The unit is the **agent**: "the full per-persona scope: workspace files, auth profiles, model registry, and session store." A **binding** maps a channel account (a Slack workspace, a WhatsApp number) to one agent [8].
- Agents are files first: the workspace bootstrap auto-injects `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, `MEMORY.md` every session, and nothing else from subdirectories [9].
- One Gateway per host, and it "is the only place that opens a WhatsApp session" [4].

### OpenClaw — 2. Runtime

- Runs on the operator's machine, not a vendor VM. Gateway binds `127.0.0.1:18789` by default; container images default to an exposed bind, which the docs call out as a deliberate exception [4][10].
- The workspace is **not** a sandbox: "The workspace is the **default cwd**, not a hard sandbox. Tools resolve relative paths against the workspace, but absolute paths can still reach elsewhere on the host unless sandboxing is enabled." Sandbox mode moves tools into `~/.openclaw/sandboxes` [6].
- Built-in runtime id is `openclaw`; "The legacy alias `pi` normalizes to `openclaw`"; plugin harnesses register other ids such as `codex`. Plaintext official HTTP endpoints are rejected when selecting a harness [5].
- `@earendil-works/pi-tui` remains a third-party dependency for the TUI [5].
- **Nodes** (macOS/iOS/Android/headless) join over the same WebSocket with `role: node` and expose `camera.*`, `screen.record`, `location.get`; pairing is device-based with an approval store [4].

### OpenClaw — 3. Identity & auth

- Auth profiles are per-agent, stored in `<agentDir>/openclaw-agent.sqlite` (`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`) [8].
- Cross-agent credential inheritance is explicit: when a secondary agent's local OAuth credential expires, OpenClaw "reads through to the auth-inheritance owner's credential for the same profile id and adopts whichever token is freshest, without copying the refresh token"; "OAuth refresh material is not portable by default" [8].
- Config, credentials and sessions live in `~/.openclaw/`, deliberately separate from the workspace the model can write [6].

### OpenClaw — 4. Memory

- Memory Core is "plain files and one SQLite index, organized into tiers with different trust levels, write rules, and injection behavior" [7].
- Five stated principles, the first of which is "**No hidden state.** The model only remembers what is written to files in the agent workspace. Every memory surface is inspectable and editable with a text editor." [7]
- Third principle is a security claim masquerading as a storage decision: "**The write path is the security boundary.** Content-level scanning of memory cannot catch poisoned facts reliably, so OpenClaw enforces provenance at write time and gates promotion structurally instead of trying to detect bad memories later." [7]
- Curation runs "off the busy reply path" in a background pass ("dreaming"), with recall lanes and a user model [7].

### OpenClaw — 5. Always-on mechanics

- Three mechanisms under one heading: **automations** (cron jobs, webhooks, Gmail Pub/Sub triggers, IMAP), **hooks** (internal lifecycle events), and **standing orders** [3].
- Standing orders are "**permanent operating authority** for defined programs", each with scope, triggers, approval gates and escalation rules, and they are loaded through the same bootstrap injection as `AGENTS.md` [9].
- Automations support announce/webhook/none delivery and failure alerts [3].

### OpenClaw — 6. Tools

- MCP is first-class: the docs index carries dedicated "MCP and agent interop" material and the security audit tracks MCP/agent-interop advisories as a category [3][12].
- Skills are markdown, loaded from each agent workspace plus shared roots such as `~/.openclaw/skills`, filtered by a per-agent allowlist [8].
- ClawHub is the public skill registry, scanned per version: "Static analysis, VirusTotal, and NVIDIA SkillSpector check every ClawHub skill version before listing", with 67,453 scans published [12].
- A2A 1.0 is shipped as a channel plugin, so external agents can task OpenClaw over the same surface as a human [16].

### OpenClaw — 7. Permissions & approvals

- The security audit is the approval story's backbone: it checks DM/trust model (shared main sessions, group scope), webhook token reuse, sandbox configuration, sandbox browser network modes, mDNS leakage, `gateway.auth.mode="none"`, unpinned plugins, and allowlists that key on mutable names instead of stable IDs [11].
- It explicitly warns when small models (≤300B) run unsandboxed with web/browser tools, and when write/edit tools are disabled while `exec` stays available without a filesystem boundary [11].
- `exec` approvals and tool-policy profiles are separate documented surfaces — the docs index carries "Discord components and approvals … exec approvals in Discord" and a `openclaw policy` CLI for inspecting "the tool policy the guidance above configures" [3][10]. The approval *UX* is unverified.

### OpenClaw — 8. Models

- Provider-agnostic: model/provider registry under `src/llm/`, per-model runtime policy (`agentRuntime.id`, model entry wins over provider entry), `auto` resolution, model failover, compaction, context engine [5][3].
- Gateway startup builds "one prepared model runtime generation per configured agent" so a failed generation is never served alongside a newer partial one [5].

### OpenClaw — 9. Multi-agent

- Multiple isolated agents in one process, each with workspace, `agentDir` and SQLite session store; plus subagent thread sessions and an agent-to-agent access switch with an allow list [8][11].
- The audit emits `security.trust_model.cross_agent_session_access_default` when agent-to-agent access is open and session visibility resolves to `all` [11] — i.e. "several agents" is treated as a trust-boundary problem, not a feature toggle.

### OpenClaw — 10. Surface

- Channels: Discord, Google Chat, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp, Zalo, plus WebChat, a macOS app, CLI and Control UI [2][4].
- Presence is a real read model, not a spinner: a `presence` tool and `presence.query` RPC return people, their connected clients and devices, and observed activity, with `include: ["devices","network","location"]` [17].

### OpenClaw — 11. Plans, limits, pricing

- The software is free and the project sells no consumer plan: "No subscription. No hosted tier. No token. Stewarded by an independent 501(c)(3). Your memories. Your skills. Your models. Your machines. Your data." [2]
- The commercial surface is **OpenClaw Enterprise**, labelled "Open source · Pre-1.0": "A vendor neutral control plane for persistent agents in sensitive environments", "Pre-1.0 software, intended for internal pilot workloads". No price is published [14].
- You pay your model provider directly; the docs assume your own keys [2][5].

### OpenClaw — 12. Safety & failure modes

- The trust model is stated as a scope limit, not a promise: "**One trust boundary per gateway.** … OpenClaw is not a hostile multi-tenant security boundary for mutually adversarial users sharing one agent or gateway. For mixed-trust or adversarial-user operation, split trust boundaries: separate gateway + credentials, ideally separate OS users or hosts." [10]
- There is a published threat model mapped to MITRE ATLAS (`/security/THREAT-MODEL-ATLAS`) plus a prompt-injection page about "Untrusted content reaching the model, model choice, and the wrapping that bounds it" [10].
- The project publishes its own vulnerability ledger: "1,799 Reports filed Since January 2026", "722 Fixed and published 39 carry a CVE", "14 Confirmed critical All 14 fixed and disclosed", latest advisory 2026-09-11 [12].
- Failure is documented in public, including a release-quality incident: "Gateways got slower. Some installs got stuck in plugin dependency repair loops. … People downgraded. People lost time." with the fix being a smaller core, plugins moved to ClawHub, and an LTS line [13].

### Instinct — 1. Product model

- One assistant per person, addressed by text or call: "The interface is simple: there are no new interfaces. You can text or call it." [18]
- "You may only create one Account at a time to use the Services, unless we agree otherwise." [19]

### Instinct — 2. Runtime

- "It can use a phone and computer in the same way that you do." [18]
- The Terms describe the client as "any related Mac OS application or other computer or mobile applications", so the user-facing app is macOS/mobile [19]. Where the computer it operates actually runs, what OS it is, whether it persists between sessions, and whether it is per-user are **not stated anywhere** [18][19][20].

### Instinct — 3. Identity & auth

- The model is credential custody by the vendor, not per-agent accounts: "you may provide your payment information to the personal assistant so it can book rides on your behalf or your username and password for third-party accounts so that the personal assistant can sign into these accounts on your behalf" [20].
- "You hereby authorize the Services to access and interact with Connected Services on your behalf. You also authorize us to access, copy, collect, and index data from your Connected Services … and take Actions on Connected Services on your behalf." [19]
- There is a **Vault** whose contents are excluded from training, but the ToS does not say how it is encrypted or who can read it [19][20].

### Instinct — 4. Memory

- Memory is index-of-everything, with deletion as a separate act: "even if you disconnect a Connected Service, we may still use the indexed Connected Service Input data unless you follow the instructions to request deletion", via `app.instinct.com/workspace` [19].
- Training on your Materials is on by default with an opt-out at `app.instinct.com/settings`, plus a safety-review carve-out and go-forward-only semantics [19][20].
- Storage format, retrieval and retention windows are not disclosed [19][20].

### Instinct — 5. Always-on mechanics

- Nothing published. The homepage claims it "understands what you're working on and what's important to you" but describes no schedules, triggers, wake conditions or quiet hours [18].

### Instinct — 6. Tools

- The advertised tool set is the computer, the phone, and connected accounts: "order ingredients for a new recipe, book a train home for the weekend, order groceries, send flowers to a friend, or find a court for the weekend" [18].
- No tool declaration format, connector list, sandbox description or artifact model is published [18][19].

### Instinct — 7. Permissions & approvals

- Approvals are disclaimed rather than specified: "We may implement safeguards, confirmation requirements, or other controls on certain Actions; however, we make no representation or warranty that such safeguards will prevent unintended or erroneous Actions." [19]
- The audit trail is explicitly fallible: "Records of Actions available through the Services may not always be accurate." [19]
- Irreversibility is put on the user: "Actions may not always be reversible", and "You hereby appoint the Services as your agent to enter into agreements, commitments or transactions on your behalf … Any such agreements or commitments shall be binding on you as if entered into directly by you." [19]

### Instinct — 8. Models

- "third-party AI model providers" may process input; no model names, no routing, no context handling published [20].
- Google Workspace data is carved out harder than the rest: not used for training, and "we do not disclose raw or derived Workspace or Photos API user data to third party AI services, including third-party AI model providers, for model training or secondary purposes" [20].

### Instinct — 9. Multi-agent

- Not documented; the ToS assumes a single account and a single assistant ("You may not allow anyone else to use your Account") [19].

### Instinct — 10. Surface

- Text and voice on the user's existing phone, plus a web workspace at `app.instinct.com` for settings, Vault and deletion [18][19].
- No activity/progress surface, no artifact store, no handoff model is described [18].

### Instinct — 11. Plans, limits, pricing

- The ToS has a "Paid services" section and contemplates fees, but no price, tier, allowance or concurrency limit is published on the site [19].
- Access is invite/waitlist-only per press [unverified: secondary].

### Instinct — 12. Safety & failure modes

- The Privacy Policy names the threat model in two sentences, and it is the same one the rest of the field uses: "the possibility of unintended actions (including unintended payments or communications to outside parties), incorrect or incomplete outputs, and interactions with third parties who may include misleading instructions intended to influence autonomous agents." [20]
- No security page, no threat model document, no incident writeup, no prompt-injection guidance, no subprocessor list. The only control surface published is "request deletion" [19][20].

### Microsoft Agent 365 — what is documented

- Positioned as administration, not an agent runtime: "a control plane to observe, govern, and secure every agent across your organization", with a registry covering agents "built with Microsoft AI platforms, agents from our ecosystem partners, and any agents you register yourself", an agents map, per-role oversight, and onboarding that applies "security policy templates" [21].
- No runtime, memory, always-on or pricing facts are published: the page only offers "See plans and pricing" [21].

### Microsoft Entra Agent ID — what is documented

- The identity substrate for that control plane: agent identities, **agent identity blueprints**, an "agent's user account", agent service principals, "Authorization in Agent ID", inheritable permissions, "Authentication protocols for agents", Conditional Access for agents and ID Protection for agents [22].
- That list is the clearest published answer in this whole survey to "what identity does the outside world see": an agent can be a directory principal with an owner, a sponsor, a lifecycle and its own conditional-access policy [22].

### Shared substrate — the standards this class actually cites

- **Governance.** The Linux Foundation's **Agentic AI Foundation** now hosts the pile: Model Context Protocol, Agent2Agent, **AGENTS.md**, **Agent Skills**, Open Responses, agentgateway, Agent Router, Goose, OpenEnv, OpenSandbox [23][31]. OpenClaw's own A2A page points at "the Linux Foundation Agent2Agent protocol" [16].
- **MCP**, current spec `2026-07-28`: JSON-RPC 2.0 between **Hosts**, **Clients** and **Servers**, with resources/tools/prompts as the server-side features [24]. Authorization is delegated to OAuth, not invented: "follows the conventions outlined for OAuth 2.1", with a `401` carrying RFC 9728 **Protected Resource Metadata**, optional **Dynamic Client Registration**, authorization-code + PKCE, and an audience/resource binding so a token minted for one server is not replayable at another ("This is key to help avoid token passthrough scenarios") [25].
- **A2A**, v1.0, with JSON-RPC, gRPC and HTTP+JSON bindings, task lifecycle operations (SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask, SubscribeToTask, push-notification configs) and discovery through an Agent Card at `/.well-known/agent-card.json` [26][27].
  - Identity is in the spec twice: security schemes as first-class objects (`APIKeySecurityScheme`, `HTTPAuthSecurityScheme`, `OAuth2SecurityScheme`, `OpenIdConnectSecurityScheme`, plus the `OAuthFlows` set including device-code) [26], and **Agent Card signing**: "Agent Cards **MAY** be digitally signed using JSON Web Signature (JWS) as defined in RFC 7515 … Before signing, the Agent Card content **MUST** be canonicalized using the JSON Canonicalization Scheme (JCS) as defined in RFC 8785" [26].
- **AG-UI** is cited as the third leg, in its own words: "**MCP** … Connects agents to tools and to context … **A2A** … Connects agents to other agents … **AG-UI (Agent–User Interaction)** Connects agents to users", and "a single agent can and often does use all 3 simultaneously" [28]. The docs index shows AG-UI 1.0 with a per-SDK migration guide [32].
- **Agentic security guidance** has converged on OWASP rather than on any vendor doc: **OWASP Top 10 for Agentic Applications 2026** (December 9, 2025, "globally peer-reviewed … more than 100 industry experts") [29], preceded by **Agentic AI – Threats and Mitigations** (February 17, 2025, "the first in a series of guides from the OWASP Agentic Security Initiative") [30], with a "Multi-Agentic System Threat Modeling Guide v1.0" and "Securing Agentic Applications Guide 1.0" in the same catalogue [33].
- The one vendor threat model published in the open is OpenClaw's, mapped to **MITRE ATLAS** [10]. Two different vocabularies — OWASP for the risk list, ATLAS for the adversary technique — is the current state of the art, not a settled standard.

## Verbatim (the lines that carry the architecture)

> "A single long-lived **Gateway** owns all messaging surfaces (WhatsApp via Baileys, Telegram via grammY, Slack, Discord, Signal, iMessage, WebChat)." — [4]

> "An **agent** is the full per-persona scope: workspace files, auth profiles, model registry, and session store. A **binding** maps a channel account (a Slack workspace, a WhatsApp number, etc.) to one of those agents." — [8]

> "**No hidden state.** The model only remembers what is written to files in the agent workspace. Every memory surface is inspectable and editable with a text editor." — [7]

> "**The write path is the security boundary.** Content-level scanning of memory cannot catch poisoned facts reliably, so OpenClaw enforces provenance at write time and gates promotion structurally instead of trying to detect bad memories later." — [7]

> "Standing orders grant your agent **permanent operating authority** for defined programs." — [9]

> "The workspace is the **default cwd**, not a hard sandbox. Tools resolve relative paths against the workspace, but absolute paths can still reach elsewhere on the host unless sandboxing is enabled." — [6]

> "OpenClaw is not a hostile multi-tenant security boundary for mutually adversarial users sharing one agent or gateway." — [10]

> "No subscription. No hosted tier. No token. Stewarded by an independent 501(c)(3). Your memories. Your skills. Your models. Your machines. Your data." — [2]

> "The interface is simple: there are no new interfaces. You can text or call it. It can use a phone and computer in the same way that you do." — [18]

> "You hereby appoint the Services as your agent to enter into agreements, commitments or transactions on your behalf … Any such agreements or commitments shall be binding on you as if entered into directly by you." — [19]

> "We may implement safeguards, confirmation requirements, or other controls on certain Actions; however, we make no representation or warranty that such safeguards will prevent unintended or erroneous Actions." — [19]

> "Agent Cards **MAY** be digitally signed using JSON Web Signature (JWS) as defined in [RFC 7515] … Before signing, the Agent Card content **MUST** be canonicalized using the JSON Canonicalization Scheme (JCS) as defined in [RFC 8785]." — [26] (link markers elided)

## Open questions

- **The Wired lead text.** `wired.com` blocks this box directly and in the archive; the "designed to compete with OpenClaw and Instinct" phrasing and the 2026-09-20 review are known to me only from the search index [1]. Treat the sentence as secondary.
- **Instinct's runtime is entirely undisclosed.** No doc, security page, help centre or blog exists; `instinct.com/security`, `/docs`, `/faq`, `/blog` all redirect to the app shell. Where the "computer" runs, whether it is per-user, whether it persists, which models, what approvals look like, what it costs — all unverified.
- **Instinct funding/launch numbers.** Secondary sources disagree wildly ($250M Series B at $2.5B vs $1B Series C at $10B). I used neither. The only primary facts are the entity name (Spear Street Technology, Inc. d/b/a Instinct) and the ToS revision date (2026-08-26).
- **Is Instinct built on OpenClaw?** No primary source says so; Instinct publishes nothing about its stack. Unverified either way.
- **Google.** `gemini.google/agents/` returns a sign-in wall from this box; I could not verify any Google always-on consumer agent, and Wired's mention of "Google's CC" is unexplained. Not covered.
- **Anthropic, Amazon, Apple, Perplexity, Meta Muse, xAI Grok Bot, OpenAI Dots.** Out of scope here (other researchers own the named three) or not checked within budget. Nothing in this file should be read as evidence about them.
- **Microsoft Agent 365 pricing/limits** not opened; **Agent 365** is a governance plane, not a personal runtime — do not cite it for runtime or memory facts.
- **MCP details beyond structure.** I read the spec index and the authorization tutorial, not the tool/elicitation/sampling sections; nothing here should be used to claim MCP behaviour beyond JSON-RPC, the host/client/server split, and OAuth 2.1 + PRM.
- **A2A bindings.** Only the JSON-RPC binding and the security objects were read; gRPC/HTTP+JSON and multi-tenancy sections were not.
- **OWASP Top 10 item names.** The ten risk titles are in the PDF; the landing page publishes the framework, date and authorship claim only.
- **OpenClaw hosted/managed offerings.** Secondary sites claim an "OpenClaw Cloud $49/mo". The homepage says there is no hosted tier and the only commercial product is the pre-1.0 Enterprise control plane. Do not use the $49 figure.

## Sources

1. Wired, "Meta's Muse Is Better at Surveilling Than Helping Me" (2026-09-20) — https://www.wired.com/story/metas-muse-is-better-at-surveilling-than-helping-me/ (BLOCKED direct and in archive; wording read from a Brave index snippet; secondary, unverified) — read 2026-10-26.
2. OpenClaw homepage — https://openclaw.ai/ (direct) — read 2026-10-26.
3. OpenClaw documentation index (llms.txt) — https://docs.openclaw.ai/llms.txt (direct) — read 2026-10-26.
4. OpenClaw docs, "Gateway architecture" — https://docs.openclaw.ai/concepts/architecture.md (direct) — read 2026-10-26.
5. OpenClaw docs, "Agent runtime architecture" — https://docs.openclaw.ai/agent-runtime-architecture.md (direct) — read 2026-10-26.
6. OpenClaw docs, "Agent workspace" — https://docs.openclaw.ai/concepts/agent-workspace.md (direct) — read 2026-10-26.
7. OpenClaw docs, "Memory architecture" — https://docs.openclaw.ai/concepts/memory-architecture.md (direct) — read 2026-10-26.
8. OpenClaw docs, "Multi-agent routing" — https://docs.openclaw.ai/concepts/multi-agent.md (direct) — read 2026-10-26.
9. OpenClaw docs, "Standing orders" — https://docs.openclaw.ai/automation/standing-orders.md (direct) — read 2026-10-26.
10. OpenClaw docs, "Security" — https://docs.openclaw.ai/gateway/security.md (direct) — read 2026-10-26.
11. OpenClaw docs, "Security CLI" — https://docs.openclaw.ai/cli/security.md (direct) — read 2026-10-26.
12. OpenClaw, Security status page — https://openclaw.ai/security (direct) — read 2026-10-26.
13. OpenClaw blog, "OpenClaw Had a Rough Week" (2026-05-05) — https://openclaw.ai/blog/openclaw-rough-week (direct) — read 2026-10-26.
14. OpenClaw Enterprise — https://openclaw.ai/enterprise (direct) — read 2026-10-26.
15. GitHub API, openclaw/openclaw — https://api.github.com/repos/openclaw/openclaw (direct, JSON) — read 2026-10-26.
16. OpenClaw docs, "A2A" — https://docs.openclaw.ai/channels/a2a.md (direct) — read 2026-10-26.
17. OpenClaw docs, "Presence" — https://docs.openclaw.ai/concepts/presence.md (direct) — read 2026-10-26.
18. Instinct homepage — https://instinct.co/ (direct) — read 2026-10-26.
19. Instinct, Terms of Service, "Last revised on August 26, 2026" — https://instinct.co/terms (wayback https://web.archive.org/web/20261005113037/https://instinct.com/terms) — read 2026-10-26.
20. Instinct, Privacy Policy — https://instinct.co/privacy (direct) — read 2026-10-26.
21. Microsoft, "Microsoft Agent 365" — https://www.microsoft.com/en-us/microsoft-agent-365 (direct) — read 2026-10-26.
22. Microsoft Learn, "Microsoft Entra Agent ID documentation" — https://learn.microsoft.com/en-us/entra/agent-id/ (direct) — read 2026-10-26.
23. Agentic AI Foundation, "Projects" — https://aaif.io/projects/ (direct) — read 2026-10-26.
24. MCP specification, version 2026-07-28 — https://modelcontextprotocol.io/specification/2026-07-28/index.md (direct) — read 2026-10-26.
25. MCP docs, "Understanding Authorization in MCP" — https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization.md (direct) — read 2026-10-26.
26. A2A specification source (v1.0, §4.5 Security Objects, §8.4 Agent Card Signing) — https://raw.githubusercontent.com/a2aproject/A2A/main/docs/specification.md (direct) — read 2026-10-26.
27. A2A specification, rendered — https://a2a-protocol.org/latest/specification/ (direct) — read 2026-10-26.
28. AG-UI docs, "MCP, A2A, and AG-UI" — https://docs.ag-ui.com/agentic-protocols.md (direct) — read 2026-10-26.
29. OWASP, "OWASP Top 10 for Agentic Applications for 2026" (December 9, 2025) — https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ (direct) — read 2026-10-26.
30. OWASP, "Agentic AI – Threats and Mitigations" (February 17, 2025) — https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/ (direct) — read 2026-10-26.
31. Agentic AI Foundation home (Linux Foundation) — https://aaif.io/ (direct) — read 2026-10-26.
32. AG-UI documentation index (llms.txt) — https://docs.ag-ui.com/llms.txt (direct) — read 2026-10-26.
33. OWASP GenAI Security Project resource index (sitemap) — https://genai.owasp.org/resource-sitemap.xml (direct) — read 2026-10-26.
