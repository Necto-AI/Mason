# Always-on agents — how the state of the art actually works (research run, 2026-10-26)

Goal: find out how the shipped always-on autonomous agents are built, and extract what is transferable — the
architecture, not the marketing. Closed-source first (Grok Bot, Muse, dots), then the open-source counterparts
(Hermes Agent, OpenBot) and the rest of the field (OpenClaw, Instinct, Microsoft's agent control plane).

**154 sources**, nearly all primary: the vendors' own announcement, docs, help-centre, pricing, privacy and security
pages; the model system cards; and, for the open-source projects, the source at a pinned commit. The few that are not
primary are flagged as such on their own source line (`02` carries one search-index snippet and one unrelated archived
capture of a domain that changed hands; `06` carries one blocked Wired article read through a search snippet). Four of
the six sites block this machine's region or sit behind Cloudflare, so much of it was read from the Wayback snapshot of
the same page — each source line records which, because a reader may need to reproduce the read.

## Read this first

If you read one file, read [`08-keys-to-autonomous-agents.md`](08-keys-to-autonomous-agents.md). Fourteen practices
that the shipped systems agree on, each with its evidence and where it breaks. If you read two, add
[`07-architecture-comparison.md`](07-architecture-comparison.md): the six systems in tables, the four decisions that
actually differentiate them, and the failure each vendor admits in writing.

## The files

| File | What it covers | Sources |
|---|---|---|
| [01-grok-bot.md](01-grok-bot.md) | **Grok Bot** (xAI, running on Cursor-hosted cloud computers). One Firecracker microVM **per user** shared by all that member's Bots; no agent identity; Auto Review as a second model; Routines on hyphen-free interval schedules rather than cron. The most operationally documented product in the set. | 18 |
| [02-meta-muse.md](02-meta-muse.md) | **Muse** (Meta). A per-user Linux VM split into two security domains: the agent in a systemd-nspawn cell, and `Sentinel`, a separate host-side agent that is the sole authority for connector actions and all network egress. Surrogate tokens, kernel taint tracking to ration approvals, single-use payment cards. The best published security architecture of the six. | 18 |
| [03-openai-dots.md](03-openai-dots.md) | **dots** (OpenAI). One named agent per user on its own cloud computer, GPT-6 Astra only, Auto-review as a separate model, and a measured failure curve: scope violations roughly double when task chains go from five to ten steps. The most candid numbers. | 20 |
| [04-hermes-agent.md](04-hermes-agent.md) | **Hermes Agent** (Nous Research, MIT). The open-source counterpart: bounded Markdown memory with an error on overflow, FTS5 session search, five different trigger mechanisms, tool search as a bridge, and a `SECURITY.md` that argues the only real boundary is the OS. Read from the code at a pinned commit. | 40 |
| [05-openbot.md](05-openbot.md) | **OpenBot** (CopilotKit, MIT). One container per Bot behind a gateway that resolves the target from its own snapshot, evaluates a CEL policy, **writes the audit row before acting**, then gates. The only system in the set where the record precedes the action. Plus AG-UI 1.0, the agent↔UI protocol it speaks. | 25 |
| [06-the-rest-of-the-field.md](06-the-rest-of-the-field.md) | **OpenClaw** (MIT, self-hosted, with a published threat model mapped to MITRE ATLAS and its own vulnerability ledger), **Instinct** (closed, invite-only, publishes only a homepage and terms), **Microsoft Agent 365** and **Entra Agent ID** (the governance and identity layer), and the substrate they all cite: MCP 2026-07-28, A2A 1.0, AG-UI, the Linux Foundation's Agentic AI Foundation, OWASP's agentic Top 10. | 33 |
| [07-architecture-comparison.md](07-architecture-comparison.md) | The six side by side across runtime, identity, memory, triggers, permissions and money; where they converge; the four decisions that distinguish them; what each admits does not work; the open problems. | — |
| [08-keys-to-autonomous-agents.md](08-keys-to-autonomous-agents.md) | The transferable practices: the kernel is the boundary, the credential never enters the context, authority is a capability, the record precedes the action, the reviewer is not the actor, approval friction is rationed, memory is small-and-resident or large-and-searched, always-on is a trigger discipline, caching is a correctness constraint, handoffs are typed. Ends with what this says about mason. | — |

`07` and `08` carry no sources of their own: every claim in them is sourced in `01`–`06` and in
[`../grokbot-insights/`](../grokbot-insights/INDEX.md), the earlier set on the same subject.

Working material from the run — the shared protocol, the per-subject briefs and the six raw notes before the
house-style pass — is in `.scratch/agents-research/` (gitignored, same convention as the earlier set). It also holds
`fetch.mjs`, the helper that gets past this box's region blocks and Cloudflare walls; a reader reproducing any
source in this directory will want it.

## How this relates to `docs/research/grokbot-insights/`

That set came from Denis's notes on a lecture about grokbot, plus a changelog and a talk on harness engineering: it
is about *practice* — browsing ladders, memory governance, compaction, prompting policy, delegation, self-editing.
This set is about *products*: what shipped, in what architecture, with which numbers, cited to the vendor's own
pages and to the source code. Where they overlap on Grok Bot, `01` here says what the earlier notes could not
(the runtime is a microVM per user, model choice is not customer-facing, Auto Review has named blind spots) and
does not repeat the design philosophy already covered there.

## Cross-cutting conclusions

1. **Four decisions define the design**, and they are made early whether or not anyone decides them on purpose:
   what the isolation unit is (user / agent / host), whether the agent has an identity, where the permission
   decision sits (prompt / policy code / second model), and whether the record precedes the action.
2. **The kernel is the boundary; everything in-process is a heuristic.** Stated outright by Nous Research, agreed
   with in practice by Meta (two security domains per box) and by OpenAI ("environments separate from the systems
   that … enforce key safeguards"). Nobody claims containment from a prompt.
3. **Credentials never enter the context window**, by three different mechanisms. This is the cheapest
   high-value property in the whole study: it needs no sandbox and it removes the most common injection payoff.
4. **A second model reviews the actor**, in five of six (the three closed products, Hermes' smart-mode guardian, and
   OpenBot's auto-review layer sitting above its CEL policy; OpenClaw's approval surface is not documented as one).
   What makes it usable is the published coverage list — Grok Bot names what Auto Review skips, OpenAI names its
   weakest category, Muse makes the reviewer a separate process with its own authority.
5. **Approval fatigue is engineered, not configured**: taint tracking, read-only classes for background work, graded
   recipient specificity, and a small enumerated set that always stops.
6. **Nobody has solved long-chain supervision.** The only public number is bad — 8.6% → 19.7% violation flags for
   5 → 10 intervening steps — and no vendor re-checks whether a plan still matches the request after ten turns.
7. **The quiet path is a mechanism, not a policy**: `NO_REPLY`, "worth surfacing" filters, focus-aware suppression.
   An always-on agent whose only channel is a notification produces noise by construction.
8. **mason already splits judgement from execution** (`pi-env`, the projection whitelist, the `env -i` daemon) but
   has no decision point *between* the model and the world. If unattended work arrives, this set says settle the
   reviewer, the grant and the pre-action record first — in that order. See the end of `08`.
