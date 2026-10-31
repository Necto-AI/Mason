#!/usr/bin/env bash
# Make the deployment's `vendor/pi` the commit this checkout pins it to. Run inside the deployment checkout, after the
# ref has been checked out — `deploy/deploy.sh` streams this file over ssh rather than running whatever copy the host
# already has, so an update always uses the logic it is deploying with.
#
# Two failures this exists for, both seen on a real host (issue #84):
#
# - the pin moves with the ref, and nothing moved the submodule with it. `deploy.sh` fetched, checked out and built; the
#   image was built from the previous `vendor/pi`, against an API the new code may not have, with today's tag on it and
#   nothing in the log to say so.
# - a checkout that was copied rather than cloned leaves `vendor/pi/.git` a gitfile pointing at a repository that is
#   not there, and then `git status` in the deployment fails outright instead of reporting what it is running.
#
# `--force` is deliberate: in a deployment the submodule is the pin, not a place somebody edits, and an edit left in it
# is exactly the drift this script is here to remove.
set -euo pipefail

path=vendor/pi

# Refuse before touching anything when the checkout has no pin to restore: a `rm -rf` here without one would trade a
# broken submodule for no submodule at all.
recorded="$(git rev-parse "HEAD:$path")"

if [ -e "$path" ]; then
	# `rev-parse` alone is not enough: run inside an ordinary directory, it walks up and answers with the *outer*
	# repository, so a copied `vendor/pi` looks healthy until the first command that needs a commit from it. Ask what
	# the repository at this path is, and compare it with this path.
	self="$(cd "$path" && pwd -P)"
	top="$(git -C "$path" rev-parse --show-toplevel 2>/dev/null || true)"
	if [ "$top" != "$self" ]; then
		printf '    %s is there but is not its own repository; re-initialising it from %s\n' "$path" "${recorded:0:7}"
		rm -rf "$path"
	fi
fi

git submodule sync --recursive >/dev/null
git submodule update --init --recursive --force

checked="$(git -C "$path" rev-parse HEAD)"
if [ "$recorded" != "$checked" ]; then
	printf 'deploy failed: %s is at %s, but this commit pins %s\n' "$path" "${checked:0:7}" "${recorded:0:7}" >&2
	exit 1
fi

printf '    %s %s\n' "$path" "${recorded:0:7}"
