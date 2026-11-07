#!/bin/sh
# Install the chat plays sandbox worker (Agent Streams S6) on the host that runs OpenVibe.Codes. Run as root, from the
# Codes release (/opt/openvibe.codes): `sudo deploy/sandbox/install.sh [--with-browser] [--start]`. Idempotent: it
# never overwrites a secret or an env file that exists, never changes a sysctl, and starts nothing without --start.
#
# What the worker needs from the host:
#   1. bubblewrap >= 0.8 (apt install bubblewrap) and unprivileged user namespaces. On Ubuntu 23.10+ with
#      kernel.apparmor_restrict_unprivileged_userns=1 an AppArmor profile lets /usr/bin/bwrap (only it) create one.
#   2. cgroup v2 (the unified hierarchy): the unit has Delegate=cpu memory pids, one child cgroup per sandbox.
#   3. Node 22+ at /usr/bin/node (bound read-only into each sandbox for its supervisor) and util-linux script(1).
#   4. Its own system user, openvibe-sandbox, with no home and no login; Codes' user joins its group for the local socket.
#   5. Two secrets as systemd credentials in /etc/openvibe/codes-sandbox/ (root, 0600):
#        codes-worker-secret     generated here; the same value goes into /etc/openvibe/codes.env as
#                                CODES_SANDBOX_WORKER_SECRET (then restart openvibe-codes)
#        network-client-secret   the worker's own Network OAuth client (its service identity, holding the grant
#                                live.agent_sandbox.register); created by the owner on OpenVibe.Network, not here
#   6. Optional (--with-browser): Playwright's headless Chromium in /opt/openvibe-codes-sandbox/browser.
set -eu

CODES_DIR=${CODES_DIR:-/opt/openvibe.codes}
CODES_USER=${CODES_USER:-ubuntu}
SANDBOX_USER=openvibe-sandbox
SECRETS=/etc/openvibe/codes-sandbox
ENV_FILE=/etc/openvibe/codes-sandbox.env
BROWSER_DIR=/opt/openvibe-codes-sandbox/browser
PLAYWRIGHT_VERSION=${PLAYWRIGHT_VERSION:-1.62.1}
WITH_BROWSER=0
START=0
for arg in "$@"; do
    case "$arg" in
        --with-browser) WITH_BROWSER=1 ;;
        --start) START=1 ;;
        *) echo "usage: $0 [--with-browser] [--start]" >&2; exit 2 ;;
    esac
done
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
say() { printf '[sandbox-install] %s\n' "$*"; }
here=$(cd "$(dirname "$0")" && pwd)

# 1. bubblewrap and script(1)
if ! command -v bwrap >/dev/null 2>&1; then say "installing bubblewrap"; apt-get install -y bubblewrap; fi
command -v script >/dev/null 2>&1 || apt-get install -y bsdutils
ver=$(bwrap --version | sed -n 's/.* \([0-9]*\)\.\([0-9]*\)\..*/\1 \2/p')
# shellcheck disable=SC2086 # split "major minor" on purpose
set -- $ver
if [ "${1:-0}" -eq 0 ] && [ "${2:-0}" -lt 8 ]; then echo "bubblewrap $(bwrap --version) is too old: 0.8 or newer" >&2; exit 1; fi
if [ -u "$(command -v bwrap)" ]; then echo "bwrap is setuid here; the worker expects the unprivileged build (NoNewPrivileges=yes)" >&2; exit 1; fi

# 2. cgroup v2
[ -f /sys/fs/cgroup/cgroup.controllers ] || { echo "no cgroup v2 unified hierarchy: the sandboxes' limits need it" >&2; exit 1; }

# 3. Node
node_ok=$(/usr/bin/node -e 'process.stdout.write(String(Number(process.versions.node.split(".")[0]) >= 22))' 2>/dev/null || echo false)
[ "$node_ok" = true ] || { echo "/usr/bin/node 22+ is required" >&2; exit 1; }

# 4. The user, and Codes' user in its group (the local API socket is 0660)
if ! id "$SANDBOX_USER" >/dev/null 2>&1; then
    say "creating the system user $SANDBOX_USER"
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SANDBOX_USER"
fi
if id "$CODES_USER" >/dev/null 2>&1; then usermod -aG "$SANDBOX_USER" "$CODES_USER"; fi

# 1b. Unprivileged user namespaces: allowed, or allowed for bwrap by its own AppArmor profile (never the sysctl)
restrict=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)
if [ "$restrict" = 1 ]; then
    say "Ubuntu restricts unprivileged user namespaces: installing the AppArmor profile for /usr/bin/bwrap"
    install -m 0644 "$here/apparmor-bwrap" /etc/apparmor.d/openvibe-codes-sandbox-bwrap
    apparmor_parser -r /etc/apparmor.d/openvibe-codes-sandbox-bwrap
fi
if [ "$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo 1)" = 0 ]; then
    echo "kernel.unprivileged_userns_clone=0: unprivileged user namespaces are off on this host; the worker cannot run" >&2
    exit 1
fi
if ! runuser -u "$SANDBOX_USER" -- bwrap --unshare-all --unshare-user --disable-userns --ro-bind /usr /usr \
        --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev -- /usr/bin/true; then
    echo "bubblewrap cannot make a sandbox as $SANDBOX_USER here" >&2
    exit 1
fi

# 5. Secrets (credentials) and the env file
install -d -m 0700 -o root -g root "$SECRETS"
if [ ! -s "$SECRETS/codes-worker-secret" ]; then
    say "generating the Codes heartbeat secret ($SECRETS/codes-worker-secret)"
    (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRETS/codes-worker-secret")
    say "put the same value in /etc/openvibe/codes.env as CODES_SANDBOX_WORKER_SECRET (sudo cat $SECRETS/codes-worker-secret), then restart openvibe-codes"
fi
if [ ! -s "$SECRETS/network-client-secret" ]; then
    (umask 077; : > "$SECRETS/network-client-secret")
    say "the worker's Network client secret is empty: write it to $SECRETS/network-client-secret and its client id to $ENV_FILE (CODES_SANDBOX_CLIENT_ID); until then it does not check in with Live"
fi
if [ ! -f "$ENV_FILE" ]; then
    install -m 0640 -o root -g "$SANDBOX_USER" "$here/sandbox-worker.env.example" "$ENV_FILE"
    say "wrote $ENV_FILE from the example: set CODES_SANDBOX_WORKER_ID, CODES_SANDBOX_CLIENT_ID and CODES_SANDBOX_LIVE_STREAMS"
fi

# 6. The browser (optional)
if [ "$WITH_BROWSER" = 1 ]; then
    say "installing Playwright $PLAYWRIGHT_VERSION's headless Chromium into $BROWSER_DIR"
    install -d -m 0755 "$BROWSER_DIR"
    PLAYWRIGHT_BROWSERS_PATH="$BROWSER_DIR" npx --yes "playwright@$PLAYWRIGHT_VERSION" install --with-deps --only-shell chromium
    chmod -R a+rX "$BROWSER_DIR"
fi

# The unit
install -m 0644 "$here/openvibe-codes-sandbox.service" /etc/systemd/system/openvibe-codes-sandbox.service
systemctl daemon-reload
say "installed openvibe-codes-sandbox.service"

# The self-test, the way the unit runs it (its user, its delegated cgroup, its hardening): ready or why not.
say "self-test:"
systemd-run --wait --pipe --quiet --uid="$SANDBOX_USER" --gid="$SANDBOX_USER" -p Delegate=yes -p NoNewPrivileges=yes \
    -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p RuntimeDirectory=openvibe-codes-sandbox-check \
    -E CODES_SANDBOX_LIMITS=cgroup -E PATH=/usr/bin:/bin -E CODES_SANDBOX_RUNTIME_DIR=/run/openvibe-codes-sandbox-check \
    --working-directory="$CODES_DIR" -- /usr/bin/node "$CODES_DIR/bin/openvibe-sandbox-worker.js" --check \
    || { echo "the self-test failed: the worker would report itself not ready (see above)" >&2; exit 1; }

if [ "$START" = 1 ]; then
    systemctl enable --now openvibe-codes-sandbox.service
    say "started; journalctl -u openvibe-codes-sandbox -f"
else
    say "not started (pass --start, or: systemctl enable --now openvibe-codes-sandbox)"
fi
