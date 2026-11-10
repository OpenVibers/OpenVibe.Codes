# G3: Codes sessions clone from the disk on the Git host

A Codes session on the same host as OpenVibe Git does not fetch the repository over HTTPS.
`server/domain/forge.js` sees that the bare repository exists under `CODES_GIT_DATA_DIR`, gives
the job `OPENVIBE_GIT_LOCAL_ROOT`, and `harness/job.js` clones from
`<root>/repos/<owner>/<name>.git` instead of the clone URL. It then sets `origin` back to the
HTTPS address, so the branch is pushed to OpenVibe Git with the session's token as before.

One deployment setting is required: `CODES_GIT_DATA_DIR=/var/lib/openvibe/git` (the Git host's
`GIT_DATA_DIR`). Codes and OpenVibe Git run as the same user (`ubuntu`) in the production unit.
Without it the job clones over HTTPS; with it the clone is a local disk read.

## Measurement, 2026-11-10

Host: `openvibe-ovh`, the production host. Repository: `openvibers/openvibe.codes` (3.73 MiB
packed, 5,501 objects). The command is the one the job runs, five alternating runs, into a fresh
temporary directory:

```
git clone -q --depth 50 -- <source> <tmp>/repo
```

| Source | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| HTTPS, `https://git.openvibe.codes/openvibers/openvibe.codes.git` | 446 ms | 446 ms | 349 ms | 403 ms | 370 ms | **403 ms** |
| Disk, `/var/lib/openvibe/git/repos/openvibers/openvibe.codes.git` | 35 ms | 38 ms | 35 ms | 37 ms | 35 ms | **37 ms** |

Before: 403 ms over HTTPS (5.3 MiB shallow checkout). After: 37 ms from the disk (7.8 MiB working
tree; git ignores `--depth` for a local clone and copies the full history), about 11 times faster,
with no network request and no GitHub API call.

The numbers are wall clock, measured with `date +%s%N` around the clone, on an otherwise idle
host. They are a measurement of this host and repository, not a promise for every repository.
