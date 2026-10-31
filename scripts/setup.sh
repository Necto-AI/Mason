#!/usr/bin/env bash
# The whole first-time setup, in one place: `vendor/pi`'s dependencies and build, the Rust daemon the tool machine runs,
# and the root install. `devenv shell -- setup` runs this, and so does CI, so a fresh clone and a green run are the same
# recipe rather than two that drift.
#
# Why each step is here rather than left to `npm install`:
#
# - `vendor/pi` is a submodule pinned to a commit, and every `@earendil-works/*` import — at runtime and in
#   `tsconfig.json`'s `paths` — resolves into it. Its own dependencies (`openai`, `@anthropic-ai/sdk`, …) are nested
#   workspace entries that the root lockfile knows nothing about, so the root install prunes them
#   (`scripts/verify-vendor.mjs` exists for that, and repairs them after the fact).
# - the packages are consumed through `dist`, not `src`, so the build has to have happened. Measured on a fresh CI
#   checkout: without it, nothing under `src/server/` resolves `@earendil-works/pi-mcp` or `pi-coding-agent`, and the
#   compiler reports it as our error.
# - the daemon binary is not tracked in the submodule (issue #57), and two test files start a real one.
# - npm 11 gates install scripts, so the root `postinstall` may never run: it is what links the vendored packages into
#   `node_modules`. Measured here, a `npm install` that skipped it left `node_modules/@earendil-works` empty and the
#   compiler could not resolve a single vendored import. Both scripts run explicitly at the end for that reason.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '[setup] %s\n' "$*"; }

step "vendor/pi dependencies"
(cd vendor/pi && npm ci --ignore-scripts)

if [ ! -f vendor/pi/packages/ai/src/providers/data/.manifest.json ]; then
	step "pi-ai model data"
	(cd vendor/pi/packages/ai && npm run hydrate-model-data)
fi

step "vendor/pi packages"
(cd vendor/pi && npm run build:offline)

step "pi-env daemon"
(cd vendor/pi/packages/env && npm run build:daemon)
mkdir -p vendor/pi/packages/env/bin/pi-env-linux-x64
cp vendor/pi/packages/env/daemon/target/debug/pi-env vendor/pi/packages/env/bin/pi-env-linux-x64/pi-env
chmod +x vendor/pi/packages/env/bin/pi-env-linux-x64/pi-env

step "root dependencies"
# `ci` when the tree is not ours to write to, `install` when it is: the strict install is the point in CI, and the
# permissive one is what a person editing `package.json` wants.
if [ -n "${CI:-}" ]; then npm ci; else npm install; fi

step "linking vendor into node_modules"
node scripts/link-vendor.mjs
node scripts/verify-vendor.mjs
