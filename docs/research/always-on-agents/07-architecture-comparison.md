# Six always-on agents side by side — where they converge and where they actually differ

> Research note, 2026-10-26. Cross-product comparison of Grok Bot (xAI), Muse (Meta), dots (OpenAI), Hermes Agent
> (Nous Research), OpenBot (CopilotKit) and the adjacent field (OpenClaw, Instinct, Microsoft Agent 365).
> Every cell is sourced in the per-product notes next to this file; this note only arranges them. Where a cell says
> "not disclosed", the vendor does not publish it and no amount of reading gets you there.

## The one-paragraph version

All six landed on the same skeleton within about a year: **a long-lived named agent, its own machine, its own
memory, standing instructions, a way to stop for approval, and a surface that shows progress.** The differences
that matter are not in features but in four decisions: *what the isolation unit is* (user, agent, or nothing),
*whether the agent has an identity of its own*, *where the permission decision is made* (prompt, policy code, or a
second model), and *whether the audit row precedes the action or follows it*. Everything else in this class is
downstream of those four.

## 1. The matrix

### Runtime and isolation

| | Grok Bot | Muse | dots | Hermes | OpenBot | OpenClaw |
|---|---|---|---|---|---|---|
| Execution unit | one **Firecracker microVM per member**, shared by all that member's Bots | one **Linux VM per user**, one Muse | one **cloud computer per dot** | whatever backend you point it at: local, Docker, SSH, Modal, Daytona, Vercel | one **container per Bot** | the operator's own machine |
| Isolation primitive | microVM, own kernel | systemd-nspawn cell + separate privileged systemd services | per-user isolation; "sandboxing restricts what code and tools can access" inside the box | the terminal backend, and only the terminal backend | container with `CapDrop: ALL`, `no-new-privileges`, pids limit; gVisor or a Sandbox CRD optionally | none by default; "the workspace is the default cwd, not a hard sandbox" |
| Persistence | durable disk across hibernate / terminate / recreate | VM data backed up continuously | "the computer can keep its state between periods of use" | resumable if the backend offers it; serverless hibernation on Modal/Daytona | named volumes outlive the container | the host's disk |
| Screen / browser | one screen per Bot, 1920×1200, "work surfaces, not security boundaries" | Chromium behind a separate broker, a11y tree only | own browser with its own sessions, takeover model | Chromium over CDP in-process, or the sandbox's virtual display | headed Chromium on the computer's own Xvfb, persistent profile per Bot | the operator's browser |
| Shell | yes, sudo is an Enterprise switch | yes, root inside the cell mapped to an unprivileged host user | yes | yes, through the backend | yes, through the gateway, 120 s timeout, env allowlist | yes |
| Egress control | per-team allowlist, shared static IPs, no dedicated IPs | forced through Sentinel at L4 and L7 with SSRF checks | admin toggles only, semantics unpublished | proxy + host-side credential firewall in the Docker backend | four proxy modes, cloud metadata refused in every mode | none by default |
| Self-host | no, "Cursor-hosted cloud computers" only | no | no | yes, that is the whole product | yes, that is the whole product | yes |

### Identity, credentials, memory

| | Grok Bot | Muse | dots | Hermes | OpenBot | OpenClaw |
|---|---|---|---|---|---|---|
| Agent identity | none: "A Bot can never hold more access than the person it belongs to". Exception: a claimable bot email address with plus-tag routing | none for the agent; the human's identity is what the outside world sees | none at launch: "you cannot give your dot its own standalone email address". Specialist dots (enterprise pilots) get their own | the messaging bot's own account (Telegram bot, Slack app) | per-agent callback token + signed run assertion; optional SPIRE workload identity | per-agent auth profiles in the agent's own SQLite |
| Credentials vs model | tokens stay on the backend; Vault → 1Password → Secure Form by reference; model never sees them | `hatch-authd` mints **surrogate tokens**, Sentinel swaps the real credential in at the network boundary | paused model + out-of-band login form; separate encrypted credential service for saved passwords | `browser_vault` fills fields; the model sees `{filled_fields: 1, origin: …}` | web logins live in the Bot's own browser profile; saved logins at `/settings/passwords` | auth profiles per agent, with explicit credential inheritance on expiry |
| Memory | per-Bot behavioural memory, conversational editing only, no browser, format unpublished | files in the VM (`MEMORY.md`), user-readable and editable, plus "Active Memory" as a trained capability | two stores: inherited ChatGPT memory + the dot's own notes; deleting the notes requires deleting the dot | two bounded Markdown files (2,200 / 1,375 chars) + unlimited FTS5 session search; overflow is an error, not a silent drop | content and recall in an external service, provenance in the repo's own rows | plain files + one SQLite index, five trust tiers, "no hidden state" |
| Memory write path | not disclosed | not disclosed | not disclosed | scanned for injection before storage, because memory enters the system prompt | filtered by provenance rows before a Bot sees it | "the write path is the security boundary" |

### Always-on mechanics

| | Grok Bot | Muse | dots | Hermes | OpenBot | OpenClaw |
|---|---|---|---|---|---|---|
| Schedules | Routines: hourly / interval / daily / weekday / monthly, **counted from creation**, not cron; per-Bot time zone | crons first-class in the runtime sizing | saved recurring schedules with timezone, cadence, end date, destination, and which changes deserve notification | in-process 60 s ticker, own `jobs.json`, receipts-based crash recovery | routines with a 15-minute floor, 20 per person, ten failures switch it off | cron jobs, webhooks, Gmail Pub/Sub, IMAP |
| Self-initiated wake | a dedicated "primary" Bot proposes work | "in response to relevant events"; the result is filtered before it notifies | "Your dot can decide when to pause and wake up to continue work" | heartbeat (idle-only, coalesced), `/loop`, `/goal` with a judge | event triggers per responsibility | standing orders with triggers, gates, escalation |
| What stops the noise | notification suppression by focus, per-person collapse | "notifies you only when something is meaningfully new or needs your input" | per-kind destination routing; a fixed bug list | `NO_REPLY` / `[SILENT]` is a legal turn ending | audit rows record "Nobody watching" as an initiator | not documented |

### Permissions and the reviewer

| | Grok Bot | Muse | dots | Hermes | OpenBot | OpenClaw |
|---|---|---|---|---|---|---|
| Who decides | per-action approval, then **Auto Review** (a second model), then admin policy | **Sentinel**, a separate host-side agent, "the sole permission authority" for connectors and all egress | **Auto-review**, a separate model; controls live outside the dot's environment | approval gate + a smart-mode guardian LLM; hardline floor under all of it | CEL policy → audit row → approval gate → act | exec approvals + tool-policy profiles |
| Grants | Allow once / Always allow (a rule) / Deny; rules can only tighten | capabilities bound to connector/destination, scopeable one-time → perpetual | four Custom Rule modes; built-ins always apply | `smart` / `manual` / `off`, plus per-surface defaults that deny | `allow` / `pre_approved` / `ask` / `hand_off` | policy profiles |
| Friction rationing | rules narrow it | **taint tracking**: clean processes auto-allow, tainted ones lose it | read-only tool class for background work, enforced in code | webhook sessions get a four-tool allowlist in code | per-run tool narrowing (not called a boundary) | not documented |
| Always stops | sending, posting, buying, deleting: "checks your own messages for approval" | checkout detection always stops | password change, account transfer, purchases | card fills from the vault survive YOLO | credentials, security settings, payments | not documented |
| Audit | separate Audit Logs + Action Recording, 90-day, OTel-tagged | full activity log behind the avatar, plus a permissions view | Activity + Scheduled views; Compliance API records | session transcript; skills install audit; no per-action log | 129 typed events, row written **before** the action, refusal names its rule | security audit + vuln ledger |

### Models and money

| | Grok Bot | Muse | dots | Hermes | OpenBot | OpenClaw |
|---|---|---|---|---|---|---|
| Model | vendor-chosen, no picker, mixed first-party + subprocessors, allowlist does not apply | Muse Spark 1.3 → Muse Wonder; independent classifier stack | GPT-6 Astra only; "Enterprise model controls do not apply" | any provider; per-job pins; credential pools | none ships; admin supplies the credential | provider-agnostic, per-agent runtime |
| Price | $30 / $100 / $200 per month, weekly usage, on-demand overage | free metered; $20 → 500M tokens/wk, $100 → 3B/wk | included in Pro 100/200/500; "an allowance for deeper work", unquantified | free, MIT; you pay the provider | MIT; CopilotKit Intelligence from $39 to $100/seat | free, MIT; Enterprise pre-1.0 |

## 2. Where they converge — treat these as settled

1. **The agent gets a machine, not a session.** Six for six. Nobody in this class runs a persistent agent as a
   conversation against a shared API; they run it on a computer it does not share with the model's judgement.
2. **Credentials are never in the context window.** Three closed vendors, three different mechanisms (network-
   boundary swap, encrypted broker, paused-model form), same invariant. The stated reason is identical: if the
   token never enters the context, coercion has nothing to steal.
3. **A second model decides.** Grok Bot's Auto Review, OpenAI's Auto-review, Muse's Sentinel, Hermes' smart-mode
   guardian, and OpenBot's auto-review layer above its CEL policy — five of six. What differs is *where it sits in
   the stack*: in OpenBot the model gate is the last resort above team and personal rules, not the first line.
   The class has stopped believing that the acting model can police itself.
4. **Irreversible actions are a product class, not a permission level.** Four of the six enumerate payments, sends,
   deletes and password or account changes and gate them in code or in a non-configurable layer above user policy
   (Grok Bot, dots, Muse, OpenBot). The two that do not: Hermes leaves outbound messages unblocked outside the
   vault and the approval mode, and OpenClaw's approval surface is not documented well enough to say.
5. **Memory is files or it is not inspectable.** Every system here that shows memory to the user shows files
   (Muse's `MEMORY.md`, Hermes' two Markdown files, OpenClaw's workspace). Of the three that show none — Grok Bot,
   dots, OpenBot — two publish no format at all (Grok Bot, dots) and the third publishes a row schema but no recall
   (OpenBot, whose memory lives in an external service).
6. **Quiet is a mechanism.** Muse's "worth surfacing" filter, Hermes' `NO_REPLY`, Grok Bot's focus-aware
   suppression, dots' per-kind routing. An always-on agent that reports everything is the same as one that
   reports nothing.

## 3. Where they split — the four real decisions

### 3.1 What the isolation unit is

Three answers, three cost curves:

- **Per user, shared by agents** (Grok Bot). One Firecracker microVM per member; every Bot of that member shares
  files, browser logins and shell. This is cheap and it makes handoff between a member's Bots work without any
  protocol; the vendor says the quiet part out loud: "Bots isolate personalities and workspaces, not compute", and
  the remedy for a workload that needs more is "give it its own Cursor user".
- **Per agent** (OpenBot, dots). Each coworker gets its own container or cloud box. Isolation is the feature, and
  the price is that cross-agent work has to become a message between machines.
- **Per host, unisolated** (OpenClaw). The agent runs where you live and the workspace is a cwd, not a jail. The
  project is explicit that this is a single-trust-boundary design.

The consequence nobody escapes: **the isolation unit determines what "my agent can see my other agent's work"
means.** Per-user sharing gets collaboration for free and loses compartmentalisation; per-agent isolation gets
compartmentalisation and pays for collaboration in protocol.

### 3.2 Whether the agent has an identity

Three of the three closed products say no, and say it as a security property. Grok Bot: "there's no separate machine
identity outside your identity provider to provision, rotate, or audit", with team-managed connectors the one
carve-out. dots: no standalone email at launch. Muse: browsing "will appear as your activity", and the terms forbid
obscuring that the actions are automated.

The counter-current is real but early: OpenAI's *specialist dots* are "set up with its own identity, credentials, and
access"; Microsoft's Agent 365 + Entra Agent ID makes an agent a directory principal with an owner, a sponsor, a
lifecycle and its own Conditional Access policy; A2A 1.0 lets an Agent Card be signed with JWS over JCS (RFC 8785)
so the identity of an agent can be verified by a stranger. Nobody in the consumer products has shipped that, and it
is the clearest fork in the road ahead: **an agent that acts as you cannot be delegated to by anyone else.**

### 3.3 Where the permission decision is made

Four placements, in increasing strength:

| Placement | Who | Strength | What it costs |
|---|---|---|---|
| In the prompt ("ask before sending") | early agent frameworks; no system in this set relies on it | none against an adversarial model | nothing, which is why every product here replaced it with one of the rows below |
| A second model over the proposed action | Auto Review, Auto-review, Sentinel, Hermes' guardian, OpenBot's auto-review layer | catches intent the acting model lost; returns a rationale; can be tuned | the reviewer has blind spots — and only two of the five publish them |
| Policy code in the path, before the action | OpenBot's CEL, dots' read-only class, Muse's taint rule | fail-closed, testable, no model to argue with | someone has to write the policy, and a rule table cannot anticipate everything |
| Capability granted out of band | Sentinel's scoped grants, OpenBot's signed run assertion, Entra Agent ID | survives a fully compromised agent | the hardest to build, and the least shipped |

Two details are worth copying regardless of placement:

- **Judge the resolved object, not the model's label.** OpenBot refuses to evaluate an element the model named,
  because "a gateway that decides on a label supplied by the model is theatre": `{ref: "e13", name: "Continue"}`
  defeats "never click Submit". The server resolves the ref from its own snapshot.
- **Name the blind spots.** Grok Bot publishes that Auto Review does not review memory writes or most settings
  changes. OpenAI publishes that auto-review is weakest on "ambiguous authorization". That honesty is what makes
  the mechanism usable by an operator.

### 3.4 Does the record precede the action

OpenBot is the only one that makes the audit row a precondition: policy → row → gate → act, with the row written
before the call, so "an action that was not recorded did not happen, because there is no path that acts without
writing the row first". Everyone else records afterward, or records selectively (Grok Bot's Action Recording is off
by default; Hermes has no per-action audit trail and says so).

The distinction is not bookkeeping. A record written before the act is what lets an operator answer "what was it
about to do, and on whose authority" for an action that was *refused* — which is the majority of security-relevant
events. OpenBot's `initiator` column (person / routine / responsibility / memory / handoff, plus a filter literally
called "Nobody watching") is the smallest version of that idea and the cheapest to adopt.

## 4. What each of them admits does not work

This is the most useful table in the set, because a vendor only publishes a limitation it has decided not to fix.

| Product | Admitted failure |
|---|---|
| Grok Bot | Auto Review misses memory writes and most settings; a turn running during terminate "is lost"; recreate fails if a Bot cannot pause in time; reset can lose very recent changes; memory is "not a substitute for an authoritative source" |
| Muse | "Muse isn't immune to attack"; prompt injection "remains an open problem"; deleting something does not guarantee it is forgotten; isolation "does not prevent Meta from accessing data" |
| dots | scope-violation flag rate roughly doubles (8.6% → 19.7%) when intervening tasks go from five to ten; the model has "some success at evading the assignment of a P0 priority"; deleting a dot does not undo what it already did |
| Hermes | an in-process skill or plugin can read in-memory credentials; a denylist over shell strings is "structurally incomplete"; a crashed delegation becomes `unknown` rather than replayed; no live interrupt |
| OpenBot | a process that ignores proxy variables and opens a raw socket is not stopped; a browser profile is not a container; status is alpha |
| OpenClaw | "not a hostile multi-tenant security boundary"; absolute paths reach the host unless sandboxing is on |

Read together they describe one unsolved problem with three names: **the longer the chain, the less the
supervision holds.** OpenAI is the only one that put a number on it, and the number is a doubling of violations for
a doubling of chain length.

## 5. Open problems nobody has closed

1. **Long-chain supervision.** Every approval and every reviewer evaluates a step. None of them evaluates whether
   the *plan* still matches the request after ten steps, which is exactly where the measured drift appears.
2. **Memory as an attack surface.** All three closed products gate *actions*; none gates *memory writes* with the
   same rigour, and Grok Bot says outright that Auto Review does not cover them. A poisoned memory is a poisoned
   system prompt on every future session.
3. **Undo.** Everyone stops before the irreversible and nobody can reverse it afterwards. The closest thing in the
   set is Hermes' opt-in shadow-git checkpoint (its curator also archives skills rather than deleting them);
   OpenClaw's curator "dreams" — a background curation pass — and states no archive-never-delete rule.
4. **Cost as a first-class control.** OpenAI has a time budget, everyone has a usage allowance, nobody publishes a
   per-task cost ceiling that the agent itself must respect.
5. **Agent identity for the consumer case.** Entra Agent ID answers it for the enterprise; none of the consumer
   products lets a dot or a Bot be authenticated by a third party. The nearest thing is Grok Bot's claimable bot
   email with plus-tag routing — an address the outside world can see, not an identity it can verify. That caps
   what any of them can be delegated to do.
