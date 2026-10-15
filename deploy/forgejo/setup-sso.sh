#!/bin/bash
# After install.sh: the site admin (a random password, written to /root/forgejo-admin.txt, never printed) and the
# "OpenVibe" sign-in: an OpenID Connect source on OpenVibe.Network's discovery document, with the OAuth client
# `forgejo` that Network seeds (OpenVibe.Network server/db/database.js). Its secret is read from Network's database
# here and handed to Forgejo directly. Idempotent: an existing admin or source is updated, not duplicated.
#
#   sudo bash deploy/forgejo/setup-sso.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "setup-sso.sh: run as root" >&2; exit 1; }
FJ=(sudo -u forgejo /usr/local/bin/forgejo --config /etc/forgejo/app.ini --work-path /var/lib/forgejo)
NETWORK_DB="${NETWORK_DB:-ov_network}"

if ! "${FJ[@]}" admin user list --admin 2>/dev/null | awk 'NR > 1 { print $2 }' | grep -qx openvibe-admin; then
    umask 0077
    "${FJ[@]}" admin user create --admin --username openvibe-admin --email admin@openvibe.codes --random-password --must-change-password=false > /root/forgejo-admin.txt
    echo "site admin openvibe-admin created (password in /root/forgejo-admin.txt)"
fi

secret=$(sudo -u postgres psql -d "$NETWORK_DB" -tAc "SELECT client_secret FROM oauth_clients WHERE client_id = 'forgejo'")
[ -n "$secret" ] || { echo "setup-sso.sh: Network has no OAuth client 'forgejo' yet (deploy Network first)" >&2; exit 1; }
args=(--name OpenVibe --provider openidConnect --key forgejo --secret "$secret"
      --auto-discover-url https://openvibe.network/.well-known/openid-configuration
      --scopes openid --scopes profile --scopes email --skip-local-2fa
      --icon-url https://openvibe.network/favicon.ico)
id=$("${FJ[@]}" admin auth list 2>/dev/null | awk '$2 == "OpenVibe" { print $1 }')
if [ -n "$id" ]; then
    "${FJ[@]}" admin auth update-oauth --id "$id" "${args[@]}" >/dev/null
    echo "OpenVibe sign-in updated (source $id)"
else
    "${FJ[@]}" admin auth add-oauth "${args[@]}" >/dev/null
    echo "OpenVibe sign-in added"
fi
