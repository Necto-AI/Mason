# Deploying mason

Two containers. `mason` is the server: the repo run from source, the built web client, the agent's home on a volume,
the Chord socket and the web UI on 8787. `mason-env` is the machine the agent's tools actually run on: ubuntu 24.04 and
an sshd, reached only by mason, with no route out. The split is not packaging taste — every `read`, `write`, `edit`,
`bash` and `listFiles` call already goes through `@earendil-works/pi-env`, so the boundary between thinking and doing
was in the code before it was in a compose file.

```
host loopback :8787 ──► mason ──ssh──► mason-env        (no ports, internal network only)
                          │
                          └── volumes: mason-home, mason-workspace, env-keys
```

## Before the first `up`

1. **The submodule.** The mason image is built from the repository root, and `vendor/pi` is part of what it is:

   ```sh
   git submodule update --init --recursive
   ```

2. **A `.env`** next to this file (`deploy/.env`, mode 0600 — it names a directory of credentials):

   ```sh
   MASON_PI_AGENT_DIR=/srv/mason/agent    # required: the host directory in the next step
   MASON_PORT=8787                        # optional: the host loopback port
   TEAM=Ilya,Denis                        # optional: the roster to seed on a fresh home
   MASON_UID=1000                         # optional: must match on both images (see below)
   MASON_GID=1000
   MASON_MODEL_REQUIRED=1                 # 0 starts a stack with no model at all
   TZ=Europe/Moscow                       # optional: decides the date in log/YYYY-MM-DD.md
   MASON_ENV_HOST=mason-env               # optional: the env container's name on the compose network
   MASON_ENV_USER=mason                   # optional: the login account; the images create it, so changing it is a rebuild
   MASON_ENV_PORT=22
   MASON_ENV_ALIAS=pi-env-mason-env       # optional: the name its host key is pinned under
   MASON_ENV_WAIT_ATTEMPTS=30             # optional: how long the boot waits for it to answer
   ```

3. **Provider credentials**, in the directory `MASON_PI_AGENT_DIR` names. This is pi's own layout, unchanged — two
   files, nothing of ours:

   | File | What goes in it |
   |---|---|
   | `settings.json` | `{"defaultProvider": "…", "defaultModel": "…"}` — which model mason thinks with |
   | `auth.json` | `{"<provider>": {"type": "api_key", "key": "…"}}` — the key for it |

   Put a **static API key** there, not an OAuth login. The copy mason reads lives in a container, so a token that
   refreshes itself inside the container and a `pi` CLI on the host that refreshes its own copy will drift apart, and
   the container's copy is the one that stops working, at the least convenient moment.

4. **Build and start:**

   ```sh
   cd deploy
   docker compose up -d --build
   docker compose ps
   ```

   The build is slow the first time (`npm install` repairs `vendor/pi`'s nested dependencies), and it re-runs whenever a
   file the root `.dockerignore` does not exclude changes: the checkout is the image.

## First boot, and the pairing link

`docker compose logs mason` on a fresh home prints, once:

```text
mason listening on http://0.0.0.0:8787
[data] /home/mason/.mason/data
[auth] minted a token for this home; open one of these once, per browser or device:
[auth]   http://127.0.0.1:8787/?token=mason_…
```

Open that link once, in each browser. It spends the token on an `HttpOnly` cookie and redirects to the bare page, so the
token never stays in the address bar, the history or a `Referer`. The plaintext token is shown exactly once and stored
only as a hash in `mason-home/config.json`; a lost one is replaced, never recovered.

The URL in that line is assembled from what the server knows about itself, which is the container: `127.0.0.1:8787` is
right on the host as long as `MASON_PORT` is 8787 and nothing sits in front of it. Behind a proxy, or on a different
port, take the `?token=…` part and put it on the URL you actually serve — the token is the whole credential, the rest is
an address. The same applies to the link `npm run token -- add` prints.

Before the server starts, the boot prints what it prepared:

```text
[deploy] copied settings.json from /run/pi-agent
[deploy] copied auth.json from /run/pi-agent
[deploy] generated the env keypair in /home/mason/.mason/ssh
[deploy] published /home/mason/.mason/ssh/id_ed25519.pub to mason-env as /run/env-keys/authorized_keys
[deploy] waiting for mason@mason-env:22
[deploy] pinned 2 host key(s) for pi-env-mason-env from mason-env:22
[deploy] added "Ilya" to the roster
[deploy] added "Denis" to the roster
[deploy] seeded 2 name(s) from TEAM into /home/mason/.mason/roster.json
[deploy] tools run on mason@mason-env:22, in /home/mason/.mason/workspace
```

If the env host never answers, mason refuses to start rather than run an agent with nowhere to put a tool, and says so
with the name of the container to look at (`docker compose logs mason-env`).

## A person, and a device

Two different things, and two different commands — a person is a name the transcript can carry, a device is something
holding a token.

```sh
docker compose exec mason npm run team  -- add "Ilya"     # who may claim a name on /join
docker compose exec mason npm run team  -- remove "Ilya"
docker compose exec mason npm run team  -- list

docker compose exec mason npm run token -- add --label phone   # prints a pairing link, once
docker compose exec mason npm run token -- list
docker compose exec mason npm run token -- revoke <id>
```

Both files are read per request, so an add or a remove lands on the next request without a restart. The roster is an
access list, not an authentication: any paired browser may claim any name on it. That is the deliberate trade for a room
of five people (docs/TEAM-IDENTITY.md); it stops being acceptable when a stranger can hold the invite link.

`TEAM` in `.env` only seeds a home that has no roster yet. Once `roster.json` exists, the CLI is the way in — editing
`.env` and restarting changes nothing, on purpose.

## Provider credentials, and what the volume now holds

The mounted directory is read-only and is the *input*. On every boot, mason copies `settings.json` and `auth.json` into
`mason-home/pi/` (`0700`, files `0600`) and points `PI_CODING_AGENT_DIR` at the copy. Two reasons, both load-bearing:

- pi takes a lock file beside `auth.json` **even to read it** (`proper-lockfile`), and a directory it cannot write is a
  credential store it opens empty — the read path swallows the failure, the server starts, and every turn fails late with
  no key. A copy in a directory mason owns removes that failure instead of betting on the mount's permissions.
- The copy is redone on every boot, so a rotated key lands on a restart rather than at some remembered moment.

The consequence is worth stating plainly: **the `mason-home` volume holds a copy of your provider key.** It is
deliberate, and it makes the volume a credential of the same weight as the key itself: back it up encrypted, do not
paste it into a bug report, and remember that anyone who can read the volume can spend the key. Nothing about it is
ever baked into an image — the key never exists in a layer, only in a volume you control.

## What to back up

**`mason-home`, and nothing else.** It is the agent: `soul.md`, `profile.md`, the dated log, `skills/`, `data/agent.sqlite`
(the transcript and the hooks), `roster.json`, `config.json` (the token hashes — no plaintext token lives here), `ssh/`
(the env key and the pinned host key) and `pi/` (the copied provider credential). `mason-workspace` is inside it and
`env-keys` is one public key, so neither needs its own backup. A backup that includes the volume includes the provider
key; treat the archive accordingly.

```sh
docker run --rm -v mason-home:/data:ro -v "$PWD":/backup alpine \
  tar -czf /backup/mason-home-$(date +%F).tar.gz -C /data .
```

Restore it into a fresh `mason-home` and the agent comes back with its memory, its roster and its paired devices; the
env keypair comes with it, and the host key is re-pinned on the next boot.

## What is exposed, and what is not

- `mason`: port 8787 published on the host's **loopback only**. Nothing else is published.
- `mason-env`: no ports, and it is attached only to `mason-internal`, which is `internal: true` — no gateway, no route
  out, no DNS beyond the compose network. A tool cannot reach the internet or the host from there.
- mason itself is on `mason-edge` only because it is the one thing that should reach the model provider.
- **No TLS here.** The server speaks plain HTTP and says so in its own boot line. Terminate TLS in a reverse proxy on the
  host and forward to `127.0.0.1:8787`. Two headers are not optional: the proxy must preserve the original `Host` (the
  Origin gate compares `Origin` to it, and a rewritten `Host` refuses every browser), and it should send
  `X-Forwarded-Proto: https` so the session cookie is issued `Secure`.
- `/api/health` is unauthenticated by design (a monitor that needs a token is a monitor nobody runs). Everything else
  goes through `src/server/auth.ts`; there is no route in this deployment that does not.

## The path agreement, and the one honest limitation

The agent's workspace is `/home/mason/.mason/workspace` and that exact string is what the server sends to the env
container as the `cwd` for a tool call. It is not derived, negotiated, or made relative on the way: it is one path used
on two machines, so `mason-workspace` is mounted at **the same absolute path in both containers**. The path is a
constant rather than an `.env` variable on purpose — a fresh named volume takes the ownership of the directory it is
mounted over, and only the paths the images create are owned by the agent's uid. Move the home to `/srv/mason` in
`.env` and the volume comes up root-owned, the workspace is not writable, and the failure reads as a tool that cannot
write rather than as a mount that was never prepared. Changing either mount by hand has the other half of the same
failure: every tool call lands in a directory that does not exist, which measured against a real SSH target is a bare
`spawn_error` with no text at all.

The limitation is that coupling. The remote cwd is not its own name — it is the mason container's path, borrowed by
another machine — so anyone who moves the workspace in one image has to remember the other. Giving the remote cwd its
own name (a `cwd` mapping, or a workspace that is a mount point rather than a directory inside the home) is the
follow-up that removes it. Until then, the agreement is a comment and a variable, and this paragraph.

Two smaller honest notes:

- **Host keys are generated per container boot**, so the pin is written by scanning on every boot rather than trusted
  once and kept. That is not a weaker check than trust-on-first-use in the way that matters here — the boundary is the
  `internal: true` network, where the only peer is mason itself — but it *is* a scan: mason pins whoever answers on that
  name. Persisting the env host key on a volume and pinning the first one forever is the change that would make it a
  real pin, and it is not done.
- **The uid/gid must match.** Both images run the agent as `1000:1000` (`MASON_UID`/`MASON_GID`), because the two
  containers share two volumes and a volume owned by 1000 is not writable by 1001. Both images also create
  `/run/env-keys` owned by that uid, not group- or world-writable, which is required twice over: mason writes there, and
  `StrictModes` refuses a key file under a world-writable directory with `bad ownership or modes for directory …` — a
  login that fails with a message about a directory rather than about a key. If you change the uid/gid, wipe the volumes
  (`docker compose down && docker volume rm mason-home mason-workspace env-keys`) and start again; a half-migrated
  volume is a workspace nobody can write to.

## What is in the env image, and why nothing else is

ubuntu 24.04 plus `openssh-server`. No `pi-env` daemon: `sshConnection()` uploads the binary over the connection, checks
its SHA-256 on the far side, renames it into place and deletes older ones. An image that carried a daemon would freeze a
protocol version inside the deployment and then disagree with the mason image that replaced it — silently, because the
upload is designed never to fail loudly about a version it did not ship.

A tool runs as `mason` inside that container, with `env -i` and a nine-variable allowlist from the server side, so it
cannot read the server's environment or the provider key. It can read and write the shared workspace, and that is the
whole of what it has.
