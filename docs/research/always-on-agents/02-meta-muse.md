# Muse (Meta) — a consumer personal agent that runs as a daemon on a per-user Linux VM in Meta's cloud, with a separate permission agent (Sentinel) gating every connector action and every network request

> Research note, 2026-10-26. Muse is Meta's consumer personal AI agent: one named agent per subscriber living on its own cloud Linux VM with a real Chromium browser, shell and file system, connectors to third-party services, and a separate host-side permission agent (Sentinel) that authorises every connector action and every network egress. 18 sources — 16 primary sources, 2 flagged (1 secondary SERP, 1 archived legacy page).
> Written for docs/research/always-on-agents/. Facts carry their source; [inference] marks reasoning, not evidence.

## What it is

Muse is Meta's personal AI agent (proprietary — no source, self-host path or on-device build of the product is published [inference]), launched 2026-09-08 in the US, described as "available in the US and Canada" three weeks later, on iOS, Android and the web at muse.ai, with WhatsApp as a chat surface and AI glasses "coming soon" [5][6]. Each user gets one named, avatar-bearing Muse living on a dedicated cloud VM ("Muse Secure VM") that holds the agent, the files, and the credentials; the agent acts through connectors, a real Chromium browser, a shell and a file system, and keeps working while the app is closed [4][1]. It is free with a usage limit that refreshes, and paid tiers are token-denominated per week: $20/month for 500M, $100/month for 3B [1][9].

Domain note, because it is a real trap: `muse.ai` is Meta's, not a third-party product. `ai.meta.com/muse`'s "Try Muse" CTA is `https://applink.muse.ai/?pt=10684&pid=ai_meta_site…` [1], `applink.muse.ai` 302s to `https://muse.ai/` [16], `muse.ai` answers with Meta's CSP (`*.meta.ai`, `*.fbcdn.net`, `wss://gateway.meta.ai`) and bounces anonymous visitors to `auth.muse.ai` [15], and Meta's help centre says "You can subscribe with your Meta account through the mobile app or at muse.ai" [9]. The search result labelled "Muse — Your Personal AI Agent … from finances …" resolves to `https://muse.ai/`, i.e. the same product, so nothing is excluded on that basis [17].

## Axis findings

### 1. Product model

- One Muse per person, not a roster: you name it, pick an avatar and a style ("Creating our own avatar, naming it, and giving it a unique style has become one of the core features people light up about most"), and the author's own is called "Veda" [3].
- The unit of interaction is one long conversation with chat bubbles rather than turns: "Unlike other AI apps, Muse isn't a turn-by-turn experience. You can interrupt it or send multiple tasks at once without waiting for it to respond to the last" [3].
- Side chats exist because “some people still wanted separate context for certain topics … which made sense as projects grew more complex” [3].
- Work is organised as tasks and goals on top of the conversation: a Goals tab tracks long-running goals and the plan to reach them, an Ideas tab holds generated suggestions [3].
- Persistence is the VM: "You and your Muse share your own dedicated computer in the cloud. This is where your Muse lives and where all data and credentials for any service you connect are securely stored" [4].
- Identity is deliberately non-corporate — the designers rejected "talking to a corporate logo or entity" [3]; the app is rated 18+ and requires 18+ to subscribe [10][8].
- `muse.ai` is the web client; there is one product across iOS, Android, web, WhatsApp, Mac and (planned) glasses [6][2].

### 2. Runtime

- Per-user cloud VM: "Each Virtual Machine(VM) is an isolated linux box with a browser and enough storage, CPU, and memory to do real work — like compiling code the agent writes, developing custom skills and handling concurrent sub-agents and crons" [4].
- Filesystem and terminal are real: "Muse has its own computer, with a file system and a terminal, so it can write its own code and build the tools a task needs" [3].
- The harness is not root on the host. It runs in a systemd-nspawn container: "Root inside the runtime cell is mapped to an unprivileged host user so runtime cell root is not host root. The cell gets its own root filesystem (including a full debian image) separate from the host filesystem where your other more sensitive data lives. It also gets a virtual network interface, filtered system calls (for example no io_uring), and limited kernel capabilities (for example no CAP_SYS_PTRACE and no CAP_NET_ADMIN)" [4].
- Two security domains per box, explicitly: "The right mental model is two isolated security domains on one box, not an LLM powered agent with root" [4].
- Privileged services run as separate systemd units outside the cell: `hatch-safety` (independent classifier models), `privsep` workers (connector business logic), `hatch-authd` (credential store), `Sentinel`, plus "Proxies for inference and telemetry" [4].
- State: "All durable application state is stored in a postgres database separate from the runtime cell and from the credential store" [4].
- Disk persistence and restore: "Your VM data is backed up continuously so you can restore it if something goes wrong" [4].
- IPC is kernel-authenticated: "All communication between the runtime cell and other services in the VM happens via Unix domain sockets with SO_PEERCRED and peer ACLs" [4].
- Egress is forced through Sentinel via "a forward proxy configured with Linux networking controls (userns, veth boundaries and eBPF filtering)", evaluated at L4 and L7 — "the hostname, the resolved and final destination IP address, the port, protocol, HTTP method, path, and the actual decoded request", with SSRF checks after DNS resolution [4].
- Clients are thin: "Muse clients (the iOS and Android apps, the web UI) connect directly to your VM via a secure transport layer" [4]. The Mac app is a native local client that reaches Apple apps: "Muse for Mac OS … organizes files, fills out forms, and pulls from Messages, Calendar, and Notes, all with your permission" [2]. Whether the Mac app proxies that local data into the VM or runs any inference locally is not stated [inference: it is a client with local data access; the agent itself is stated to live in the VM].
- Cloud vendor, region and OS image beyond "a full debian image" are not disclosed [4].

### 3. Identity & auth

- Per-user credential store inside the VM, not central: `hatch-authd` "is responsible for credential storage (including OAuth tokens for third-party services you choose to connect – these are stored in your VM, not in centralized Meta infrastructure) and for credential surrogation so your main agent never sees sensitive credentials" [4].
- Surrogate tokens: "code in the runtime cell or a worker only ever sees a 'surrogate' token, minted by authd. After the concrete network request is authorized, Sentinel will replace any surrogate tokens with the real credential, obtained from authd, at the network boundary. The agent never sees real tokens" [4].
- Credential-capable code is separated from the agent: built-in connector CLIs in the cell "simply parse their arguments, open any files the caller is already allowed to access, and pass typed arguments and file descriptors over a Unix socket", while a sandboxed worker runs the logic, identified by cgroup with explicit credential allowlists — "A calendar worker cannot ask authd for an email credential simply by changing a request parameter" [4].
- Website logins go through a client-side capture UI straight to authd, "not visible to your main agent, but gets injected into the browser window at the point of need"; the browser sub-agent cannot read them [4].
- Payments: Muse's wallet stores cards compliantly, launch partner Stripe Link (Shop Pay "coming soon"); "a single-use card number is issued, and that's what gets passed through to the merchant's website", bound to merchant, amount and a short validity window [4].
- 1Password integration is announced as coming, for reusing existing logins [11][6].
- The outside world sees the human, not a bot identity: browsing "will appear as your activity" [4]; the terms forbid concealment where disclosure is legally required ("Misrepresent Muse responses as human-generated … where disclosure of its non-human identity is required by applicable law or regulation") and forbid chaining actions "designed to obscure the automated nature of those actions" [8].

### 4. Memory

- Memory is files in the VM plus retrieval: "Its memory persists across your conversations, and can manage lots of context" [3]; the privacy policy names `MEMORY.md` as a system file and lists "saved preferences, goals, memories, and scheduled tasks" as stored data [7].
- User-visible and user-editable: "your Memory files, which you can read and edit directly" [3]; "You can find out what Muse remembers about you at any time by asking directly, or by viewing files like your MEMORY.md" [7].
- Deletion is partial by design: you can delete messages, side chats and files, or reset Muse entirely, but "After you delete something, Muse may still “remember” information it learned from what you deleted", and the “Forget skill” makes it forget "to the best of its ability" [7].
- Model-side memory is a trained capability the vendor calls Active Memory, described as "carrying important context about you across conversations and actively retrieving the details relevant to the task at hand", alongside "Active Focus" for sustained work [13].
- No retention period, embedding store or index format is published [7][4].

### 5. Always-on mechanics

- Schedule plus events, not polling: "Once you've set a goal or a task, Muse continues to work on a schedule and in response to relevant events, taking the next step and following up, alongside whatever you ask it in conversation" [3].
- Background work survives app closure: "When you ask Muse to do something, it keeps working in the background whether you're actively using the app or not … if you ask it to monitor daily weather reports and alert you about rain, it will do that on its own without you needing to check in" [1].
- Crons are first-class in the runtime sizing: the VM is specced for "concurrent sub-agents and crons" [4], and "scheduled tasks" are enumerated as stored user data [7].
- Event sources can push: "calendar Connectors can update Muse automatically when there are changes in your schedule. We identify Connectors that do this before you connect them" [7].
- Output is filtered before it interrupts: "When it completes its background work, it evaluates whether the result is worth surfacing, and notifies you only when something is meaningfully new or needs your input" [3].
- Proactivity is user-tunable: "you can always tell your Muse to turn it off, dial it down, or dial it up" [3]. No quiet hours, digest window or rate limit on notifications is documented [1][3].
- "Monitor things you care about" has no separate primitive in any doc I read; monitoring is a standing task that keeps running on the schedule above, with connector pushes and the surfacing filter doing the wake-up work [inference from 1][3][7].

### 6. Tools

- Built-in skills chosen by the model: "when you give Muse a task, it figures out which built-in skills it needs and gets to work" [1].
- Connectors are first-party integrations built with each provider, plus "SKILLs — detailed instructions to Muse — on how to get the most out of each connector" [4].
- The agent can write new tools: it has a terminal and "can write its own code and build the tools a task needs" [3], and "Muse can also write its own custom connectors for other services you care about if they have their own APIs or CLIs" [4]; the small-business post repeats "Muse also supports custom connectors" [6].
- Third-party connector programme exists: describe, submit for review ("functional, security, and legal requirements"), then appear in a directory — `muse.ai/platform` [12]. Connector docs live at `muse.ai/docs` but return `401` JSON unauthenticated, so the declaration format is not public [12].
- Published connector list at launch + small business: email, calendar, Instagram, Facebook, health and fitness data, finances, "your car or your home", Meta ad accounts, Asana, Box, Canva, Dropbox, Figma, Granola, HighLevel, Intuit QuickBooks, Klaviyo, Lovable, Notion, Shopify, Slack, Stripe, Zoom [4][10][11][6].
- Computer use runs in a real Chromium behind a virtualization layer, driven by a dedicated browser sub-agent that "sees an accessibility tree snapshot of the page — not the raw DOM", with "no ability to run javascript in the page context, no script verbs, no exec in the browser process, and Chrome devtools are disabled" [4].
- Artifacts are a tool output class: "rich, interactive outputs that are sent through the chat and can also live outside of it" — documents, PDFs, web pages, dashboards, trackers [3].
- MCP is not mentioned in any Muse page I read; the connector surface is Meta's own [1][3][4][12].

### 7. Permissions & approvals

- A separate agent is the authority: "Sentinel is a separate host-side agent from your Muse. It is the sole permission authority for approval to perform actions with connectors to third-party services and for all egress over the network. Muse proposes actions, but only Sentinel can grant permission to perform action" [4].
- Three-way decision per request, with a purpose string: the tool submits "the connector, which method is to be invoked, the class of action, its scope, and context of what the user asked for from which Sentinel generates a user-visible purpose for the request", then Sentinel "decides whether the action should be allowed, denied, or to ask the user" [4].
- Grants are capabilities, not hints: "Approvals granted via the human in the loop system are strict capabilities, not conversational suggestions. They're bound to the particular connector/destination and use case. Muse has support for obtaining one-time, session-scoped, task-scoped, time-bounded, or perpetual permission … Sentinel decides which grant types to present … and ensures that subsequent invocations match the granted scope exactly" [4].
- The approval dialog bypasses the chat: "A dialog is presented to the user directly within the client UI — not via their conversation with Muse — and their answer is routed directly back to Sentinel" [4].
- Consumer copy matches: "You can choose to allow an action once, always allow it, or deny it. You can manage your default permission settings for every connection at any time" [1]; read-only vs act is a per-connector setting [7][5].
- Friction is rationed by taint tracking, not by asking everything: each tool process "starts in a clean state and becomes tainted if it reads user data. Clean network requests that already qualify for a narrowly bounded auto allow policy … can be allowed through without bothering the user. Tainted or unverifiable processes lose auto-allow and fall back to the normal approval flow" [4].
- Default posture is browse freely, stop before irreversible: "the default allows for standard browsing of the web and stops for anything hard to undo", explicitly to avoid "banner blindness — where people approve everything to make it go away" [3].
- Purchases always stop: checkout-page detection triggers "a human in the loop approval with the exact details of the purchase every time" [4].
- Audit trail: "Tapping on your Muse avatar will show you its full activity log as well as permissions you've approved" [3]; "Muse shows people a complete audit trail of everything it has done and plans to do" [6].
- Fine-grained scoping under OAuth: read and write are split where the service allows, and "if you grant Muse the Gmail read-access OAuth scope on the Gmail side, you can remove the ability to access Gmail settings that usually comes along with it" [4].

### 8. Models

- Launch model: "powered by Muse Spark, Meta's most capable model to date, built for real-world agentic work like this" [6]; the security post names "Muse Spark 1.3" for prompt-injection resistance and browser driving [4].
- Upgrades are staged to subscribers: "Muse Wonder will soon power experiences in Muse, and will roll out first to subscribers. Muse Wonder will also power artifact generation and processes that require more intelligence" [13].
- Model work is scoped to agents: "We trained our model with a specific focus on the areas that are critical for an agent like this: zero-shot tool calling using CLIs and skills, long context, long-trajectory instruction following with inherent awareness of prompt injection, and multi-agent coordination" [4].
- An independent safety stack, not the main model: "hatch-safety operates an independent set of models and classifiers which inspect requests and responses to/from core model inference" [4]; prompt-injection detection is "an ensemble of multiple prompt injection detection classifiers … trained … independently from the model" [4].
- Compaction, context window, routing and caching are not disclosed [4][13].
- Adjacent, do not conflate: Muse Glimmer is a separate open-weights 30B on-device model (Apache 2.0, Aug 2026) for local agent workflows; no Meta page says it runs inside Muse [14].

### 9. Multi-agent

- Sub-agents are an implementation detail the vendor advertises: Muse "launches swarms of subagents, builds its own tools, and edits itself" [4], and the VM is sized for "concurrent sub-agents and crons" [4].
- Browser work is delegated to a specialised sub-agent per task, with web-specific injection instructions [4].
- Sentinel is a second, independent agent on the same host, deliberately not controllable by Muse [4].
- Users do not get multiple named agents: no roster, no agent-creation UI, no delegation contract between user-visible agents is documented — parallelism is internal [inference from 1][3].

### 10. Surface

- Presence: avatar with a live snippet of current work, "under the Avatar, you'll see a snippet of what it's working on" [3].
- Activity and permissions: full activity log behind the avatar, plus a permissions view [3].
- Goals and Ideas tabs; Artifacts as first-class outputs that outlive the message [3].
- Chat is bubble-based to survive out-of-order proactivity [3].
- Channels: iOS and Android apps (iOS 18.0+, iPadOS 18.0+, 120 MB, 18+, free with in-app purchases) [10], the web app at muse.ai [6], WhatsApp ("in the Muse app or directly in WhatsApp") [6], a macOS app with local Messages/Calendar/Notes access [2], AI glasses "coming soon" [6].
- Handoff: "Users can see what Muse is doing in the browser and take over at any time", and while the human holds the browser or a password is being filled, "the agent is paused and can't act at all" [4].

### 11. Plans, limits, pricing

- Free tier exists and is metered: "Muse is available for free with a usage limit … you can upgrade to a paid subscription, or wait until your free usage limit refreshes" [1].
- Paid tiers are token-denominated per week, on a help-centre page updated "3 weeks ago": "Power plan ($20/month) 500M Muse tokens per week" and "Maximum plan ($100/month) 3B Muse tokens per week"; "Weekly usage allowance for Muse increases as you upgrade plans" [9].
- Availability is limited: subscriptions "are available at muse.ai and through the mobile app. Muse and Muse subscriptions are in limited testing and aren't available in all locations yet"; subscriber must be 18+ and in a supported country [9]. Launch was US only [6]; by 2026-09-29 Meta described Muse as "available in the US and Canada" [5].
- Rate behaviour at the cap, concurrency caps and per-task budgets are not published [9].

### 12. Safety & failure modes

- Stated threat model is "assume the agent may be under attack": "we designed the system to assume the agent may be under attack and limit the potential damage — the harness runs in its own isolated cell, it doesn't see real credentials, and every interaction with the outside world runs through a Sentinel which the agent can't override" [4].
- Prompt injection is handled in layers: model training; labelling external data as untrusted in context; an ensemble of injection classifiers on files and tool results; human approval for data leaving the VM; plus the deterministic boundaries below [4]. The post cites Simon Willison's "lethal trifecta" by name [4].
- Email is treated as a credential-confusion surface: "Muse's email connector filters out one-time tokens, password reset links, and login magic links via both deterministic filters and a classifier model" [4].
- Browser-specific classifier family blocks or escalates on: personal-data egress unrelated to the task, injection in the DOM, injection in images/media, injection in downloaded files, and high-risk form submission [4].
- Payment blast radius is bounded by the card: single-use number "tied to that particular merchant, a particular dollar amount, and only valid for a limited period of time. This way, even if it were stolen via prompt injection or some other attack, it would not be particularly useful" [4].
- Bug bounty is public and priced: "up to $300,000 for valid reports, including up to $130,000 for successful prompt injection attempts that affect one user", opened to anyone on launch day [4].
- Privacy posture, stated plainly: VM is the system of record; no ad-system sharing; training on by default with an opt-out that applies retroactively; trajectories sanitised of PII and disassociated from the account [7][4].
- The vendor states the current limit of its own privacy claim: isolation "restricts access to your data by Meta personnel through operational policies. It does not prevent Meta from accessing data when necessary to support, secure or operate the service"; "Muse Confidential VM" is planned for later in 2026 to "cryptographically and verifiably prevent Meta from accessing data in your VM", in trusted-tester use, with source shown to external auditors [4][7].
- Admitted gaps: "Muse isn't immune to attack. Prompt injection remains an open problem in the industry — and Muse will sometimes make mistakes"; the App Store copy says "Muse may be inaccurate or take unexpected actions, so check in to keep it on track" [4][10].
- "Agentic AI security standards" is the FAQ's own phrase ("built with automated protections, agentic AI security standards, and user controls") [1]; no document with that title is published — the substance lives in the security post and the bug bounty [4][1], while the model-level safety claims sit in Meta's scaling frameworks referenced in sibling posts [13][14]. Treat the phrase as marketing that resolves to [4], not as an external standard.

## Verbatim (the lines that carry the architecture)

> "You and your Muse share your own dedicated computer in the cloud. This is where your Muse lives and where all data and credentials for any service you connect are securely stored." — [4]

> "The right mental model is two isolated security domains on one box, not an LLM powered agent with root." — [4]

> "Sentinel is a separate host-side agent from your Muse. It is the sole permission authority for approval to perform actions with connectors to third-party services and for all egress over the network. Muse proposes actions, but only Sentinel can grant permission to perform action." — [4]

> "Approvals granted via the human in the loop system are strict capabilities, not conversational suggestions. They're bound to the particular connector/destination and use case. Muse has support for obtaining one-time, session-scoped, task-scoped, time-bounded, or perpetual permission. Sentinel decides which grant types to present for the user to choose between and ensures that subsequent invocations match the granted scope exactly." — [4]

> "The agent never sees real tokens, which means any attempt to coerce the agent to reveal the actual secrets via prompt-injection or otherwise is futile." — [4]

> "To balance the signal-to-noise ratio of user approvals, Muse uses kernel-level data flow tracking, which we call “tainted egress.” Each tool execution process starts in a clean state and becomes tainted if it reads user data." — [4]

> "Muse has its own computer, with a file system and a terminal, so it can write its own code and build the tools a task needs. It also has access to a full web browser, so it can search, navigate sites, fill out forms, and complete transactions, like booking and purchasing." — [3]

> "Once you've set a goal or a task, Muse continues to work on a schedule and in response to relevant events, taking the next step and following up, alongside whatever you ask it in conversation. When it completes its background work, it evaluates whether the result is worth surfacing, and notifies you only when something is meaningfully new or needs your input." — [3]

> "But we also wanted to avoid banner blindness — where people approve everything to make it go away. It's important to supervise those “irreversible” actions. So the default allows for standard browsing of the web and stops for anything hard to undo." — [3]

> "The browser is managed by a separate broker that manages the Chrome DevTools Protocol connection. The sub-agent, which drives the Browser, sees an accessibility tree snapshot of the page — not the raw DOM." — [4]

> "Muse runs on an environment in the cloud called a virtual machine (“VM”). This is the core environment where Muse keeps information you share and things you create together. Every Muse user's VM is isolated so no one else's agent can access it." — [7]

> "This setting is on when you first use Muse. You can change it at any time using the toggle in your Settings under “Data controls.”" — [7] (on using your interactions to train AI models)

> "We trained our model with a specific focus on the areas that are critical for an agent like this: zero-shot tool calling using CLIs and skills, long context, long-trajectory instruction following with inherent awareness of prompt injection, and multi-agent coordination." — [4]

> "Muse is rolling out in the US on iOS, Android, and muse.ai, and coming soon to AI glasses." — [6]

> "Power plan ($20/month) 500M Muse tokens per week … Maximum plan ($100/month) 3B Muse tokens per week" — [9]

## Open questions

- Cloud provider, region and data residency for Muse Secure VM — not disclosed anywhere I read [4][7][8].
- Connector declaration format (MCP? OpenAPI? own manifest?) — `muse.ai/docs` returns 401 JSON to unauthenticated clients, so the spec is not public [12].
- Context window, compaction policy, model routing and token accounting (what a "Muse token" is, and whether sub-agent or classifier calls count) — not published [9][13].
- Notification mechanics: no quiet hours, digest window, or per-event-type mute documented [1][3].
- Retention period for deleted data and for VM backups — "may still remember" is stated, lengths are not [7].
- Whether the macOS client proxies local Messages/Calendar/Notes into the VM or runs any inference locally — the download page only claims local access "with your permission" [2].
- "Agentic AI security standards" has no published document under that name; the operational content is [4]. If a standards page exists it was not reachable from ai.meta.com, security.muse.ai or the help centre [1][4].
- Meta help-centre articles for Muse resolve to an error page when fetched live; pricing and eligibility above come from the Wayback copy of the subscriptions article [9]. Other Muse help articles (permissions, connectors) were not enumerable.
- One archived capture is stale, do not cite it as Muse: `muse.ai/docs` from 2026-06-09 renders an unrelated video-hosting product ("Skiv"), i.e. the domain had an earlier occupant; the live path is Meta's and auth-gated [18].

## Sources

1. Muse: Meta's personal AI agent, features & capabilities — https://ai.meta.com/muse/ (wayback https://web.archive.org/web/20261022072424/https://ai.meta.com/muse/; FAQ text recovered from the hydration payload) — read 2026-10-26.
2. Download Muse: Free AI Agent for Mac & Mobile — https://ai.meta.com/muse/download/ (wayback https://web.archive.org/web/20260918001710/https://ai.meta.com/muse/download/) — read 2026-10-26.
3. How We Designed Muse (Mona Sarantakos with Christine Awad, September 2026) — https://introducing.muse.ai/ (direct) — read 2026-10-26.
4. How We Built Safety Into Muse (Tarek Sheasha, Meta Superintelligence Labs, September 8, 2026) — https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse (direct; `https://security.muse.ai/` 302s here) — read 2026-10-26.
5. The Future Is for Everyone: Muse for Small Business — https://about.fb.com/news/2026/09/introducing-muse-small-business/ (wayback https://web.archive.org/web/20261015113334/https://about.fb.com/news/2026/09/introducing-muse-small-business/; published 2026-09-29) — read 2026-10-26.
6. Introducing Muse: The World's First Personal AI Agent Built for Everyone — https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ (wayback https://web.archive.org/web/20261022072503/https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/; published 2026-09-08) — read 2026-10-26.
7. Muse Privacy Policy (effective September 17, 2026) — https://muse.ai/privacy (wayback https://web.archive.org/web/20261017151914/https://muse.ai/privacy) — read 2026-10-26.
8. Muse Supplemental Terms of Service (last updated September 8, 2026) — https://muse.ai/terms (wayback https://web.archive.org/web/20261017151842/https://muse.ai/terms) — read 2026-10-26.
9. About Muse subscriptions — https://www.meta.com/help/subscriptions/1021145227643680/ (wayback https://web.archive.org/web/20261005/https://www.meta.com/help/subscriptions/1021145227643680/; live URL renders an error page) — read 2026-10-26.
10. Muse from Meta, App Store listing — https://apps.apple.com/us/app/muse-from-meta/id6760173601 (direct) — read 2026-10-26.
11. Muse for Small Business — https://muse.ai/business (direct) — read 2026-10-26.
12. Muse Connector Platform — https://muse.ai/platform (direct; `/docs` returns 401) — read 2026-10-26.
13. Muse Wonder: A Frontier Model For Personal & Professional AI Agents (October 12, 2026) — https://research.meta.ai/blog/muse-wonder (direct) — read 2026-10-26.
14. Meta AI Research blog index (publication dates; Muse Glimmer, August 10, 2026) — https://research.meta.ai/blog (direct) — read 2026-10-26.
15. muse.ai root, response headers and redirect to auth.muse.ai — https://muse.ai/ (direct curl, 307 → https://auth.muse.ai/aymh/; CSP names `*.meta.ai`, `*.fbcdn.net`, `wss://gateway.meta.ai`) — read 2026-10-26.
16. applink.muse.ai — https://applink.muse.ai/ (direct curl, 302 → https://muse.ai/; DNS resolves to Meta edge, star.c10r.facebook.com) — read 2026-10-26.
17. Bing result page for `"muse.ai" personal AI agent` (secondary; used only to resolve the snippet "Muse — Your Personal AI Agent … from finances" to https://muse.ai/) — read 2026-10-26.
18. Archived muse.ai/docs capture, 2026-06-09 — https://web.archive.org/web/20260609024205/https://muse.ai/docs (flagged: renders an unrelated video-hosting product, evidence that the domain changed hands; not a Muse source) — read 2026-10-26.
