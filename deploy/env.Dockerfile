# mason-env — the machine the agent's tools actually run on.
#
# ubuntu 24.04, openssh-server, and nothing else. There is no `pi-env` daemon in this image and none is installed at
# boot: `sshConnection()` in the mason container uploads the binary over this connection, verifies its SHA-256 on this
# side, renames it into place and starts it per connection (vendor/pi/packages/env/src/ssh.ts, `deployDaemon`). An image
# with a daemon baked in would pin a protocol version that the mason image has already outgrown, silently.
#
# The image is the machine, not the agent: no secrets, no provider key. What a tool can reach is what is mounted here —
# the agent's half of the home, and nothing else. The server's half does not exist in this container, so `bash` cannot
# read the token hashes, the trigger secrets, the database, the SSH key or the provider credential even if it tries.
# Qualified for the same reason as the node image in mason.Dockerfile: no short-name resolution on a NixOS podman host.
FROM docker.io/library/ubuntu:24.04

ARG MASON_UID=1000
ARG MASON_GID=1000

# openssh-server, git, and the three tools a worker on a repository needs: `gh` (its own apt repository, key and source
# list below), `curl` and `jq`. The tools already on the image are enough for the upload: sh, coreutils (sha256sum,
# mktemp, mkdir, chmod, mv) and a shell for the login session. `git` is not for the upload: `remember` appends a fact and
# commits it on this machine, in the repository that lives in the agent's half of the home, because the log and its
# history have to share a filesystem (src/server/house.ts, `appendFact`).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server git curl ca-certificates jq gnupg \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# The package generates host keys in its postinst. Left in place they would be baked into the image and shared by every
# deployment of it — the same key everywhere, forever. They are generated per container boot instead
# (deploy/env-entrypoint.sh).
RUN rm -f /etc/ssh/ssh_host_*

# One login account, named and numbered the same as the account in the mason image: the two containers share the
# `mason-agent` and `env-keys` volumes, and a volume owned by uid 1000 is not writable by uid 1001. The base image
# may already use that uid/gid (it has shipped an `ubuntu` account), so whatever holds the number is removed first —
# `useradd` fails on a uid that is taken, and that failure would surface as a build error with no clue in it.
RUN set -eux; \
    for name in $(getent passwd "${MASON_UID}" | cut -d: -f1); do userdel "$name" || true; done; \
    for name in $(getent group "${MASON_GID}" | cut -d: -f1); do groupdel "$name" || true; done; \
    groupadd --gid "${MASON_GID}" mason; \
    useradd --uid "${MASON_UID}" --gid "${MASON_GID}" --create-home --home-dir /home/mason --shell /bin/bash mason; \
    chmod 0700 /home/mason

# `useradd` leaves the account locked (its password field is `!`), and sshd refuses a locked account outright with
# `User mason not allowed because account is locked` before it ever looks at the key — even with `PubkeyAuthentication
# yes`, because with `UsePAM no` nothing can unlock it later. `*` is "no password, not locked": the account still cannot
# be logged into with a password (`PasswordAuthentication no`), and a key is the only way in, which is the intent.
RUN usermod -p '*' mason

# The volumes, with the ownership they need on a first `up`. Whichever container starts first initialises an empty
# named volume from the directory in its own image, so both images carry the same answer: `env-keys` writable by the
# mason uid (it is the file mason writes), and the agent's half owned by the same uid in both containers. Only
# `agent/` is prepared here; `service/` has no directory in this image at all, which is the point of it.
#
# `workspace/inbox` is a volume of its own (`mason-inbox`), mounted here and in the telegram container at this same path,
# and it is prepared here for the same reason as the rest: the container that starts first initialises an empty named
# volume from the directory in its own image. Telegram is an optional half of the stack, so on a deployment that had one
# before it had the bot, this container is the one that creates the volume — and a mount point missing from this image
# would come up root-owned, which is every attachment refused with EACCES and one warn line per message.
RUN install -d -o mason -g mason -m 0755 /run/env-keys \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason/agent \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason/agent/workspace \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason/agent/workspace/inbox

COPY env-entrypoint.sh /usr/local/bin/env-entrypoint.sh
RUN chmod 0755 /usr/local/bin/env-entrypoint.sh

# Root, because sshd needs it: privilege separation, the login user, and reading host keys. The account that ever logs
# in is `mason`, and it cannot become root (`PermitRootLogin no`, and no sudo in this image).
USER root
EXPOSE 22

STOPSIGNAL SIGTERM
# Foreground sshd with `-e` (logs to stderr, which is the only place a container's logs go) and `-D` (no fork), so this
# is PID 1 and a stop signal ends the daemon rather than a shell that left it orphaned.
ENTRYPOINT ["/usr/local/bin/env-entrypoint.sh"]
