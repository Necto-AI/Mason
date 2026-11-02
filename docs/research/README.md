# Research, and what it changed

Five runs, in the order they happened. Each is a directory with an index of its own; this page exists so that nobody
starts a sixth one without knowing what the first five already answered.

| Run | Question it was asked | Files | Sources | What it actually decided |
|---|---|---|---|---|
| [`grokbot-insights/`](grokbot-insights/INDEX.md) (2026-10-18) | What does state-of-the-art always-on agent practice look like, from a lecture on xAI's grokbot plus public sources? | 13 | — | The behaviour layer: attention budget, the cost ladder, file-based memory with governed write-back, progressive disclosure, compaction discipline, secrets never in context, subagent triage, the trigger→turn mapping |
| [`always-on-agents/`](always-on-agents/INDEX.md) (2026-10-26) | How are the *shipped* always-on agents built — Grok Bot, Meta Muse, OpenAI dots, Hermes Agent, OpenBot, and the rest? | 9 | 154 | The architecture layer: the boundary is the kernel, every agent gets a machine, a credential never enters the context, a reviewer that is not the actor, and per-user versus per-agent isolation decides your multi-agent story |
| [`openbot/`](openbot/README.md) (2026-10-24) | What is in CopilotKit's open-source agent product, file by file? | 14 | — | The control-plane layer: one container per bot behind a gateway that resolves the target, evaluates a CEL policy, writes the audit row *before* acting. AG-UI as the agent↔UI protocol |
| [`agent-computers.md`](agent-computers.md) (2026-10-26) | Can every agent have a real computer, snapshotted and asleep when idle? Firecracker against Cloud Hypervisor, Kata, gVisor, libkrun and the managed sandboxes | 1 | 60+ | The VMM that meets all of it is Cloud Hypervisor, not Firecracker: Firecracker refuses virtiofs and 9p, so a host directory cannot be shared, and its rootless story is a PoC. **Firecracker was chosen anyway on 2026-11-02** — the file service and a privileged supervisor became work instead of a reason to switch ([`../adr/0009`](../adr/0009-firecracker-first-then-a-shared-vm.md)); [`../ENV-PLAN.md`](../ENV-PLAN.md) is built on that |
| [`browser-service/`](browser-service/INDEX.md) (2026-11-01) | What should the browser be? A service the agent drives over CDP and a person can take over, with Bitwarden filling logins | 2 | 25 | The browser is a service, not a library: Steel is the only self-hostable session API under a usable licence, Kernel is a better box with no session API, Browserbase ships nothing to run, browserless is SSPL. A handoff is a lease nobody sells; a credential is filled, never read |
| [`yandex-integrations/`](yandex-integrations/INDEX.md) (2026-10-26) | Can mason reach Denis's Yandex Disk, Calendar and Mail, and what does each cost? | 3 | 107 | Three protocols, no webhooks: Disk is one OAuth token, Calendar is CalDAV with a password that never expires, Mail is IMAP/SMTP with an error taxonomy nobody wrote down. All three are the `mason-telegram` shape. **Later work since 2026-11-02**: Gmail and Google Calendar come first for the application bot; this run stays the design for when Yandex is built |

## The five findings that survived all four runs

Stated once here, because they are what the plans are built on. Each names where the evidence is.

1. **The isolation boundary is the operating system, not the prompt.** Every shipped system says it, in its own words,
   and the strongest form is Nous Research's: nothing inside the agent process is containment — not the approval gate,
   not output redaction, not a tool allowlist. That is why [`../ENV-PLAN.md`](../ENV-PLAN.md) is about a machine and not
   about a policy file. (`always-on-agents/08`, §1)
2. **Every agent gets its own machine, and the isolation unit is a product decision with a bill attached.** Per user
   shared by agents (Grok Bot) makes collaboration free and compartmentalisation impossible; per agent (OpenBot, dots)
   buys the opposite. Sibling's whole shape depended on which one mason is; **answered 2026-11-02:** one container per bot,
   and several bots are a fleet speaking A2A ([`../FLEET-PLAN.md`](../FLEET-PLAN.md)). (`always-on-agents/08`, §2)
3. **A credential must never enter the context window.** Three closed vendors, three mechanisms, one invariant: the model
   is given a reference or a surrogate, and the real secret is substituted at the network boundary by something that is
   not the model. This is the same conclusion the Yandex notes reach from the other direction, and it is why the sign-in
   plan is a link that mints a credential into a container's `/data`, never a password typed into a chat.
   (`always-on-agents/08` §3, `yandex-integrations/01` §2)
4. **Attention is the scarce resource, and proactivity must be rationed.** The behaviour run's attention budget and the
   architecture run's "reviewer that is not the actor" are the same idea from two sides: a turn that speaks has to
   justify itself, and a routine that produces nothing is a cost. [`../BACKEND-PLAN.md`](../BACKEND-PLAN.md) §3 and
   [`../MVP-PLAN.md`](../MVP-PLAN.md) rung 3 are written to make that testable rather than aspirational.
   (`grokbot-insights/07`, `always-on-agents/08`)
5. **Durability is the substrate, not a feature.** Every system in the set survives a restart mid-task; the difference is
   what they make durable. Mason already makes the turn durable; the gap the plans name is the *task* (a unit of work
   that outlives a conversation), which is also what agents delegating to each other requires.
   (`always-on-agents/07`, `grokbot-insights/10`)

## What the research did not settle

- **Cold start and the cost of a machine per agent.** No vendor publishes boot or restore latencies for their agent
  computers. Firecracker's numbers are the project's own and exclude the parts an agent needs.
- **Whether a chat is a good interface for a long task.** Every shipped product has more than a chat; none publishes
  usage data showing which surface carries the work. The pilot in [`../MVP-PLAN.md`](../MVP-PLAN.md) exists to answer
  this for one person.
- **What a fleet of bots is worth.** Nobody in the set ships agent-to-agent delegation as a product. The A2A direction in
  [`../FLEET-PLAN.md`](../FLEET-PLAN.md) is a product decision, not evidence, and should be treated as such until two bots
  complete a delegated task end to end.
