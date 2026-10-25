# Index — grokbot lecture insights → mason (deep-research run, 2026-10-18)

Origin: Denis's notes on a guest lecture about xAI's **grokbot** always-on personal agent (`~/Documents/Insights from grok bot on always on agents_261018_143051.pdf`, distilled copy: `.scratch/grokbot-insights/SOURCE-grokbot-lecture.md`). Goal: extract state-of-the-art practice applicable to mason's agentic behavior and capabilities.

Run: 11 parallel research subagents, model `opencode-go/deepseek-v4.1-flash`, thinking `max`, launched 2026-10-18 ~18:18 MSK. Briefs, protocol, raw logs: `.scratch/grokbot-insights/`. Sessions (resume with `pi --resume <id>`): `~/.pi/agent/sessions/--home-denis-dev-mason--/`, IDs listed per file below. Every claims-vs-source audit belongs to the triage/spec phase — findings marked **[inference]** there are unverified.

| File | Topic | Session ID |
|---|---|---|
| [01-web-browsing-for-agents.md](01-web-browsing-for-agents.md) | Web browsing: structure-first vs pixels, persistent profiles, handoff at walls | `01a14f9a-4e3d-7054-bc9e-90397e888147` |
| [02-computer-use.md](02-computer-use.md) | Computer use: helper-owned screen, Xvfb container, click accuracy, isolation | `01a14f9a-7557-7518-96ab-8505f2d6d565` |
| [03-file-based-memory.md](03-file-based-memory.md) | File-based memory: profile/log/notes/search, governed write-back, mem0 coexistence | `01a14f9a-9c66-7327-9fa3-833790252495` |
| [04-progressive-disclosure.md](04-progressive-disclosure.md) | Skills + tool search + docs-on-demand; pi ships it, mason doesn't wire it | `01a14f9a-c379-776d-b455-ef7bd6031c5d` |
| [05-compaction-branching-caching.md](05-compaction-branching-caching.md) | Compaction timing, cache-miss discipline, fork-per-workstream instead of branches | `01a14f9a-ea86-71ed-96fe-fe1c2dd5eae9` |
| [06-secrets-and-security.md](06-secrets-and-security.md) | Secrets never reach the model; env boundary, control-plane auth, untrusted labels | `01a14f9b-119f-74a7-a339-e03f8c9743ec` |
| [07-behavior-alignment-via-prompting.md](07-behavior-alignment-via-prompting.md) | Behavior policy: attention budget, cost ladder, terminal send_to_user, POLICY.md | `01a14f9b-38b3-7765-9585-28a481667d2f` |
| [08-subagents-triage-delegation.md](08-subagents-triage-delegation.md) | Orchestrator-worker on the durable harness; report contracts; triage by channel | `01a14f9b-5fc3-70bd-a47d-faff675dd691` |
| [09-recursive-self-improvement.md](09-recursive-self-improvement.md) | Self-edit ladder with evidence gates; evals from failures; monthly ablation | `01a14f9b-86e5-74f4-a7c9-a0a6949bfcb3` |
| [10-always-on-durability-triggers.md](10-always-on-durability-triggers.md) | Trigger→turn mapping, durable schedules, batching, channel layer | `01a14f9b-adf0-776c-aa84-f024ee9d5347` |
| [11-tool-design-and-ui-pairing.md](11-tool-design-and-ui-pairing.md) | Stable tool list, small schemas, actionable errors, approval cards | `01a14f9b-d507-7737-904e-92f0176629e0` |
| [12-whats-new-2026-10-18.md](12-whats-new-2026-10-18.md) | A week of shipped grokbot product, not a design lecture: typed cards, attention, channel queues | — (raw transcript supplied by Denis) |
| [13-is-the-agent-harness-dead.md](13-is-the-agent-harness-dead.md) | "Is the agent harness dead?" — the runtime / context split, the flywheel, what mason already stands on | — (raw transcript supplied by Denis) |

`12` and `13` are companions, not thirteenth and fourteenth lecture notes: they distill *other* sources — xAI's shipped changelog (a video transcript) and a talk on harness engineering itself — so they say what shipped and what the discipline now argues, rather than what the guest lecture argued. `12` reads as the gap list against what shipped; `13` is reference only and proposes no change.

**Sibling set:** [`../always-on-agents/`](../always-on-agents/INDEX.md) (2026-10-26) is the product-side companion —
what Grok Bot, Muse, dots, Hermes Agent, OpenBot and OpenClaw actually built, cited to vendor pages and source code.
Where the two overlap on Grok Bot, that set carries the technical facts these notes do not.

## Cross-cutting conclusions (from all 11 files)

1. **pi-durable already covers the durable-agent hard part** — the gaps are app-level edges: trigger mapping, schedules-as-tasks, channels, batching (10, 08).
2. **Mason under-uses pi's own context-economy machinery** — skills, tool search, sections are all there; nothing in mason wires them (04, 03, 07).
3. **The execution environment is the security boundary, not prompts** — minimal daemon env, authenticated control plane, untrusted-content labeling, sandboxed target as default (06, 01).
4. **Quiet is mechanical, not vibes** — a terminal `send_to_user` tool makes "no news = no message" enforceable and saves the final model call (07, 10, 11).
5. **Delegation belongs in-process on the durable Harness**, never as `pi -p` subprocesses — ownership tree gives UI rows, abort, durability (08, 02).
6. **Self-improvement = evidence-gated edits**: writable roots enforced outside the agent's write scope, evals grown from real failures, ablation to delete scaffolding (09).
7. **Cache stability is an invariant, not an optimization** — byte-stable prefix, no mid-conversation tool-list changes (fix the sandboxed-UI toggle), telemetry for miss detection (05, 11).
8. **Browser/computer use: structure first, pixels as fallback, helper owns the screen, human at the walls** — start with `agent-browser` skill + a browsing ladder, not an MCP tool explosion (01, 02).
