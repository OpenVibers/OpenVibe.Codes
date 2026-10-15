#!/bin/bash
# Read mirrors of OpenVibers' public GitHub repositories on OpenVibe Git, in the OpenVibers organisation: Forgejo pulls
# each one every MIN_INTERVAL/DEFAULT_INTERVAL (app.ini [mirror]). GitHub stays canonical until a repository is moved
# here (plan: one repository at a time); then the direction flips to a push mirror. Uses a short-lived site-admin API
# token it creates and deletes. Idempotent: a repository already mirrored is skipped.
#
#   sudo bash deploy/forgejo/mirror-github.sh            (needs `gh` signed in as someone who can list OpenVibers)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "mirror-github.sh: run as root" >&2; exit 1; }
FJ=(sudo -u forgejo /usr/local/bin/forgejo --config /etc/forgejo/app.ini --work-path /var/lib/forgejo)
API=http://127.0.0.1:5060/api/v1
REPOS_FILE="${1:-}"
name="mirror-$(date +%s)"
token=$("${FJ[@]}" admin user generate-access-token --username openvibe-admin --token-name "$name" --scopes write:organization,write:repository --raw)
# A token cannot delete itself through the API (403): remove it from Forgejo's database when the script ends.
trap 'sudo -u postgres psql -d ov_forgejo -qtAc "DELETE FROM access_token WHERE name = '"'"'$name'"'"'" >/dev/null || true' EXIT
call() { curl -fsS -H "Authorization: token $token" -H 'Content-Type: application/json' "$@"; }
call -o /dev/null "$API/orgs/OpenVibers" 2>/dev/null || call -o /dev/null -X POST "$API/orgs" -d '{"username":"OpenVibers","full_name":"OpenVibers","website":"https://openvibe.network","visibility":"public","description":"The OpenVibe projects."}'
if [ -n "$REPOS_FILE" ]; then list=$(cat "$REPOS_FILE"); else list=$(gh repo list OpenVibers --visibility public --limit 200 --json name -q '.[].name'); fi
made=0; kept=0
while read -r repo; do
    [ -n "$repo" ] || continue
    # Forgejo reserves names ending in .wiki (a repository's wiki): OpenVibe.Wiki is mirrored as OpenVibe-Wiki.
    local_name="$repo"; case "$repo" in *.wiki|*.Wiki) local_name="${repo%.*}-${repo##*.}" ;; esac
    if call -o /dev/null "$API/repos/OpenVibers/$local_name" 2>/dev/null; then kept=$((kept + 1)); continue; fi
    call -o /dev/null -X POST "$API/repos/migrate" -d "{\"clone_addr\":\"https://github.com/OpenVibers/$repo.git\",\"repo_owner\":\"OpenVibers\",\"repo_name\":\"$local_name\",\"mirror\":true,\"mirror_interval\":\"1h\",\"service\":\"git\",\"description\":\"Mirror of github.com/OpenVibers/$repo\"}" && made=$((made + 1)) || echo "mirror of $repo failed" >&2
done <<< "$list"
echo "mirrors: $made created, $kept already there"
