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
  <https://openvibe.link/machines>). A named machine is refused rather than silently ignored.
- **`--json`** prints the API's answer instead of the readable log.

`task show` without `--follow` prints the task, its attempts and its outcome once. With `--follow` it reads
`GET /api/v1/tasks/:id/events` and prints the session's lines, each attempt and why it happened, ending when the
outcome is decided.

## Your agent home: `home apply`

What your agents need on a machine, written once (`openvibe.home@1`):

```json
{
  "format": "openvibe.home@1",
  "tools": { "node": "24.19.0", "go": "1.27.1", "rust": "1.96.0" },
  "agents": ["claude-code", "codex"],
  "repos": ["OpenVibers/OpenVibe.Live", "https://git.openvibe.codes/you/site"],
  "git": { "name": "Your Name", "email": "you@example.com" }
}
```

```bash
openvibe-codes home apply home.json      # set it up here (in your sandbox, or this account's home)
openvibe-codes home show                 # what was set up, and what failed
```

- **Tools** are pinned with [mise](https://mise.jdx.dev). mise itself is fetched from its release, with its SHA-256
  checked against the release's list. Everything lands in your home, nothing global.
- **Agents** are installed by Codes' own installer, as `openvibe-codes setup` does.
- **Repositories** are partial clones (`--filter=blob:none`) under `work/`. When one is there already, it is fetched.
  A private one uses the machine's token (`GITHUB_TOKEN`), or your OpenVibe Git token when it is on
  git.openvibe.codes. An address with a user or password in it is refused.
- **Every step runs**, even when one fails. The failures are listed, and `.openvibe-home.json` keeps the result.

You can also save it once on <https://openvibe.codes/setup#step-home> and press **Set up**. The machine you pick
does it as a Codes job (mode `home`) in your sandbox there, and every step appears on the page as it happens. Nobody
logs in to the machine. The runner needs 0.12.0 or later.

## For an agent: `--for-agent` and `skills get`

A supervising agent should not read the human log. `--for-agent` is the machine face of every command in this
document that runs or reads a run: one compact JSON object per line, no ANSI and no pretty printing, with fixed
fields — `run`, `seq`, `event`, `agent`, `session`, `ref`, `ok`, and on a failure `error: {code, retry,
suggestion}`. Text is bounded to 400 characters; `--json` stays the full event stream for a person debugging.

```bash
openvibe-codes agents --for-agent                       # one line per harness, with why it cannot run
openvibe-codes run --for-agent "rename getUser to findUser"
openvibe-codes runs --for-agent
openvibe-codes show <run id> --for-agent                # the header, each attempt, the result (not every event)
openvibe-codes resume <run id> --for-agent "now add the test"
```

`retry` is true only when repeating the exact command is safe; an agent run is not idempotent, so a failed run is
continued with `resume`. The closed set of error codes is in the guide the binary ships:

```bash
openvibe-codes skills list        # the guides inside this binary
openvibe-codes skills get         # the openvibe-codes guide, Markdown, for the exact version you are running
openvibe-codes skills path        # where the file is, for a host that loads files itself
```

The guide is version-matched by construction: it is in the package and its `{{version}}` line is replaced with the
binary's own version, and a test keeps it and the CLI's flags in step.

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
// POST /api/v1/tasks/:id/message    { text } → 202 while an attempt runs (it waits for the next attempt),
//                                    or the next attempt now when nothing runs, like a continue with a note
// POST /api/v1/tasks/:id/stop       the running attempt stops; nothing carries it on
```

What the portal had and Codes does not (yet): a *named machine* per task, a transcript endpoint separate from the
event stream (the stream carries the session's lines), and fencing a whole chain of jobs — here the **task** is
the unit, and a continue is an attempt on the same task.

## Code mode (runner 0.13.0)

Claude Code's own Code Mode works only in an interactive terminal, and every Codes run is headless. A job with
`code_mode: true` brings Codes' own instead: `openvibe-codes code-mode` (harness/code-mode.js), an MCP server started
beside Claude Code with two tools.

- `search { query }`: the repository tools a script may call, with their input types.
- `execute { code }`: one JavaScript script in openvibe-sdk/code-mode's sandbox. Its only way out is
  `await tools.<name>(input)`: `read`, `grep` (ripgrep when there is one), `glob`, `ls`, and as the job allows `edit`,
  `write` and `sh`. Only what it returns (32 KB) and its console lines come back; ten minutes and 300 calls at most.

Every tool stays inside the job's folder, never touches a `.env` file, and keeps the job's permission:

| Job | Code mode may | Claude's own file and shell tools |
|---|---|---|
| a task on a repository (`edit`) | read, edit, write, run commands (no git push/commit/reset/clean/stash, sudo, rm -rf) | off (strict) |
| `read` | read, grep, glob, ls | off (strict) |
| `full` | everything but git push | off (strict) |
| a conductor turn at `ask` | read only | on, and they ask the owner |
| a conductor turn at `project` | read and change files, no commands | on |
| a conductor turn at `full` | everything but git push | off (strict) |

Measured on Claude Code 2.1 with Haiku (11-18, a rename across three files): with its own tools it took 4 to 7 turns;
in strict code mode, two `execute` calls in three turns. The system prompt says how to use it, and Claude Code's tool
search is off for the run so `execute` is visible from the start. Node.js 22.13 or newer is needed for the sandbox; an
older runner says code mode is off and runs as before.
