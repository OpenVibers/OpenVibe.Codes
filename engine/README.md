# engine/

The agent engine: the pieces of the private agent portal (learned in production, on this workstation, since June 2026)
that every Codes surface shares — the CLI on a Node, the hosted runner and, until it retires, the portal itself.

CommonJS, Node 22, no dependencies.

```js
const engine = require('./engine');

engine.classify('Root cause of the race condition in the webhook');  // { tier: 'hard', why: 'a hard problem' }
engine.outcome(attempts);                                            // { state, reason, step, … }
```

## The modules

### `adapters/` — every harness Codes can run, with the portal's argv and environment

Six harnesses, each one the portal's runner script, ported: `claude-code` and `claude-other` (Claude Code, and Claude
Code on another provider with the cm-style environment), `codex`, `command-code`, `opencode` and `minimax-code`. An
adapter says how its CLI is started (the argv and the environment — the portal's, not a guess), how what it prints is
read into the one transcript shape (the portal's feed converters), and what its reasoning levels are.

```js
const { adapterFor } = require('./engine/adapters');

adapterFor('codex').build({ prompt, cwd, model: 'gpt-5-codex', effort: 'medium', permission: 'edit' });
// → { cmd: 'codex', argv: ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '-s', 'workspace-write', …], env: {}, stdin: prompt }
```

The effort is fitted to the harness, never handed over as it came: the 2026-10-29 incident killed a job that copied
Codex's "medium" to Command Code, which accepts off, low, high and max.

### `jobrunner.js` — one attempt of one harness, the way the portal runs one

The prompt is assembled (`prompt.js`), the harness is started (`adapters/`), what it prints goes through the transcript
normaliser (`transcript.js`) into job lines (`joblines.js`), and a budget stop buys one wrap-up turn on the same session
(`budget.js`).

### `prompt.js` — the prompt every job gets

The git rule, the house rules, the lessons (when a store is reachable), the repo digest (`repomap.js`), then the brief.

### `logins.js` — what this machine has

Each CLI: installed, signed in, and the limit windows it can read. Nothing else: no key, no token, no account name.

### `router.js` — what kind of task is this, and which runner may take it

A brief is classified into one of five tiers (`basic`, `research`, `standard`, `hard`, `design`); a line `tier: hard`
in the brief forces it. Each tier has a ladder, cheapest suitable first: free models for chores, flat-price plans for
everyday code, the strongest models for hard problems and design. `pick()` walks that ladder and skips a runner that is
off, unhealthy, at its slot cap, or under 40% real success over seven days.

Public: `classify(prompt, opts)`, `classifyText(text, opts)`, `pick(prompt, ctx)`, `track(runs)`, `briefFor(prompt, JOBS, name)`,
`forcedTier(text)`, `LADDER`, `TIERS`.

```js
const { classify, pick } = require('./engine/router');

classify('tier: hard\nFind the race condition');        // { tier: 'hard', why: 'the brief says so' }

pick('Fix the parser', {                                // → { runner: 'mm', model: null, effort: 'high', … }
    cfg: { subagents: { mm: { enabled: true, max: 2 } } },
    health: { mm: { state: 'ok' } },
    counts: {}, models: {}, runs: [],
});
```

The ladder is the portal's, so the portal's jobs keep their routing. Codes supplies its own through
`pick(prompt, { ladder })`.

### `chain.js` — the attempts of one task, why they stopped, what happens next

Pure: it takes the attempts and returns the outcome and the next step. It never reads a log folder, a marker file or a
process table — the caller passes the data in. The failure reasons are the portal's: `limit`, `auth`, `capacity`,
`refused`, `error`, `budget`, `stopped`, `crash`, `timeout`, `incomplete`, `context`, `hung`.

An attempt is `{ key, runner, name, runnerName, status, updated, error, next, prev, parent, resolvedNote, stopped, budget, wrapUp, facts }`.

Public: `outcome(attempts, opts)`, `nextStep(attempts, opts)`, `annotate(attempts)`, `settle(attempts, start)`,
`nextRunner(run, ctx)`, `detect(attempt)`, `facts(attempt, events)`, `continuationNote(run, logFile)`,
`reason(text)`, `base(name)`, `chainRoot(name)`, `sameChain(a, b)`, `REASON_TEXT`, `SWITCHABLE`.

```js
const { outcome } = require('./engine/chain');

outcome([
    { key: 'cc:a', runner: 'cc', name: 'a', runnerName: 'Command Code', status: 'failed', updated: 1, error: 'usage limit reached' },
    { key: 'mm:a-r2', runner: 'mm', name: 'a-r2', runnerName: 'MiniMax Code', status: 'done', updated: 2 },
], { cfg, health, counts, models, runners: ['cc', 'mm'] });
// { state: 'done', reason: 'limit', attempt: 1,
//   step: { action: 'done', why: 'the task finished' }, … }
```

`step.action` is one of `wait`, `done`, `switch`, `continue`, `restart`, `wrap-up`, `stop`, `failed`, `none`.

### `budget.js` — how far one task may go

Three limits: steps (tool calls), minutes (wall clock) and dollars. A limit that is not set is no limit — an unknown
price is never a zero budget. The first limit reached wins. Steps and minutes buy **one** wrap-up turn, so the work
already done lands; dollars stay a hard stop.

Public: `limitsFor(cfg, runner, override)`, `evaluate(used, limits)`, `state(status)`, `wrapUp(hit, opts)`,
`wrapUpPrompt(hit)`, `STATES`.

```js
const { evaluate, wrapUp } = require('./engine/budget');

evaluate({ steps: 120, minutes: 30, usd: 1.2 }, { steps: 100, minutes: 60, usd: 5 });
// { hit: 'steps', limits: { steps: 100, minutes: 60, usd: 5 }, used: { steps: 120, minutes: 30, usd: 1.2 } }

wrapUp('steps');    // { action: 'wrap-up', prompt: 'You reached your steps limit…', why: … }
wrapUp('usd');      // { action: 'stop', prompt: null, why: 'a dollar limit is a hard stop: no wrap-up turn' }
```

### `transcript.js` — one event shape for every harness

Claude Code stream-json, Codex, Command Code, OpenCode, `dsh --json` and MiniMax Code stream-json all become
`{ t, text, name, input, output, at, … }`. The whole shape is described in [`transcript.schema.json`](transcript.schema.json).
Parsing a file is incremental: only the bytes added since the last read are parsed, so polling a running task every
second stays cheap.

Public: `parse(file)`, `parseText(text)`, `view(state, from, limit)`, `stats(file)`, `statsOf(state)`,
`persistStats(file)`, `summary(name, input)`, `kindOf(name)`, `clip(value, max)`, `textOf(content)`, `atOf(ts)`.

```js
const { parseText } = require('./engine/transcript');

const state = parseText([
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'On it.' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
].join('\n'));

state.events.map((e) => e.t);   // ['text', 'tool']
state.events[1].name;           // 'Bash'
state.events[1].input.text;     // '{ "command": "npm test" }' (the input as text)
```

### `effort.js` — the reasoning level a harness accepts, and the models a provider refuses

Each harness accepts a different set of levels, so `fitEffort` rounds a wanted level to the nearest one the target
harness takes (a tie goes up) — otherwise a retry hands a runner a level it refuses and it dies before its first step.
The blocked-model list is per harness: a refused model is replaced by one the harness still lists, and a launch with
nothing left is an error, never a silent run with a refused model.

Public: `fitEffort(runner, effort)`, `stepUp(effort, list)`, `EFFORTS`, `ALIASES`, `ORDER`, `harnessOf(id)`,
`blockedList(blockedModels, runner)`, `isBlocked(blockedModels, runner, model)`, `pickModel({ runner, model, models, blockedModels })`,
`blockModel(list, model, error)`, `unblockModel(list, model)`.

```js
const { fitEffort, pickModel } = require('./engine/effort');

fitEffort('cc', 'medium');   // 'high' — Command Code does not take 'medium'
fitEffort('oc', 'medium');   // 'medium' — OpenCode has no effort setting

pickModel({ runner: 'cx', model: 'gpt-6.1-sol', models: { cx: ['gpt-6.1-sol', 'gpt-6-sol'] },
            blockedModels: { cx: ['gpt-6.1-sol'] } });
// 'gpt-6-sol'
```

Codes' harness names (`claude-code`, `codex`, `command-code`, `opencode`, `deepseek`) are accepted anywhere a portal
runner id is.

### `scope.js` — one systemd scope per job

An agent that starts a server in the background leaves it behind when its shell exits: the server is reparented to the
user's systemd, out of the job's process group, and nothing ever sees it again. Fifteen such servers and headless
browsers ran this workstation out of memory on 2026-10-30 01:38 UTC — the kernel killed the IDE, the portal and every
running job. A scope is a cgroup: everything the job starts stays in it, however it detaches, and `reap()` stops the
scope when the job itself is gone. `ovjobs.slice` caps all jobs together (15G/18G) and each scope caps one job
(6G/8G, `OOMPolicy=continue`).

Linux with a systemd user manager only: everywhere else `wrap()` returns the command unchanged and `reap()` does
nothing.

Public: `available()`, `wrap(cmd, args, label)`, `remember(unit, pid, label)`, `reap({ log })`, `stopFor(pid)`,
`SLICE`, `MAP`.

```js
const scope = require('./engine/scope');

const { cmd, args, unit } = scope.wrap('node', ['server.js'], 'cc-my-job');
// on Linux with systemd: cmd = 'systemd-run', unit = 'ovjob-cc-my-job-….scope'
// elsewhere:             cmd = 'node',      unit = null

await scope.reap({ log: (line) => console.log(line) });
```

### `runerror.js` — what a failed run really said

A harness that ends without an answer often leaves the wrapper's own no-result message behind; that message lists
possible causes, not an observed failure, so it is never reported as one. Only a real diagnostic in the feed or on
stderr is, and never a fragment of the launch command (the brief is echoed after a killed child).

Public: `failureError(feed, stderr, summary)`, `message(value)`, `NO_RESULT`.

```js
const { failureError } = require('./engine/runerror');

failureError('{"type":"result","is_error":true,"result":"API Error: usage limit reached"}', '');
// 'API Error: usage limit reached'
```

## Tests

`test/engine-*.test.js` in the Codes repo, run by the repo's own runner (`npm test`).
