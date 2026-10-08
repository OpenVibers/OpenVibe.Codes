#!/usr/bin/env node
'use strict';

/**
 * openvibe-codes — code with any agent, from your terminal. The harness runs on your machine with your agents and your
 * keys; nothing is sent to OpenVibe. The commands and options are in USAGE below (`openvibe-codes --help`); the guide is
 * https://openvibe.codes/start.
 */
const path = require('path');
const { createHarness } = require('../harness');
const { version: VERSION } = require('../package.json');

const USAGE = `openvibe-codes ${VERSION} — code with any agent, from your terminal

  openvibe-codes agents                       which agents this machine can run, and why not the others
  openvibe-codes route [--task edit] [--need harness:resume,…]   which agent a task would go to, and why
  openvibe-codes run [options] "what to do"   run a task ("-" reads it from stdin)
      --task edit|review|long|resume   what kind of task (default edit)
      --agent <id>                     skip routing: claude-code, codex, opencode, command-code, aider,
                                       deepseek, openai-compatible
      --model <name>                   the first agent's model
      --permission read|edit|full      read: look and answer; edit: change files (default);
                                       full: anything, unattended
      --cwd <dir>                      where the agent works (default: here)
      --no-handoff                     stop at the first agent's result
      --attempts <n>                   at most this many agents in one run (default 3)
      --json                           the events as JSON lines instead of a readable log
  openvibe-codes runs                         the latest runs on this machine
  openvibe-codes show <run id> [--json]       one run's attempts and result (--json: every event)
  openvibe-codes resume <run id> "follow-up"  continue a run's last session with its agent

Environment: DEEPSEEK_API_KEY · OPENVIBE_CODES_BASE_URL, OPENVIBE_CODES_MODEL, OPENVIBE_CODES_API_KEY
(your own OpenAI-compatible server) · OPENVIBE_CODES_HOME (where runs are kept).
Guide: https://openvibe.codes/start`;

function parse(argv) {
    const opts = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--no-handoff') opts.handoff = false;
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
    if (e.type === 'system' && e.subtype === 'handoff') return out(`⇢ handing over from ${e.from}: ${e.reason}`);
    if (e.type === 'system' && (e.subtype === 'error' || e.subtype === 'warning')) return out(dim(`! ${e.text}`));
    if (e.type === 'assistant') {
        for (const c of (e.message && e.message.content) || []) {
            if (c.type === 'text') out(c.text);
            if (c.type === 'tool_use') {
                const i = c.input || {};
                const what = i.command || i.file_path || i.path || i.pattern || i.query || i.description || '';
                out(dim(`  → ${c.name}${what ? ` ${String(what).split('\n')[0].slice(0, 120)}` : ''}`));
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

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const o = parse(rest);
    if (!cmd || cmd === 'help' || o.help || cmd === '--help' || cmd === '-h') { out(USAGE); return 0; }
    if (cmd === '--version' || cmd === '-v' || cmd === 'version') { out(VERSION); return 0; }
    const harness = createHarness();

    if (cmd === 'agents') {
        const list = harness.agents();
        if (o.json) { out(JSON.stringify(list, null, 2)); return 0; }
        for (const a of list) out(`${a.available ? '✔' : '·'} ${a.id.padEnd(18)} ${a.name.padEnd(16)} ${a.available ? dim(a.where || '') : dim(a.reason)}`);
        return 0;
    }
    if (cmd === 'route') {
        const requirements = o.need ? { capabilities: String(o.need).split(',').map((s) => s.trim()).filter(Boolean) } : {};
        const d = harness.route({ task: o.task || 'edit', requirements });
        if (o.json) { out(JSON.stringify(d, null, 2)); return 0; }
        out(d.selected ? `→ ${d.selected}` : '→ no agent here can take it');
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
            if (!prev) { out(`no run ${o._[0]} on this machine (openvibe-codes runs)`); return 1; }
            const last = [...(prev.attempts || [])].reverse().find((a) => a.session_id);
            if (!last) { out('that run has no session to resume'); return 1; }
            resume = last.session_id; agent = last.agent; cwd = prev.cwd || cwd;
            prompt = o._.slice(1).join(' ');
        } else {
            prompt = o._.join(' ');
        }
        if (prompt === '-') prompt = await readStdin();
        if (!prompt || !prompt.trim()) { out('what should the agent do? openvibe-codes run "…"'); return 1; }
        const controller = new AbortController();
        process.on('SIGINT', () => { controller.abort(); });
        const run = harness.run({
            prompt, task: o.task || (resume ? 'resume' : 'edit'), agent, model: o.model || null, cwd, resume,
            permission: o.permission || 'edit', handoff: o.handoff !== false && !resume, maxAttempts: Number(o.attempts) || 3, signal: controller.signal,
        });
        if (!o.json) out(dim(`run ${run.runId} · ${cwd}`));
        let last = null;
        for await (const e of run) { last = e; if (o.json) out(JSON.stringify(e)); else printEvent(e); }
        return last && last.type === 'result' && !last.is_error ? 0 : 1;
    }
    if (cmd === 'runs') {
        const runs = harness.store.listRuns(Number(o.limit) || 20);
        if (o.json) { out(JSON.stringify(runs, null, 2)); return 0; }
        for (const r of runs) {
            const ok = r.result && !r.result.is_error;
            out(`${ok ? '✔' : '✗'} ${r.run_id}  ${(r.attempts || []).map((a) => a.agent).join(' ⇢ ').padEnd(28)} ${dim(String(r.prompt || '').split('\n')[0].slice(0, 70))}`);
        }
        return 0;
    }
    if (cmd === 'show') {
        const r = harness.store.loadRun(o._[0]);
        if (!r) { out(`no run ${o._[0]} on this machine`); return 1; }
        if (o.json) { for (const e of harness.store.events(r.run_id)) out(JSON.stringify(e)); return 0; }
        out(`${r.run_id} · ${r.cwd} · ${r.permission}`);
        for (const a of r.attempts || []) out(`  ${a.ok ? '✔' : '✗'} ${a.agent}${a.session_id ? dim(` session ${a.session_id}`) : ''}${a.error ? ` — ${a.error}` : ''}`);
        if (r.result) out(r.result.result || '');
        return r.result && !r.result.is_error ? 0 : 1;
    }
    out(USAGE);
    return 1;
}

main().then((code) => process.exit(code), (err) => { process.stderr.write(`openvibe-codes: ${err.message}\n`); process.exit(1); });
