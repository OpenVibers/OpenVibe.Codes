#!/bin/bash
# OpenVibe Git (Forgejo) on the host: the binary (checked against the release's sha256), its user and directories, a
# PostgreSQL role and database, /etc/forgejo/app.ini from app.ini.template with secrets generated here, and the
# systemd unit. Idempotent: a second run upgrades the binary to FORGEJO_VERSION and leaves the config and data alone.
#
#   sudo bash deploy/forgejo/install.sh          (from the Codes checkout on the host)
#
# Prints no secret. The database password and Forgejo's own keys exist only in /etc/forgejo/app.ini (root:forgejo 0660).
set -euo pipefail
VERSION="${FORGEJO_VERSION:-16.0.6}"
KIT="$(cd "$(dirname "$0")" && pwd)"
LIB=/usr/local/lib/forgejo
URL="https://codeberg.org/forgejo/forgejo/releases/download/v${VERSION}/forgejo-${VERSION}-linux-amd64"
[ "$(id -u)" = 0 ] || { echo "install.sh: run as root" >&2; exit 1; }

# 1. The binary, verified.
mkdir -p "$LIB"
if [ ! -x "$LIB/forgejo-$VERSION" ]; then
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/forgejo" "$URL"
    curl -fsSL -o "$tmp/forgejo.sha256" "$URL.sha256"
    want=$(cut -d' ' -f1 "$tmp/forgejo.sha256")
    have=$(sha256sum "$tmp/forgejo" | cut -d' ' -f1)
    [ -n "$want" ] && [ "$want" = "$have" ] || { echo "install.sh: sha256 mismatch for forgejo $VERSION" >&2; rm -rf "$tmp"; exit 1; }
    install -m 0755 "$tmp/forgejo" "$LIB/forgejo-$VERSION"
    rm -rf "$tmp"
    echo "forgejo $VERSION installed (sha256 verified)"
fi
ln -sfn "$LIB/forgejo-$VERSION" /usr/local/bin/forgejo

# 2. Its user and directories.
id forgejo >/dev/null 2>&1 || adduser --system --group --home /var/lib/forgejo --shell /bin/bash --disabled-password --gecos 'OpenVibe Git' forgejo
install -d -o forgejo -g forgejo -m 0750 /var/lib/forgejo /var/lib/forgejo/custom /var/lib/forgejo/data /var/lib/forgejo/log /var/lib/forgejo/repositories
install -d -o root -g forgejo -m 0770 /etc/forgejo

# 3 and 4. The database and the config, once.
if [ ! -f /etc/forgejo/app.ini ]; then
    pw=$(openssl rand -hex 24)
    printf "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'forgejo') THEN CREATE ROLE forgejo LOGIN PASSWORD '%s'; ELSE ALTER ROLE forgejo LOGIN PASSWORD '%s'; END IF; END \$\$;\n" "$pw" "$pw" \
        | sudo -u postgres psql -q -v ON_ERROR_STOP=1 >/dev/null
    if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'ov_forgejo'" | grep -q 1; then
        sudo -u postgres createdb -O forgejo -E UTF8 -T template0 ov_forgejo
    fi
    key=$(/usr/local/bin/forgejo generate secret SECRET_KEY)
    tok=$(/usr/local/bin/forgejo generate secret INTERNAL_TOKEN)
    umask 0007
    sed -e "s|@DB_PASSWORD@|$pw|" -e "s|@SECRET_KEY@|$key|" -e "s|@INTERNAL_TOKEN@|$tok|" "$KIT/app.ini.template" > /etc/forgejo/app.ini
    chown root:forgejo /etc/forgejo/app.ini
    chmod 0660 /etc/forgejo/app.ini
    echo "config written to /etc/forgejo/app.ini (database ov_forgejo, role forgejo)"
fi

# The OpenVibe look (custom/: the openvibe theme), refreshed on every run. app.ini names it; an install from before the
# theme gets the two [ui] lines updated in place.
cp -r "$KIT/custom/." /var/lib/forgejo/custom/
chown -R forgejo:forgejo /var/lib/forgejo/custom
if ! grep -q '^DEFAULT_THEME = openvibe' /etc/forgejo/app.ini; then
    sed -i -e 's/^DEFAULT_THEME = .*/DEFAULT_THEME = openvibe/' -e 's/^THEMES = .*/THEMES = openvibe,forgejo-auto,forgejo-light,forgejo-dark/' /etc/forgejo/app.ini
fi

# 5. The service.
install -m 0644 "$KIT/openvibe-forgejo.service" /etc/systemd/system/openvibe-forgejo.service
systemctl daemon-reload
systemctl enable --now openvibe-forgejo.service >/dev/null
systemctl restart openvibe-forgejo.service
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:5060/api/healthz && break; read -rt 1 < <(tail -f /dev/null) || true; done
curl -fsS http://127.0.0.1:5060/api/healthz >/dev/null && echo "openvibe-forgejo is up on 127.0.0.1:5060" || { echo "install.sh: forgejo did not come up; journalctl -u openvibe-forgejo" >&2; exit 1; }
