# mason — the server: the repository, the built web client, the durable home, and the two sockets it serves.
#
# The build context is the REPOSITORY ROOT, not this directory (compose.yaml: `context: ..`, `dockerfile:
# deploy/mason.Dockerfile`). That is not a convention to be tidied later: the TypeScript is run from source, the
# `@earendil-works/*` packages are symlinked out of the `vendor/pi` submodule by `npm install`'s postinstall, and the
# web client is esbuild's output from `src/web`. Check the submodule out first:
#   git submodule update --init --recursive
FROM node:22-bookworm-slim

# The uid and gid the agent runs as, and the numbers the two shared volumes are owned by. mason-env is built with the
# same values (deploy/env.Dockerfile); they have to agree, or the workspace is one container's and not the other's.
ARG MASON_UID=1000
ARG MASON_GID=1000

# git            — the home is a git repository, so every memory write is a commit that can be reverted (house.ts).
# openssh-client — ssh, ssh-keyscan and ssh-keygen are how the boot reaches mason-env (deploy/mason-entrypoint.sh).
# tzdata         — TZ decides the date in `log/YYYY-MM-DD.md` and in the boot lines; without it every date is UTC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client tzdata \
 && rm -rf /var/lib/apt/lists/*

# The image ships a `node` account at 1000:1000. Rename it rather than adding a second account, so the uid that owns
# the home, the workspace and the SSH key is the uid mason-env's login user has.
RUN groupmod --new-name mason node \
 && usermod --login mason --home /home/mason node \
 && install -d -o mason -g mason -m 0700 /home/mason \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason/workspace \
 && install -d -o mason -g mason -m 0755 /run/env-keys

WORKDIR /app

# The context is the working checkout, and the root `.dockerignore` keeps out what is not the image: node_modules (its
# vendor symlinks are absolute paths from the host), .data (an older home), dist (rebuilt below), and the git directory.
COPY . /app

# `npm install` runs the repo's postinstall: it symlinks `@earendil-works/*` into node_modules from `vendor/pi` and
# repairs the submodule's nested dependencies, which a root install prunes (scripts/link-vendor.mjs,
# scripts/verify-vendor.mjs). It needs the network.
RUN npm install

# `src/web/main.tsx` -> `dist/web/`, which is what the server serves and what the pairing link lands on.
RUN npm run build:web

# The entrypoint is the one in the repo, not a copy: the script that runs is the script that is reviewed.
RUN chmod 0755 /app/deploy/mason-entrypoint.sh

# HOME before USER, because Docker does not derive it from the account: `~/.pi/agent` and `~/.mason` are resolved from
# it, and the home volume is mounted under it.
ENV HOME=/home/mason
ENV MASON_HOME=/home/mason/.mason

USER mason

STOPSIGNAL SIGTERM
# The entrypoint prepares the home (key, host key, roster, provider credential) and then `exec`s the server, so node is
# the process that receives this signal and the one that closes the database on the way out.
ENTRYPOINT ["/app/deploy/mason-entrypoint.sh"]
