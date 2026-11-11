'use strict';

/**
 * The job runner: one attempt of one harness, the way the portal runs one.
 *
 * The portal's runner scripts (cc-run.sh, cx-run.sh, cm-run.sh, mm-run.sh, oc-run.sh) do the same four things, and this
 * does them too:
 *
 *   1. the prompt is assembled (engine/prompt.js): the git rule, the house rules, the lessons, the repo digest, the brief;
 *   2. the harness is started with its own argv and environment (engine/adapters/);
 *   3. what it prints goes through the transcript normaliser (engine/transcript.js) into job lines (engine/joblines.js);
 *   4. when the budget is reached the work is landed in one wrap-up turn (engine/budget.js), and the session is kept so a
 *      continue picks the same conversation up.
 *
 * The runner writes the harness's feed to a file and parses it incrementally, so a live page costs one parse of the
 * bytes that arrived, not one of the whole log.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { adapterFor } = require('./adapters');
const { assemble } = require('./prompt');
const transcript = require('./transcript');
const joblines = require('./joblines');
const budget = require('./budget');
const ledger = require('./ledger');

/** The wall clock when the task sets none: no limit, like every other unset limit. */
const DEFAULT_TIMEOUT_MS = 0;

/**
 * Run one attempt.
 *
 * @param {object} opts
 * @param {string} opts.agent the harness (claude-code, codex, command-code, opencode, minimax-code, claude-other)
 * @param {string} opts.prompt the brief
 * @param {string} opts.cwd the folder the job works in
 * @param {string} [opts.model] the model
 * @param {string} [opts.effort] the wanted reasoning level (fitted to the harness)
 * @param {string} [opts.permission] 'read' | 'edit' | 'full'
 * @param {string} [opts.resume] the session to continue
 * @param {object} [opts.budget] the limits ({ steps, minutes, usd }); null means no limit
 * @param {object[]} [opts.ledger] the caller's per-turn ledger (engine/ledger.js); this attempt appends to it
 * @param {string} [opts.trigger] what triggered this attempt (ledger entry)
 * @param {string} [opts.parent] the parent turn when delegated (ledger entry)
 * @param {boolean} [opts.ledgerWarned] the cap warning already went out (threaded back as result.ledgerWarned)
 * @param {boolean} [opts.know] this machine has the shared Know MCP server (Claude Code gets mcp__ov_know)
 * @param {string} [opts.claudeConfig] the Claude Code config to read for that check
 * @param {string} [opts.knowLessons] the Know store's module (know/lessons.js) for the prompt's lessons
 * @param {string} [opts.log] the file the feed is written to
 * @param {function} [opts.onLine] every job line
 * @param {AbortSignal} [opts.signal] stops the attempt
 * @returns {Promise<object>} the attempt's result
 */
async function runAttempt(opts = {}) {
    const adapter = adapterFor(opts.agent);
    if (!adapter) throw new Error(`no adapter for ${opts.agent}`);
    const onLine = opts.onLine || (() => {});
    const cwd = opts.cwd || process.cwd();
    const log = opts.log || path.join(os.tmpdir(), `openvibe-codes-${process.pid}-${Date.now()}.jsonl`);
    const dir = path.dirname(log);
    fs.mkdirSync(dir, { recursive: true });

    // The prompt: the rules, the house rules, the lessons, the repo digest, then the brief.
    const prompt = opts.systemPrompt === false
        ? { text: String(opts.prompt || ''), parts: [{ name: 'brief', text: String(opts.prompt || '') }] }
        : assemble({ brief: opts.prompt, dir: cwd, env: opts.env || process.env, know: opts.knowLessons });
    const rulesFile = opts.rulesFile !== null ? path.join(dir, 'rules.md') : null;
    if (rulesFile) fs.writeFileSync(rulesFile, prompt.parts.filter((p) => p.name !== 'brief').map((p) => p.text).join('\n\n'));

    // The permission rules go in the project, the portal's way (they survive --yolo).
    if (adapter.writeSettings) {
        try { adapter.writeSettings(cwd, { permission: opts.permission || 'edit' }); } catch { /* the job may not write there */ }
    }

    // The task's limits (Settings → Limits) set the harness's own caps too: its turn cap sits 25 above the step limit
    // and its wall clock 5 minutes past the time limit, or there is neither (engine/budget.js caps()). Passing them to
    // the builder and the process keeps Command Code, Claude Code and MiniMax Code from their old hard-coded 150/200.
    const limits = budget.limitsFor({ budget: opts.budget || {} }, opts.agent, opts.budgetOverride);
    const caps = budget.caps(limits);
    // The per-turn ledger and the pre-call gate (engine/ledger.js): the caller's turns ride in on opts.ledger, the
    // gate refuses at the cap with a 409 instead of running, and this attempt's spending is appended after the run.
    const turns = Array.isArray(opts.ledger) ? opts.ledger : [];
    const gate = ledger.preCall(turns, { turns: limits.steps, usd: limits.usd }, { warned: !!opts.ledgerWarned });
    if (!gate.allowed) {
        return {
            agent: adapter.id, ok: false, sessionId: opts.resume || null, model: opts.model || null,
            summary: gate.message, promptLayers: prompt.parts,
            refused: { status: gate.status, code: 'budget.capped', hit: gate.hit, message: gate.message },
            usage: { input: 0, output: 0, cached: 0 }, cost: null, steps: 0,
            budgetHit: gate.hit, wrapUp: null, log,
            ledger: turns, ledgerWarned: gate.warned, ledgerWarning: gate.warning || null,
        };
    }
    const built = adapter.build({
        prompt: prompt.text,
        model: opts.model,
        effort: opts.effort,
        resume: opts.resume,
        permission: opts.permission,
        maxTurns: opts.maxTurns != null ? opts.maxTurns : caps.maxTurns,
        maxSteps: opts.maxSteps != null ? opts.maxSteps : (opts.maxTurns != null ? opts.maxTurns : caps.maxTurns),
        timeout: caps.timeout,
        know: opts.know,
        claudeConfig: opts.claudeConfig,
        cwd,
        rules: rulesFile,
        provider: opts.provider,
        title: opts.title,
        out: opts.out,
    });

    const started = Date.now();
    const state = { from: 0, sessionId: opts.resume || null, usage: null, cost: null, steps: 0, done: false };

    const feed = adapter.feed({
        model: opts.model || null,
        onEvent: (event) => {
            fs.appendFileSync(log, JSON.stringify(event) + '\n');
        },
    });

    // The transcript normaliser reads the feed; the job lines are what came out of it.
    const pump = () => {
        const st = transcript.parse(log);
        const { lines, next } = joblines.lines(st, state.from);
        state.from = next;
        state.sessionId = st.session || feed.state.sessionId || state.sessionId;
        state.usage = st.usage;
        state.cost = st.cost;
        for (const l of lines) {
            if (l.t === 'tool') state.steps++;
            onLine(l);
        }
        return st;
    };

    const { runCli } = require('./adapters/base');
    const run = runCli({
        cmd: built.cmd,
        argv: built.argv,
        cwd,
        // The adapter's own environment (the provider's, the effort), then the job's (the PATH with the CLI on it).
        env: { ...(opts.env || {}), ...built.env },
        stdin: built.stdin,
        timeoutMs: opts.timeoutMs != null ? opts.timeoutMs : caps.timeoutMs,
        signal: opts.signal,
        onLine: (raw) => { feed.line(raw); pump(); },
        onEnd: () => { feed.end(); },
    });

    await run.done;
    const st = pump();

    // The budget: the steps or the minutes ran out, the work is landed in one wrap-up turn.
    const used = { steps: state.steps, minutes: (Date.now() - started) / 60000, usd: state.cost };
    const hit = budget.evaluate(used, limits).hit;
    const wrap = budget.wrapUp(hit, { done: false });

    const ok = !!(st.events || []).some((e) => e.t === 'final' && !e.isError);
    // This attempt's spending joins the caller's ledger: engine and model, effort, tokens with cached called out,
    // cost where the transcript priced it, what triggered it, the parent when delegated, how it ended.
    const u = state.usage || {};
    ledger.add(turns, {
        engine: adapter.id, model: st.model || opts.model || null, effort: opts.effort || null,
        inputTokens: u.input != null ? Number(u.input) : null,
        outputTokens: u.output != null ? Number(u.output) : null,
        cachedTokens: u.cached != null ? Number(u.cached) : null,
        costUsd: state.cost != null ? Number(state.cost) : null,
        costSource: state.cost != null ? 'transcript' : null,
        trigger: opts.trigger || 'attempt', parent: opts.parent || null, outcome: ok ? 'ok' : 'error',
    });
    const result = {
        agent: adapter.id,
        ok,
        sessionId: state.sessionId,
        model: st.model || opts.model || null,
        summary: ((st.events || []).find((e) => e.t === 'final') || {}).text || '',
        // Preserve the exact, inspectable prompt composition with the run result for later review.
        promptLayers: prompt.parts,
        usage: state.usage,
        cost: state.cost,
        steps: state.steps,
        budgetHit: hit,
        wrapUp: wrap.action === 'wrap-up' ? wrap.prompt : null,
        log,
        ledger: turns,
        ledgerSummary: ledger.summarize(turns),
        ledgerWarned: gate.warned,
        ledgerWarning: gate.warning || null,
    };

    // The wrap-up turn: the same session, one last turn that lands the work.
    if (wrap.action === 'wrap-up' && result.sessionId && !opts.signal) {
        const wrapLog = log.replace(/\.jsonl$/, '.wrapup.jsonl');
        const again = await runAttempt({
            ...opts,
            prompt: wrap.prompt,
            resume: result.sessionId,
            log: wrapLog,
            budget: { steps: null, minutes: null, usd: null },
            onLine,
        });
        result.wrapUpResult = again;
        result.ok = again.ok || result.ok;
        result.sessionId = again.sessionId || result.sessionId;
        result.summary = again.summary || result.summary;
        result.log = again.log;
    }

    return result;
}

module.exports = { runAttempt, DEFAULT_TIMEOUT_MS };
