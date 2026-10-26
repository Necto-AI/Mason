# Deploying mason

Two containers. `mason` is the server: the repo run from source, the built web client, the agent's home on a volume,
the Chord socket and the web UI on 8787. `mason-env` is the machine the agent's tools actually run on: ubuntu 24.04 and
an sshd, reached only by mason, with no route out. The split is not packaging taste — every `read`, `write`, `edit`,
`bash` and `listFiles` call already goes through `@earendil-works/pi-env`, so the boundary between thinking and doing
was in the code before it was in a compose file. A deployment may add a third container per integration (see "An
integration" below); those are other people's images, not this repo's.

```
host loopback :8787 ──► mason ──ssh──► mason-env        (no ports, internal network only)
                          │
                          ├── mason-mcp ──► integration containers   (no ports; each also on mason-edge, or on
                          │                                           mason-egress with the vpn sidecar)
                          └── volumes: mason-agent (both containers), mason-service, env-keys
```

## The two halves of the home

`MASON_HOME` is still one root, and it has two halves with different owners:

| Half | What is in it | Where it is mounted |
|---|---|---|
| `agent/` | `profile.md`, `log/`, `journal/`, `skills/`, `agents/` (worker definitions), `workspace/`, and `.git` — the agent's memory and its history | both containers, at `/home/mason/.mason/agent` |
| `service/` | `soul.md`, `roster.json`, `config.json` (token hashes), `integrations.json` (the services mason reaches), `data/` (the transcript, the hooks, the seeded-skills record), `ssh/` (the env key), `pi/` (the copied provider credential) | the mason container only |

The split is a **mount boundary**, not a permission mode: `bash` can talk its way around a mode bit. In this deployment
`service/` does not exist in the `mason-env` container at all, so the agent cannot read its own door, its own keys or
its own provider credential even if a prompt tells it to. The soul is the clearest case: the bot has no path to the job
it was hired to do, which is what lets sibling hand several bots different souls from the same codebase.

**The home's repository is the memory repo, and it lives at `agent/.git`.** `remember` appends a fact to
`agent/log/YYYY-MM-DD.md` and commits it *on the tool machine*, in that repository, in one call — the log and its
history share a filesystem, so a memory is never written without its commit because a second process in another
container was down. `service/` is deliberately **unversioned** from the split onwards: the soul, the roster, the
credentials and the database are not in the history.

A home migrated from before the split (`npm run doctor -- migrate`) is the one place to be careful about `git`. The
migration does not move the old repository into `agent/`: it stays at the home root, on the server, with the history it
had, and both halves leave its index and enter its `.gitignore` so the agent's writes are not dirt in it forever.
`agent/.git` is then created fresh, and the agent's history begins at the migration. Only `agent/` is a volume, so the
frozen repository at the home root lives in the mason container's filesystem: run `doctor` before the first `up` on the
host if you want to keep that history, because recreating the container takes it with it.

In the **dev stack** (`npm run dev:stack`) there are no containers: `agent/` and `service/` are ordinary sibling
directories on one filesystem, reached by the loopback SSH daemon. That is a layout, not a boundary — a tool can see
`service/` there — and the writable-roots policy is what protects it for a developer.

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
   EXAMPLE_TOKEN=…                          # optional: an integration container's own credential (see "An integration")
   TELEGRAM_BOT_TOKEN=…                    # optional: the telegram integration's bot token (see "The first integration")
   TELEGRAM_TRIGGER_SECRET=…               # optional: printed once by `npm run integration -- secret telegram`
   TELEGRAM_ALLOWED_CHATS=-1001234567890   # optional: the chat ids the bot may relay, comma-separated
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

5. **On a rootless podman host instead of docker**, add the stack's own file to the command:

   ```sh
   cd deploy
   podman build -t mason:local -f mason.Dockerfile --build-arg MASON_UID=1000 --build-arg MASON_GID=100 ..
   podman build -t mason-env:local .
   podman compose -f compose.yaml -f compose.podman.yaml up -d
   ```

   `compose.podman.yaml` exists because of uid mapping, not taste: rootless podman maps the container's root to the host
   user and every other uid to a subuid, so `mason` inside the container is *not* host uid 1000 and cannot read the
   `.pi/agent` directory that the host user owns. It fails as `install: cannot open '/run/pi-agent/settings.json'`
   while the file is plainly readable on the host. The override passes `userns_mode: keep-id` to the two mason services,
   which makes uid 1000 the same person on both sides and gives both a single ownership on the shared `mason-agent`
   volume. The two explicit builds are there because podman-compose 1.6 tries to *pull* an `image:` name that only ever
   exists locally (`short-name "mason-env:local" did not resolve to an alias`) before it considers building it.

## First boot, and the pairing link

`docker compose logs mason` on a fresh home prints, once:

```text
mason listening on http://0.0.0.0:8787
[data] /home/mason/.mason/service/data
[auth] minted a token for this home; open one of these once, per browser or device:
[auth]   http://127.0.0.1:8787/?token=mason_…
```

Open that link once, in each browser. It spends the token on an `HttpOnly` cookie and redirects to the bare page, so the
token never stays in the address bar, the history or a `Referer`. The plaintext token is shown exactly once and stored
only as a hash in `mason-service/config.json`; a lost one is replaced, never recovered.

The URL in that line is assembled from what the server knows about itself, which is the container: `127.0.0.1:8787` is
right on the host as long as `MASON_PORT` is 8787 and nothing sits in front of it. Behind a proxy, or on a different
port, take the `?token=…` part and put it on the URL you actually serve — the token is the whole credential, the rest is
an address. The same applies to the link `npm run token -- add` prints.

Before the server starts, the boot prints what it prepared:

```text
[deploy] copied settings.json from /run/pi-agent
[deploy] copied auth.json from /run/pi-agent
[deploy] generated the env keypair in /home/mason/.mason/service/ssh
[deploy] published /home/mason/.mason/service/ssh/id_ed25519.pub to mason-env as /run/env-keys/authorized_keys
[deploy] waiting for mason@mason-env:22
[deploy] pinned 2 host key(s) for pi-env-mason-env from mason-env:22
[deploy] added "Ilya" to the roster
[deploy] added "Denis" to the roster
[deploy] seeded 2 name(s) from TEAM into /home/mason/.mason/service/roster.json
[deploy] tools run on mason@mason-env:22, in /home/mason/.mason/agent/workspace
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
of five people (docs/ROOM-IDENTITY.md); it stops being acceptable when a stranger can hold the invite link.

`TEAM` in `.env` only seeds a home that has no roster yet. Once `roster.json` exists, the CLI is the way in — editing
`.env` and restarting changes nothing, on purpose.

## Provider credentials, and what the volume now holds

The mounted directory is read-only and is the *input*. On every boot, mason copies `settings.json` and `auth.json` into
`mason-service/pi/` (`0700`, files `0600`) and points `PI_CODING_AGENT_DIR` at the copy. Two reasons, both load-bearing:

- pi takes a lock file beside `auth.json` **even to read it** (`proper-lockfile`), and a directory it cannot write is a
  credential store it opens empty — the read path swallows the failure, the server starts, and every turn fails late with
  no key. A copy in a directory mason owns removes that failure instead of betting on the mount's permissions.
- The copy is redone on every boot, so a rotated key lands on a restart rather than at some remembered moment.

The consequence is worth stating plainly: **the `mason-service` volume holds a copy of your provider key.** It is
deliberate, and it makes the volume a credential of the same weight as the key itself: back it up encrypted, do not
paste it into a bug report, and remember that anyone who can read the volume can spend the key. Nothing about it is
ever baked into an image — the key never exists in a layer, only in a volume you control.

## An integration: a container, a line, a restart

A capability mason should have that nobody wrote a tool for — GitHub, a docs server, somebody's internal API — arrives as
an **integration**: one container and one entry in a file (docs/adr/0003-integrations-are-services.md). No image in this
repo, no TypeScript, no extension, nothing in `src/` to change.

1. **A container.** Copy the commented template at the end of `compose.yaml`, uncomment it, name it after the
   integration and give it that integration's own image. It joins two networks: `mason-mcp`, where mason reaches its MCP
   endpoint by name (`http://mason-github:8082/mcp`), and `mason-edge`, the only way out to the third party's API. Its
   credential is an environment variable read from `deploy/.env` — the container owns it, mason does not.

2. **A line.** `deploy/integrations.json`. Create it beside the compose file before the first `up` — an empty
   `{"integrations": {}}` is a stack with no integration at all — because a bind source that does not exist is a
   directory to the container runtime, and a directory is no input. The same split as pi's credentials: the mounted file
   is the input, and `service/integrations.json` is the copy the server reads. Every boot installs it `0600` (it can hold
   a trigger secret) and prints one line — `copied integrations.json from /run/integrations.json`, or `unchanged`. One
   integration:

   ```jsonc
   { "integrations": { "github": {
       "enabled": true,
       "description": "Issues and pull requests for the team's repositories",
       "tools": { "url": "http://mason-github:8082/mcp", "required": false }
   } } }
   ```

   `description` is required for an entry whose tools are on: it is the only thing the model is told about it. `required:
   true` is the opt-in to a boot that refuses while that container is down; without it an unreachable integration removes
   its tools, logs why, and leaves the boot alone.

3. **A restart.** The file is read once, at boot, because what the model can do must not change between two messages of
   one conversation. `docker compose restart mason` is how an edit lands. `npm run integration -- list | add | remove |
   enable | disable` inside the container is the writer that validates the file, and it says the same thing.

**Nothing is published.** `mason-mcp` is `internal: true`: no gateway, no route out, no DNS beyond the compose network,
joined by mason and the integration containers only. No integration declares `ports:` — mason reaches it by name, so it
needs none — and a published port would be a second door into a service holding a credential, with no token of mason's in
front of it. mason keeps `mason-edge` for the model provider, and an integration keeps it for its upstream — or, where
the upstream is not reachable from this host, the integration joins `mason-egress` instead and the proxy sidecar beside
it keeps `mason-edge` (`mason-telegram`, below). The network is the authentication on the MCP wire: as long as the only
peer is mason, a shared secret would be a secret with one holder.

**`mason-env` is not on `mason-mcp`, and must not be.** The tool machine runs `bash` for a model that can be talked into
anything. If it could reach an MCP endpoint directly, the tool surface would stop being what `integrations.json` says it
is: the bot would call a capability without the registration, the naming and the truncation mason applies, and without a
person having decided it. mason is the only member of that network that decides anything.

**Two writers, one file.** The mount wins: a boot that sees content differing from `service/integrations.json` installs
the mount's version. That is the right precedence — the file a person keeps beside the compose file survives a recreate —
but it means an integration added inside a running container with `npm run integration` has to be copied back to
`deploy/integrations.json` before the next restart, or the boot undoes it. A stack that would rather be edited live can
leave the mount out; the copy on the volume is then the whole truth.

## The first integration: `mason-telegram`, and the sidecar it needs

[`integrations/telegram/`](../integrations/telegram/README.md) is the first integration built in this repository rather
than by somebody else: one package, one image, both faces of ADR-0003. The image is built from
`integrations/telegram` — by `docker compose up -d --build`, or on its own with `docker build integrations/telegram`.
It is still just the two containers in the templates at the end of `compose.yaml` — `mason-telegram` on `mason-mcp` with a
`/data` volume for its offset and no `ports`, plus a `vpn` sidecar — and the only thing mason knows about it is one entry
in `integrations.json` and a trigger secret. Mint that secret on the mason side
(`npm run integration -- add telegram --url http://mason-telegram:8082/mcp --description "The team chat"`, then
`secret telegram --hook team-chat`), put what it printed once into `TELEGRAM_TRIGGER_SECRET` in `deploy/.env` beside the
bot token and the chat allowlist, and the boot refuses — naming the hook — until the `team-chat` hook this build defines
is the one the trigger names.

**The sidecar is not optional here, and neither is the network that carries it.** Telegram is unreachable from most hosts
this runs on, so the integration is given `HTTPS_PROXY=http://vpn:1080` and reaches its upstream through it. The
`mason-telegram` container therefore joins `mason-mcp` and `mason-egress`, and not `mason-edge`: `mason-egress` is
`internal: true`, so the proxy is the only address the container can reach, and — since `mason-edge` is an ordinary
bridge with a gateway — being on it would have given the container its own way out and made the proxy decoration. The
sidecar is the only container that stands on both (`mason-egress` in, `mason-edge` out), and `mason-telegram` is the only
other member of `mason-egress`, so that network is that container's single route and the proxy is its only address there.
The proxy is not a fence between mason and an integration: mason stands on `mason-edge` as the sidecar does, so mason can
open `vpn:1080` too — and it changes nothing, because `mason-edge` already gives mason egress of its own, which is why
mason never joins `mason-egress` and has no use for the proxy. What `mason-egress` keeps off it is the tool machine:
`mason-env` joins neither network, so it has no route to the proxy at all. The proxy's config is a real server's address
and key, so it is a file the operator owns — copy `vpn/config.example.json` to `vpn/config.json` (gitignored) and fill in
the TODOs; it is mounted read-only, never baked into an image, and the sidecar publishes no port, because a published
SOCKS port is an open proxy. Its mixed inbound serves SOCKS and HTTP on 1080, and only the integrations that name it use
it.

## What to back up

**Two volumes, and both of them.** `mason-agent` is the agent: `profile.md`, the dated log, `journal/`, `skills/` (the
shipped ones seeded on first boot), `agents/`, `workspace/` and the git repository its memory is committed to — whose
history begins at the migration if the home was migrated, since the pre-split history stays in the repository at the
home root, which is not a volume. `mason-service` is the server: `soul.md`,
`roster.json`, `config.json` (the token hashes — no plaintext token lives here), `integrations.json` (the integrations
mason reaches, and each one's trigger secret), `data/agent.sqlite`
(the transcript and the hooks), `data/seeded-skills.json` (which shipped skills this home was
seeded with), `ssh/` (the env key and the pinned host key) and `pi/` (the copied provider credential).
`env-keys` is one public key and needs no backup of its own. A backup that includes `mason-service` includes the
provider key; treat the archive accordingly.

A home upgraded from a build that still had the GitHub connector also keeps a `service/data/connectors.json`: no code
reads it (the migration moved `data/` wholesale, so it came along), every secret in it opens nothing, and it is safe to
delete before you take the archive.

```sh
for volume in mason-agent mason-service; do
  docker run --rm -v "$volume":/data:ro -v "$PWD":/backup alpine \
    tar -czf "/backup/$volume-$(date +%F).tar.gz" -C /data .
done
```

Restore both into fresh volumes and the agent comes back with its memory, its roster and its paired devices; the env
keypair comes with `mason-service`, and the host key is re-pinned on the next boot.

## What is exposed, and what is not

- `mason`: port 8787 published on the host's **loopback only**. Nothing else is published.
- `mason-env`: no ports, and it is attached only to `mason-internal`, which is `internal: true` — no gateway, no route
  out, no DNS beyond the compose network. A tool cannot reach the internet or the host from there.
- mason itself is on `mason-edge` only because it is the one thing that should reach the model provider.
- `mason-mcp` is a second `internal: true` network: mason and the integration containers, and nobody else. Nothing on it
  publishes a port, and `mason-env` is not a member (see "An integration" above).
- `mason-egress` is the third, also `internal: true`, and it carries exactly two members: the `vpn` sidecar and the
  integrations told to reach the internet through it. Its only reachable address is `http://vpn:1080`. Neither mason nor
  `mason-env` joins it: mason reaches the proxy from `mason-edge` — it has egress of its own there, so the proxy gains it
  nothing — while `mason-env` joins neither network, so the tool machine has no route to the proxy at all.
- **No TLS here.** The server speaks plain HTTP and says so in its own boot line. Terminate TLS in a reverse proxy on the
  host and forward to `127.0.0.1:8787`. Two headers are not optional: the proxy must preserve the original `Host` (the
  Origin gate compares `Origin` to it, and a rewritten `Host` refuses every browser), and it should send
  `X-Forwarded-Proto: https` so the session cookie is issued `Secure`.
- Two paths are outside `src/server/auth.ts` on purpose, and each can do exactly one thing. `/api/health` answers one word
  and needs no credential at all (a monitor that needs a token is a monitor nobody runs), and
  `POST /api/events/<integration>` is authenticated by that integration's trigger secret: the HMAC is the door, and the
  door opens `hooks.fire` and nothing else — it cannot read, claim or call. Everything else under `/api`, and the Chord
  socket, goes through `src/server/auth.ts`; the shell itself is served publicly because it is a bundle with no secrets in
  it, and it is where a browser is told it is not paired.

## The path agreement, and the one honest limitation

The agent's workspace is `/home/mason/.mason/agent/workspace` and that exact string is what the server sends to the env
container as the `cwd` for a tool call. It is not derived, negotiated, or made relative on the way: it is one path used
on two machines, so `mason-agent` is mounted at **the same absolute path in both containers** — the whole agent's half,
not only the workspace, because the profile, the log, the skills and the repository are read there too. The path is a
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
  (`docker compose down && docker volume rm mason-agent mason-service env-keys`) and start again; a half-migrated
  volume is a workspace nobody can write to.

## What is in the env image, and why nothing else is

ubuntu 24.04 plus `openssh-server` and `git`. The `git` is not for the upload: `remember` appends a fact and commits it
on that machine, in `agent/.git`. No `pi-env` daemon: `sshConnection()` uploads the binary over the connection, checks
its SHA-256 on the far side, renames it into place and deletes older ones. An image that carried a daemon would freeze a
protocol version inside the deployment and then disagree with the mason image that replaced it — silently, because the
upload is designed never to fail loudly about a version it did not ship.

A tool runs as `mason` inside that container, with `env -i` and a nine-variable allowlist from the server side, so it
cannot read the server's environment or the provider key. It can read and write `agent/` — the profile, the log,
the skills, the workspace and the repository — and that is the whole of what it has. `service/` is not mounted there.
