#!/usr/bin/env bash
# The image as a deployment runs it: five assertions, in the order a container meets them.
#
#   1. `docker/Dockerfile` builds. Nothing else here is meaningful if the source tree cannot become the image.
#   2. An empty home, and a home that names a model but has no key, are both refused non-zero by a sentence that names
#      the missing credential. The second is the shape the bug actually has: a server with a model and no key boots and
#      listens while every turn fails, so the assertion is the output, not just the exit code.
#   3. `MASON_HOME` naming the root is refused by the guard, and the boot wrote nothing into the root first. The
#      entrypoint used to create `agent/` and `service/` there before any mason code ran, which bypassed
#      `refuseRootAsHome`: `refuseLegacyRoot` then refused every command about two directories mason had just made.
#   4. With the offline provider (`PI_FAUX_MODEL=1`, `src/server/provider.ts`) the server reaches its ready state, and a
#      running container carries three files the boot had to write. Ready is `/api/health`: mason has a health door
#      (`docs/SURFACE.md`, `main.ts`), it needs no credential, and it names the home it serves, so this asserts the door
#      rather than a boot line. The three files are the ones whose absence is silent: `agent/.git` (the boot's `git`
#      could be missing and `ensureRepository` returns quietly), the seeded `ocr` skill (`seedShippedSkills` reads a
#      missing directory as no skills) and `/app/docs/agent/README.md` (the docs index does the same). Each leaves
#      `mason listening`, `200 {"status":"ok"}` and a prompt that points at a file nobody shipped.
#   5. SIGTERM stops the server cleanly: exit 0 within the stop timeout, which is what proves the entrypoint `exec`s
#      node as PID 1.
#
# The engine is podman on a NixOS host and docker on the CI runner; both take the flags below. The home is a named
# volume, not a bind mount: a rootless podman maps container uid 1000 outside the host's uid, so a bind mount's modes
# belong to the wrong account. A fresh volume takes the ownership of the image's `/home/mason/.mason`, and the dummy
# home is seeded by a throwaway root container.
#
#     bash scripts/boot-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

engine="${CONTAINER_ENGINE:-}"
if [ -z "$engine" ]; then
	if command -v podman >/dev/null 2>&1; then
		engine=podman
	elif command -v docker >/dev/null 2>&1; then
		engine=docker
	else
		echo "boot-test: neither podman nor docker is on PATH" >&2
		exit 1
	fi
fi
image="${MASON_BOOT_IMAGE:-mason:boot-test}"
# The readiness probe: the public health door answers with one word and the home it serves. `node` is in the image, so
# the probe needs no `curl` and no published port.
probe='fetch("http://127.0.0.1:8787/api/health").then(async (r) => { const text = await r.text(); if (!r.ok) process.exit(1); process.stdout.write(text); }).catch(() => process.exit(1))'
container=""
volume=""
log="$(mktemp)"

cleanup() {
	if [ -n "$container" ]; then "$engine" rm -f "$container" >/dev/null 2>&1 || true; fi
	if [ -n "$volume" ]; then "$engine" volume rm -f "$volume" >/dev/null 2>&1 || true; fi
	rm -f "$log"
}
trap cleanup EXIT

pass() { echo "  ok $1"; }
fail() {
	echo "  FAIL $1" >&2
	shift
	for line in "$@"; do echo "         $line" >&2; done
	exit 1
}
# A container's output, indented for a failure: the boot lines are the evidence, and the last forty are the boot.
logs() { "$engine" logs "$container" 2>&1 | tail -40 || true; }
# One file the boot had to write, asserted inside the running container: `test -e` is the whole of it, and the second
# argument says what its absence would mean.
shipped() {
	"$engine" exec "$container" test -e "$1" \
		|| fail "4. the boot carries what it ships" "missing $1 — $2" "$(logs)"
}

echo "[boot-test] engine: $engine, image: $image"
"$engine" build --tag "$image" --file docker/Dockerfile . \
	|| fail "1. the image builds" "docker/Dockerfile did not build"
pass "1. the image builds ($image)"

# An empty home and no credential. The volume is fresh, so this is the exact shape of a first `docker run` with no
# configuration: there is nothing to resolve a model or a key from.
volume="mason-boot-$$-empty"
"$engine" volume create "$volume" >/dev/null
container="mason-boot-$$-empty"
set +e
"$engine" run --rm --name "$container" --volume "$volume:/home/mason/.mason" "$image" >"$log" 2>&1
status=$?
set -e
container=""
"$engine" volume rm -f "$volume" >/dev/null
volume=""
if [ "$status" -eq 0 ]; then
	fail "2. an empty home with no credential is refused" "it exited 0, with: $(tail -20 "$log")"
fi
if ! grep -q "no provider credential" "$log"; then
	fail "2. an empty home with no credential is refused" "exit $status did not name the credential: $(tail -20 "$log")"
fi

# The bug this exists for is not the empty home: it is a home that names a model and has no key, which the server boots
# and serves while every turn fails. The same refusal, by name, on the shape that actually starts.
volume="mason-boot-$$-nokey"
"$engine" volume create "$volume" >/dev/null
"$engine" run --rm --user 0 --entrypoint /bin/sh --volume "$volume:/home/mason/.mason" "$image" -c '
	set -eu
	mkdir -p /home/mason/.mason/common /home/mason/.mason/bot/agent
	printf "%s\n" "{\"version\":\"0.1\",\"defaultProvider\":\"openai\",\"defaultModel\":\"gpt-4o\"}" \
		> /home/mason/.mason/common/settings.json
	chown -R 1000:1000 /home/mason/.mason
' >/dev/null
container="mason-boot-$$-nokey"
set +e
"$engine" run --rm --name "$container" --volume "$volume:/home/mason/.mason" "$image" >"$log" 2>&1
status_nokey=$?
set -e
container=""
"$engine" volume rm -f "$volume" >/dev/null
volume=""
if [ "$status_nokey" -eq 0 ]; then
	fail "2. a home with a model and no key is refused" "it exited 0, with: $(tail -20 "$log")"
fi
if ! grep -q "no provider credential" "$log"; then
	fail "2. a home with a model and no key is refused" "exit $status_nokey did not name the credential: $(tail -20 "$log")"
fi
pass "2. no provider credential is refused by name: an empty home (exit $status) and a model with no key (exit $status_nokey)"

# A root addressed as one home. The volume holds `common/` and a bot, and `MASON_HOME` names the root itself: the guard
# that refuses it lives in `ensureHouse`, and this asserts that the boot reached it — and that no half was written into
# the root on the way, which is what left every command refusing until a human moved two directories. `PI_FAUX_MODEL=1`
# keeps the credential check out of the way, so what refuses is the guard and not a missing key.
volume="mason-boot-$$-roothome"
"$engine" volume create "$volume" >/dev/null
"$engine" run --rm --user 0 --entrypoint /bin/sh --volume "$volume:/home/mason/.mason" "$image" -c '
	set -eu
	mkdir -p /home/mason/.mason/common /home/mason/.mason/bot/agent
	printf "%s\n" "{\"version\":\"0.1\",\"defaultProvider\":\"faux\",\"defaultModel\":\"faux-1\"}" \
		> /home/mason/.mason/common/settings.json
	chown -R 1000:1000 /home/mason/.mason
' >/dev/null
container="mason-boot-$$-roothome"
set +e
"$engine" run --rm --name "$container" --env PI_FAUX_MODEL=1 --env MASON_HOME=/home/mason/.mason \
	--volume "$volume:/home/mason/.mason" "$image" >"$log" 2>&1
status_root=$?
set -e
container=""
if [ "$status_root" -eq 0 ]; then
	fail "3. a root named as one home is refused" "it exited 0, with: $(tail -20 "$log")"
fi
if ! grep -q "is a mason root, not one home" "$log"; then
	fail "3. a root named as one home is refused" "exit $status_root was not the guard's sentence: $(tail -20 "$log")"
fi
for half in agent service; do
	if "$engine" run --rm --user 0 --entrypoint /bin/sh --volume "$volume:/home/mason/.mason" "$image" \
		-c "test -e /home/mason/.mason/$half"; then
		fail "3. a root named as one home is refused" "the boot wrote /home/mason/.mason/$half before refusing"
	fi
done
"$engine" volume rm -f "$volume" >/dev/null
volume=""
pass "3. MASON_HOME naming the root is refused by the guard (exit $status_root), and the boot wrote neither half into it"

# A home with the offline provider: the bot directory is seeded here rather than by the entrypoint (the home is the
# server's to complete, under its own refusals), `common/` names the model, and `PI_FAUX_MODEL=1` is the credential-free
# provider this build plays itself.
volume="mason-boot-$$-faux"
"$engine" volume create "$volume" >/dev/null
"$engine" run --rm --user 0 --entrypoint /bin/sh --volume "$volume:/home/mason/.mason" "$image" -c '
	set -eu
	mkdir -p /home/mason/.mason/common /home/mason/.mason/bot/agent
	printf "%s\n" "{\"version\":\"0.1\",\"defaultProvider\":\"faux\",\"defaultModel\":\"faux-1\"}" \
		> /home/mason/.mason/common/settings.json
	chown -R 1000:1000 /home/mason/.mason
' >/dev/null

container="mason-boot-$$-faux"
"$engine" run --detach --name "$container" --env PI_FAUX_MODEL=1 --volume "$volume:/home/mason/.mason" "$image" >/dev/null

ready=""
for ((attempt = 1; attempt <= 60; attempt += 1)); do
	if body="$("$engine" exec "$container" node -e "$probe" 2>/dev/null)"; then
		ready="$body"
		break
	fi
	if [ "$("$engine" inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != "true" ]; then break; fi
	sleep 1
done
if [ -z "$ready" ]; then
	fail "4. a dummy provider reaches its ready state" "/api/health did not answer within 60 s" "$(logs)"
fi
if ! printf '%s' "$ready" | grep -q '"status":"ok"'; then
	fail "4. a dummy provider reaches its ready state" "/api/health answered $ready" "$(logs)"
fi
if ! printf '%s' "$ready" | grep -q '"home":"/home/mason/.mason/bot"'; then
	fail "4. a dummy provider reaches its ready state" "/api/health served the wrong home: $ready" "$(logs)"
fi

shipped "/home/mason/.mason/bot/agent/.git" "git is not on the server's PATH, and the agent's memory has no history"
shipped "/home/mason/.mason/bot/agent/skills/ocr/SKILL.md" "the shipped skills were not seeded into the home"
shipped "/app/docs/agent/README.md" "the reference the prompt indexes did not ship"
pass "4. PI_FAUX_MODEL=1 reaches ready (/api/health, the public health door: no boot-line wait) and the boot wrote its git history, its seeded skill and its docs"

started="$(date +%s)"
"$engine" stop --time 15 "$container" >/dev/null \
	|| fail "5. SIGTERM stops the server cleanly" "the engine did not stop the container" "$(logs)"
stopped="$(date +%s)"
elapsed="$((stopped - started))"
code="$("$engine" inspect --format '{{.State.ExitCode}}' "$container" 2>/dev/null || echo unknown)"
if [ "$code" != "0" ]; then
	fail "5. SIGTERM stops the server cleanly" "exit code $code after ${elapsed}s (137 is a SIGKILL: PID 1 was not the server)" "$(logs)"
fi
pass "5. SIGTERM stops it cleanly (exit 0 in ${elapsed}s)"

"$engine" rm -f "$container" >/dev/null
container=""
"$engine" volume rm -f "$volume" >/dev/null
volume=""
echo "[boot-test] all five assertions passed"
