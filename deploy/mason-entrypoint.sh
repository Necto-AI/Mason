#!/usr/bin/env bash
# mason's boot: the six things the server cannot do for itself, then the server.
#
# Runs as the unprivileged `mason` user, from the repo root (the image's WORKDIR, /app), on first boot and on every boot
# after it. Each step is idempotent and prints one `[deploy]` line saying what it did, in the shape the server's own
# `[auth]` / `[data]` boot lines already use.
#
# Order, and why:
#   0. the two halves of the home — `agent/` and `service/`, since the server's own state goes in the second one;
#   1. the provider credential — a deployment with no model must say so before it spends minutes waiting for a machine
#      it cannot use;
#   2. the env keypair — the key is what makes the rest of the boot possible;
#   3. the env host key — pinned into the file the server reads at import time (PI_ENV_SSH_KNOWN_HOSTS);
#   4. the integrations — the operator's mounted file, copied into the service half, because the copy is what the server
#      reads and what `npm run integration` writes;
#   5. the bot's own files — `soul.md` and a starter `skills/` tree, installed once and never overwritten;
#   6. the server, with the SSH target it reads from the environment.
set -euo pipefail

: "${MASON_HOME:?mason-entrypoint: MASON_HOME is not set (deploy/compose.yaml sets it)}"
: "${MASON_PI_AGENT_SRC:?mason-entrypoint: MASON_PI_AGENT_SRC is not set (deploy/compose.yaml sets it)}"
: "${MASON_INTEGRATIONS_SRC:?mason-entrypoint: MASON_INTEGRATIONS_SRC is not set (deploy/compose.yaml sets it)}"
: "${MASON_ENV_HOST:?mason-entrypoint: MASON_ENV_HOST is not set (deploy/compose.yaml sets it)}"
: "${MASON_ENV_USER:?mason-entrypoint: MASON_ENV_USER is not set (deploy/compose.yaml sets it)}"
: "${MASON_ENV_PORT:?mason-entrypoint: MASON_ENV_PORT is not set (deploy/compose.yaml sets it)}"
: "${MASON_ENV_ALIAS:?mason-entrypoint: MASON_ENV_ALIAS is not set (deploy/compose.yaml sets it)}"

if [ ! -f package.json ]; then
  echo "[deploy] package.json is not in $(pwd): this script expects the repo root (the image's WORKDIR)" >&2
  exit 1
fi

model_required="${MASON_MODEL_REQUIRED:-1}"
wait_attempts="${MASON_ENV_WAIT_ATTEMPTS:-30}"
# The home is two halves: `agent/` is the agent's own files and its history, mounted into the tool machine too;
# `service/` is everything the server owns and no tool can see (src/server/house.ts). This script only touches the
# service half, except for creating both directories.
agent_dir="$MASON_HOME/agent"
service_dir="$MASON_HOME/service"
ssh_dir="$service_dir/ssh"
pi_dir="$service_dir/pi"

install -d -m 0700 "$MASON_HOME" "$agent_dir" "$service_dir"

# 1. The provider credential, copied out of the read-only mount.
#
# pi reads `settings.json` (which model) and `auth.json` (which key) from `$PI_CODING_AGENT_DIR`, and it takes a lock
# file beside `auth.json` even to read it — `FileAuthStorageBackend.withLock` → `proper-lockfile.lockSync`. On a
# read-only directory that lock cannot be created, the error is swallowed one level up, and the store comes up empty:
# the server starts, resolves the model, and answers every turn with no credential. So the mount stays read-only (it is
# the operator's file, not ours) and the copy on the home volume is what the server reads. It is redone on every boot,
# so a rotated key lands on a restart; identical content is left alone.
copy_pi_file() {
  local name="$1"
  local source="$MASON_PI_AGENT_SRC/$name"
  local target="$pi_dir/$name"
  if [ -f "$source" ]; then
    if [ -f "$target" ] && [ "$(sha256sum "$source" | cut -d' ' -f1)" = "$(sha256sum "$target" | cut -d' ' -f1)" ]; then
      chmod 0600 "$target"
      echo "[deploy] $name unchanged"
      return 0
    fi
    install -m 0600 "$source" "$target"
    echo "[deploy] copied $name from $MASON_PI_AGENT_SRC"
    return 0
  fi
  if [ -f "$target" ]; then
    rm -f "$target"
    echo "[deploy] removed $name: $MASON_PI_AGENT_SRC has no $name"
    return 0
  fi
  echo "[deploy] no $name in $MASON_PI_AGENT_SRC"
  return 0
}

install -d -m 0700 "$pi_dir"
copy_pi_file settings.json
copy_pi_file auth.json

if [ "$model_required" = "1" ] && [ ! -f "$pi_dir/auth.json" ]; then
  echo "[deploy] no provider credential: $MASON_PI_AGENT_SRC/auth.json is missing." >&2
  echo "[deploy] put pi's settings.json and auth.json in the directory MASON_PI_AGENT_DIR names (deploy/README.md)," >&2
  echo "[deploy] or set MASON_MODEL_REQUIRED=0 to start a stack that deliberately has no model." >&2
  exit 1
fi
export PI_CODING_AGENT_DIR="$pi_dir"

# 2. The key mason logs in with. Generated once, into the service half of the home, never in an image; the public half
# goes to the shared volume, which is how it reaches mason-env without a copy step or a secret in either image. The key
# stays in `service/` on purpose: it is the door, and the tool machine must not be able to read it.
install -d -m 0700 "$ssh_dir"
if [ ! -f "$ssh_dir/id_ed25519" ]; then
  ssh-keygen -q -t ed25519 -N '' -C mason-env -f "$ssh_dir/id_ed25519"
  echo "[deploy] generated the env keypair in $ssh_dir"
fi
chmod 0600 "$ssh_dir/id_ed25519"
if ! install -m 0600 "$ssh_dir/id_ed25519.pub" /run/env-keys/authorized_keys 2>/dev/null; then
  echo "[deploy] cannot write /run/env-keys/authorized_keys as uid $(id -u): the env-keys volume is not writable." >&2
  echo "[deploy] the volume was created before the image owned that directory; recreate it with:" >&2
  echo "[deploy]   docker compose down && docker volume rm ${MASON_ENV_KEYS_VOLUME:-env-keys}" >&2
  exit 1
fi
echo "[deploy] published $ssh_dir/id_ed25519.pub to mason-env as /run/env-keys/authorized_keys"

# 3. Wait for mason-env, then pin its host key.
#
# The keys are generated per container boot (deploy/env-entrypoint.sh), so the file is rewritten rather than treated as
# trust-on-first-use state: what is pinned is what answered now, under a fixed alias, which is why a re-created env
# container is a re-scan instead of a "host key changed" refusal. `ssh-keyscan` is the wait and the pin at once.
echo "[deploy] waiting for $MASON_ENV_USER@$MASON_ENV_HOST:$MASON_ENV_PORT"
known_hosts="$ssh_dir/known_hosts"
# `ssh-keyscan` writes the keys to stdout and also a per-host banner comment there (`# <host> SSH-2.0-…`), so the lines
# are filtered by key type before they reach the file: `alias <type> <key>` is what ssh accepts and what `HostKeyAlias`
# looks up. A run that yields no key line is a failed attempt, not a pin.
KEY_TYPE='^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+)$'
pinned=""
attempt=1
while [ "$attempt" -le "$wait_attempts" ]; do
  if scan="$(ssh-keyscan -T 5 -p "$MASON_ENV_PORT" "$MASON_ENV_HOST" 2>/dev/null)"; then
    pinned="$(printf '%s\n' "$scan" | awk -v alias="$MASON_ENV_ALIAS" -v type="$KEY_TYPE" '$2 ~ type { print alias, $2, $3 }' | sort -u)"
    if [ -n "$pinned" ]; then
      break
    fi
  fi
  sleep 2
  attempt=$((attempt + 1))
done
if [ -z "$pinned" ]; then
  echo "[deploy] mason-env never answered on $MASON_ENV_HOST:$MASON_ENV_PORT after $wait_attempts attempts." >&2
  echo "[deploy] look at the other container: docker compose logs mason-env (it should stay up and log from sshd)." >&2
  echo "[deploy] mason is not starting: an agent with nowhere to run a tool is worse than no agent." >&2
  exit 1
fi
printf '%s\n' "$pinned" > "$known_hosts.tmp"
mv "$known_hosts.tmp" "$known_hosts"
chmod 0600 "$known_hosts"
echo "[deploy] pinned $(wc -l < "$known_hosts") host key(s) for $MASON_ENV_ALIAS from $MASON_ENV_HOST:$MASON_ENV_PORT"

# 4. The integrations, from the read-only mount.
#
# The same idiom as pi's credential in step 1, for the same reason: the mounted file is the operator's input, and the
# server reads a copy it owns. It is service-owned and never a path inside `agent/` — a tool that could rewrite the list
# of integrations could grant itself a capability a person never approved. Two differences from pi's copy, both
# deliberate:
#
#   * it is not rewritten every boot. `npm run integration` writes this file too, so a missing mount is not an
#     instruction to delete it: an operator who added an integration inside the container did not ask for a restart to
#     undo it. Only content that differs is installed.
#   * it is installed 0600, like everything else in `service/` — it holds each integration's connector grant.
integrations_target="$service_dir/integrations.json"
if [ -f "$MASON_INTEGRATIONS_SRC" ]; then
  if [ -f "$integrations_target" ] && [ "$(sha256sum "$MASON_INTEGRATIONS_SRC" | cut -d' ' -f1)" = "$(sha256sum "$integrations_target" | cut -d' ' -f1)" ]; then
    chmod 0600 "$integrations_target"
    echo "[deploy] integrations.json unchanged"
  else
    install -m 0600 "$MASON_INTEGRATIONS_SRC" "$integrations_target"
    echo "[deploy] copied integrations.json from $MASON_INTEGRATIONS_SRC"
  fi
else
  echo "[deploy] no integrations.json in $MASON_INTEGRATIONS_SRC: $integrations_target left as it is"
fi

# 5. The bot's own files: a soul, and a starter kit of skills.
#
# Both are the operator's, not the server's: `soul.md` is written by a person and the bot has no path to it, and the
# skills are seeds the bot then owns and rewrites. That is why neither is ever restored over an existing file — a second
# boot that re-installed them would undo the bot's own edits and, in the soul's case, a person's.
#
# The directory is optional on purpose (`MASON_BOT_SRC` may name one with neither): a deployment that ships no soul gets
# DEFAULT_SOUL on a fresh home, which is what every deployment did before this step existed.
bot_dir="${MASON_BOT_SRC:-/run/bot}"
soul_target="$service_dir/soul.md"
if [ ! -f "$bot_dir/soul.md" ]; then
  echo "[deploy] no soul.md in $bot_dir: the home keeps its own, or DEFAULT_SOUL on a fresh one"
elif [ -f "$soul_target" ] && [ "${MASON_BOT_FORCE:-0}" != "1" ]; then
  # A home that has booted once always has a soul.md, because the server writes DEFAULT_SOUL into a fresh one. That is not
  # a person's file in that case, and the message has to say how to replace it, or a deployment that was given a soul
  # months after it started runs the default one forever and never learns why.
  echo "[deploy] soul.md present: not overwriting it from $bot_dir (remove $soul_target, or boot once with" \
    "MASON_BOT_FORCE=1, if you meant to install this one)"
else
  install -m 0600 "$bot_dir/soul.md" "$soul_target"
  echo "[deploy] installed soul.md from $bot_dir"
fi

seed_skills() {
  local source="$bot_dir/skills"
  [ -d "$source" ] || return 0
  local seeded=0
  for candidate in "$source"/*/; do
    [ -d "$candidate" ] || continue
    local name
    name="$(basename "$candidate")"
    # A directory with no SKILL.md is not a skill the index can see. Seeding it would be worse than skipping it: the copy
    # takes the name, and the next boot refuses the operator's corrected directory because something is already there.
    if [ ! -f "$candidate/SKILL.md" ]; then
      echo "[deploy] $source/$name has no SKILL.md: skipped" >&2
      continue
    fi
    # A skill of the same name is the bot's own (or mason's shipped one, already seeded): leave it alone.
    if [ -e "$agent_dir/skills/$name" ]; then
      echo "[deploy] skill \"$name\" present: not overwriting it"
      continue
    fi
    # A starter kit is optional, so a failure to copy one is not a reason to refuse the boot: say so and keep going.
    if ! install -d -m 0700 "$agent_dir/skills" || ! cp -R "$candidate" "$agent_dir/skills/$name"; then
      echo "[deploy] could not seed skill \"$name\" into $agent_dir/skills" >&2
      continue
    fi
    seeded=$((seeded + 1))
    echo "[deploy] seeded skill \"$name\" from $source"
  done
  [ "$seeded" -gt 0 ] || echo "[deploy] no new skills in $source"
}
seed_skills

# 6. The server, with the SSH target it reads from the environment (src/server/env.ts, `sshTargetFromEnv`).
export PI_ENV_SSH_HOST="$MASON_ENV_HOST"
export PI_ENV_SSH_USER="$MASON_ENV_USER"
export PI_ENV_SSH_PORT="$MASON_ENV_PORT"
export PI_ENV_SSH_IDENTITY="$ssh_dir/id_ed25519"
export PI_ENV_SSH_KNOWN_HOSTS="$known_hosts"
export PI_ENV_SSH_ALIAS="$MASON_ENV_ALIAS"
echo "[deploy] tools run on $MASON_ENV_USER@$MASON_ENV_HOST:$MASON_ENV_PORT, in $agent_dir/workspace"
# `npm run dev` is this same command; exec'ing node directly keeps one process as PID 1, so SIGTERM reaches the server
# that installs the handler rather than an npm wrapper that may not pass it on.
exec node --experimental-strip-types src/server/main.ts
