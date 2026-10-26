#!/usr/bin/env bash
# Push whatever is in git onto a running deployment.
#
# The deployment is a checkout of this repository on another machine, built and started there by `podman compose`. So an
# update is four things in this order: fetch and check out the ref, build, up, and then *prove* that the running
# containers are the ones this build made. That last step is not ceremony. `podman compose up -d --build` has been seen to
# finish a build and leave the old process running — the log then shows an image that exists and a container that never
# restarted, and the failure surfaces later as an integration the agent cannot reach. A container still running the
# previous image is a deployment that did not happen, and this script says so instead of printing "done".
#
# It does not touch `deploy/.env`. That file is the deployment's own state (tokens, secrets, the port, the uid, the
# profiles) and lives only on the host, so an update changes code, never credentials. It does not run migrations and it
# does not roll back: the checkout is left on the ref that was asked for, and a failed step leaves the failure in the
# terminal.
#
# Usage:
#   deploy/deploy.sh                 # main, on the host named by DEPLOY_HOST (default: pc)
#   deploy/deploy.sh v0.1.0          # a tag, which is what a release is
#   DEPLOY_HOST=rpi deploy/deploy.sh feat/thing
#
# Environment:
#   DEPLOY_HOST   ssh target that holds the checkout (default: pc)
#   DEPLOY_DIR    the checkout on that host (default: ~/dev/mason)
#   DEPLOY_PORT   the host loopback port mason answers on (default: read from that host's deploy/.env, else 8787)
#   COMPOSE_CMD   the compose invocation (default: "podman compose"; the podman override is always applied)
#
# Extra compose files come from `COMPOSE_EXTRA_FILES` in the host's `deploy/.env`, space-separated and relative to
# `deploy/` — `COMPOSE_EXTRA_FILES=compose.telegram.yaml` is the stack with the Telegram integration and its proxy. The
# provider here does not read that variable itself, so each name is passed as another `-f`; without it the services in
# that file are silently not part of the stack, which is exactly the kind of absence this script exists to catch.
set -euo pipefail

ref="${1:-main}"
host="${DEPLOY_HOST:-pc}"
dir="${DEPLOY_DIR:-~/dev/mason}"
compose="${COMPOSE_CMD:-podman compose}"

say() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() { printf 'deploy failed: %s\n' "$*" >&2; exit 1; }

# One ssh call per step rather than one long one, so a failure names the step it happened in instead of the session.
remote() { ssh "$host" "set -euo pipefail; cd $dir; $*"; }

extra="$(remote "grep -E '^COMPOSE_EXTRA_FILES=' deploy/.env 2>/dev/null | cut -d= -f2-" || true)"
extra_args=""
for file in $extra; do extra_args="$extra_args -f $file"; done
stack="$compose -f compose.yaml -f compose.podman.yaml$extra_args"

say "deploying $ref to $host:$dir${extra:+ (with $extra)}"

say "checkout"
# `git fetch origin <ref>` sets FETCH_HEAD for a branch and for a tag alike, and the checkout is a detached one on purpose:
# `git checkout <branch>` lands on the *local* branch of that name, which is whatever the last fetch left there — measured
# here as a deployment that quietly ran a commit from three pushes ago. A detached checkout is also honest about what a
# deployment is: a place that runs exactly one commit, not a place somebody edits.
remote "git fetch --quiet --tags --force origin '$ref' && git checkout --quiet --force --detach \$(git rev-parse FETCH_HEAD) && git log -1 --format='    %h %s'"
commit="$(remote "git rev-parse --short HEAD" | tr -d '[:space:]')"

project="$(remote "grep -m1 '^name:' deploy/compose.yaml | cut -d: -f2" | tr -d '[:space:]')"
project="${project:-mason}"

say "build"
remote "cd deploy && $stack build 2>&1 | tail -5"

say "up"
# `--force-recreate` is not caution, it is the only thing that works here: the compose provider on this host decides a
# service is unchanged by comparing the image *name* on the container with the one in the file, and a rebuild keeps the
# name (`mason:local`) while changing the id under it. It therefore reports a started container and leaves the previous
# process running — measured on this host, `mason_mason_1` kept an image from two builds earlier. The cost is that every
# deploy restarts every container, including the tool machine; the verification below is what makes that price worth it.
remote "cd deploy && $stack up -d --force-recreate 2>&1 | tail -20"

port="${DEPLOY_PORT:-$(remote "grep -E '^MASON_PORT=' deploy/.env 2>/dev/null | cut -d= -f2" || true)}"
port="${port:-8787}"
wait_for_health() {
	answered=no
	for _ in $(seq 1 60); do
		if remote "curl -fsS -o /dev/null http://127.0.0.1:$port/api/health" 2>/dev/null; then
			answered=yes
			break
		fi
		sleep 2
	done
	[ "$answered" = yes ] || fail "mason did not answer on 127.0.0.1:$port within two minutes"
}

say "waiting for mason to answer"
wait_for_health

# mason reads `integrations.json` once, at boot, and an endpoint that is not listening yet costs that integration its tools
# until the next restart — measured here as `[mcp] telegram: unreachable … its tools are absent from this boot`, because
# `up` starts mason and the integration container at the same moment. Compose cannot express the order across two files,
# so the server is restarted after the stack is up and the log is checked for what a restart was supposed to fix.
say "restarting mason, so every integration is already listening"
absent_before="$(remote "podman logs mason_mason_1 2>&1 | grep -c 'its tools are absent' || true")"
remote "podman restart mason_mason_1 >/dev/null"
wait_for_health
absent_after="$(remote "podman logs mason_mason_1 2>&1 | grep -c 'its tools are absent' || true")"
[ "$absent_after" = "$absent_before" ] || fail "an integration was unreachable at boot: $(remote "podman logs --tail 40 mason_mason_1 2>&1 | grep 'its tools are absent' | tail -1")"

say "checking that what is running is what was just built"
# Two facts from podman, compared here rather than on the host: what each container runs, and what each tag points at
# now. A container whose image id differs from the current id of its own tag is a container `up` left behind.
running="$(remote "podman ps --format '{{.Names}}|{{.Image}}|{{.ImageID}}'" | tr -d '\r')"
tags="$(remote "podman images --format '{{.Repository}}:{{.Tag}}|{{.Id}}'" | tr -d '\r')"
stale=0
while IFS='|' read -r container image have; do
	case "$container" in "${project}_"*) ;; *) continue ;; esac
	want="$(printf '%s\n' "$tags" | awk -F'|' -v t="$image" '$1 == t { print $2 }')"
	if [ -z "$want" ]; then
		note "$container: image $image is not in the local store"
		stale=1
	# `podman ps` answers a short id and `podman images` a full one, so the comparison is on the first twelve hex digits.
	elif [ "${have#sha256:}" != "${want#sha256:}" ] && [ "${have:0:12}" != "${want:0:12}" ]; then
		note "$container: running ${have:0:12}, built ${want:0:12}"
		stale=1
	else
		note "$container: ${want:0:12}"
	fi
done <<< "$running"
[ -n "$running" ] || fail "no container of the $project stack is running"
[ "$stale" = 0 ] || fail "a container is not running the image this build produced (podman compose left it running)"

say "deployed $commit to $host, answering on 127.0.0.1:$port"
