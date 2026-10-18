# AGENTS.md — mason

## Overview

A proactive, always-on personal agent built on `@earendil-works/pi-durable`, `@earendil-works/pi-env`, and `@earendil-works/chord`, with an event-hook system and a mobile-ready web client adapted from `CopilotKit/OpenIntelligentUI`.

Full architecture, contracts, and milestone specifications live in [`docs/SPEC.md`](docs/SPEC.md). Read `docs/SPEC.md` before writing code.

The browser client is the chat area of `apiary` re-implemented in React: [`docs/UI-PLAN.md`](docs/UI-PLAN.md) is the porting plan, the rendering model and the decisions log. The pure part of it (`src/web/lib/transcript-model.ts` and friends) is covered by `test/transcript-model.test.ts`; keep that model free of DOM. A root `npm install` prunes `vendor/pi`'s nested dependencies (`scripts/verify-vendor.mjs` repairs them on the next install).

## Non-Negotiable Rules

1. **Do NOT touch `apiary`.** This project is standalone and will later serve as the foundation for refactoring `apiary`.
2. **Work against the local clone in `vendor/pi` — a git submodule pinned to an exact commit:**
   - `vendor/pi` — `DenisSud/pi` (upstream `earendil-works/pi` plus the fleet's patches), currently `aa9cf15be`.
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

## Commands (inside `devenv shell` or via `devenv shell -- ...`)

- `git submodule update --init --recursive` — checks out `vendor/` (first clone only).
- `npm install` — installs root dependencies, links `vendor/` packages (`scripts/link-vendor.mjs`) and repairs `vendor/pi`'s nested dependencies if a root install pruned them (`scripts/verify-vendor.mjs`, which runs `npm ci --ignore-scripts` in `vendor/pi`).
- `npm run dev` — starts the durable agent + Chord WebSocket + HTTP server (`src/server/main.ts`).
- `npm run build:web` — bundles the browser client (`src/web/main.tsx` -> `dist/web/`) using `esbuild`.
- `npm test` — runs the test suite (`node --conditions=source --experimental-strip-types --test test/*.test.ts`).

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in the repo (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, label strings equal to their names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
