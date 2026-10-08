'use strict';

/**
 * The OpenVibe.Codes harness: every coding agent behind one interface, routed by what the task needs, with hand-offs.
 *
 *   const harness = createHarness({ env, fetch, store });
 *   harness.agents()                       the catalog with what is available on this machine, and why not
 *   harness.route({ task, requirements })  the placement decision (openvibe-sdk/placement over the catalog's offers)
 *   const run = harness.run({ prompt, task, agent?, model?, cwd, permission, resume?, handoff, maxAttempts })
 *   for await (const event of run) …       the shared events (harness/events.js), every attempt in turn
 *   run.summary()                          { run_id, attempts: [{ agent, ok, session_id, … }], result }
 *
 * Routing is the site's own (server/domain/harness-placement.js over server/data/harness-offers.json): capability
 * first, then cost; an agent that is not installed or has no key here is offered to the planner as down, so the
 * decision names it and says why. A hand-off happens when an attempt ends in error or goes quiet for `stallMs`: the
 * next agent the planner picks (the ones that already failed are left out) gets the task with a note on what the
 * previous one did and what the working tree looks like now.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHarnesses } = require('../server/domain/harnesses');
const placement = require('../server/domain/harness-placement');
const cli = require('./adapters/cli');
const { apiAgent } = require('./adapters/api');
const ev = require('./events');
const { createStore } = require('./sessions');

/** The adapter for each catalog harness (the catalog row's id). */
function adaptersFor(env) {
    return {
        'claude-code': cli.claudeCode,
        codex: cli.codex,
        opencode: cli.opencode,
        'command-code': cli.commandCode,
        aider: cli.aider,
        deepseek: apiAgent({ id: 'deepseek', name: 'DeepSeek', baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-chat', priceIn: 0.00027, priceOut: 0.0011 }),
        'openai-compatible': apiAgent({ id: 'openai-compatible', name: 'Your own model', baseUrl: env.OPENVIBE_CODES_BASE_URL || 'http://127.0.0.1:8080/v1', keyEnv: 'OPENVIBE_CODES_API_KEY', model: env.OPENVIBE_CODES_MODEL || 'local' }),
    };
}

/** Is the executable on PATH? (No shell, no `which`.) */
function onPath(bin, env) {
    for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
        try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return path.join(dir, bin); } catch { /* next */ }
    }
    return null;
}

function availability(adapter, env) {
    if (!adapter) return { available: false, reason: 'no adapter for this harness yet' };
    if (adapter.kind === 'cli') {
        const where = onPath(adapter.bin, env);
        return where ? { available: true, where } : { available: false, reason: `\`${adapter.bin}\` is not on PATH (install ${adapter.name})` };
    }
    if (adapter.id === 'openai-compatible') return env.OPENVIBE_CODES_BASE_URL ? { available: true, where: env.OPENVIBE_CODES_BASE_URL } : { available: false, reason: 'set OPENVIBE_CODES_BASE_URL (and OPENVIBE_CODES_MODEL) to your server' };
    return env[adapter.keyEnv] ? { available: true, where: adapter.baseUrl } : { available: false, reason: `set ${adapter.keyEnv}` };
}

/** What changed in the working tree, for a hand-off note (empty outside a git checkout). */
function treeState(cwd) {
    try {
        const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const status = git(['status', '--short']);
        const stat = git(['diff', '--stat']);
        return [status && `git status --short:\n${status.split('\n').slice(0, 40).join('\n')}`, stat && `git diff --stat:\n${stat.split('\n').slice(-20).join('\n')}`].filter(Boolean).join('\n\n');
    } catch { return ''; }
}

function handoffNote({ prompt, from, why, tally, cwd }) {
    const t = tally;
    const files = [...t.files].slice(0, 30);
    return [
        `You are taking over a coding task that ${from} started and could not finish (${why}).`,
        '',
        'The task:',
        prompt,
        '',
        `What ${from} did: ${t.tools} tool call(s)${files.length ? `, files it edited: ${files.join(', ')}` : ''}.`,
        t.lastText ? `Its last message:\n${ev.clip(t.lastText, 2000)}` : '',
        treeState(cwd) ? `The working tree now:\n${treeState(cwd)}` : '',
        '',
        'Look at the current state before you change anything, finish the task, and end with a short summary of what you did.',
    ].filter((l) => l !== '').join('\n');
}

function createHarness({ env = process.env, fetch: fetchImpl = globalThis.fetch, store = createStore({ env }), catalog = createHarnesses() } = {}) {
    const adapters = adaptersFor(env);

    function agents() {
        return catalog.list().map((h) => ({ ...h, agents: catalog.agents(h.id), adapter: adapters[h.id] ? adapters[h.id].kind : null, ...availability(adapters[h.id], env) }));
    }

    /** The placement decision among the agents available here; `exclude` leaves harnesses out (a hand-off's earlier attempts). */
    function route({ task = 'edit', requirements = {}, exclude = [] } = {}) {
        const opts = {};
        const why = {};
        for (const h of catalog.list()) {
            const a = availability(adapters[h.id], env);
            const down = !a.available || exclude.includes(h.id);
            for (const agent of catalog.agents(h.id)) {
                const id = `${h.id}:${agent.id || agent.model}`;
                if (down) { opts[id] = { health: 'down' }; why[id] = exclude.includes(h.id) ? 'already tried in this run' : a.reason; }
            }
        }
        const decision = placement.route({ task, extra: requirements, harnesses: catalog, opts });
        decision.candidates = (decision.candidates || []).map((c) => (why[c.id] ? { ...c, included: false, reason: why[c.id] } : c));
        return decision;
    }

    function run({ prompt, task = 'edit', agent = null, model = null, cwd = process.cwd(), permission = 'edit', resume = null, handoff = true, maxAttempts = 3, stallMs = 10 * 60_000, timeoutMs, maxTurns, requirements = {}, signal } = {}) {
        if (!prompt || !String(prompt).trim()) throw new Error('a run needs a prompt');
        if (!['read', 'edit', 'full'].includes(permission)) throw new Error('permission is read, edit or full');
        const runId = store.newRunId();
        const attempts = [];
        let final = null;
        let current = null;

        const summary = () => ({ run_id: runId, prompt: ev.clip(prompt, 500), cwd, task, permission, attempts, result: final, started_at: attempts[0] ? attempts[0].started_at : null });

        const iterator = (async function* events() {
            const tried = [];
            let nextPrompt = String(prompt);
            for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt++) {
                let harnessId;
                let modelFor = model;
                if (attempt === 1 && agent) {
                    harnessId = agent;
                    const a = availability(adapters[agent], env);
                    if (!adapters[agent] || !a.available) {
                        final = ev.result({ ok: false, text: `${agent} is not available here: ${a.reason || 'unknown agent'}` });
                        yield final; break;
                    }
                } else {
                    const decision = route({ task, requirements, exclude: tried });
                    if (!decision.selected) {
                        const reason = attempt === 1 ? 'no available agent can take this task' : 'no other agent is available to take over';
                        const text = `${reason}: ${(decision.candidates || []).map((c) => `${c.id} (${c.reason || 'excluded'})`).join('; ')}`;
                        yield ev.error(text);
                        // The run ends with the last attempt's own result (or this refusal when nothing ran).
                        if (attempt === 1) final = ev.result({ ok: false, text });
                        yield final;
                        break;
                    }
                    harnessId = decision.selected.split(':')[0];
                    if (attempt > 1) modelFor = null;      // the model named for the first agent is that agent's
                }
                tried.push(harnessId);
                const adapter = adapters[harnessId];
                const started = Date.now();
                const rec = { attempt, agent: harnessId, started_at: new Date(started).toISOString(), ok: false, session_id: null };
                attempts.push(rec);
                const tally = ev.createTally();
                const controller = new AbortController();
                if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
                current = adapter.start({ prompt: nextPrompt, cwd, model: modelFor, resume: attempt === 1 ? resume : null, permission, maxTurns, timeoutMs, signal: controller.signal }, { env, fetch: fetchImpl, sessions: store });
                let stalled = false;
                let res = null;
                let pending = null;           // the next() still in flight when the stall timer won the race
                while (true) {
                    let timer;
                    const quiet = new Promise((r) => { timer = setTimeout(() => r({ stalled: true }), stallMs); timer.unref?.(); });
                    if (!pending) pending = current.next();
                    const next = await Promise.race([pending, quiet]);
                    clearTimeout(timer);
                    if (next.stalled) { if (!stalled) { stalled = true; current.cancel(); controller.abort(); } continue; }
                    pending = null;
                    if (next.done) break;
                    const e = { ...next.value, _attempt: attempt, _agent: harnessId };
                    tally.add(next.value);
                    store.appendEvent(runId, e);
                    if (next.value.type === 'result') { res = next.value; continue; }
                    yield e;
                }
                const t = tally.get();
                rec.session_id = t.sessionId;
                rec.ok = !!(res && !res.is_error);
                rec.duration_ms = Date.now() - started;
                rec.cost_usd = res ? res.total_cost_usd : 0;
                if (stalled) {
                    const quietFor = stallMs >= 60_000 ? `${Math.round(stallMs / 60_000)} min` : `${Math.round(stallMs / 1000)} s`;
                    res = { ...(res || ev.result({ ok: false })), subtype: 'error', is_error: true, result: `went quiet for ${quietFor} and was stopped` };
                    rec.ok = false;
                }
                rec.error = rec.ok ? null : (res ? ev.clip(res.result, 300) : 'no result');
                final = res ? { ...res, _attempt: attempt, _agent: harnessId } : ev.result({ ok: false, text: 'the agent ended without a result' });
                if (rec.ok || !handoff || (signal && signal.aborted)) { yield final; break; }
                if (attempt >= maxAttempts) { yield final; break; }
                const why = rec.error || 'it failed';
                nextPrompt = handoffNote({ prompt, from: adapter.name, why, tally: t, cwd });
                const note = { type: 'system', subtype: 'handoff', from: harnessId, reason: why, attempt: attempt + 1 };
                store.appendEvent(runId, note);
                yield note;
            }
            store.saveRun(runId, summary());
        }());
        iterator.runId = runId;
        iterator.summary = summary;
        iterator.cancel = () => { if (current && current.cancel) current.cancel(); };
        return iterator;
    }

    return { agents, route, run, store, adapters };
}

module.exports = { createHarness, adaptersFor, availability, handoffNote, onPath };
