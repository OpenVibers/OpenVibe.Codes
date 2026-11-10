# openvibe-codes — the guide for agents

Version: {{version}} (shipped inside the binary; it always matches `openvibe-codes --version`)

`openvibe-codes` runs a coding task on an agent CLI installed on **this machine** — Claude Code, Codex, OpenCode,
Command Code, MiniMax Code or Aider — or on the DeepSeek API or any OpenAI-compatible server. The harness routes the
task, hands it to the next agent when one fails, and keeps every run. Nothing is sent to OpenVibe.

Use this guide when you are an agent driving `openvibe-codes` (or a script that supervises one). Read it with
`openvibe-codes skills get`; do not paste the human documentation into a prompt.

## First, what is here

```bash
openvibe-codes agents --for-agent        # one line: which harness ids this machine can run, and why not the rest
openvibe-codes logins --for-agent        # installed, signed in, each provider's limit windows
openvibe-codes route --for-agent --task edit   # which agent a task would go to, and why
```

Only run an id that `agents --for-agent` reports `"available":true`. An agent that is not installed, not signed in
or at its usage limit will not be picked.

## Run a task

```bash
openvibe-codes run --for-agent "rename getUser to findUser"
openvibe-codes run --for-agent --agent codex --permission read "where is the session cookie set?"
openvibe-codes run --for-agent --task review "review the diff on this branch"
openvibe-codes run --for-agent - < brief.md          # the task on stdin
```

- `--agent <id>` skips routing and runs that harness first. Without it the harness picks, cheapest suitable first,
  and hands over on failure.
- `--permission read|edit|full` — `read` looks only, `edit` (default) changes files, `full` is anything unattended.
  OpenCode and Command Code have no edits-only mode; outside a sandbox they need `full`.
- `--model`, `--effort low|medium|high|max`, `--advisor` are passed to the first agent.
- `--cwd <dir>` is where the agent works (default: the current directory).
- `--no-handoff` stops at the first agent's result; `--attempts <n>` caps the agents in one run (default 3).
- `--json` is the full event stream for a person debugging; **use `--for-agent` instead**.

## The `--for-agent` envelope

One compact JSON object per line on stdout, no ANSI and no pretty printing. Every line has fixed fields:

| field | meaning |
|---|---|
| `run` | the run id; `show` and `resume` take it |
| `seq` | the line's number in this run, from 1 |
| `event` | `init`, `text`, `tool`, `tool_error`, `progress`, `handoff`, `warning`, `stderr`, `result`; `show`/`runs` also answer `run`, `attempt`, `error` |
| `agent` | the harness that produced the line |
| `session` | the harness's session id, when it has one (what `resume` continues) |
| `ref` | what a tool call points at: a file, a pattern, a URL or the first line of a command |
| `ok` | on a result: did the agent finish without an error |
| `error` | on a failure: `{ code, retry, suggestion }` |
| `text` | the message or answer, bounded to 400 characters |

A successful run ends with exactly one `result` line with `"ok":true`. A failed run ends with one `result` line
carrying `"ok":false` and a `code`; a failure before any agent ran is one `error` line. Text is truncated to keep an
agent's context small; the human log (no `--for-agent`) has all of it.

Example lines:

```json
{"run":"run_01J…","seq":1,"event":"init","agent":"codex","model":"gpt-6","session":"cx-1"}
{"run":"run_01J…","seq":2,"event":"tool","agent":"codex","tool":"Edit","ref":"src/user.js"}
{"run":"run_01J…","seq":3,"event":"result","agent":"codex","ok":true,"session":"cx-1","text":"renamed getUser to findUser","cost_usd":0.02}
```

## Reading a run without re-running it

```bash
openvibe-codes runs --for-agent                  # one line per kept run on this machine
openvibe-codes show <run> --for-agent            # the header, each attempt, the result (not every event)
openvibe-codes resume <run> --for-agent "now add the test"   # continue the last session with the same agent
```

`show --json` dumps every event; an agent should use `show --for-agent`, which is bounded.

## Errors and retries

Failures carry `{code, retry, suggestion}`. Branch on `code`, never on the message text.

| code | retry | what to do |
|---|---|---|
| `no_prompt` | false | give the task as an argument, or `-` plus stdin |
| `bad_agent` | false | the id is not in the catalog: read `agents --for-agent` |
| `unavailable` | false | the harness is not installed or signed in here: read `agents --for-agent` |
| `agent_failed` | false | read the result, then `resume` the same session with what is missing |
| `no_run` | false | the id is not on this machine: read `runs --for-agent` |
| `usage` | false | a wrong command line: read `skills get` |
| `internal` | false | an unexpected error: run the command without `--for-agent` for the full message |

`retry` is `true` only when repeating the exact same command is safe. An agent run is not idempotent (it edits the
working tree), so a failed run is continued with `resume`, not started again.

## Exit codes

| code | meaning |
|---|---|
| 0 | the last agent finished without an error |
| 1 | a failure: the task failed, no agent could take it, or the command line was wrong |
| 2 | `task` only: the command line or the Network token is wrong (nothing was sent) |

## Tasks on openvibe.codes

`openvibe-codes task` hands a task to openvibe.codes/run and one of the person's machines runs it there:

```bash
openvibe-codes task start --repo OpenVibers/OpenVibe.Codes --file brief.md --name codes-c6 --tier hard
openvibe-codes task list --state running|needs|done
openvibe-codes task show <task> --follow
openvibe-codes task continue <task> --note "and add the test the reviewer asked for"
openvibe-codes task stop <task>
```

It needs a personal Network token (`OPENVIBE_TOKEN`, or `~/.config/openvibe/token`). `docs/cli.md` in the repository
has its flags and the task API it maps onto.

## The rules of this machine

- Do not parse the human log: use `--for-agent`.
- Do not assume an agent's tool names: `tool` and `ref` are normalised to Claude Code's vocabulary.
- Do not repeat a mutating run; `resume` it with a follow-up.
- The harness never prints a token, and neither should you: `openvibe-codes` scrubs secrets out of events.
- The run is kept in `OPENVIBE_CODES_HOME` (else `$XDG_STATE_HOME/openvibe-codes`, else `~/.local/state/openvibe-codes`).
