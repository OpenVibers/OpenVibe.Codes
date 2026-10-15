# OpenVibe Git (Forgejo)

The OpenVibe projects' own Git host, at **https://openvibe.codes/git/**. It runs Forgejo, which is lighter than GitLab
on the 15 GB host. It moves to `git.openvibe.codes` once that DNS name exists: change `ROOT_URL`, `DOMAIN` and the
redirect URI.

- **Sign-in:** people sign in with their OpenVibe account through OpenVibe.Network's OpenID Connect (the OAuth client
  `forgejo`, which Network seeds). There is no local sign-up; the first sign-in creates the account with the OpenVibe
  username.
- **Mirrors:** the `OpenVibers` organisation holds read mirrors of the public GitHub repositories, pulled hourly.
  GitHub stays canonical until a repository is moved here, one at a time. Then the direction flips to a push mirror
  to GitHub.
- **Cloning:** HTTPS only. `openvibe.codes` is behind Cloudflare's proxy, which carries no SSH.
- **Off:** mail, Actions (CI) and federation are off for now; turn them on in `app.ini` when they have a job.

## Files

| File | What it does |
|---|---|
| `install.sh` | Binary (sha256-checked), the `forgejo` user, the PostgreSQL role and the `ov_forgejo` database, `/etc/forgejo/app.ini` with secrets generated on the host, and the systemd unit. Idempotent; `FORGEJO_VERSION=x.y.z` upgrades the binary. |
| `app.ini.template` | The config; `@…@` values are filled in by `install.sh`. |
| `openvibe-forgejo.service` | The unit: `127.0.0.1:5060`, hardened, 1 GB of memory at most. |
| `setup-sso.sh` | The site admin (a random password in `/root/forgejo-admin.txt`) and the OpenVibe sign-in. The client secret is read from Network's database. |
| `mirror-github.sh [file]` | The `OpenVibers` organisation and one pull mirror per public repository: names from `gh`, or one per line in `file`. |

nginx: `deploy/nginx/openvibe.codes.conf` proxies `^~ /git/` to `127.0.0.1:5060`, streamed, with a 512 MB limit.

## Install (on the host, from the Codes checkout)

```bash
sudo bash deploy/forgejo/install.sh
sudo ov-vhost-install deploy/nginx/openvibe.codes.conf openvibe.codes.conf
sudo bash deploy/forgejo/setup-sso.sh                    # after Network seeds the forgejo client
gh repo list OpenVibers --visibility public --limit 200 --json name -q '.[].name' > /tmp/repos.txt   # where gh is signed in
sudo bash deploy/forgejo/mirror-github.sh /tmp/repos.txt
```

Backups: `ov_forgejo` is a PostgreSQL database like the others (add it to the host inventory's databases), and the
repositories live in `/var/lib/forgejo/repositories`.
