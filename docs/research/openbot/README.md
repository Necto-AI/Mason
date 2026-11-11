# OpenBot research package

A read of OpenBot's repository, written to decide what mason should copy, what it should refuse, and what
parity would cost. Reports are numbered in dependency order; each one cites the upstream source as
`path:line`.

- **Researched:** 2026-10-26
- **Upstream:** `ef13020`, dated 2026-10-25
- **Citations:** every `path:line` in these reports points into the clone at
  `/home/user/dev/research/openbot` at that commit, not into mason.

Start with [00-SUMMARY.md](00-SUMMARY.md) — one page, the verdicts, and the reading order.

## Product

- [01-product-and-repo-map.md](01-product-and-repo-map.md) — what OpenBot is, its five workspace packages,
  the sixteen `agent-*` directories, the three runtime topologies, and where docs and code disagree.

## Backend

- [02-server-core.md](02-server-core.md) — the Hono server: routing, agent resolution, callback tokens,
  the `work_items` queue, routines, responsibilities, approvals and delivery.
- [03-data-and-learning.md](03-data-and-learning.md) — 92 tables and 61 migrations, the migration
  reachability check, Activity as a derived read, memory rows, demonstrations, telemetry and retention.
- [04-agent-engines.md](04-agent-engines.md) — the four requests every engine adapter serves, what the
  server puts around a remote run, how the engines actually differ, and what one adapter would have saved.

## Operations

- [05-container-and-deploy.md](05-container-and-deploy.md) — the all-in-one s6 image, Compose with the
  Docker-socket supervisor, the Helm chart's three computer modes, and an honest account of the sandbox floor.

## Frontend and apps

- [06-web-app-architecture.md](06-web-app-architecture.md) — routing gates, one REST transport with an
  envelope, CopilotKit owning the conversation, the roster socket, and chunking.
- [07-ui-ux.md](07-ui-ux.md) — shells, screen by screen behaviour, the design system, interaction
  patterns, and what the code shows about accessibility.
- [08-desktop-tauri.md](08-desktop-tauri.md) — the setup wizard, the fetched source tree, 36 Rust commands,
  provider sign-in, and the host-access bridge as an outbound poll.
- [09-mobile-expo.md](09-mobile-expo.md) — ten screens as a second client, keystore sessions, push as one
  delivery transport, and what a native shell buys over an installable web client.

## Security

- [10-security-and-integrations.md](10-security-and-integrations.md) — identity and roles, the credential
  vault, per-Bot grants, the tool-call corridor, approvals, channels and the append-only audit trail.

## Synthesis

- [11-product-suite.md](11-product-suite.md) — the whole suite as one system: five backend layers, three
  clients, three deployment shapes, and the bets each of them rests on.
- [12-comparison.md](12-comparison.md) — mason against OpenBot, eleven dimensions with a verdict each,
  where the reports disagree, and where mason's own decisions look wrong.
- [13-parity-roadmap.md](13-parity-roadmap.md) — what parity means for five people, the disagreements it
  settles, the M0/M1/M2 slices with dependencies and a ten-week timeline, and what mason never builds.
