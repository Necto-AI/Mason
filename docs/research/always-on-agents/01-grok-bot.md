# Grok Bot (xAI/SpaceXAI, built with Cursor) — always-on cloud agents, one Firecracker microVM per user

> Research note, 2026-10-26. Grok Bot is a desktop and mobile client for long-lived named agents ("Bots") that keep a job, memory and a shared per-user cloud computer, running on schedules and event triggers while the laptop is closed. 18 primary sources.
> Written for docs/research/always-on-agents/. Facts carry their source; [inference] marks reasoning, not evidence.

## What it is

A desktop (macOS/Windows/Linux) + iOS/Android client for long-lived named agents ("Bots"), each with a job,
memory and a shared cloud computer with browser, filesystem and terminal; work continues while the laptop is
closed, and the Bot returns when it is done or needs approval [1][9][8]. Launched 2026-08-11/12 as an
internal prototype opened to SuperGrok/Cursor subscribers, "in beta" [1][18]. Enterprise GA 2026-09-03
[15]; Team Bots (shared Bots) public beta 2026-09-28 [14]. Client versions v0.17.0 (Aug 12) → v0.71.2
(Oct 14) in the public changelog [4].

## Axis findings

### 1. Product model

- The unit is the **Bot**: "a durable AI teammate with a name, a job, its own conversation, and working
  context that develops over time" [8]. Signature line from the design post: "A Bot has a name. It has an
  avatar and a title. It remembers its conversations with you. It has its own computer and tools. When you
  come back tomorrow, you are coming back to the same Bot." [2]
- The vendor's own framing is **five primitives**: Bots, Chats, Prompts, Tools, Artifacts — "Everything else
  could remain beneath the interface until the user had a reason to care about it" [2]. Prompts are the
  interesting one because they unify three products: "Prompts give a Bot context or instructions. They can be
  used once, saved as Skills, or triggered automatically as Routines." [2]
- **Boundary rule they state explicitly**: "Capabilities and context therefore follow different boundaries in
  Grok Bot. Tools and Skills live at the account level… Memory and Routines belong to the Bot because they
  reflect what that particular role knows and does over time." [2]
- Roster as the organizing object, not chat history: "the main objects in Grok Bot are Bots, not
  conversations" [2]. Sidebar supports pins, sections, hidden Bots [4 v0.57.0][8].
- A Bot can create another Bot ("Your Bot can create a new Bot inside one of your sidebar sections") [4
  v0.34.0], and Bots can suggest a focused Bot when a job needs a long-lived owner [8].
- One Bot is marked **primary** and is the proactive one: "Your primary Bot, marked with a star, will now spot
  work it can take off your plate and offer to handle it." [4 v0.66.0]
- Teams add **Team Bots** (shared, with Managers, publish/draft states) alongside personal Bots; a Team Bot
  cannot be a member's primary Bot [4 v0.65.0][14].

### 2. Runtime (the richest axis here)

- **One microVM per user, shared by all of that user's Bots.** "Each user's work runs in a dedicated
  Firecracker microVM, a micro virtual machine with hardware-level separation from other users." [6]
  "Every computer is a Firecracker microVM with its own kernel, memory, and virtual devices." [6]
- The FAQ states the sharing rule flatly: "Every Grok Bot shares one persistent cloud computer. Your Bots
  share that machine (files, browser, logins), so they can hand work off and keep context. Isolation is per
  user, not per Grok Bot." [3]
- Inside one user there is **no compute boundary between Bots**: "all of that user's Bots share one computer,
  and Bots isolate personalities and workspaces, not compute" [6]. Deleting a Bot does not clean up:
  "Deleting a Bot doesn't remove computer files or browser sessions." [5]
- **Per-Bot screens.** "Each Bot gets its own screen, so several Bots can use browser and desktop tools in
  parallel (one computer-use task per screen at a time), but the screens are work surfaces, not security
  boundaries." [8] The computer has a 1920 × 1200 screen, raised from 1280 × 800 [4 v0.68.1].
- **Filesystem**: "The computer has a shared workspace at `/workspace`." [8] Terminal + shell access are
  listed as first-class ("a browser, filesystem, and terminal") [9]; sudo is a per-team Enterprise switch
  ("Allow Sudo on Bot Computers") [6].
- **Persistence model** — a durable disk, and three distinct lifecycle operations [5][7]:
  - "Each member's computer keeps local files, browser sessions, and anything saved in the browser on a
    durable disk across sessions. Connector tokens are never stored on the computer." [5]
  - Idle: "Idle computers hibernate automatically. Hibernation is not deletion." [5]
  - **Recreate** (new image): files and logins stay, self-installed apps/packages are removed, Team Setup
    Scripts re-run; "The current computer stays available until the replacement is ready… A Bot that is
    mid-turn pauses at a safe point and resumes on the new computer. If it can't pause in time, that member's
    recreate is not started and shows as failed." [7]
  - **Terminate**: "the member's next message starts a fresh computer on the same durable disk… a turn that
    was running is lost" [7]. Auto-terminate after 30 days idle, counted "from when the computer went to
    sleep after its last use" [7].
  - **Reset/Recover**: "both rebuild the computer from your last saved data; if the computer can't be reached
    to save first, very recent changes don't come back" [8]. Conversations live outside the computer and
    survive a reset [8].
- **No self-hosting.** "Grok Bot runs only on Cursor-hosted cloud computers. On-premises deployment,
  deployment inside your own perimeter, and bring-your-own-image deployment are not supported today." [5]
- **Egress**: shared static egress IP ranges, "shared across Grok Bot customers, and dedicated per-customer
  IPs are not available" [5]; Enterprise destination allowlist with three modes (Allow All / Defaults +
  Team Allowlist / Team Allowlist Only), applied to running computers "within about a minute", to sleeping
  ones "when they next wake", no recreate needed [5]. Members can route the cloud computer's traffic through
  their own desktop ("Route egress through this desktop") [4 v0.50.0][5].
- **Isolation is the whole product's load-bearing claim**, and they scope it honestly: one user cannot reach
  another's computer; within a user, "when a workload needs its own computer and credential set, give it its
  own Cursor user" [6].
- Not disclosed: distro/kernel version, CPU/RAM/disk size, hypervisor host region beyond "the US" [5].
  No OS name appears on any page I read (security, security FAQ, computers, work, teams) [5][6][7][8].

### 3. Identity & auth

- **Bots have no identity of their own, with one named exception**: "Bots act as the signed-in member. A Bot can
  never hold more access than the person it belongs to, every action stays attributable to a named member, and
  there's no separate machine identity outside your identity provider to provision, rotate, or audit.
  **Team-managed connectors are the one exception: they may use team or service-account credentials.**" [5]
  So the human-identity model holds for per-member connectors and stops holding for anything an org administers
  centrally, which is exactly where an auditor would look next.
- **Tokens never reach the model or the disk**: "Connector tokens stay on Cursor's backend. Bots invoke tools
  without receiving OAuth tokens, and tokens are never stored on the computer." [5]
- **Credentials by reference**: Vault → connected password manager (1Password) → Secure Form, in that order
  [8]; "the model never receives a saved password, card number, or security code, or what the member types in
  a Secure Form" [5]. API keys go through a masked secret card kept out of the transcript [5]. "Vault isn't
  available on Team Bots." [5]
- **Handing the screen over is the fallback**, not a workaround: SSO, passkeys, CAPTCHA, QR codes, card
  verification — "The Bot hands you the computer when a form can't do the step" [8].
- **A Bot can have its own email address**, claimable, plus-addressed per purpose: "Bots can claim their own
  email address and receive mail there, and email they send from it waits for your approval on a draft card"
  [4 v0.70.2]; "Bots can send from a tagged form of their email address, like name+shop@, and a routine on
  that tag runs only for its mail" [4 v0.71.2]. This is the one identity the outside world can see that is
  not the member's [inference from those two changelog lines].
- Sign-in to the product itself is the Cursor account: SAML 2.0 SSO (Okta, Entra, Google, OneLogin), SCIM 2.0
  Enterprise-only [5]. Inside the computer, apps are signed into with the org's own IdP "comparable to
  enrolling a new laptop" [5].
- Payments are an identity-adjacent path: Bots can pay with Stripe Link or X Money, cards from Vault or a
  Secure Form, "a card saved in Vault fills at checkout without a separate approval each time" [5][4
  v0.70.2].

### 4. Memory

- Behavioural description only: "A Bot retains stable preferences, important facts, and summaries from its
  work, which lets it keep a role over time without replaying every prior message." [8] The product page:
  "Stable preferences, role context, and summaries of prior work. Conversations and learned context stay
  separate per Bot, while shared files, browser sessions, and direct handoffs move context between them." [9]
- They argue **against** memory as a source of truth: "Memory is not a substitute for an authoritative
  source: keep changing facts in the source system, ask the Bot to cite or reopen current data for
  consequential decisions… and back safety boundaries with approvals and Auto-review rules rather than
  memory alone." [8]
- Memory is **per Bot, not per account** — the reason they split the boundary at all: "A legal Bot may need
  the history of an ongoing dispute, while a finance Bot may need years of financial records. Combining those
  histories into one large memory would make it harder to give each Bot the information relevant to its
  work." [2]
- Memory is editable only conversationally: tell the Bot, ask it to remember; there is a "forget" path
  ("save and forget memories reliably") [8][4 v0.59.0]. No memory browser, no export format is documented.
- Deletion surfaces: Delete All Grok Bot Data removes "Bots, conversations, memory, routines, and computer
  across every team they belong to" [7]; DPA deletion within 30 days of written direction [5].
- Team Bots: "each person's conversations with it remain private. The Bot keeps separate context and memories
  for each user while drawing on the skills shared across the team." [14] — but the same post's Data Bot
  example says "It remembers every correction and confirmation, so answers get better for everyone over
  time" [14]. The two claims are not reconciled in the post.
- Storage format, retrieval method (embeddings? search? files?) and retention of memory: not disclosed
  anywhere I read [5][8][9].

### 5. Always-on mechanics (Routines)

- The stated purpose: "Most agent sessions begin when a user sends a prompt. That leaves even a persistent Bot
  waiting for someone to activate it. Routines let users give a Bot a standing responsibility that runs on a
  schedule or in response to an event… The user defines the work once, and the Routine activates the Bot when
  it needs to happen." [2]
- Routines were promoted from settings to the main interface: "We initially treated Routines as secondary
  configuration. As they became more important to autonomous work, we moved them into the Bot's main
  interface." [2]
- **Schedule vocabulary** as shipped in the UI: every day at 8:00, weekdays at 8:00, every Monday at 9:00,
  monthly on the 1st at 8:00, every 30 minutes [2]. Semantics are **relative-to-creation and interval
  based**, not calendar-cron: "Hourly, interval, and daily routines run on a schedule counted from when you
  create them." [4 v0.31.0] Time zone is per Bot, settable in Settings and updated when the member messages
  from another zone [4 v0.53.0][4 v0.71.2][10].
- **Event triggers** (the routine list in the design post): GitHub (issue created, any issue event, PR opened/
  merged/closed, push to main, checks fail, label added, comment containing /fix, review approved, thread
  resolved, workflow fails), generic webhook POST, Slack (new messages in #channel, reaction added, channel
  created matching a pattern), Linear (issue created, status → In Review, end of cycle, status → Done), and
  Microsoft Teams messages / Sentry alerts / PagerDuty incidents [2][4 v0.17.0]. Webhook routines get "their
  own Webhook URL and Webhook key" and "receive the request body, so your Bot can act on what was sent"
  [4 v0.21.0][4 v0.27.0].
- **Triggers carry identity**: a GitHub routine "can watch a single pull request, including when it closes,
  and removes itself once the pull request merges or closes" [4 v0.25.0].
- **Control surface**: right-click a routine for Pause / Resume / Test / Edit / Delete; a Test run "performs
  real work"; a routine's runs open in their own chat [4 v0.68.0][8][4 v0.36.0]. Pausing or deleting also
  cancels queued runs [4 v0.39.0].
- **Attention backpressure for schedules** — the honest failure handling: "After a long period away, Grok Bot
  may ask whether to keep routines running and pause them if you don't respond" [8]; "A notice tells you when
  routines were paused while you were away." [4 v0.33.0]. A routine that needs a sign-in "asks you in chat at
  that step instead of quietly stopping" [4 v0.71.2].
- Teaching a routine by demonstration: "Teaching records visible computer interaction for up to ten minutes
  and doesn't record microphone audio" [8]; the learned artifact is a *skill*, which a routine then runs [1]
  [2].
- Not disclosed: missed-run/catch-up behaviour, DST handling, or whether a routine that fires while its Bot is
  busy queues or is dropped. The only adjacent line is the queue-priority rule below [4 v0.59.0].

### 6. Tools

- Tool taxonomy is deliberately flat: "Tools let Bots access information and take action through software,
  APIs, connectors, the shell, or computer use." [2] Computer use is the catch-all: Bots "can sign in and
  work across apps, tools, and websites, including platforms with no clean API or MCP" [1].
- **Skills = the open Agent Skills standard**: "a portable, version-controlled package that teaches agents how
  to perform domain-specific tasks… Skills load resources on demand, keeping context usage efficient." [12]
  In Grok Bot, skills are account-level, shared across Bots, with a `@`/by-name invocation and a per-Bot enable
  list [2][8]. A shipped change raised the plugin-skill ceiling from 24 to 200 [4 v0.71.2].
- **Connectors** are "apps" (account-wide, one connection usable by every Bot), with OAuth held server-side
  [8][5]; MCP servers are supported, including a note that a private Tailscale MCP must be exposed first
  [4 v0.70.2]. Blocking an app does not block the service's website — "the connector policy and the network
  policy are separate layers" [5].
- Tool-call robustness is visibly a product concern, not a model one: connector calls wait "up to two minutes
  for a reply", bots "fix wrongly shaped arguments", rate limits are waited out rather than retried in a loop
  [4 v0.71.2][4 v0.70.2].
- **Artifacts** are the fifth primitive: "documents, designs, code, data, and other durable outputs" [2];
  rendered as cards in the transcript (email drafts with Send/Discard, slide decks as PPTX or Google Slides,
  HTML previews with source, spreadsheet previews) [2][4 v0.68.1][4 v0.31.0][4 v0.56.0].
- **Subagents have a file format**: markdown + YAML frontmatter (`name`, `description`, `model`,
  `readonly`, `is_background`) at `.cursor/agents/` or `~/.cursor/agents/` [13]. Two built-in ones — Explore
  and Browser — exist explicitly to keep noisy output out of the parent context and to run on a faster model
  [13].

### 7. Permissions & approvals

- Three layers, named: per-action approvals, **Auto Review**, and admin enforcement [5].
  - Approvals: "the conversation shows the proposed operation and its inputs. Allow once lets the Bot continue
    with that action, Always allow can save a matching rule, and Deny stops the action; the Bot doesn't try it
    again until the member sends another message." [5] "An approval controls the proposed action, not work
    already completed." [5]
  - **Auto Review** is a second model, not a rules engine only: "an independent review model that evaluates
    risky Bot actions before they run, covering shell commands, app calls, computer use, automation writes
    (changes to routines and event triggers), and delegation such as Cloud Agent and subagent launches. It can
    let an action proceed, require approval, or deny it." [5]
  - Its stated blind spots: "It doesn't review every side effect. Memory writes and most settings changes are
    examples. Treat it as a complement to explicit boundaries and least privilege." [5]
- **Rules are the durable form of a decision**: "Ask first rules always stop matching actions, and Allow
  automatically rules let matching actions proceed only when the reviewer finds no other reason to stop…
  they only make behavior stricter; Ask first wins when rules conflict." [5] They advise narrow rules tied to
  a known action and warn against "allow everything in the browser" [5]. Rules are saved to the account and
  apply on every device [5][10].
- **Admins can enforce**: Enterprise can require Auto-review, add team rules that appear as locked rows
  ("Required by your admin"), and lift the lock per group [5][4 v0.45.0].
- **Irreversible is a modelled class**: "Before an action it can't undo, such as sending, posting, buying, or
  deleting, a Bot checks your own messages for approval" [4 v0.70.2]; browser approval cards describe the
  action "in plain words" and a saved Allow rule applies the same way on every tool [4 v0.70.2]. Approval
  requests expire and close when their time runs out [4 v0.52.0][4 v0.35.0].
- **Proactive work is itself gated**: "Auto-review asks before your Bot runs a task you didn't ask for." [4
  v0.17.0]
- **Local machine execution is a separate control from cloud approvals**: three policies (Ask every time,
  Always allow, Never allow), per desktop, "Recommend Never allow unless a Bot has a specific reason to work
  on local files" [5][4 v0.29.0].
- **Audit**: Audit Logs (admin/security/control-plane, Enterprise) and Action Recording (bot actions, off by
  default, 90-day retention, "scrubbed shell commands", OTel export tagged `cursor.surface=grok_bot`) are
  separate pipelines [5][6]. The recorded event list is unusually concrete — tool calls, connector calls,
  browser navigations as `scheme://host/path`, computer-use sessions as action/screenshot counts, "never tool
  arguments, file paths, or message content" [6].

### 8. Models

- **No model picker, and no fixed vendor set**: "Grok Bot manages model selection. There is no customer-facing
  model picker, and the serving mix can change over time with no fixed vendor set guaranteed. Each request goes
  to a first-party xAI model or a third-party model from a provider on the sub-processor list." [5]
- Usage accounting follows: "Usage and spending views record this activity as Grok Bot usage rather than by
  model." [5]
- The team model allowlist explicitly does **not** govern Grok Bot; teams with an allowlist see an
  acknowledgement when they enable it [5]. That is a deliberate trade of governance for routing freedom.
- Zero Data Retention is inherited from Cursor's provider agreements; "Providers may run abuse and safety
  classifiers, and flagged data may be stored for investigation." [5]
- Model names: the surrounding releases are Grok 4.5 (Jul 20), 4.6 (Aug 14, "a particular focus on
  long-running agents"), 4.7 (Sep 21) [18]; Grok Bot's serving model per turn is not disclosed [5].
- Compaction/context handling for a Bot's own context: not documented [5][8]. Subagents exist partly for
  this ("Long research or exploration tasks don't consume space in your main conversation") [13].

### 9. Multi-agent

- **Group chats** are the primitive: two to six Bots, a shared transcript, `@` to hand a request to one Bot,
  `@everyone` for group-wide updates [8][2]. "They pass work, assign ownership, and only pull you in for
  judgment calls." [1]
- **Handoffs are async messages, not RPC**: "A Bot can send an asynchronous message to another Bot, which
  wakes, handles the request, and can reply later; you see the handoff in the conversation." [8] Bot-to-group
  handoff messages are text-only, so a Bot must send an image directly if another must inspect it [8].
- **Cancellation propagates down the delegation tree**: "When you tell a Bot to stop, it also stops the other
  Bots it handed work to and the Cloud Agents it started." [4 v0.56.0] Same for background subagents: "Stop
  also ends a Bot's background subagents, so their results no longer wake the Bot afterward, and their pending
  approval cards expire." [4 v0.71.2]
- **Queueing has an explicit priority order**: "When you message a busy Bot, it answers you before working
  through queued updates from other Bots, Cloud Agents, and background tasks." [4 v0.59.0]; "Bots read every
  message from your other Bots, even when several arrive while they're busy." [4 v0.45.0]
- **The user is not the router** — the design principle: they rejected dashboards, assignment boards and
  handoff controls because "Each one gave the user more coordination work. Instead, coordinating Bots handle
  routine routing and bring the user in when a decision requires judgment." [2]
- **Delegation to a heavier tier exists**: "A Bot can start a Project when you ask for one: a Cloud Agent that
  plans the work and runs its own agents." [4 v0.57.0] The Team Bots post reports one such setup steering "a
  Cursor Project that orchestrated hundreds of Cloud Agents" for 100+ PRs/day [14].
- Scaling numbers: "roughly 50 Bots per account and six per group chat" [2], later relaxed — "You can create
  more than 50 Bots." [4 v0.31.0]
- Team admins can switch off bot-to-bot messaging entirely: "Team admins can turn off Messaging between Bots
  under Bot capabilities on the dashboard" [4 v0.71.2].

### 10. Surface

- **Presence is the avatar.** Six states — "A Bot may be idle, thinking, working, waiting, blocked, or done" —
  expressed as motion rather than badges, because "that would have added another layer of UI for the user to
  interpret" [2]. Hover reveals the current action [2].
- **The computer is visible in three graded levels**: "Status: the title-bar icon turns purple while the
  computer is active. Preview: opening it reveals a pinned side panel… Takeover: when the Bot needs help, the
  user can open the computer full screen, take control, and then hand it back." [2] The explicit goal: "the
  user can enter the Bot's workspace without being drawn into operating it" [2].
- **Heterogeneous transcript** is the stated design: "conversation, system events, interactive objects, and
  visualizations share one timeline" [2]; routine creation, bot-to-bot messages and settings changes appear
  as cards in the transcript, not as separate screens [2].
- **Notifications are collapsed per person, not per device**: "Notifications are suppressed while Grok Bot is
  focused; the sidebar and dock badge still show unread activity." [10] "Your phone skips notifications for a
  Bot you're viewing on your computer, and resumes them once the computer locks, sleeps, or sits idle." [4
  v0.65.0] Sidebar separates "need attention (a question, approval, or handoff)", unread activity, and working
  status [10].
- Mobile is a first-class client (iOS/Android), plus Slack as a channel per Team Bot with its own handle
  [9][14]. Voice chat exists ("a voice call from your phone wakes the Bot's sleeping computer") [4
  v0.71.2].
- They describe subtraction as the endgame: "We removed window and panel controls, computer-view options, and
  agent metadata." [2]

### 11. Plans, limits, pricing (read 2026-10-26)

- **The verifiable statement is about Cursor plans, not about a Grok Bot price.** "Grok Bot runs on macOS,
  Windows, Linux, iOS, and Android, and is included with every paid individual Cursor plan and with the Cursor
  Teams plan. You can also link an individual SuperGrok, SuperGrok Plus, or SuperGrok Heavy subscription, or
  sign in with a seat on a self-serve Grok Business plan." [5] There is no standalone Grok Bot subscription in
  the docs.
- Second-hand figures, **unverified** because `x.ai/bot` and `x.ai/pricing` are geo-blocked from this machine and
  have no archive capture: individual **Premium $30/mo, Super $100/mo, Ultra $200/mo**; Teams $30+/user/month;
  Enterprise custom [3][16]. The product page is reported to frame it as "Grok Bot's own computer / Signs into
  your tools / Routines on a schedule / Weekly Grok Bot usage included", with usage multipliers 3.5x (Super) and
  12x (Ultra) over Premium [3]; a pricing table with 4x Plus / 15x Plus / 50x Plus and Grok Bot as a
  Premium-and-up feature [16]. The two plan vocabularies do not reconcile — see Open questions.
- **Usage**: "Grok Bot subscriptions come with weekly usage included, with additional usage billed based on
  token cost." [3] "Usage resets weekly." [9] Members can set a monthly on-demand limit (None / Fixed /
  Unlimited) and a spend limit; hitting one shows a full limit banner with Upgrade / Set Spend Limit /
  Request Upgrade [4 v0.25.0][4 v0.59.0].
- At the cap the Bot degrades loudly rather than silently: "When a Bot can't reply because of a usage limit,
  rate limit, or timeout, the chat shows a card that says why." [4 v0.58.0] Enterprise admins see per-member
  spend vs limit [4 v0.30.0].
- Caps that are stated as numbers: 50 Bots/account (later relaxed) and 6 Bots/group chat [2][4 v0.31.0];
  one computer-use task per Bot screen [8]; 90-day Action Recording retention [5]; 30-day idle termination
  [7]; 100 members per bulk computer operation [7]; attachment limits 20 per message, 250 MB per document,
  1 GB per video [8].
- Not disclosed: how "usage" is metered (tokens? actions? a blended unit), what a week's allowance is in
  tokens, or any concurrency cap on simultaneously-working Bots [3][16].

### 12. Safety & failure modes

- **Threat model is published and pragmatic**, with the ordering stated: "The strongest boundary is the one
  in the request itself, so have members state what a Bot may change and where it must stop" [5], then
  Auto Review, then non-model controls: "controls that don't depend on any model's judgment, including the
  network policy, per-action approvals, and per-user isolation" [5].
- **Prompt injection**: "Content a Bot reads from the outside world, like web pages, app results, and command
  output, can try to steer it… Auto Review checks Bot actions against the member's request when enforcement is
  on… Outside content is marked as untrusted data when presented to the model… These controls reduce, but
  don't eliminate, risk from malicious content." [5] Plus Enterprise "inference hooks" that send each signed
  model request to the org's security server for allow/deny before the model runs, starting in shadow mode
  [5].
- **What they admit does not work**: Auto Review misses memory writes and most settings changes [5]; "A site
  can still block automation, expire a session, or require a human step" [9]; recreate can fail if a Bot
  cannot pause [7]; a turn running during terminate "is lost" [7]; reset can lose very recent changes [8];
  screenshot evidence is not enough for fast-changing data [8]; memory is not a source of truth [8].
- **Data residency**: "Grok Bot computers run in the United States today. That is not the same as Cursor's
  US-only data residency program, which does not apply to Grok Bot by default." [5] No customer-managed
  point-in-time restore, no per-org retention policy [5]. On-prem/BYO-image unsupported [5].
- **Certifications**: Anysphere holds ISO/IEC 27001 and ISO/IEC 42001 with Grok Bot in scope [5]. The xAI-side
  security page is generic (SSE-S3 at rest, TLS, 90-day audit trail, 180-day logs, HackerOne) and is not
  Bot-specific [17].
- **Admin kill switches**: terminate a member's computer ("stops running Bots, keeps the durable disk"), delete
  all Grok Bot data, disable bot-to-bot messaging, enforce Auto-review, network allowlist, allow/deny sudo,
  disable agent email [7][4 v0.71.2][5].

## Verbatim (the lines that carry the architecture)

> "Bots share a computer of their own in the cloud, so jobs do not stall when you step away." — [1]

> "Every Grok Bot shares one persistent cloud computer. Your Bots share that machine (files, browser, logins),
> so they can hand work off and keep context. Isolation is per user, not per Grok Bot." — [3]

> "Each user's work runs in a dedicated Firecracker microVM, a micro virtual machine with hardware-level
> separation from other users." — [6]

> "Within one user, the boundary is different: all of that user's Bots share one computer, and Bots isolate
> personalities and workspaces, not compute." — [6]

> "Each Bot gets its own screen, so several Bots can use browser and desktop tools in parallel (one
> computer-use task per screen at a time), but the screens are work surfaces, not security boundaries." — [8]

> "Capabilities and context therefore follow different boundaries in Grok Bot. Tools and Skills live at the
> account level because many Bots may need to browse the web, work with documents, or send email. Memory and
> Routines belong to the Bot because they reflect what that particular role knows and does over time." — [2]

> "Prompts give a Bot context or instructions. They can be used once, saved as Skills, or triggered
> automatically as Routines." — [2]

> "Auto Review is the review layer behind those prompts: an independent review model that evaluates risky Bot
> actions before they run, covering shell commands, app calls, computer use, automation writes (changes to
> routines and event triggers), and delegation such as Cloud Agent and subagent launches." — [5]

> "It doesn't review every side effect. Memory writes and most settings changes are examples." — [5]

> "A Bot has no identity or credentials of its own: Bots act as the signed-in member. A Bot can never hold more
> access than the person it belongs to. … Team-managed connectors are the one exception: they may use team or
> service-account credentials." — [5]

> "Connector tokens stay on Cursor's backend. Bots invoke tools without receiving OAuth tokens, and tokens are
> never stored on the computer." — [5]

> "Grok Bot manages model selection. There is no customer-facing model picker, and the serving mix can change
> over time with no fixed vendor set guaranteed." — [5]

> "Grok Bot runs only on Cursor-hosted cloud computers. On-premises deployment, deployment inside your own
> perimeter, and bring-your-own-image deployment are not supported today." — [5]

> "Each member's computer keeps local files, browser sessions, and anything saved in the browser on a durable
> disk across sessions." … "Idle computers hibernate automatically. Hibernation is not deletion." — [5]

> "A Bot that is mid-turn pauses at a safe point and resumes on the new computer. If it can't pause in time,
> that member's recreate is not started and shows as failed." — [7]

> "When you tell a Bot to stop, it also stops the other Bots it handed work to and the Cloud Agents it
> started." — [4 v0.56.0]

> "A Bot can send an asynchronous message to another Bot, which wakes, handles the request, and can reply
> later; you see the handoff in the conversation." — [8]

> "Hourly, interval, and daily routines run on a schedule counted from when you create them." — [4 v0.31.0]

> "A Bot can start a Project when you ask for one: a Cloud Agent that plans the work and runs its own
> agents." — [4 v0.57.0]

> "The result is a heterogeneous transcript in which conversation, system events, interactive objects, and
> visualizations share one timeline." — [2]

> "Notifications are suppressed while Grok Bot is focused; the sidebar and dock badge still show unread
> activity." — [10]

> "Outside content is marked as untrusted data when presented to the model." — [5]

> "Grok Bot computers run in the United States today. That is not the same as Cursor's US-only data residency
> program, which does not apply to Grok Bot by default." — [5]

## Open questions

- **Cloud computer OS, kernel, CPU/RAM/disk size**: not disclosed. Searched `/docs/grok-bot/security`,
  `/docs/grok-bot/security-faq` [11], `/docs/grok-bot/computers`, `/docs/grok-bot/work`,
  `/docs/grok-bot/teams`, the FAQ on `x.ai/bot`, and the full changelog. Only "Firecracker microVM" [6] and
  the screen size (1920 × 1200) [4 v0.68.1] are stated. No OS name appears anywhere.
- **Which model serves a given turn, and how routing decides**: not disclosed by design — "Cursor selects the
  model" [5]. xAI first-party plus sub-processor list, no per-model usage view [5].
- **Concurrency**: how many Bots can work at once on one computer beyond "one computer-use task per screen at a
  time" [8]; whether non-browser tool work is bounded. Not disclosed.
- **Routine scheduling internals**: no cron expression, no documented missed-run/catch-up, DST, or
  fire-while-busy semantics. There is no dedicated Routines doc page (`/docs/grok-bot/routines` returns 404);
  schedule semantics exist only as prose in the design post [2], the work doc [8] and changelog lines
  [4 v0.31.0].
- **Memory implementation**: storage format, retrieval (embeddings vs search), inspection UI, per-Bot memory
  size limits — not disclosed [8][9].
- **The "each Bot has its own computer" claim contradicts the docs.** Launch/design/enterprise posts say each
  Bot has its own computer [1][2][15]; the FAQ and the security docs say one computer per *member*, shared
  by that user's Bots [3][6][8]. The docs are later and more specific, so I treat per-member as the design
  of record and the marketing line as shorthand for "not your computer" [inference].
- **Metering unit for "usage"**: "weekly usage", "billed based on token cost", "recorded as Grok Bot usage
  rather than by model" — but no published allowance, unit or conversion [3][5][16].
- **Two unreconciled plan vocabularies.** The docs say Grok Bot is "included with every paid individual Cursor
  plan and with the Cursor Teams plan" and can be reached by linking "SuperGrok, SuperGrok Plus, or SuperGrok
  Heavy" [5], while the x.ai product and pricing pages describe Premium / Super / Ultra with 3.5x / 12x / 50x
  multipliers [3][16]. Those pages are geo-blocked here, so which family actually governs access, and what a
  subscription costs today, is **unverified** — the §11 figures should be treated as second-hand until someone
  reads `x.ai/pricing` from a permitted region.
- **Marketplace/connector counts**: not extracted. `x.ai/bot/marketplace` rendered no counts through the fetch
  path and no numeric inventory of plugins/MCP servers is published that I found [not sourced: fetch returned
  no counts].
- **Desktop app stack**: the changelog's "Use hardware acceleration", installer/update behaviour and version
  cadence read as Electron-style [inference]; the vendor never says so.

## Sources

1. Introducing Grok Bot — https://x.ai/news/introducing-grok-bot (wayback https://web.archive.org/web/20261021235025/https://x.ai/news/introducing-grok-bot, snapshot 20261021235025) — read 2026-10-26.
2. Designing Grok Bot for a world of persistent agents — https://x.ai/news/designing-grok-bot (wayback https://web.archive.org/web/20261009055356/https://x.ai/news/designing-grok-bot, snapshot 20261009055356) — read 2026-10-26.
3. Grok Bot product page + FAQ — https://x.ai/bot (wayback https://web.archive.org/web/20261022131014/https://x.ai/bot) — read 2026-10-26.
4. Grok Bot Changelog (v0.17.0 → v0.71.2, Aug 12 – Oct 14 2026) — https://x.ai/changelog/bot (wayback https://web.archive.org/web/20261022235207/https://x.ai/changelog/bot) — read 2026-10-26.
5. Grok Bot security — https://cursor.com/docs/grok-bot/security (direct) — read 2026-10-26.
6. Grok Bot for Teams and Enterprise — https://cursor.com/docs/grok-bot/teams (direct) — read 2026-10-26.
7. Manage Grok Bot computers — https://cursor.com/docs/grok-bot/computers (direct) — read 2026-10-26.
8. Work with Grok Bot (bots, messaging, the computer, skills, routines) — https://cursor.com/docs/grok-bot/work (direct) — read 2026-10-26.
9. Grok Bot overview — https://cursor.com/docs/grok-bot (direct) — read 2026-10-26.
10. Settings and notifications — https://cursor.com/docs/grok-bot/settings (direct) — read 2026-10-26.
11. Grok Bot security FAQ — https://cursor.com/docs/grok-bot/security-faq (direct) — read 2026-10-26.
12. Agent Skills — https://cursor.com/docs/skills (direct) — read 2026-10-26.
13. Subagents — https://cursor.com/docs/subagents (direct) — read 2026-10-26.
14. Team Bots: shared AI teammates that learn as they work (Sep 28, 2026) — https://x.ai/news/team-bots (wayback https://web.archive.org/web/20261009055522/https://x.ai/news/team-bots) — read 2026-10-26.
15. Grok Bot for Enterprise (Sep 3, 2026) — https://x.ai/news/grok-bot-for-enterprise (wayback https://web.archive.org/web/20261001153009/https://x.ai/news/grok-bot-for-enterprise) — read 2026-10-26.
16. Pricing — https://x.ai/pricing (wayback https://web.archive.org/web/20261023154921/https://x.ai/pricing) — read 2026-10-26.
17. Trust & Security — https://x.ai/security (wayback https://web.archive.org/web/20261019192316/https://x.ai/security) — read 2026-10-26.
18. News index (release dates: Grok 4.5 Jul 20, 4.6 Aug 14, 4.7 Sep 21, Grok Bot Aug 11/12) — https://x.ai/news (wayback https://web.archive.org/web/20261019192327/https://x.ai/news) — read 2026-10-26.
