#!/usr/bin/env node
'use strict';

/**
 * openvibe-codes — code with any agent, from your terminal. The harness runs on your machine with your agents and your
 * keys; nothing is sent to OpenVibe. The commands and options are in USAGE below (`openvibe-codes --help`); the guide is
 * https://openvibe.codes/start.
 */
const path = require('path');
// The catalog shipped with this binary is checked by its tests: the CLI trusts it, and starts without the contracts (0.4 s).
if (process.env.OPENVIBE_CODES_TRUST_CATALOG == null) process.env.OPENVIBE_CODES_TRUST_CATALOG = '1';
const { createHarness, adaptersFor } = require('../harness');
const provision = require('../harness/provision');
const { runJob, resultWriter, jobEnv } = require('../harness/job');
const { task } = require('./task');
const { skills } = require('./skills');
const agentOut = require('./agent-output');
const { createProofAdapters } = require('../harness/proof');
const { version: VERSION } = require('../package.json');
const { probe: probeLogins } = require('../engine/logins');

const USAGE = `openvibe-codes ${VERSION} — code with any agent, from your terminal

  openvibe-codes skills [get|list|path] [name] the guide an agent reads, shipped with this binary
  openvibe-codes acp [--permission read|edit|full] [--agent <id>]   Codes as one ACP agent on stdin/stdout, for Zed,
                                       JetBrains, T3 Code and any ACP client: auto or any harness as its models
  openvibe-codes setup [--profile <actor>] [--agents a,b] [--login own|locker|exchange]
                                       get this machine ready for an actor in one step: installs the agents, makes the
                                       actor's own home, its Locker key, and says what is ready and what is left
  openvibe-codes doctor [--profile <actor>]   every agent here: installed, signed in, ready, and the one command that
                                       fixes what is missing
  openvibe-codes install <agent…> | --all     install agents into this runner's own folder (never global, never root)
  openvibe-codes login <agent> [--profile <actor>]   the agent's own sign-in, kept in that actor's homes
  openvibe-codes agents                       which agents this machine can run, and why not the others
  openvibe-codes logins                      the coding CLIs here: installed, signed in, and their limit windows
  openvibe-codes route [--task edit] [--need harness:resume,…]   which agent a task would go to, and why
  openvibe-codes swarm [--tickets 4] [--concurrency 3] [--agents a,b] [--planner <id>] "goal"
                                       split a goal into tickets that run at once, each on its own agent and git
                                       worktree, merged into one branch (yours is untouched)
  openvibe-codes run [options] "what to do"   run a task ("-" reads it from stdin)
      --task edit|review|long|resume   what kind of task (default edit)
      --profile <actor>                the actor's own homes for every agent: its logins, history and settings, apart
                                       from every other actor on this machine (OPENVIBE_CODES_PROFILE)
      --login own|locker|exchange      where the agent's sign-in comes from for this run: its own, the actor's Locker
                                       login (OPENVIBE_CODES_LOGIN_<AGENT>=locker:<item>, OPENVIBE_LOCKER_TOKEN), or
                                       OpenVibe.Exchange as the gateway (OPENVIBE_EXCHANGE_KEY)
      --no-install                     do not install a missing agent (OPENVIBE_CODES_AUTOINSTALL=0)
      --agent <id>                     skip routing: claude-code, claude-other, codex, opencode, command-code,
                                       aider, minimax-code, deepseek, openai-compatible
      --model <name>                   the first agent's model
      --effort <level>                 reasoning effort for agents that take one (auto|low|medium|high|max);
                                       auto is each agent's own default; OpenVibe.AI resolves it from its
                                       role and task defaults, the CLIs take no flag
      --advisor                        let the OpenVibe.AI agent ask a stronger model for advice
                                       mid-run (at most 3 uses; AI puts each use on the run's receipt)
      --advisor-model <provider/model> the advisor model (default: AI's reviewer role, then its strongest)
      --permission read|edit|full      read: look and answer; edit: change files (default);
                                       full: anything, unattended. OpenCode and Command Code have no
                                       edits-only mode: here they need full (on a paired machine's
                                       sandboxed jobs, edit is enough)
      --cwd <dir>                      where the agent works (default: here)
      --no-handoff                     stop at the first agent's result
      --attempts <n>                   at most this many agents in one run (default 3)
      --json                           the events as JSON lines instead of a readable log
      --for-agent                      one compact JSON line per event with fixed fields (run, seq,
                                       event, agent, session, ref, ok, error {code,retry,suggestion});
                                       no ANSI, bounded text. The machine face of every command here.
  openvibe-codes runs                         the latest runs on this machine
  openvibe-codes show <run id> [--json]       one run's attempts and result (--json: every event)
  openvibe-codes resume <run id> "follow-up"  continue a run's last session with its agent
  openvibe-codes job                          one task as an OpenVibe Run job (JSON input on stdin; the
                                              OpenVibe Link's job worker runs it on your own machine)
  openvibe-codes task start|list|show|continue|stop   coding tasks on openvibe.codes, as you, on one of
                                              your machines (openvibe-codes task --help)
  openvibe-codes tools find|run|mine|make      OpenVibe Tools from the terminal: find a tool for a need, run it,
                                              your own tools, or describe one and a model makes it
                                              (openvibe-codes tools --help)
  openvibe-codes mcp                          the Codes MCP tools for a Claude Code session: tasks, the fleet,
                                              shipping status, and the conductor's approvals (stdio JSON-RPC)

Environment: OPENVIBE_EXCHANGE_KEY (your Exchange key; the deepseek agent calls OpenVibe.Exchange by
default) · DEEPSEEK_API_KEY, OPENVIBE_CODES_DEEPSEEK_DIRECT=1 (your own DeepSeek key on a self-hosted run) ·
OPENVIBE_CODES_BASE_URL, OPENVIBE_CODES_MODEL, OPENVIBE_CODES_API_KEY (your own OpenAI-compatible server) ·
OPENVIBE_CODES_HOME (where runs are kept) · OPENVIBE_TOKEN (your Network token, for 'task') and
OPENVIBE_CODES_URL (the server task talks to).
Guide: https://openvibe.codes/start`;

let agentMode = false;   // --for-agent: the final error handler answers in the same envelope

function parse(argv) {
    const opts = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--for-agent') { opts.forAgent = true; agentMode = true; }
        else if (a === '--advisor') opts.advisor = true;
        else if (a === '--no-handoff') opts.handoff = false;
        else if (a === '--no-install') opts.install = false;
        else if (a === '--all') opts.all = true;
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (a.startsWith('--')) { const k = a.slice(2); opts[k] = argv[++i]; }
        else opts._.push(a);
    }
    return opts;
}

const out = (s) => process.stdout.write(`${s}\n`);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function printEvent(e) {
    if (e.type === 'system' && e.subtype === 'init') return out(dim(`▶ ${e.agent}${e.model ? ` (${e.model})` : ''}${e.session_id ? ` · session ${e.session_id}` : ''}`));
    if (e.type === 'system' && e.subtype === 'handoff') return out(`handing over from ${e.from}: ${e.reason}`);
    if (e.type === 'system' && (e.subtype === 'error' || e.subtype === 'warning')) return out(dim(`! ${e.text}`));
    if (e.type === 'assistant') {
        for (const c of (e.message && e.message.content) || []) {
            if (c.type === 'text') out(c.text);
            if (c.type === 'tool_use') {
                const i = c.input || {};
                const what = i.command || i.file_path || i.path || i.pattern || i.query || i.description || '';
                out(dim(`  calls ${c.name}${what ? ` ${String(what).split('\n')[0].slice(0, 120)}` : ''}`));
            }
        }
        return undefined;
    }
    if (e.type === 'user') {
        for (const c of (e.message && e.message.content) || []) if (c.type === 'tool_result' && c.is_error) out(dim(`    ✗ ${String(c.content).split('\n')[0].slice(0, 160)}`));
        return undefined;
    }
    if (e.type === 'result') {
        const u = e.usage || {};
        const facts = [`${Math.round((e.duration_ms || 0) / 1000)} s`, e.total_cost_usd ? `$${e.total_cost_usd.toFixed(4)}` : null, `${k((u.input_tokens || 0) + (u.cache_read_input_tokens || 0))} in / ${k(u.output_tokens || 0)} out`].filter(Boolean).join(' · ');
        return out(e.is_error ? `✗ ${e.result} ${dim(`(${facts})`)}` : dim(`✔ done (${facts})`));
    }
    return undefined;
}

async function readStdin() {
    let s = '';
    for await (const chunk of process.stdin) s += chunk;
    return s;
}

/**
 * A Link job's args: its first line (Link writes the args and a newline). An interactive job's stdin stays open after
 * them (Link v0.72.0), so the runner reads that line and not to the end; what came with it after the newline is kept
 * for the agent the job hands its stdin to (a sign-in's code). → { line, rest }
 */
function readJobLine(stream = process.stdin) {
    return new Promise((resolve) => {
        let buf = '';
        const done = () => { stream.removeListener('data', onData); stream.removeListener('end', onEnd); stream.pause(); };
        const onData = (chunk) => {
            buf += chunk;
            const i = buf.indexOf('\n');
            if (i >= 0) { done(); resolve({ line: buf.slice(0, i), rest: buf.slice(i + 1) }); }
        };
        const onEnd = () => { done(); resolve({ line: buf, rest: '' }); };
        stream.setEncoding('utf8');
        stream.on('data', onData);
        stream.once('end', onEnd);
    });
}

/**
 * The person's own homes for a job on a machine (Link v0.72.0): with their persistent sandbox (OPENVIBE_SANDBOX), the
 * runner's folder is in it (the agents it installs) and the job runs as the actor `me` there (their sign-ins). Without
 * one, nothing changes.
 */
function sandboxEnv(env = process.env) {
    if (!env.OPENVIBE_SANDBOX) return env;
    const inBox = { ...env, OPENVIBE_CODES_HOME: path.join(env.OPENVIBE_SANDBOX, 'codes') };
    return provision.withTools(provision.profileEnv(inBox, 'me'));
}

/**
 * Sign an agent in on this machine, in the person's sandbox (a Link job of mode 'login', interactive): the agent's
 * own sign-in runs with the job's stdin, so the code its sign-in page shows reaches it from the page (job_stdin). It
 * installs the agent first when it is missing. The result says whether it is signed in now.
 */
async function loginJob(input, rest, env) {
    const id = String(input.agent || '');
    const adapter = adaptersFor(env)[id];
    const args = provision.LOGIN_ARGS[id];
    const result = (doc) => resultWriter(out)({ mode: 'login', agent: id, ...doc });
    if (!adapter || !args) { out(`No sign-in here for ${id || 'that agent'}.`); result({ ok: false, error: 'unknown_agent' }); return 0; }
    const ready = provision.ensure(adapter, env, { log: (m) => out(m) });
    if (!ready.ok) { out(ready.error); result({ ok: false, error: 'install_failed' }); return 0; }
    out(`Signing ${adapter.name} in on this machine…`);
    const { spawn } = require('child_process');
    const child = spawn(ready.where || adapter.bin, args, { env: { ...env, BROWSER: 'true' }, stdio: ['pipe', 'inherit', 'inherit'] });
    if (rest) child.stdin.write(rest);
    process.stdin.resume();
    process.stdin.pipe(child.stdin);
    // 2026-11-16 (a real sign-in on ov-node-01): Claude Code keeps waiting after its input closes, so the job would end
    // only at Link's limit, killed, with no result for the page. The page's input closing gives the agent a few seconds
    // to finish; the job's own deadline (before Link's 10 minutes) ends it with a result either way.
    const stop = () => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM'); };
    const graceMs = Number(env.OPENVIBE_CODES_LOGIN_GRACE_MS) || 5000;
    const deadlineMs = Number(env.OPENVIBE_CODES_LOGIN_DEADLINE_MS) || 9 * 60 * 1000;
    let grace = null;
    const onEnd = () => { grace = setTimeout(stop, graceMs); };
    process.stdin.once('end', onEnd);
    const deadline = setTimeout(stop, deadlineMs);
    const code = await new Promise((resolve) => child.on('close', (c, sig) => resolve(c == null ? (sig || 'stopped') : c)));
    clearTimeout(deadline); if (grace) clearTimeout(grace);
    process.stdin.off('end', onEnd);
    process.stdin.unpipe(child.stdin);
    const now = probeLogins({ home: env.HOME, env }).find((x) => x.id === id) || {};
    const signedIn = now.signed_in === true;
    out(signedIn ? `${adapter.name} is signed in.` : `${adapter.name} did not sign in (exit ${code}).`);
    result({ ok: signedIn, signed_in: signedIn, exit: code });
    process.stdin.destroy();
    return 0;
}

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    // Tasks on openvibe.codes: the person's own token, the server's API. Nothing here runs an agent.
    if (cmd === 'task') return task(rest);
    // The Codes MCP server (Codes C9b): a conductor's Claude Code session starts it with --mcp-config.
    if (cmd === 'mcp') return require('./mcp').mcp();
    // Codes as one Agent Client Protocol agent (Zed, JetBrains, T3 Code, …): every harness behind one agent.
    if (cmd === 'acp') return require('./acp').acp({ argv: rest });
    const o = parse(rest);
    if (cmd === 'skills') return skills(rest.filter((a) => a !== '--json'), { out, json: o.json });
    if (cmd === 'tools') return require('./tools').tools(rest, { out, json: o.json });
    if (!cmd || cmd === 'help' || o.help || cmd === '--help' || cmd === '-h') { out(USAGE); return 0; }
    if (cmd === '--version' || cmd === '-v' || cmd === 'version') { out(VERSION); return 0; }
    // The actor's own homes and this runner's installed agents (2026-11-16: provisioning).
    let env = process.env;
    try { env = provision.profileEnv(env, o.profile || env.OPENVIBE_CODES_PROFILE || null); } catch (e) { out(e.message); return 1; }
    env = provision.withTools(env);
    if (o.install === false) env = { ...env, OPENVIBE_CODES_AUTOINSTALL: '0' };
    const harness = createHarness({ env });
    if (cmd === 'install') {
        const ids = o.all ? Object.keys(provision.recipes) : o._;
        if (!ids.length) { out('which agents? openvibe-codes install claude-code codex …  (or --all)'); return 1; }
        let bad = 0;
        for (const id of ids) {
            const r = provision.install(id, env, { log: (m) => { if (!o.json) out(dim(m)); } });
            if (o.json) out(JSON.stringify({ id, ...r })); else out(`${r.ok ? '✔' : '✗'} ${id}${r.ok ? dim(` ${[r.where, r.version].filter(Boolean).join(' · ')}`) : ` ${r.error}`}`);
            if (!r.ok) bad++;
        }
        return bad ? 1 : 0;
    }
    if (cmd === 'login') {
        // The agent's own sign-in, in the actor's homes: the login lands in that actor's profile and nowhere else.
        const id = o._[0];
        const adapter = id && adaptersFor(env)[id];
        const args = id && provision.LOGIN_ARGS[id];
        if (!adapter || !args) { out(`sign in which agent? openvibe-codes login ${Object.keys(provision.LOGIN_ARGS).join('|')} [--profile <actor>]`); return 1; }
        const ready = provision.ensure(adapter, env, { log: (m) => out(dim(m)) });
        if (!ready.ok) { out(ready.error); return 1; }
        if (env.OPENVIBE_CODES_PROFILE) out(dim(`signing ${adapter.name} in for actor ${env.OPENVIBE_CODES_PROFILE}`));
        const r = require('child_process').spawnSync(ready.where || adapter.bin, args, { env, stdio: 'inherit' });
        return r.status || 0;
    }
    if (cmd === 'setup' || cmd === 'doctor') {
        if (cmd === 'setup') {
            const ids = String(o.agents || 'claude-code,codex,opencode').split(',').map((s) => s.trim()).filter(Boolean);
            for (const id of ids) {
                const adapter = adaptersFor(env)[id];
                const r = adapter ? provision.ensure(adapter, env, { log: (m) => out(dim(m)) }) : provision.install(id, env, { log: (m) => out(dim(m)) });
                if (!r.ok) out(`✗ ${id} ${r.error}`);
            }
            if (o.login === 'locker') {
                const k = await provision.lockerKeys(env, env.OPENVIBE_CODES_PROFILE || 'default');
                out(`Locker: share each agent's login with this actor's key (${k.public.fingerprint.join ? k.public.fingerprint.join(' ') : k.public.fingerprint}).`);
                out(dim(`  its public key: ${k.file.replace(/locker-keys\.json$/, '')} (locker-keys.json keeps the private half, 0600)`));
                out(dim('  then set OPENVIBE_CODES_LOGIN_<AGENT>=locker:<item id> and OPENVIBE_LOCKER_TOKEN for the runs'));
            }
        }
        const rows = provision.doctor(adaptersFor(env), env, { logins: probeLogins({ home: env.HOME, env }) });
        if (o.json) { out(JSON.stringify({ profile: env.OPENVIBE_CODES_PROFILE || null, agents: rows }, null, 2)); return 0; }
        if (env.OPENVIBE_CODES_PROFILE) out(dim(`actor ${env.OPENVIBE_CODES_PROFILE} · ${env.OPENVIBE_CODES_PROFILE_DIR}`));
        for (const r of rows) out(`${r.ready ? '✔' : r.installed ? '◐' : '·'} ${r.id.padEnd(16)} ${r.ready ? dim(`ready · ${r.login} login`) : dim(r.fix || '')}`);
        return rows.some((r) => r.ready) ? 0 : 1;
    }

    if (cmd === 'agents') {
        const list = harness.agents();
        if (o.forAgent) {
            for (const a of list) out(agentOut.line({ event: 'agent', id: a.id, name: a.name, available: !!a.available, reason: a.available ? undefined : a.reason }));
            return 0;
        }
        if (o.json) { out(JSON.stringify(list, null, 2)); return 0; }
        for (const a of list) out(`${a.available ? '✔' : '·'} ${a.id.padEnd(18)} ${a.name.padEnd(16)} ${a.available ? dim([a.where, a.version].filter(Boolean).join(' · ')) : dim(a.reason)}`);
        return 0;
    }
    if (cmd === 'logins') {
        // What this machine has: each CLI, whether it is signed in, and the limit windows it can read. Nothing else:
        // no key, no token, no account name.
        const rows = probeLogins({ home: env.HOME, env });
        if (o.forAgent) {
            for (const r of rows) out(agentOut.line({ event: 'login', id: r.id, installed: !!r.installed, signed_in: !!r.signed_in, windows: r.windows || [] }));
            return 0;
        }
        if (o.json) { out(JSON.stringify(rows, null, 2)); return 0; }
        for (const r of rows) {
            const windows = r.windows.length ? r.windows.map((w) => `${w.name}${w.used != null ? ` ${w.used}/${w.limit}` : ''}${w.resets_at ? ` (resets ${w.resets_at})` : ''}`).join(', ') : '';
            out(`${r.installed ? '✔' : '·'} ${r.id.padEnd(16)} ${r.signed_in ? 'signed in' : 'not signed in'}${windows ? dim(' · ' + windows) : ''}`);
        }
        return 0;
    }
    if (cmd === 'route') {
        const requirements = o.need ? { capabilities: String(o.need).split(',').map((s) => s.trim()).filter(Boolean) } : {};
        const d = harness.route({ task: o.task || 'edit', requirements });
        if (o.forAgent) { out(agentOut.line({ event: 'route', selected: d.selected || null, reasons: d.reasons || [], candidates: (d.candidates || []).map((c) => ({ id: c.id, included: !!c.included, reason: c.reason || undefined })) })); return d.selected ? 0 : 1; }
        if (o.json) { out(JSON.stringify(d, null, 2)); return 0; }
        out(d.selected ? `selected ${d.selected}` : 'no agent here can take it');
        for (const r of d.reasons || []) out(dim(`  ${r}`));
        for (const c of d.candidates || []) out(`${c.included ? '  ✔' : '  ·'} ${c.id}${c.reason ? dim(` — ${c.reason}`) : ''}`);
        return d.selected ? 0 : 1;
    }
    if (cmd === 'run' || cmd === 'resume') {
        let prompt;
        let resume = null;
        let agent = o.agent || null;
        let cwd = path.resolve(o.cwd || process.cwd());
        if (cmd === 'resume') {
            const prev = harness.store.loadRun(o._[0]);
            if (!prev) {
                if (o.forAgent) out(agentOut.errorLine('no_run', `no run ${o._[0]} on this machine`));
                else out(`no run ${o._[0]} on this machine (openvibe-codes runs)`);
                return 1;
            }
            const last = [...(prev.attempts || [])].reverse().find((a) => a.session_id);
            if (!last) {
                if (o.forAgent) out(agentOut.errorLine('no_run', 'that run has no session to resume', { suggestion: 'start a new run instead: `openvibe-codes run --for-agent "<task>"`' }));
                else out('that run has no session to resume');
                return 1;
            }
            resume = last.session_id; agent = last.agent; cwd = prev.cwd || cwd;
            prompt = o._.slice(1).join(' ');
        } else {
            prompt = o._.join(' ');
        }
        if (prompt === '-') prompt = await readStdin();
        if (!prompt || !prompt.trim()) {
            if (o.forAgent) out(agentOut.errorLine('no_prompt', 'no task was given'));
            else out('what should the agent do? openvibe-codes run "…"');
            return 1;
        }
        let runHarness = harness;
        if (agent) {
            const adapter = adaptersFor(env)[agent];
            const ready = provision.ensure(adapter, env, { log: (m) => { if (!o.json && !o.forAgent) out(dim(m)); } });
            if (!ready.ok) { if (o.forAgent) out(agentOut.errorLine('agent_missing', ready.error)); else out(ready.error); return 1; }
            let login = null;
            try {
                if (o.login === 'locker') login = await provision.lockerLogin(agent, env);
                else if (o.login === 'exchange') login = provision.exchangeLogin(agent, env);
            } catch (e) { if (o.forAgent) out(agentOut.errorLine(e.code || 'login', e.message)); else out(e.message); return 1; }
            if ((o.login === 'locker' || o.login === 'exchange') && !login) {
                const why = o.login === 'exchange' ? 'set OPENVIBE_EXCHANGE_KEY (an Exchange key)' : `set OPENVIBE_CODES_LOGIN_${agent.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}=locker:<item id>`;
                if (o.forAgent) out(agentOut.errorLine('no_login', why)); else out(why);
                return 1;
            }
            // The login reaches this run's agent only: a harness of its own, never this process's environment.
            if (login) runHarness = createHarness({ env: { ...env, ...login } });
        }
        const controller = new AbortController();
        process.on('SIGINT', () => { controller.abort(); });
        const run = runHarness.run({
            prompt, task: o.task || (resume ? 'resume' : 'edit'), agent, model: o.model || null, cwd, resume,
            permission: o.permission || 'edit', handoff: o.handoff !== false && !resume, maxAttempts: Number(o.attempts) || 3, signal: controller.signal,
            effort: o.effort || null, advisor: o.advisor ? (o['advisor-model'] ? { model: o['advisor-model'] } : true) : null,
        });
        if (!o.json && !o.forAgent) out(dim(`run ${run.runId} · ${cwd}`));
        let last = null;
        let seq = 0;
        for await (const e of run) {
            last = e;
            if (o.forAgent) { for (const l of agentOut.eventLines(run.runId, seq + 1, e)) { seq++; out(l); } }
            else if (o.json) out(JSON.stringify(e));
            else printEvent(e);
        }
        return last && last.type === 'result' && !last.is_error ? 0 : 1;
    }
    if (cmd === 'swarm') {
        // One goal, split into tickets that run at once on their own agents and worktrees, merged into one branch.
        let goal = o._.join(' ');
        if (goal === '-') goal = await readStdin();
        if (!goal || !goal.trim()) { out('what should the swarm do? openvibe-codes swarm "…"'); return 1; }
        const { createSwarm } = require('../harness/swarm');
        const controller = new AbortController();
        process.on('SIGINT', () => { controller.abort(); });
        const agents = String(o.agents || '').split(',').map((a) => a.trim()).filter(Boolean);
        let swarm;
        try {
            swarm = createSwarm({ harness }).run({ goal, cwd: path.resolve(o.cwd || process.cwd()), agents, maxTickets: Number(o.tickets) || 4,
                concurrency: Number(o.concurrency) || 3, permission: o.permission || 'edit', planner: o.planner || null, signal: controller.signal });
        } catch (err) { out(`swarm: ${err.message}`); return 1; }
        if (!o.json) out(dim(`swarm ${swarm.swarmId}`));
        let last = null;
        for await (const e of swarm) {
            last = e;
            if (o.json) { out(JSON.stringify(e)); continue; }
            if (e.type === 'system' && e.subtype === 'swarm') {
                if (e.phase === 'board') { out(e.text); for (const t of e.tickets) out(`  ${t.id} ${t.title}${t.agent ? ` · ${t.agent}` : ''}${t.files.length ? dim(` · ${t.files.join(', ')}`) : ''}`); }
                else if (e.phase === 'ticket_end') out(`${e.status === 'done' ? '✔' : '✗'} ${e.ticket} ${e.status} (${e.changed} file${e.changed === 1 ? '' : 's'})`);
                else out(dim(`${e.ticket ? `${e.ticket} ` : ''}${e.text || e.phase}`));
            } else if (e.type === 'result') {
                out(e.is_error ? `✗ ${e.result}` : `✔ ${e.result}`);
            } else if (e.type === 'assistant' && e._ticket) {
                for (const c of (e.message && e.message.content) || []) if (c.type === 'tool_use') out(dim(`  [${e._ticket}] ${c.name}`));
            }
        }
        return last && last.type === 'result' && !last.is_error ? 0 : 1;
    }
    if (cmd === 'job') {
        // The job ends 0 whenever it handed over a result, ok or not (the document says which): OpenVibe Run keeps a
        // result only from a job that exited 0, and the person needs the summary and the patch either way.
        const { line: input, rest } = await readJobLine();
        // The job's own environment (Codes C3): the run token the harness carries and where the model APIs are. The
        // harness is built with it, so the agent's process gets the token and never the job's other input.
        let wanted = {};
        let parsed = {};
        try { parsed = JSON.parse(input); wanted = jobEnv(parsed); } catch { wanted = {}; }
        // A forge credential line is for git alone (the clone and the push): the agent's environment never has it.
        // The person's sandbox, when the machine gives one: their agents and sign-ins live there (sandboxEnv).
        const { OPENVIBE_GIT_CREDENTIALS: gitCredentials, ...forAgents } = sandboxEnv({ ...process.env, ...wanted });
        if (parsed && parsed.mode === 'login') return loginJob(parsed, rest, forAgents);
        process.stdin.destroy();   // a coding job reads nothing more: an interactive job's open stdin is closed here
        const jobHarness = createHarness({ env: forAgents });
        // The proof adapters: the repo's own tests, its pages in a browser, its diff, and the second model. The review
        // spends the same run token the attempt already carries, so it names the same person.
        const proof = createProofAdapters({
            cwd: process.cwd(),
            env: forAgents,
            jobEnv: (({ OPENVIBE_GIT_CREDENTIALS: _drop, ...rest }) => rest)(wanted),
            // The models this machine can offer a reviewer: the catalog's own.
            models: (jobHarness.agents() || []).flatMap((a) => (a.agents || []).map((x) => x.model)).filter(Boolean),
        });
        await runJob({ input, harness: jobHarness, emit: out, writeResult: resultWriter(out), proof, env: { ...forAgents, ...(gitCredentials ? { OPENVIBE_GIT_CREDENTIALS: gitCredentials } : {}) } });
        return 0;
    }
    if (cmd === 'runs') {
        const runs = harness.store.listRuns(Number(o.limit) || 20);
        if (o.forAgent) { for (const r of runs) out(agentOut.runLine(r)); return 0; }
        if (o.json) { out(JSON.stringify(runs, null, 2)); return 0; }
        for (const r of runs) {
            const ok = r.result && !r.result.is_error;
            out(`${ok ? '✔' : '✗'} ${r.run_id}  ${(r.attempts || []).map((a) => a.agent).join(', then ').padEnd(28)} ${dim(String(r.prompt || '').split('\n')[0].slice(0, 70))}`);
        }
        return 0;
    }
    if (cmd === 'show') {
        const r = harness.store.loadRun(o._[0]);
        if (!r) {
            if (o.forAgent) out(agentOut.errorLine('no_run', `no run ${o._[0]} on this machine`));
            else out(`no run ${o._[0]} on this machine`);
            return 1;
        }
        if (o.forAgent) { for (const l of agentOut.showLines(r)) out(l); return r.result && !r.result.is_error ? 0 : 1; }
        if (o.json) { for (const e of harness.store.events(r.run_id)) out(JSON.stringify(e)); return 0; }
        out(`${r.run_id} · ${r.cwd} · ${r.permission}`);
        for (const a of r.attempts || []) out(`  ${a.ok ? '✔' : '✗'} ${a.agent}${a.session_id ? dim(` session ${a.session_id}`) : ''}${a.error ? ` — ${a.error}` : ''}`);
        if (r.result) out(r.result.result || '');
        return r.result && !r.result.is_error ? 0 : 1;
    }
    if (o.forAgent) { out(agentOut.errorLine('usage', `unknown command or option: ${[cmd, ...rest].filter(Boolean).join(' ')}`)); return 1; }
    out(USAGE);
    return 1;
}

main().then((code) => process.exit(code), (err) => {
    if (agentMode) process.stdout.write(`${agentOut.errorLine('internal', err && err.message)}\n`);
    process.stderr.write(`openvibe-codes: ${err && err.message}\n`);
    process.exit(1);
});
