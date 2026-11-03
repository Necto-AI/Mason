# mason-env — the machine the agent's tools actually run on.
#
# ubuntu 24.04, openssh-server, and nothing else. There is no `pi-env` daemon in this image and none is installed at
# boot: `sshConnection()` in the mason container uploads the binary over this connection, verifies its SHA-256 on this
# side, renames it into place and starts it per connection (vendor/pi/packages/env/src/ssh.ts, `deployDaemon`). An image
# with a daemon baked in would pin a protocol version that the mason image has already outgrown, silently.
#
# The image is the machine, not the agent: no secrets, no provider key. What a tool can reach is what is mounted here —
# the agent's half of the home, and nothing else. The server's half does not exist in this container, so `bash` cannot
# read the token hashes, the connector credentials, the database, the SSH key or the provider credential even if it tries.
# Qualified for the same reason as the node image in mason.Dockerfile: no short-name resolution on a NixOS podman host.
FROM docker.io/library/ubuntu:24.04

ARG MASON_UID=1000
ARG MASON_GID=1000

# openssh-server, git, and the three tools a worker on a repository needs: `gh` (its own apt repository, key and source
# list below), `curl` and `jq`. The tools already on the image are enough for the upload: sh, coreutils (sha256sum,
# mktemp, mkdir, chmod, mv) and a shell for the login session. `git` is not for the upload: `remember` appends a fact and
# commits it on this machine, in the repository that lives in the agent's half of the home, because the log and its
# history have to share a filesystem (src/server/house.ts, `appendFact`).
#
# `python3` and `python3-venv` are for one thing only, the OCR in the layer after the login account: the interpreter it
# runs under, in a virtualenv of its own (see below). Nothing else on this image is Python.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server git curl ca-certificates jq gnupg python3 python3-venv \
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

# OCR, in the image and not behind a service — because the file is already here. A photo of a page, a scan, a screenshot
# or a PDF arrives in a chat, lands on the `mason-inbox` volume, and this container is the process holding that path:
# `indra-ocr <path> --format md` is one call away — no upload, no second copy, no port, no credential
# (docs/CAPABILITY-PLAN.md, phase 3). CPU only: a small ONNX graph (det 0.4 MB, rec 5 MB) with the OpenCV/PDFium
# post-processing that turns a page into markdown, no torch and no GPU.
#
# Pinned to upstream tag `v1.1.2` of `github:datalab-to/indra`, the same tag `~/dev/pi-setup` packages, so both machines
# read a page with the same code and the same weights. Code and weights move together: the package names the Hugging
# Face revision it was built against (`HF_REVISION` in `indra_ocr/models.py`), so an install that floated would let a
# rebuilt image read a page differently with nothing in this repository to point at. A virtualenv rather than the system
# python: Ubuntu 24.04 marks its `python3` EXTERNALLY-MANAGED (PEP 668), and this image has no business owning a
# system-wide python package. The dependencies are wheels for this arch (`opencv-python-headless`, `onnxruntime`,
# `pypdfium2`), so nothing compiles here — which is also why NixOS, whose `opencv-python-headless` has no usable wheel,
# packages this same tag from source instead of installing it.
#
# The ~76 MB of weights are fetched here, at build time, into the cache the runtime reads with no network at all: the
# default `$HOME/.cache/huggingface` under the account a tool runs as. `XDG_CACHE_HOME` is set to the same directory
# rather than a cache of its own, because the daemon a tool runs under is started with an allowlist that carries `HOME`
# and not `XDG_CACHE_HOME` (src/server/env.ts, `DAEMON_ENV_ALLOWED`) — the default is the path to fill. The download runs
# as root and the directory is handed to `mason` before the layer ends. The second call is the same lookup with
# `HF_HUB_OFFLINE=1`, which succeeds only from a warm cache: a build with no network, or one whose download refused,
# stops here, loudly, instead of shipping an OCR whose first message is a download and whose offline answer is an error.
RUN set -eux; \
    python3 -m venv /opt/indra; \
    /opt/indra/bin/pip install --no-cache-dir --disable-pip-version-check \
      "git+https://github.com/datalab-to/indra@v1.1.2"; \
    ln -sf /opt/indra/bin/indra-ocr /usr/local/bin/indra-ocr; \
    install -d -m 0755 /home/mason/.cache; \
    HOME=/home/mason XDG_CACHE_HOME=/home/mason/.cache HF_HUB_DISABLE_TELEMETRY=1 \
      /opt/indra/bin/python -c 'from indra_ocr.models import model_dir; print(model_dir())'; \
    HOME=/home/mason XDG_CACHE_HOME=/home/mason/.cache HF_HUB_OFFLINE=1 \
      /opt/indra/bin/python -c 'from indra_ocr.models import model_dir; print(model_dir())'; \
    chown -R mason:mason /home/mason/.cache; \
    indra-ocr --version

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
