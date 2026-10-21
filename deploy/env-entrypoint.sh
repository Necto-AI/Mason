#!/usr/bin/env bash
# mason-env's boot: host keys, then sshd in the foreground.
#
# This container is the machine the agent's tools run on, and nothing else. It has no `pi-env` daemon: mason uploads the
# binary over this very connection and verifies its SHA-256 before running it (vendor/pi/packages/env/src/ssh.ts). The
# only thing this script owns is the identity a client pins and the one file that says which key may log in.
set -euo pipefail

# Host keys, per container and never in the image: a baked key is a key every deployment of the image shares. Generated
# into /run rather than /etc/ssh so the point is visible — this is a container's identity, not a machine's. Kept across a
# `restart` and regenerated on a re-create; mason re-pins whatever answers on its own boot.
install -d -m 0700 /run/mason-env
if [ ! -f /run/mason-env/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -C mason-env -f /run/mason-env/ssh_host_ed25519_key
fi
if [ ! -f /run/mason-env/ssh_host_rsa_key ]; then
  ssh-keygen -q -t rsa -b 3072 -N '' -C mason-env -f /run/mason-env/ssh_host_rsa_key
fi

# sshd's privilege-separation directory. Ubuntu's package leaves creating it to its systemd unit, and there is no systemd
# here: without it sshd refuses to start with "Missing privilege separation directory".
install -d -m 0755 /run/sshd

# The authorized_keys file is written by mason, on the shared env-keys volume, on its own boot. If this container is up
# first — it usually is — the file is not there yet, and saying so is better than a login that fails with no clue.
if [ ! -f /run/env-keys/authorized_keys ]; then
  echo "[deploy] /run/env-keys/authorized_keys is not there yet: mason writes it on its first boot"
fi

config=/run/mason-env/sshd_config
# A whole configuration of our own (`-f`) rather than the distribution's: nothing is inherited, so everything that
# matters is on this page. `AuthorizedKeysFile` points at the shared volume, which is why the file is owned by the login
# user's uid, mode 0600, inside a directory only root or that uid owns — what StrictModes checks. The account is
# interpolated rather than written twice: compose lets the operator rename it, and a hardcoded `AllowUsers mason` would
# lock that operator out with a "Permission denied (publickey)" and nothing else to go on.
login_user="${MASON_ENV_USER:-mason}"
cat > "$config" <<EOF
Port 22
ListenAddress 0.0.0.0
HostKey /run/mason-env/ssh_host_ed25519_key
HostKey /run/mason-env/ssh_host_rsa_key
PidFile /run/sshd.pid

# The one way in: a key, written by mason, for one account.
AuthorizedKeysFile /run/env-keys/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
AllowUsers $login_user

# No PAM: there is no account policy to apply beyond the key, and a container has no session stack to hand a login to.
UsePAM no
StrictModes yes

# Nothing here is a tunnel or a jump host; it runs one command per connection, from one client.
AllowTcpForwarding no
AllowAgentForwarding no
PermitTunnel no
X11Forwarding no
GatewayPorts no
PermitUserEnvironment no

LogLevel VERBOSE
PrintMotd no
EOF

echo "[deploy] sshd starting on :22 for $login_user; authorized_keys from /run/env-keys/authorized_keys"
# -D: no fork, so this is PID 1 and the stop signal ends the daemon. -e: log to stderr, which is where a container's
# logs are read.
exec /usr/sbin/sshd -D -e -f "$config"
