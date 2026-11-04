#!/usr/bin/env bash
# The whole first-time setup, in one place: the root install, then the two packages mason's tests and its runtime import
# from `dist`. `devenv shell -- setup` runs this, and so does CI, so a fresh clone and a green run are the same recipe
# rather than two that drift.
#
# There used to be four steps before these: a submodule to check out, its dependencies, its build, and a Rust daemon
# compiled from it. All of that came from `vendor/pi`, which was a pin with no local patches (#113). The packages are
# ordinary dependencies now, and the `pi-env` daemon ships inside `@earendil-works/pi-env` for eight platforms, so a
# fresh clone has nothing to compile.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '[setup] %s\n' "$*"; }

step "root dependencies"
# `ci` when the tree is not ours to write to, `install` when it is: the strict install is the point in CI, and the
# permissive one is what a person editing `package.json` wants.
if [ -n "${CI:-}" ]; then npm ci; else npm install; fi

step "the two published packages"
npm run build:packages
