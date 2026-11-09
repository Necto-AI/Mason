# OpenBot research: the one page

OpenBot is a self-hosted, multi-user chat product whose participants are agents: a Bot is a durable profile
run in the server or at any AG-UI endpoint, MIT code with CopilotKit Intelligence as a hard dependency. It
proves a governed tool corridor, a durable Postgres queue and a shell per Bot can run from one image, at the
price of fifteen engine images and a browser service, ~6,500 lines of connectors, a 732-line Helm chart and
three clients. For mason it is the best specimen of an agent product that must contain a shell it did not
write.

## Verdicts (from [12](12-comparison.md))

| Dimension | openbot | mason | Verdict |
|---|---|---|---|
| Runtime and loop | AG-UI, loop at the endpoint | one pi-durable loop, tools in `pi-env` | mason ahead |
| Persistence, memory, learning | Postgres, 92 tables, vendor transcripts | SQLite, split home, file memory | mason ahead; openbot on learning |
| Tools, triggers, security | plugin store, vault, audit | one MCP client, one HMAC door, no record | mason ahead on tools and triggers; openbot ahead on security |
| Web, desktop, mobile | five endpoints, Tauri, Expo | projection, Chord, web client frozen as an operator console; Telegram is the interface | Mason focuses on runtime and connector contracts; rich client surfaces are outside its scope |
| Identity, deployment, operations | one org, three deploy shapes | one owner, mount boundary | differs by design |

## Five things worth copying

1. **A refusal and an outcome row**, not a log line: refusals before the throw, `unattributed` when
   attribution is missing ([10](10-security-and-integrations.md) §The call corridor). Touches
   `src/server/events.ts`, `src/server/main.ts`.
2. **Approvals as a durable gate**: "ask" suspends the turn, the answer writes a resume item, actions are
   fingerprinted ([02](02-server-core.md) §Approvals and delivery). Touches `src/server/extensions/`,
   `src/shared/contract.ts`.
3. **A reviewed learning loop**: a capped, redacted recording becomes a draft, then a skill that grants
   nothing ([03](03-data-and-learning.md) §Demonstrations). Touches `src/server/extensions/skills.ts`.
4. **Scheduled work that survives downtime**, a routine switching itself off after ten failures
   ([02](02-server-core.md) §Proactive, routines, scheduling). Touches `src/server/hooks.ts`.
5. **Reach that names the decision**: a revocable device row, a delivery that carries the agent's own words
   ([09](09-mobile-expo.md) §Push). Touches `src/server/auth.ts` and the Telegram integration; a push client
   would be apiary's, not mason's.

## Five things to never copy

1. **Fifteen engine images on an AG-UI seam** — 6,035 test lines to prove fifteen frameworks answer four
   requests, and two loop owners ([04](04-agent-engines.md)).
2. **Per-vendor connectors and a plugin store** — what ADR-0003 exists to prevent
   ([10](10-security-and-integrations.md)).
3. **The Helm chart, s6 and the `EMBEDDED_*` switches** — a topology mason does not have; a mount boundary
   beats a NetworkPolicy ([05](05-container-and-deploy.md)).
4. **A vendor learning loop as the only path to improvement** — it needs a container, a CLI login and a
   browser sign-in first ([03](03-data-and-learning.md) §Learning).
5. **Multi-bot routing and handoffs** — ADR-0001 puts them out of scope; openbot concedes `ask_person` is a
   template's honest answer.

## Where mason is already ahead

- **A projection whitelist, not a filter.** An unnamed kind cannot cross; openbot streams tool arguments and
  hides them with a folding heuristic.
- **The mount boundary as the tenancy answer.** `service/` is never mounted, so a prompt bug cannot reach a
  secret as a forgotten `where` can ([03](03-data-and-learning.md)).
- **One adapter, one signed door.** A new integration is a container, a config entry and a secret.

## What this research could not settle

- What CopilotKit Intelligence does on the wire, and whether threads and memory could be local: the config
  refuses to boot without it, yet one file treats it as optional ([01](01-product-and-repo-map.md)).
- Whether two replicas can run one thread at once — the lock `ThreadBusyError` implies lives inside the
  CopilotKit client ([02](02-server-core.md)).
- Whether sandbox mode was ever run under an enforcing NetworkPolicy ([05](05-container-and-deploy.md)).
- Whether mason's door records a refusal, or an accepted fire produced a turn: `events.ts` is pure, the
  accept line was not read ([10](10-security-and-integrations.md)).

## Reading order

1. **[12](12-comparison.md)**, then **[13](13-parity-roadmap.md)** — verdicts and sequencing; a reader
   deciding stops there. 13 is now the Telegram-first roadmap: Telegram is mason's interface, the web client
   is frozen as an operator console for transcript inspection, debugging and fallback, and the rich clients
   move to apiary.
2. Backend: **[01](01-product-and-repo-map.md)**, **[02](02-server-core.md)**,
   **[03](03-data-and-learning.md)**, **[04](04-agent-engines.md)**.
3. Host and deploy: **[05](05-container-and-deploy.md)**, plus 03 §"What a self-hoster must back up".
4. Client: **[06](06-web-app-architecture.md)**, then **[07](07-ui-ux.md)**; add
   **[09](09-mobile-expo.md)**, **[08](08-desktop-tauri.md)** only for the client-side implications.
5. Security: **[10](10-security-and-integrations.md)**, then 02 §"Auth header".
6. **[11](11-product-suite.md)** last: it reconciles the reports and notes disagreements.
