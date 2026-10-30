# AGENTS.md — mason

## Overview

mason is a headless, always-on agent backend — a proactive personal agent built on `@earendil-works/pi-durable`, `@earendil-works/pi-env` and `@earendil-works/chord`, with an event-hook system — and interfaces attach to it: Telegram is the first interface, and the operator console in this repository is the second, frozen.

Full architecture, contracts, and milestone specifications live in [`docs/SPEC.md`](docs/SPEC.md). Read `docs/SPEC.md` before writing code.

The agent lives in `~/.mason/`, in two halves: `agent/` (mounted into the tool machine — `profile.md` is who it works for, agent-managed and always resident; `log/YYYY-MM-DD.md` holds dated facts one per line; `skills/` holds its own instructions; `workspace/` is where it works; `.git` is its memory's history) and `service/` (never a path inside the tool machine — `soul.md` is the first section of its system prompt, `roster.json` is who is in the room: the names a person may speak as, mapped by whichever interface that person is using, `integrations.json` is the services it reaches — each with an MCP endpoint that lends the bot tools, a signed trigger that wakes it, or both — and `config.json` and `data/` are the credentials and the transcript). In the repo, `skills/` is what mason ships — `skills/generative-ui/SKILL.md` is the widget manual the prompt only points at, and `skills/ocr/SKILL.md` says when to read a page with `indra-ocr`, which is in the tool machine's image — and it is copied into `agent/skills/` on first boot, so a personal skill of the same name wins and the index has one root. `src/server/house.ts` owns that layout; `MASON_HOME` relocates the home that every reader and writer resolves, and the runtime's `houseHome` option is where it is created — tests point both at a temporary directory, which is how they stay out of the real home. A home from before the split is refused at boot until `npm run doctor -- migrate` has moved it.

The browser client in this repository is the operator console, frozen (`docs/adr/0004-mason-is-a-headless-backend.md`): the backing contract is mason's job, and [`docs/UI-PLAN.md`](docs/UI-PLAN.md) records the port from sibling's chat area and the rendering decisions behind it. **The client is sent the reader's transcript, never the conversation:** `src/server/projection.ts` derives `transcript` / `queued` / `agentStatus` from the durable view, and reasoning, tool calls, tool arguments and tool output do not cross the wire (`test/projection.test.ts` pins both halves). Add a new user-facing surface by naming it there first — a new tool or entry kind is invisible until the whitelist says otherwise. A root `npm install` prunes `vendor/pi`'s nested dependencies (`scripts/verify-vendor.mjs` repairs them on the next install).

## Non-Negotiable Rules

1. **Do NOT touch `sibling`.** This project is standalone; sibling integrates with mason as a backend rather than replacing it (`docs/adr/0004-mason-is-a-headless-backend.md`).
2. **Work against the local clone in `vendor/pi` — a git submodule pinned to an exact commit:**
   - `vendor/pi` — `DenisSud/pi` (upstream `earendil-works/pi` plus the fleet's patches), currently `f321e5bdd`.
   - After a fresh clone: `git submodule update --init`.
   - `scripts/link-vendor.mjs` (run by `npm install`) symlinks the `@earendil-works/*` packages into `node_modules/`.
   - Vendor source is resolved through the `paths` map in `tsconfig.json` — tsc and esbuild both honour it — so the submodule stays pristine.
   - `CopilotKit/OpenIntelligentUI` is **not** a dependency: the parts this client needed were adapted into `src/web/`
     (`open-genui-content.ts`, `frame-content.ts`, `websandbox-loader.ts`, `SandboxedUiCard.tsx`, and the design-system
     constants in `design-system.ts`, MIT, pin `8391a94`). Do not add it back as a clone.
3. **Do NOT look for `pi-client`, `pi-server`, or `pi-protocol`.** Upstream `pi` deleted those packages in commit `7472cda` because `@earendil-works/chord` (`createHost`, `remote`, `method`, `acceptWebSockets`, `webSocketLink`) now provides the official RPC + live-state replication layer directly over WebSocket.
4. **Always split Harness vs. Tool Execution via `@earendil-works/pi-env`:**
   - Never use `NodeExecutionEnv` directly in the agent harness when `pi-env` is available.
   - Connect `RemoteExecutionEnv` (or `LocalExecutionEnv`) to a `Connection` running `localDaemon()` (`vendor/pi/packages/env/bin/pi-env-linux-x64/pi-env`), or an SSH target when configured.
5. **Run TypeScript directly from source on Node 22:**
   - Use `node --conditions=source --experimental-strip-types ...` for all server entrypoints and tests.
6. **Every way in goes through `src/server/auth.ts`.** The Chord socket and `/api/*` are the owner's: a token (hashed in `~/.mason/config.json`), the `HttpOnly` session cookie it is spent into, plus an `Origin` that is ours or absent. A new entry point — another route, another socket, another tool that reaches the network — is unauthenticated until it calls `authenticate`, and the default answer is no. Two paths are outside that gate on purpose and neither is a way to speak as the owner: `/api/health`, which answers one word; and `POST /api/events/<integration>`, which verifies the sender's HMAC against that integration's trigger secret (`src/server/events.ts`) and can do exactly two things, each only because the entry declares it: fire the hook the trigger names, or issue one of the commands in its `commands` list (`stop`, `compact`, `clear`, `status`, nothing outside that set). A trigger secret is not a token: no read, no claim, no method. Responses carry the security headers from `main.ts` (CSP, `no-referrer`, `frame-ancestors 'none'`); a new route gets them for free and must not widen them.
7. **Least privilege after the door.** The agent's state is `~/.mason/service/data` (home `0700`, files `0600`; `MASON_DATA` overrides) — never `.data` in the cwd, and never inside `agent/`, which the tool machine mounts. An event delivery is capped at 256 KiB and 6 *fires* a minute per integration, the same limiter keyed by the sender — so two integrations firing one hook are two budgets, and the hook's own minute is untouched; a small JSON write to `/api/join` is capped at 32 KiB. A command has a budget of its own beside it, keyed `command:<integration>` where the fire's is `integration:<integration>`: six commands a minute, charged only for a command mason will act on (an undeclared or malformed word spends nothing), so a sender that spent its fire minute can still `/stop` the turn those fires started. The `pi-env` daemon starts through `env -i` with an allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`), so a tool cannot read the server's environment: new configuration belongs in a file, not in an exported variable (`src/server/limits.ts`, `src/server/env.ts`).

## Commands (inside `devenv shell` or via `devenv shell -- ...`)

- `git submodule update --init --recursive` — checks out `vendor/` (first clone only).
- `npm install` — installs root dependencies, links `vendor/` packages (`scripts/link-vendor.mjs`) and repairs `vendor/pi`'s nested dependencies if a root install pruned them (`scripts/verify-vendor.mjs`, which runs `npm ci --ignore-scripts` in `vendor/pi`).
- `npm run dev` — starts the durable agent + Chord WebSocket + HTTP server (`src/server/main.ts`).
- `npm run build:web` — bundles the browser client (`src/web/main.tsx` -> `dist/web/`) using `esbuild`.
- `npm test` — runs the test suite (`node --conditions=source --experimental-strip-types --test test/*.test.ts`).
- `npm run eval` — runs the six behaviour scenarios against one model (`evals/run.ts`, default `opencode-go/deepseek-v4.1-flash`), writing traces to `.data/evals/`; flags, cost and scenario shape in `evals/README.md`. It costs real tokens on a paid provider: run it only when asked.
- `npm run eval:judge -- <results-dir>` — scores stored eval traces on message quality against `evals/rubric.md` (`evals/judge.ts`, default judge `llama-server/Qwen3.8-27B`).
- `npm run token -- list | add --label <name> | revoke <id>` — the credentials that may talk to the server (`scripts/token.ts`). A fresh home mints a `browser` token on first start and logs the pairing link; `add` prints one for a new device. The server reads the config per request, so a revoke lands immediately, without a restart.
- `npm run team -- add "Ilya" | remove "Ilya" | list` — who is in the room (`scripts/team.ts`): the names a browser may claim on `/join`, and the name the server writes into what that browser says. It mints nothing — a person and a device are two different things — and the roster is read per request, so an add or a remove lands without a restart.
- `npm run integration -- add <name> --url <mcp-url> --description <line> [--replace] | remove <name> | enable <name> | disable <name> | secret <name> [--hook <hook-id>] | commands <name> <a,b,c> | list` — the services the agent reaches (`scripts/integration.ts`, `src/server/integrations.ts`), in `service/integrations.json`. An entry may carry a tools face (an MCP endpoint over Streamable HTTP, with the one line the model is told about it) and a trigger face (a hook and an HMAC secret); a fresh `add` switches it on, while a `--replace` moves the endpoint and leaves the switch and the trigger as they were. `secret` mints the trigger's 32 bytes and prints them once — a rotation replaces the key, and only `--hook` on a first trigger names what it fires. `commands` declares what that trigger's secret may ask for beyond a fire, out of the closed set `stop`, `compact`, `clear`, `status`; an empty list is no vocabulary, and any other name refuses the boot. The file is read once at boot, so a change is a restart, and it says so. An integration the boot cannot reach loses its tools and says why in `/api/integrations`, unless it is `required` — then the boot refuses.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in the repo (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, label strings equal to their names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
