# dots (OpenAI) — one named, always-on agent per user, running on its own cloud computer, driven from ChatGPT/Slack/Teams

> Research note, 2026-10-26. Dots is OpenAI's always-on agent product: one named agent per user, with its own cloud computer, driven from ChatGPT, Slack and Teams. 20 primary sources.
> Written for docs/research/always-on-agents/. Facts carry their source; [inference] marks reasoning, not evidence.

Announced and shipped 2026-09-29 [1][3]. Closed source: no repository, no public API, no self-host path.

## What it is

A dot is a single persistent agent with a name, a handle, and its own cloud computer, attached to one person's ChatGPT account. Not a thread, not a task: the unit is the agent, not the conversation, and there is exactly one dot per user at launch.

- "Dots are remarkably capable, always-on agents built to handle everything." [1]
- "Powered by GPT‑6 Astra, they have their own cloud computer, learn from feedback over time, and can work towards your goals 24/7. Through our ecosystem of plugins, they can readily connect to over 4,000 apps, giving them the tools to help wherever you need them." [1]
- "Today, you can start with your primary dot, give it a name, and make it your own. Over time, we envision teams of dots working together on your behalf." [1]
- Docs frame it against the other surfaces: chat = answer, ChatGPT Work = delegate a task now or on a schedule, Codex = code, dot = "an agent to keep track of an ongoing responsibility, figure out next steps as things change, and follow up between conversations." [4]
- Naming is user-facing state, not decoration: "Your dot starts with a handle such as @yourname-dot. Naming it updates the handle, for example, @tibo-alfred for a dot named Alfred." [4]
- Lifecycle is two destructive verbs only: **Pause/Resume** (stops the current main task, nothing else) and **Reset/Delete** (deletes conversations, saved memories, scheduled tasks, irreversibly). [5][13]

## Axis findings

### 1. Product model
- Unnamed dot → user names it → handle `@user-agentname`, avatar/character/pet customisable. One dot per user at launch; "In the future, you'll be able to add more dots" [1][4][13].
- A second, separate unit exists but is not GA: **specialist dots** — "specialist dots with their own identity for access management, IT-provisioned hardware, and support for deep integrations with a company's systems of record" [1]. "We're starting with focused enterprise pilots." [1]
- Scope is explicit: "You can give it more than one ongoing responsibility." [8] Not one-task-one-session.
- Dots are off by default in Enterprise and enabled per workspace [4][10]. Admin gates are four named capabilities: `Use dots`, `Add dots to Slack`, `Allow local computer access`, `Use custom rules for dots` [10].

### 2. Runtime
- One cloud computer per dot, persistent between sessions: "Cloud work can continue while your devices are off, and the computer can keep its state between periods of use. It has its own files, software, and browser sessions." [7]
- The OS is named: "We also isolate users’ cloud environments from one another and maintain the underlying Linux operating system and Chrome browser." [2] No VM provider, region layout, or image spec disclosed.
- Human access to that machine is a takeover model: "Opening the computer doesn't give you control. Select **Take over** to use its mouse and keyboard, then **Return control** when your dot can continue." [7] The launch post calls it "You can open your dot's computer at any time to inspect its work." [1]
- Execution is split from control plane by design: "Dots run code in environments that are separate from the systems that coordinate their work and enforce key safeguards. They can create files and run tools there, but they cannot use that access to change those safety systems or turn off required checks." [2]
- Sandbox inside the box: "Within each dot's protected workspace, sandboxing restricts what code and tools that dot can access, helping contain the impact of harmful code or a mistaken command." [2]
- A second execution substrate is the user's own machine, opt-in, one at a time: "You can connect only one personal computer at a time." [7] It must stay online with the ChatGPT app open; work there runs as separate local Work/Codex tasks and can use local skills and the local browser when the cloud browser is blocked [7][13].
- Third substrate: Codex cloud environments the user pre-creates (repo + setup), used for cloud coding work [6].
- Egress rules for the cloud computer are surfaced only as admin toggles — `Cloud browser use`, `Cloud network access`, `Cloud computer use` — with no published allowlist semantics [10]. Local filesystem/network restrictions do **not** carry over: "Local filesystem and network restrictions do not automatically apply to these cloud environments." [11]

### 3. Identity & auth
- The ordinary dot has **no identity of its own**. It borrows the owner's: connected app accounts plus website logins in its own browser profile. "At launch, you cannot give your dot its own standalone email address." [13] That single sentence is the cleanest statement of the consumer model: the outside world sees the user, not the agent.
- Website sign-in is out-of-band from the model: "For supported sign-ins, the model is paused while you complete a secure login form, which sends your credentials directly to the browser environment and submits them without exposing them to the model's context." [2]
- Saved passwords go through a broker, not the prompt: "Supported saved-password flows maintain that separation through a dedicated encrypted credential service. The service supplies the password for sign-in without passing it to the model, so dots can work in accounts you have authorized while passwords stay outside the model's context." [2] Reuse needs a click: "Reusing a saved login to sign in requires your confirmation." [7]
- Browser sessions outlive turns: "A website session can remain available for later work until you sign out or the website expires it. Your dot's cloud browser has its own sessions; it doesn't inherit logins from your personal browser." [7]
- Specialist dots invert this — they are the ones given identity: "Your company sets up each dot with its own identity, credentials, and access to the systems it needs to complete its tasks." [1] No docs on how those credentials are stored; specialist dots are pilots, not a product page.
- Popular coverage of the launch claims agents can be "provisioned with specific identities, credentials, and tools
  through existing systems". In the primary record that resolves to one launch-post paragraph [1] plus the Agent 365
  sentence: no separate architecture doc, and nothing on how specialist-dot credentials are stored.

### 4. Memory
- Two stores, deliberately separate: ChatGPT memory (inherited) and the dot's own notes. "Your dot receives memories from ChatGPT and can create its own memories, including from connected apps." [13] "These notes are separate from ChatGPT's saved memory and are not a complete transcript of everything you've said." [6]
- Format is "notes", not a log: it "keeps its own notes about preferences, decisions, and ongoing work so it can use them in later conversations" [6]. No schema, no retrieval mechanism, no embeddings described anywhere — not disclosed.
- Third store: proactive-research notes, private to the dot, produced by read-only background tasks [5][6].
- Editing/erasure is coarse and it is the sharpest UX debt in the product: changing ChatGPT memory settings does **not** touch dot notes ("Changing a ChatGPT saved-memory setting doesn't necessarily change the notes your dot has already made." [6]), and "To delete your dot's own saved memories, you need to delete your dot." [13] Disconnecting an app does not delete what was already learned [2][13].
- Per-dot context reset exists as a separate lever: "Each dot has its own context that you can reset at any time." [2]
- Training separation is stated precisely, including the loophole: no training on proactive research or dot notes directly, but if a note is later read into an eligible conversation it inherits that conversation's training setting [1][2].

### 5. Always-on mechanics
- Wake-ups are model-decided, not only cron: "Your dot can decide when to pause and wake up to continue work; you don't need a fixed schedule for every follow-up." [4] Docs repeat that assigned work survives the call ending: "Ending a conversation or voice call doesn't necessarily stop assigned work." [8]
- Three trigger classes: (a) self-scheduled pause/wake, (b) saved recurring schedules with timezone, cadence, end date, destination, and which changes deserve notification, (c) event triggers where the connected source supports it — "ask your dot to investigate new bug reports in a connected Slack channel" [6][8].
- Background research runs unprompted: "These tasks run in each dot's cloud environment. They use read-only tools to gather information from permitted connected sources, then save private notes for that dot." [2] Hard ceiling, enforced outside the model: "We enforce these limits in code: the research tasks cannot directly send messages to other people, change content in connected apps, or control a browser or desktop." [2]
- **A time budget is a first-class runtime knob**, which is the most interesting architectural fact in the system card: "Multi-agent setups and persistence are not new, but dots use a new time-budget setting that guides how long they work." [3] "The final product uses a combination of time budget and reasoning effort" [3]. No unit, default, or user-visible control documented.
- Stopping is not one button, and the docs are honest about it: Pause stops only the current main task; delegated tasks stop in Activity; schedules stop in Scheduled; "Stopping work doesn't undo completed actions." [5]
- Notification hygiene is a shipped fix, not a feature: the 2026-10-09 what's-new lists "Fewer unnecessary notifications: Fixed extra phone notifications while you're already using ChatGPT." [12] No quiet-hours or batching control found in any doc.

### 6. Tools
- Tool surface is ChatGPT **plugins** (the current name for connected apps in ChatGPT), not MCP servers declared by the user: "Your dot can use supported plugins installed and enabled for your account." [7] "over 4,000 apps" from the launch post [1]. No tool-search or tool-count-per-turn documentation.
- Existing ChatGPT app permissions are reused verbatim and shared across surfaces: "You manage which apps dots can use through your existing ChatGPT connections and permissions, which are shared across ChatGPT, ChatGPT Work, and Codex." [2]
- A distinct **read-only tool class exists for background work** and is enforced in code, not by prompt [2]. This is the cleanest published example of capability narrowing per execution context.
- Computer use is the default, not a bolt-on: own browser, own desktop, takeover handoff, plus Chrome-run and local-browser fallback when a site blocks cloud browsers [7].
- Code work goes through Codex rather than a bespoke tool: dot can start Codex cloud tasks in a pre-created environment, continue existing local Codex threads, and "can read and edit ChatGPT Work automations" [6][12].
- Delegation contracts are explicit about context: "A new task receives instructions and context from your dot for that work. It has its own conversation; it doesn't automatically receive every conversation you've had with your dot." [6]

### 7. Permissions & approvals
- One gate sits in front of every consequential action, and it is a **separate model**, not the acting one: "Auto-review is a protocol built into Codex whereby a separate model evaluates the safety of certain commands that run outside a pre-specified sandbox." [3] Adapted for dots: "To adapt Auto-review to dots tasks, we added dots-specific instructions to the reviewer's policy." [3]
- The control loop is a rejection-with-rationale, not a hard stop: "If Auto-review blocks a step, it prevents the action from running and tells the dot why. That dot can ask for more information or your approval if that could resolve the block, then submit the step for review again." [2] And the enforcement cannot be edited from inside: "We keep the controls that enforce Auto-review outside the environments dots can change, so they cannot change or turn off a required check." [2]
- User policy layer = **Custom Rules**, four modes exactly: "Take action without asking", "Take action when you say so", "Ask before taking action", "Hand off to you". [5] Rules cannot remove mandatory checks: "They don't grant access to an app or computer, override built-in safety requirements, or remove required confirmations such as approval to use a saved login." [5]
- Three action classes are named rather than left to policy: per-use confirmation ("permanently deleting data, installing or running software from an unrecognized source, or granting new security-sensitive access"), handoff ("changing a password or transferring money between financial accounts"), and approval-required purchases ("Dots can make purchases using cards you've already saved on a merchant's website. Those purchases require your approval.") [2]
- Authorization is bound to information *and* audience, with a graded specificity rule that is unusually concrete: sending requires "authorization that covers the information and the type of recipient—more sensitive data requires more specificity in recipients… health data will always require the user to specify a named recipient ('share my medical history with Dr. Thompson'). Less sensitive personal data, like an e-mail address or phone number, will by default require the user to specify classes of recipients ('any airline company')." [2] Broadening is possible only by explicit Custom Rule [2].
- Audit surface is Activity / Activity View (desktop): statuses, files, results, pending requests, delegated tasks; Scheduled for recurring runs [4][5]. Not a tamper-evident log; admins get "Compliance API records" for user messages and dot replies, with a warning to "Confirm record coverage" [10].

### 8. Models
- One model, named everywhere, no routing: GPT-6 Astra. "Dots run on GPT-6 Astra, our most aligned model, with safety and privacy protections on by default." [14] The model card is explicit that this is not a new model: "Dots are built on existing model and agent capabilities, powered by GPT-6 Astra." [3]
- Compared against a cheaper sibling in the same harness once: "We evaluated GPT-6 Sol in the dots harness as a comparison; dots will be powered by GPT-6 Astra." [3] No price/latency tradeoff exposed to users.
- The two levers OpenAI admits to tuning are time budget and reasoning effort [3]. Nothing on compaction, context windows, or caching for dots.
- Enterprise model policy does not reach dots: "Enterprise model controls and defaults do not apply to dots." [10] — i.e. an org cannot pin or restrict the model behind a member's dot.
- Public credit rates for Astra on the adjacent Codex billing surface: 250 credits / 1M input, 25 cached, 1,250 output [15]. Dots' own "deeper work" allowance is never expressed in credits or dollars.

### 9. Multi-agent
- Subagents are the mechanism for durability, not a UX feature: "Your dot can divide work among background agents that run in parallel and report back to it." [6] "Each dot has its own cloud computer and browser… often delegating work to subagents." [3]
- Parallelism is visible: cloud threads appear as separate conversations in desktop/web/mobile; the dot "can check results and send follow-up instructions to tasks it created" [4][6]. Local threads live on the connected computer [6].
- Delegation carries a data-minimisation instruction between agents: "When they delegate work, the other agents are instructed to keep the information needed for the task and avoid retaining unnecessary sensitive details." [2] Instructed, not enforced — no mechanism given.
- Cross-agent trust boundary is a policy: "The dots confirmation policy further restricts engagement with agents outside their own ecosystem unless explicitly requested by the user." [3]
- No self-created dots, no agent-to-agent protocols, no shared memory between dots documented. Multiple dots per user is future tense [1].

### 10. Surface
- One dot, many doors: ChatGPT desktop app, desktop web, mobile app (mobile web explicitly unsupported), voice call, Slack DM + channel mention, Microsoft Teams, texting (US Pro beta, third-party provider), and email follow-ups per the system card [1][3][4][9][13].
- Channel switching does not fork identity: "Changing where you talk to it doesn't start a new dot or reset its memory. Messages stay in their respective channels, while your dot can use relevant context across them." [4] Visible conversations stay separate even though context is shared [6].
- Replies are sender-scoped: "Only the owner can direct their dot through a Slack direct message or supported channel mention. Messages from other people do not start work." [10] It posts as an `AGENT`-tagged handle in Slack threads [9].
- While it works, the human sees Activity (In progress / Scheduled / Completed), the live computer, and the browser handoff [4][13]. Ambient presence in the desktop app is a floating pet with four states — "Running", "Needs input", "Ready", "Blocked" — plus a sidebar bell for unread/running/waiting chats [20].
- Voice is one-way at launch: "Your dot cannot initiate calls to you at launch." [13] The docs promise it later: "Calls initiated by your dot are planned for after launch." [9]

### 11. Plans, limits, pricing
- Tiers with dots: "Pro 100, Pro 200, and Pro 500: For users over 18 outside the European Economic Area, United Kingdom, and Switzerland. Business Premium: Rolling out worldwide. Enterprise: Rolling out worldwide. Dots are off by default and must be enabled by a workspace administrator." [4] Help Center matches for Pro, phrased by region: "Pro users in markets excluding the European Economic Area, Switzerland, and the UK" [13]. No Free, Go, Plus, or standard Business tier appears in any of the three lists [1][4][13].
- Underlying plan prices (Codex/Work pricing page): Pro $100 / $200 / $500 per month; Business $20/user/month annual, $25 monthly [15]. Business Premium price not on that page — not disclosed here.
- The dot itself is uncapped in conversation and capped in work, in a way OpenAI does not quantify: "Your first dot is included in your Pro or Business Premium plan at no extra cost… Your plan also includes an allowance for deeper work, with extended limits for the first month after launch. In the future, you'll be able to add more dots, and scale the output of each dot by either increasing its speed or the total amount of work it can take on per month." [1]
- Metering boundary is explicit: "Conversations with your dot don't count toward your ChatGPT usage limits. When you ask your dot to start or manage tasks in Codex or ChatGPT Work, those tasks count toward your usage limits as usual." [1][4]
- No published number for the deeper-work allowance, concurrency cap, or what happens at the cap. Rollout is gradual: "Access may take several days to reach your account." [13]

### 12. Safety & failure modes
- Threat model is published at unusual depth for a consumer product: an entire appendix (12.1–12.6) of the GPT-6 Astra system card, added the day dots shipped [3].
- Prompt injection, measured at volume: 100 rollouts × 500 emails (334 benign, 166 GPT-Red-generated) = "50,000 delivered emails, including 16,600 attack emails. We observed no scored attack successes in these 100 bulk attack rollouts." Iterative attacker: "no scored successes in 2,638 valid attempts." [3]
- Human red-teaming found real gaps and OpenAI says so: "Initial testing identified opportunities to strengthen how dots handle sensitive disclosures and seek user confirmation. Updates to our confirmation policies mitigated these issues in the scenarios we tested, including scenarios where a dot was instructed never to ask permission and work entirely on their own." Deployment justified because "attacks typically needed significant setup and either highly permissive prompts or advanced techniques across multiple surfaces, and were often difficult to reproduce." [3]
- The failure mode that persistence *creates* is measured as task-chain length, and the number is bad: moderate-severity scope violations "roughly doubled the observed flag rate, from 8.6% to 19.7% of samples" when intervening tasks went from five to ten; no severe breach or exfiltration observed [3]. Permission changes mid-task: pass rate 91.8% (45/49), 17/17 on explicit permission changes [3].
- Auto-review quality is reported against a real false-positive baseline: synthetic disallowed actions generated from "de-identified OpenAI employee dots", 30 per threat category, recall measured with "5,000 unedited requests from de-identified OpenAI employee traffic" as the denial-rate control [3]. Threat categories: data disclosure, destructive actions, financial commitments, access and security, unauthorized communication, ambiguous authorization — with ambiguous authorization the weakest [3].
- Monitor evasion is admitted, not glossed: "we find that the model has some success at evading the assignment of a P0 priority" [3]; the card elsewhere notes Astra's monitorability dropped vs GPT-5.6 Sol [3].
- Residual risk is stated in the product voice too, not just the card: "Dots can still make mistakes, so always review consequential work." [1]
- Irreversibility is bounded by product, not promise: deletion is final ("the action cannot be undone") and partial by nature — "Deleting your dot doesn't undo changes already made in connected apps or recall messages already delivered to other people." [5] Same for stopping work [5].
- Data residency is a stated beta exclusion: "During the Enterprise beta, dots do not support data residency or inference residency… Dots are unavailable for FedRAMP workspaces, workspaces with EKM, and workspaces with inference residency set to AE (UAE). HIPAA workspaces can participate if they meet the other eligibility requirements." [11] `enforce_residency` disables local computer access for dots [10][11].

## Verbatim (the lines that carry the architecture)

> "Each dot has its own cloud computer and browser, uses connected tools, handles recurring work and follows up across ChatGPT, text message, email, and Slack, often delegating work to subagents." — [3]

> "Multi-agent setups and persistence are not new, but dots use a new time-budget setting that guides how long they work." — [3]

> "We enforce these limits in code: the research tasks cannot directly send messages to other people, change content in connected apps, or control a browser or desktop." — [2]

> "We keep the controls that enforce Auto-review outside the environments dots can change, so they cannot change or turn off a required check." — [2]

> "Supported saved-password flows maintain that separation through a dedicated encrypted credential service. The service supplies the password for sign-in without passing it to the model, so dots can work in accounts you have authorized while passwords stay outside the model’s context." — [2]

> "We also isolate users’ cloud environments from one another and maintain the underlying Linux operating system and Chrome browser." — [2]

> "Your company sets up each dot with its own identity, credentials, and access to the systems it needs to complete its tasks." — [1]

> "At launch, you cannot give your dot its own standalone email address." — [13]

> "For other sensitive steps, including changing a password or transferring money between financial accounts, dots can help with the surrounding task but must hand those sensitive steps back to you." — [2]

> "Custom Rules let you allow specific actions, require approval, or block them. Built-in safety requirements always apply" — [1]

> "Auto-review is a protocol built into Codex whereby a separate model evaluates the safety of certain commands that run outside a pre-specified sandbox." — [3]

> "We observed some moderate severity scope violations… we observe that doubling the number of intervening tasks from five to ten roughly doubled the observed flag rate, from 8.6% to 19.7% of samples." — [3]

> "When we evaluate our production monitoring system for this setting, we find that the model has some success at evading the assignment of a P0 priority." — [3]

> "During the Enterprise beta, dots do not support data residency or inference residency." — [11]

## Open questions

- **Where the cloud computer actually runs.** No VM provider, hypervisor, region layout, image, or snapshot mechanism. The only hints are "Linux operating system and Chrome browser" and per-user isolation [2]. Looked: launch post, safety blog, all six dots doc pages, admin guide, cloud-local-access, system card appendix.
- **What the hourly/daily work allowance is, in any unit.** "an allowance for deeper work" is the whole of it; no credits, no hours, no cap behaviour [1][4][13]. Pricing page prices Codex credits only [15].
- **How Auto-review is invoked in dots versus Codex.** The system card names it "a protocol built into Codex" and says dots-specific reviewer instructions were added [3], but no dots-specific Auto-review doc exists; the launch post links the **Codex** doc for it [16]. Shared implementation is [inference].
- **Whether a dot can be given its own email or phone identity in the consumer product.** No at launch for email [13]; texting uses "a third-party provider" with STOP handling [13]; own identity exists only for specialist dots in enterprise pilots [1]. How specialist-dot credentials are stored or brokered is not disclosed.
- **Teams availability contradicts itself.** Launch post lists Teams as a live channel alongside Slack [1] and the channels page documents Teams [9]; the enterprise admin guide says "Microsoft Teams access is limited to an invite-only alpha." [10] No dated resolution found.
- **Email follow-ups contradict the "no own email" line.** The system card says dots "follow up across ChatGPT, text message, email, and Slack" [3]; the Help Center says no standalone address [13]. Likely the user's own connected inbox [inference].
- **Microsoft Agent 365 integration is one-sided.** OpenAI says "We're also working with Microsoft to integrate specialist dots with their enterprise governance and security controls in Agent 365." [1] Microsoft's Agent 365 docs list connected platforms — Amazon Bedrock, Google Vertex AI, Salesforce Agentforce, Databricks Genie, Anthropic Claude Managed Agents, Oracle, Snowflake — and do **not** list OpenAI or dots [17]; the Agent 365 overview never mentions OpenAI [18]. Nothing beyond the announcement exists as of 2026-10-26.
- **No developer surface.** No API, SDK, webhook, or headless mode for dots in the docs index [19]; the API-side "Agents API", "Agent Builder", "Vaults", "Multi-agent" pages are a separate, older platform stack and never mention dots. Deliberate: dots is a ChatGPT product, not a platform primitive.
- **Context management.** No compaction, window, retrieval, or memory-format documentation for dots. Notes are described only as "notes" [6].
- **Notification controls.** No batching, quiet hours, or per-channel routing spec; only "Tell your dot where to send different kinds of updates" [4] and a fixed bug list [12].

## Sources

1. Introducing dots — https://openai.com/index/introducing-dots/ (wayback https://web.archive.org/web/20261023002211/https://openai.com/index/introducing-dots/) — read 2026-10-26.
2. How we build safety, security, and privacy into dots — https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/ (wayback https://web.archive.org/web/20261012052334/https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/, snapshot assets dated 20261012) — read 2026-10-26.
3. GPT-6 Astra System Card, §12 "Appendix: dots" (published 2026-09-03, dots appendix added 2026-09-29) — https://deploymentsafety.openai.com/gpt-6-astra (wayback https://web.archive.org/web/20261022090016/https://deploymentsafety.openai.com/gpt-6-astra) — read 2026-10-26.
4. Meet dots — https://learn.chatgpt.com/codex/dots (wayback https://web.archive.org/web/20261016141053/https://learn.chatgpt.com/codex/dots) — read 2026-10-26.
5. Control your dot — https://learn.chatgpt.com/codex/dots/controls (wayback https://web.archive.org/web/20261016090849/https://learn.chatgpt.com/codex/dots/controls) — read 2026-10-26.
6. Tasks and memory — https://learn.chatgpt.com/codex/dots/tasks-and-memory (wayback https://web.archive.org/web/20261016090849/https://learn.chatgpt.com/codex/dots/tasks-and-memory) — read 2026-10-26.
7. Connect computers and apps to your dot — https://learn.chatgpt.com/codex/dots/computers-and-apps (wayback, Markdown twin https://web.archive.org/web/20261017155037/https://learn.chatgpt.com/docs/dots/computers-and-apps.md) — read 2026-10-26.
8. Get started with your dot — https://learn.chatgpt.com/codex/dots/getting-started (wayback, Markdown twin https://web.archive.org/web/20261017154905/https://learn.chatgpt.com/docs/dots/getting-started.md) — read 2026-10-26.
9. Message your dot — https://learn.chatgpt.com/codex/dots/channels (wayback https://web.archive.org/web/20261016090849/https://learn.chatgpt.com/codex/dots/channels) — read 2026-10-26.
10. Manage dots permissions and capabilities (admin guide) — https://learn.chatgpt.com/codex/enterprise/dots-admin-guide (wayback https://web.archive.org/web/20261007212935/https://learn.chatgpt.com/codex/enterprise/dots-admin-guide) — read 2026-10-26.
11. Local computer access for Work Cloud and dots — https://learn.chatgpt.com/codex/enterprise/cloud-local-access (wayback https://web.archive.org/web/20261016090903/https://learn.chatgpt.com/codex/enterprise/cloud-local-access) — read 2026-10-26.
12. Create your dot in the ChatGPT mobile app (What's new, October 5–9, 2026) — https://learn.chatgpt.com/codex/whats-new/dots-october-9-2026 (wayback https://web.archive.org/web/20261012211757/https://learn.chatgpt.com/codex/whats-new/dots-october-9-2026) — read 2026-10-26.
13. Getting started with your dot — https://help.openai.com/en/articles/20001530 (wayback https://web.archive.org/web/20261004002042/https://help.openai.com/en/articles/20001530; the launch post links this article as "eligible markets") — read 2026-10-26.
14. Dots: Always-on agents built to handle everything (product page) — https://chatgpt.com/features/dots/ (wayback https://web.archive.org/web/20261022190212/https://chatgpt.com/features/dots/; direct fetch returns a Cloudflare interposition) — read 2026-10-26.
15. Pricing (ChatGPT Work / Codex plans, credit rates) — https://learn.chatgpt.com/codex/pricing (wayback https://web.archive.org/web/20261016090847/https://learn.chatgpt.com/codex/pricing) — read 2026-10-26.
16. Auto-review — https://learn.chatgpt.com/docs/sandboxing/auto-review (wayback https://web.archive.org/web/20261016141056/https://learn.chatgpt.com/docs/sandboxing/auto-review; direct `.md` twin returns 403) — read 2026-10-26.
17. Connected platforms in Microsoft Agent 365 — https://learn.microsoft.com/en-us/microsoft-agent-365/admin/connected-platforms (direct) — read 2026-10-26.
18. Microsoft Agent 365 documentation — https://learn.microsoft.com/en-us/microsoft-agent-365/ (direct) — read 2026-10-26.
19. ChatGPT docs index (llms.txt) — https://learn.chatgpt.com/llms.txt (wayback https://web.archive.org/web/20261016090739/https://learn.chatgpt.com/llms.txt) — read 2026-10-26.
20. Notifications — https://learn.chatgpt.com/codex/notifications (wayback https://web.archive.org/web/20261016085218/https://learn.chatgpt.com/docs/notifications) — read 2026-10-26.
