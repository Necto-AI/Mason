# mason — the server: the repository, the built web client, the durable home, and the two sockets it serves.
#
# The build context is the REPOSITORY ROOT, not this directory (compose.yaml: `context: ..`, `dockerfile:
# deploy/mason.Dockerfile`). That is not a convention to be tidied later: the TypeScript is run from source, the
# `@earendil-works/*` packages are symlinked out of the `vendor/pi` submodule by `npm install`'s postinstall, and the
# web client is esbuild's output from `src/web`. Check the submodule out first:
#   git submodule update --init --recursive
# Fully qualified on purpose: a host whose podman defines no `unqualified-search-registries` (NixOS ships none) refuses
# a bare `node:22-bookworm-slim` at build time — `short-name "node:22-bookworm-slim" did not resolve to an alias` — and
# the deploy is meant to build on such a host.
FROM docker.io/library/node:22-bookworm-slim

# The uid and gid the agent runs as, and the numbers the two shared volumes are owned by. mason-env is built with the
# same values (deploy/env.Dockerfile); they have to agree, or the workspace is one container's and not the other's.
# Qualified for the same reason as the node image in mason.Dockerfile: no short-name resolution on a NixOS podman host.
ARG MASON_UID=1000
ARG MASON_GID=1000

# git            — the home is a git repository, so every memory write is a commit that can be reverted (house.ts).
# openssh-client — ssh, ssh-keyscan and ssh-keygen are how the boot reaches mason-env (deploy/mason-entrypoint.sh).
# tzdata         — TZ decides the date in `log/YYYY-MM-DD.md` and in the boot lines; without it every date is UTC.
# patchelf       — see the RUN below: the daemon is built by whoever owns the checkout, and one of those machines is NixOS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client tzdata patchelf \
 && rm -rf /var/lib/apt/lists/*

# The image ships a `node` account at 1000:1000. Rename it rather than adding a second account, so the uid that owns the
# home, both halves of it and the SSH key is the uid mason-env's login user has.
RUN groupmod --new-name mason node \
 && usermod --login mason --home /home/mason node \
 && install -d -o mason -g mason -m 0700 /home/mason \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason/agent \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason/agent/workspace \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason/service \
 && install -d -o mason -g mason -m 0755 /run/env-keys

WORKDIR /app

# The context is the working checkout, and the root `.dockerignore` keeps out what is not the image: node_modules (its
# vendor symlinks are absolute paths from the host), .data (an older home), dist (rebuilt below), and the git directory.
COPY . /app

# `npm install` runs the repo's postinstall: it symlinks `@earendil-works/*` into node_modules from `vendor/pi` and
# repairs the submodule's nested dependencies, which a root install prunes (scripts/link-vendor.mjs,
# scripts/verify-vendor.mjs). It needs the network.
RUN npm install

# The daemon that runs on the far side of the tool machine is a binary from the checkout, not from this image's package
# manager: `bin/pi-env-linux-<arch>/pi-env` is built by `npm run build:daemon` on whichever machine owns the submodule, and
# on a NixOS machine that build links the dynamic loader out of the Nix store. The file then carries
# PT_INTERP=/nix/store/…-glibc-…/ld-linux-x86-64.so.2, which does not exist in mason-env — a login succeeds, the upload
# succeeds, and every tool call dies at the far end with `cannot execute: required file not found` (exit 127) and mason
# reports `pi-env exited with code 127 before it was ready`.
#
# Repointing the loader at the one this image has, and dropping the store RPATH that goes with it, makes the binary run
# anywhere glibc is current — verified against mason-env on ubuntu 24.04. It only touches a binary that points into
# `/nix/store`, so an ordinary build is left exactly as it was, and a cross-built (`aarch64`) one is caught later, by the
# arch check in `packagedDaemon`.
RUN set -eux; \
    for daemon in $(find -L /app -path '*pi-env-linux-*/pi-env' -type f); do \
      loader="$(patchelf --print-interpreter "$daemon")"; \
      case "$loader" in \
        /nix/store/*) echo "retargeting $daemon from $loader"; \
          patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 --remove-rpath "$daemon" ;; \
        *) echo "$daemon already portable ($loader)" ;; \
      esac; \
    done

# The entrypoint is the one in the repo, not a copy: the script that runs is the script that is reviewed.
RUN chmod 0755 /app/deploy/mason-entrypoint.sh

# HOME before USER, because Docker does not derive it from the account: `~/.pi/agent` and `~/.mason` are resolved from
# it, and the home volume is mounted under it.
ENV HOME=/home/mason
ENV MASON_HOME=/home/mason/.mason

USER mason

STOPSIGNAL SIGTERM
# The entrypoint prepares the home (key, host key, provider credential) and then `exec`s the server, so node is
# the process that receives this signal and the one that closes the database on the way out.
ENTRYPOINT ["/app/deploy/mason-entrypoint.sh"]
