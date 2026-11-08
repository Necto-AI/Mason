# AGENTS.md — mason

## Overview

mason is a headless, always-on agent backend — one deployment is one specialized bot, built on `@earendil-works/pi-durable`, `@earendil-works/pi-env` and `@earendil-works/chord`, with an event-hook system — and interfaces attach to it: Telegram is the first interface. There is no application in this repository: an interface is a connector, in its own repository.

Where a change goes is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the product goal, contracts and milestone specifications are [`docs/SPEC.md`](docs/SPEC.md). Read both before writing code.

`~/.mason/` is the **root**: `common/` (the provider, key and runtime every bot shares, written by `mason init`) and one directory per bot. Each bot is a home in two halves: `agent/` (mounted into the tool machine — `profile.md` is who it works for, agent-managed and always resident; `log/YYYY-MM-DD.md` holds dated facts one per line; `skills/` holds its own instructions; `workspace/` is where it works; `.git` is its memory's history) and `service/` (never a path inside the tool machine — `soul.md` is the first section of its system prompt, `integrations.json` is the services it reaches — each with an `mcp` server that lends the bot tools, a `connector` block that says what it may do on its socket, or both — and `config.json` holds the connector credentials, while `data/` is the transcript, the fire state and the attachment store). In the repo, `skills/` is what mason ships — `skills/ocr/SKILL.md` says when to read a page with `indra-ocr`, which is in the tool machine's image — and it is copied into `agent/skills/` on first boot, so a personal skill of the same name wins and the index has one root. A skill mason stops shipping is withdrawn unless somebody edited it. `src/server/house.ts` owns that layout and `src/server/root.ts` the root: `-b` over `MASON_BOT` over the only bot, with a refusal that names them, and a root whose halves sit at the root itself refused with the move. `MASON_HOME` still names one home directly, which is how a home from before the root keeps booting; the runtime's `houseHome` option is where a home is created, and tests point both at a temporary directory. A home from before the split is refused at boot, and this version does not move it: the error names them.

A **connector** attaches to mason (`docs/CONNECTOR-PROTOCOL.md`, `packages/protocol`): an external process with a *user* face (it carries people's words and the agent's replies), an *events* face (a fire), or both. Tools are not a face: they are the entry's **MCP server**, an endpoint over Streamable HTTP that mason calls in the other direction. It opens one JSON-RPC WebSocket at `/api/connector`, and `src/server/connector.ts` is mason's end of it — the handshake, admission, the streaming replies, the outbox and the agent's budgets. The agent reaches a reader through exactly one call, `reply`: it targets the turn's origin (the connector that carried the words) and never names a vendor's tool. No prompt names one either.

An integration's MCP server is a **catalog** the agent asks at the moment of the call (`mcp_search`, `mcp_describe`,
`mcp_call`, script-only), so a server that restarts or redeploys moves nothing the prompt is built from. There is no
approval step and no gateway: a deployment runs one bot for one person, and what a service may do is the credential it
holds.

There is no browser application in this repository and no owner token: a person speaks through a connector, and apiary
is where a UI becomes a product. What survives of the old read path is `src/server/projection.ts` — the reader's
transcript, derived from the durable view, with reasoning, tool calls, arguments and output left out
(`test/projection.test.ts` pins both halves). Add a new user-facing surface by naming it in the projection first: a new
tool or entry kind is invisible until the whitelist says so.

## Non-Negotiable Rules

1. **Do NOT touch `apiary`.** This project is standalone; apiary integrates with it rather than replacing it (`docs/adr/0004`).
2. **`@earendil-works/*` are ordinary dependencies, pinned in `package.json`.** There is no submodule and no `vendor/`:
   the pin `f321e5bdd` turned out to carry no fleet patches (#113), the packages are published, and the `pi-env` daemon
   ships inside `@earendil-works/pi-env` for eight platforms. Bump a version in `package.json`, never a commit in a
   submodule. `tsconfig.json`'s `paths` map went with it (#122): the compiler resolves the published types.
3. **Do NOT look for `pi-client`, `pi-server`, or `pi-protocol`.** Upstream `pi` deleted those packages in commit `7472cda` because `@earendil-works/chord` (`createHost`, `remote`, `method`, `acceptWebSockets`, `webSocketLink`) now provides the official RPC + live-state replication layer directly over WebSocket.
4. **Always split Harness vs. Tool Execution via `@earendil-works/pi-env`:**
   - Never use `NodeExecutionEnv` directly in the agent harness when `pi-env` is available.
   - Connect `RemoteExecutionEnv` (or `LocalExecutionEnv`) to a `Connection` running `localDaemon()` (the binary ships in `@earendil-works/pi-env`), or an SSH target when configured.
5. **Run TypeScript directly from source on Node 22:**
   - Use `node --experimental-strip-types ...` for all server entrypoints and tests. There is no `--conditions=source`
     any more: it made a published package resolve to `src/`, which is not in its tarball.
6. **Every way in goes through a credential check.** There is one credential class, the connector's: a hashed entry in `service/config.json`, read as `Authorization: Bearer` on every upgrade (`src/server/connectors.ts`), so a revoke lands on the next connection. It opens `/api/connector` and the one attachment upload path and nothing else. `/api/health` is the only path that answers without a credential, and it answers one word. A new entry point — another route, another socket, another tool that reaches the network — is unauthenticated until it says how it is opened, and `npm run gen:surface` fails on a route no door names. Responses carry the security headers from `main.ts`; a new route gets them for free and must not widen them.
7. **The catalog is live, and no MCP tool schema enters the registry.** The surface is `mcp_search`/`mcp_describe`/
   `mcp_call` and the catalog behind them, because a tool that appears mid-conversation would re-price the prompt prefix.
   A call is gated by the connector's own credential, not by an approval step: there is no gateway and no question. The
   marker is reported by the catalog and nothing acts on it.
8. **Least privilege after the door.** The agent's state is `~/.mason/service/data` (home `0700`, files `0600`; `MASON_DATA` overrides) — never `.data` in the cwd, and never inside `agent/`, which the tool machine mounts. An event delivery is capped at 256 KiB and 6 *fires* a minute per integration, the same limiter keyed by the sender — so two connectors firing one hook are two budgets, and the hook's own minute is untouched; A command has a budget of its own beside it, keyed `command:<integration>` where the fire's is `integration:<integration>`: six commands a minute, charged only for a command mason will act on (an undeclared or malformed word spends nothing), so a sender that spent its fire minute can still `/stop` the turn those fires started. A connector's socket budgets each class separately per connector — submissions (60), fires (6), controls (6, with `stop` in a class of its own) and attachments (30) — and an upload is capped at `attachmentBytes` (25 MiB, advertised at the handshake), expiring after `attachmentTtlMs` (a day) and scoped to the connector that posted it. Every refusal names `retryAfterMs`. The `pi-env` daemon starts through `env -i` with an allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`), so a tool cannot read the server's environment: new configuration belongs in a file, not in an exported variable (`src/server/limits.ts`, `src/server/env.ts`).

## Commands (inside `devenv shell` or via `devenv shell -- ...`)

- `devenv shell -- setup` (or `bash scripts/setup.sh`) — the whole first-time setup: the root install, then `build:packages`. One recipe, run by the dev shell and by CI, so a fresh clone and a green run cannot drift apart.
- `npm install` — installs everything, `@earendil-works/*` included, from npm. Nothing to link and nothing to repair.
- `npm run dev` — starts the durable agent + Chord WebSocket + HTTP server (`src/server/main.ts`).
- `npm test` — runs the test suite (`node --experimental-strip-types --test test/*.test.ts`), after `build:packages`, because the tests import the two packages from `dist`. `npm run test:packages` is the other suite: `packages/protocol` and `packages/connector` (with `--experimental-sqlite`, because the reference store is one SQLite file), and CI runs both.
- `npm run build:packages` — compiles `packages/*` to `dist/` with `tsc`, protocol first. `tsconfig.packages.json` keeps imports written as `./x.ts` and `rewriteRelativeImportExtensions` turns them into `./x.js` on emit, so the same source serves `--experimental-strip-types` in tests and plain `node` in a consumer.
- `npm run prove:connector` — packs both packages, installs the tarballs into an empty temporary project outside the tree, and runs the published conformance suite there with plain `node`. It fails if a package ships a `.ts` file, because a consumer's Node will not strip types inside `node_modules`. It writes nothing into the repository except the gitignored `packages/*/dist` it packs.
- `npm run lint` — biome over `src/`, `test/`, `scripts/`, `evals/` and `packages/` (`node scripts/biome.mjs check .`); `lint:write` applies the fixes. The version is pinned in `package.json` and used unchanged in CI, which is why `.npmrc` asks npm for the musl build — a glibc-linked binary does not start on NixOS — and `scripts/biome.mjs` points the shim at it. `biome.json` takes no comments: with one in it, 2.3.5 sees a second root and refuses the vendored one, so the reasoning lives here.
- `npm run typecheck` — the compiler over `src/`, `test/`, `scripts/` and `packages/` (`tsc --noEmit -p tsconfig.json`). `typescript` is a dev dependency, because the suite runs with `--experimental-strip-types`, which erases types without reading them. CI (`.github/workflows/ci.yml`) runs `setup`, the linter, this and the suite on every push to `main` and every pull request. There is no Rust step: the daemon is a published binary.
- `npm run gen:surface` — renders `docs/SURFACE.md` from the code: the doors and what opens each, the extensions a boot installs, the budgets. `gen:surface:check` fails on a stale or hand-edited copy, and on a route literal no door claims; `npm run check:docs` holds each document to its ceiling in `docs/doc-budgets.json` (`docs/AGENTS.md`), and `npm run check:code` holds each area of code to its ceiling in `docs/code-budgets.json`. CI runs them beside the typecheck.
- `npm run eval` — runs the five behaviour scenarios against one model (`evals/run.ts`, default `opencode-go/deepseek-v4.1-flash`), writing traces to `.data/evals/`; flags, cost and scenario shape in `evals/README.md`. It costs real tokens: run it only when asked.
- `npm run eval:judge -- <results-dir>` — scores stored eval traces on message quality against `evals/rubric.md` (`evals/judge.ts`, default judge `ollama/bonsai-2:27b`).
- `npm run connector -- list | add <connector> [--replace] | revoke <id>` — the credential a connector opens its socket with (`scripts/connector.ts`). The credential is printed once and stored as a hash in `service/config.json`, read on every connection, so a revoke lands on the next connection rather than the next restart. The grant is the entry's `connector` block in `service/integrations.json`: the faces, the one `user.owner` actor (whose words are the owner's), its conversations and capabilities, the event `kind` → routine map, and `commands` (out of the closed set `stop`, `compact`, `clear`, `status`). A credential for an entry with no `connector` block is refused — it would open a socket with nothing on it.
- `npm run integration -- add <name> --mcp-url <url> --description <line> [--replace] | remove <name> | enable <name> | disable <name> | list` — the services the agent reaches (`scripts/integration.ts`, `src/server/integrations.ts`), in `service/integrations.json`. An entry may carry an `mcp` server (an endpoint over Streamable HTTP, with the one line the model is told about it), a `connector` grant, or both. A fresh `add` switches it on, while a `--replace` moves the endpoint and leaves the switch and the grant as they were. There is no trigger face any more (#104): a service wakes mason with `mason/fire` over the connector's socket, and what that socket may spend is its grant, written into the file by hand. The file is read once at boot, so a change is a restart, and it says so. An integration the boot cannot reach loses its tools, and the loss is reported on `mason/control` `status` and at boot, unless the entry is `required` — then the boot refuses.

- `mason onboard` / `init` / `new <name>` / `bots` / `doctor` / `status` — the root and its bots (`scripts/onboard.ts`,
  `init.ts`, `new.ts`, `bots.ts`, `doctor.ts`, `status.ts`). `onboard` is the first run end to end: root, first bot, first
  connector, doctor. With a terminal it is the wizard (`scripts/onboarding.ts`, `src/tui/`); `--yes` and a pipe take the
  dispatcher, so a script is never asked anything. `init` verifies one real completion before it writes. `doctor` is nine read-only checks, one repair
  command per failure, exit 1 on any failure. A second run asks nothing the files answer.
- `mason setup` / `mason chat` — the day-2 connector and the first conversation (`scripts/setup.ts`, `scripts/chat.ts`): offers the connectors this release
  knows (`catalog/connectors.json`, parsed by `src/server/catalog.ts`, where an unknown key is a refusal), asks what the
  chosen one needs, writes the grant through the writer the boot reads, mints one credential, renders
  `service/connectors/<name>/compose.yaml` (`connector-compose.ts`) and starts it through `podman compose` (`podman.ts`)
  with `restart: always`, and reports `podman-restart.service` when the boot half of that policy is missing. Every step has a flag (`--connector`, `--url`, `--env K=V`,
  `--owner`, `--no-start`, `--yes`), so CI drives the same flow with no terminal, and the wizard (`scripts/wizard.ts`,
  `@earendil-works/pi-tui`) is a shell over it. `mason chat` is the built-in `console` connector: it mints its own
  credential for that entry and opens the same socket every connector opens. `service/connectors.json` records what was
  installed; the server never reads it.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in the repo (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, label strings equal to their names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
