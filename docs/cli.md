# `openvibe-codes task` — coding tasks on openvibe.codes, from a terminal

`openvibe-codes run` runs an agent on the machine you are on. `openvibe-codes task` hands a task to
[openvibe.codes/run](https://openvibe.codes/run) instead: one of *your* machines takes it through OpenVibe.Run
(clone, run the agent, hand back the summary, the files and the patch), and you watch it from anywhere.

It is the CLI face of the task API (`POST/GET /api/v1/tasks`, Contracts `codes.task.*`), and the way an
orchestrator (the Opus session that starts jobs for the agent pool) hands work over without the private portal.

## Who you are

A **personal Network access token**, sent as `Authorization: Bearer …`:

- `OPENVIBE_TOKEN`, or
- `~/.config/openvibe/token` (mode `600`; `OPENVIBE_TOKEN_FILE` names another path). The CLI refuses a file
  anyone else can read.

Sign in at <https://openvibe.network> and take the access token from the site (`ov_token` in your browser is the
same token). The server takes it for the tasks **you** own: your token carries no capability list, because being
that person is what authorizes your own tasks. A first-party service keeps its own path: a Network service token
for audience `openvibe.codes` holding `codes.task.start` / `read` / `cancel`, naming the person in `X-OV-Subject`.

`OPENVIBE_CODES_URL` points the client at another server (default `https://openvibe.codes`).

## The commands

```bash
openvibe-codes task start --repo OpenVibers/OpenVibe.Codes --file brief.md \
    --agent auto --machine auto --name codes-c6 --tier hard

openvibe-codes task list --state running          # running | needs | done
openvibe-codes task show tsk_01J… --follow        # the live stream, then the outcome
openvibe-codes task continue tsk_01J… --note "and add the test the reviewer asked for"
openvibe-codes task stop tsk_01J…
```

- **`--repo`** is `owner/repo` (GitHub), an `https://` git URL, or a path whose `origin` remote is one.
- **`--file`** is the brief; `-` reads it from stdin.
- **`--agent`** is an alias — `auto` (the router picks), `cx` codex, `cm`/`claude` claude-code, `cc`
  command-code, `oc` opencode, `dsh` deepseek — or any agent id from `GET /api/v1/harnesses`.
- **`--name`** is the task's idempotency key: starting again with the same name answers the first task
  (`already started tsk_…`) instead of starting a second one. 4–120 letters, digits, `_`, `.`, `:` or `-`.
- **`--tier basic|standard|hard`** appends `tier: <t>` to the brief, which is how the engine is told to force a
  tier; it does not duplicate a `tier:` line the brief already has.
- **`--permission review|edit|full`**: `review` is a read-only task (research, an audit, a review) that runs at
  the harness's `read` level; `edit` is the default; `full` may also run commands.
- **`--machine`** is `auto` only: Codes places the task on a machine of yours by itself (listed at
  <https://openvibe.bot/machines>). A named machine is refused rather than silently ignored.
- **`--json`** prints the API's answer instead of the readable log.

`task show` without `--follow` prints the task, its attempts and its outcome once. With `--follow` it reads
`GET /api/v1/tasks/:id/events` and prints the session's lines, each attempt and why it happened, ending when the
outcome is decided.

## Exit codes

| code | meaning |
|---|---|
| 0 | the API answered; with `--follow`, the task ended **done** |
| 1 | the API refused it (problem+json on stderr), the network failed, or the task ended `unfinished` / `stopped` |
| 2 | the command line or the token is wrong (nothing was sent) |

## From a script

The portal skill's job (`POST /api/job`) maps onto one call:

```js
const fs = require('fs');
const token = fs.readFileSync(`${process.env.HOME}/.config/openvibe/token`, 'utf8').trim();
const res = await fetch('https://openvibe.codes/api/v1/tasks', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    repo: 'https://github.com/OpenVibers/OpenVibe.Codes',
    prompt: `${brief}\n\ntier: hard\n`,
    agent: null,                  // auto: the router picks
    permission: 'edit',           // or review for a read-only task
    idempotency_key: 'cli:codes-c6',
  }),
});
const { task } = await res.json();
// GET  /api/v1/tasks/:id            the task, its attempts and its outcome (codes.task@2)
// GET  /api/v1/tasks?state=running  your tasks: running, needs (left unfinished for you), done
// GET  /api/v1/tasks/:id/events     the event stream (SSE; Last-Event-ID resumes it)
// POST /api/v1/tasks/:id/continue   { note?, agent? } → the next attempt now
// POST /api/v1/tasks/:id/stop       the running attempt stops; nothing carries it on
```

What the portal had and Codes does not (yet): a *named machine* per task, a transcript endpoint separate from the
event stream (the stream carries the session's lines), and fencing a whole chain of jobs — here the **task** is
the unit, and a continue is an attempt on the same task.
