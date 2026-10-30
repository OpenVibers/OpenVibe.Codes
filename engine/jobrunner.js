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

    const result = {
        agent: adapter.id,
        ok: !!(st.events || []).some((e) => e.t === 'final' && !e.isError),
        sessionId: state.sessionId,
        model: st.model || opts.model || null,
        summary: ((st.events || []).find((e) => e.t === 'final') || {}).text || '',
        usage: state.usage,
        cost: state.cost,
        steps: state.steps,
        budgetHit: hit,
        wrapUp: wrap.action === 'wrap-up' ? wrap.prompt : null,
        log,
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
