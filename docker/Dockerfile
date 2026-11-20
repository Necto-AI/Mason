# mason — the server image: one Node process, the home it serves, and no configuration of its own.
#
# The build context is the REPOSITORY ROOT (`docker build -f docker/Dockerfile .`), because the server runs its
# TypeScript from source and the workspace packages are built here. The image carries no soul, profile, connector, MCP
# entry, key or home: a configuration baked into an image is one nobody reviews, and the home is a volume that
# `mason init` and `mason new` write.
#
# Fully qualified on purpose: a host whose podman defines no `unqualified-search-registries` (NixOS ships none) refuses
# a bare `node:…` at build time — `short-name "node:…" did not resolve to an alias`. The tag is the floor in
# `packages/mason-agent/package.json` and the version `.github/workflows/ci.yml` runs.
FROM docker.io/library/node:26.4.0-bookworm-slim

# git is not optional: the boot makes `agent/` a repository and commits the memory it starts with (`house.ts`,
# `ensureRepository`). tzdata is for the date in `agent/log/YYYY-MM-DD.md`, which is otherwise UTC.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git tzdata \
 && rm -rf /var/lib/apt/lists/*

# The base image's `node` account is 1000:1000. Rename it rather than adding a second uid, so the volume's owner is the
# uid the server runs as on every host. `HOME` is set below, because Docker does not derive it from the account.
RUN groupmod --new-name mason node \
 && usermod --login mason --home /home/mason --shell /bin/bash node \
 && install -d -o mason -g mason -m 0700 /home/mason \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason

WORKDIR /app

# Only the tree the server reads. `.dockerignore` keeps node_modules, dist, a developer's homes and the git directory out
# of the context; the workspace packages are built below, and `docs/agent` is the reference the prompt's docs section
# indexes.
COPY package.json package-lock.json tsconfig.packages.json ./
COPY packages ./packages
COPY docs/agent ./docs/agent
COPY docker ./docker
# The terms travel with the source they cover: the image is AGPL-3.0-only and a deployment is a distribution of it.
COPY LICENSE NOTICE ./

# The lockfile's install, then the two workspace packages the runtime imports as values: their `exports.import` is
# `./dist/index.js`, so the workspace symlink is a package with no build until this runs. Nothing here needs a secret,
# which is why the build takes no `--build-arg`.
RUN npm ci \
 && npm run build:packages

# The tool daemon is a binary, and the old deployment's `patchelf` loop repaired one built from a local submodule that
# linked its loader out of the Nix store. There is no submodule here: `@earendil-works/pi-env` ships
# `bin/pi-env-<platform>/` static-pie for eight platforms (the published 1.5.0 linux-x64 binary has no PT_INTERP), and
# `localDaemon()` is what `src/server/env.ts` spawns. This check replaces the loop: the image fails here, not at the
# first tool call, if a future package stops carrying the daemon.
RUN daemon="$(node --input-type=module -e 'import { localDaemon } from "@earendil-works/pi-env"; process.stdout.write(localDaemon())')" \
 && test -x "$daemon" \
 && echo "pi-env daemon: $daemon"

# The root the home lives under. `MASON_HOME` is emptied because the older spelling names one home directly and outranks
# the root (`src/server/house.ts`); a deployment that means it can still set it at run time. `HOST` is the container's
# bind address, not a setting: 127.0.0.1 inside a container is the container, so a published port would answer nothing.
ENV HOME=/home/mason \
    MASON_ROOT=/home/mason/.mason \
    MASON_HOME="" \
    HOST=0.0.0.0 \
    PORT=8787

USER mason

STOPSIGNAL SIGTERM

# The entrypoint prepares the halves and the credential, then `exec`s the server, so node is PID 1 and receives this
# signal. `scripts/boot-test.sh` pins the three boot properties: the build, the refusal, and the clean stop.
ENTRYPOINT ["/app/docker/entrypoint.sh"]
