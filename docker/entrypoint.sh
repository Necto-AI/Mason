#!/usr/bin/env bash
# mason's boot: the two halves of the home, a provider credential, then the server as PID 1.
#
# The home is a volume and the image has none of it: a missing half is created here, so a mount holding an existing
# `agent/` (a backup, another machine's copy) gets its `service/` without a manual mkdir. The credential check is the one
# thing the server cannot do for itself: a model with no key boots, listens and fails every turn, and that failure is a
# provider error in a transcript rather than a sentence at start (`docker/credential.ts`).
#
# `exec` is the point of the last line. `npm run dev` is this same command with an npm wrapper in front of it, and the
# wrapper, not the server, becomes PID 1: SIGTERM stops the wrapper and the server that installs the handler dies with
# the container. Node here is PID 1, so `podman stop`/`docker stop` reaches `main.ts`'s SIGTERM handler and the database
# closes.
set -euo pipefail

: "${HOME:?[boot] HOME is not set}"
root="${MASON_ROOT:-$HOME/.mason}"
root="${root%/}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# An absent root is ours to make; an existing one is the mount's, so its mode is left alone. The server tightens the
# layout it opens (`house.ts`, `ensureHouse`), and a chmod on somebody else's mount is not this script's to do.
[ -d "$root" ] || install -d -m 0700 "$root"

# `MASON_HOME` names one home directly (the older spelling, still read by `house.ts`); otherwise the root's one bot is
# the directory beside `common/` that already holds a half. Zero or several is the server's refusal to make, with the
# names and the move; this script prepares what it can identify and lets that sentence be the one an operator reads.
home="${MASON_HOME:-}"
if [ -z "$home" ]; then
	found=()
	for candidate in "$root"/*/; do
		[ -d "$candidate" ] || continue
		if [ "${candidate%/}" = "$root/common" ]; then continue; fi
		if [ -d "$candidate/agent" ] || [ -d "$candidate/service" ]; then found+=("${candidate%/}"); fi
	done
	if [ "${#found[@]}" -eq 1 ]; then home="${found[0]}"; fi
fi
if [ -n "$home" ]; then
	[ -d "$home" ] || install -d -m 0700 "$home"
	[ -d "$home/agent" ] || install -d -m 0700 "$home/agent"
	[ -d "$home/service" ] || install -d -m 0700 "$home/service"
	echo "[boot] home: $home"
fi

node --experimental-strip-types "$here/credential.ts" "$root" "$home"

echo "[boot] starting the server"
exec node --experimental-strip-types "$here/../packages/mason-agent/src/server/main.ts"
