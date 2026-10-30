'use strict';

/**
 * The chain of one task: what each attempt did, why it stopped, and what happens next.
 *
 * Everything here is pure. It takes the attempts (already read by the caller) and returns the outcome and the next
 * step; it never reads a log folder, a marker file or a process table. The portal's own folder stays its business, the
 * hosted runner can use the same code with its own store, and a test needs no disk at all.
 *
 * An attempt is:
 *
 *   key          its own id, unique ("cc:a", "mm:a-r2")
 *   runner       the harness that ran it ("cc", "mm", ...)
 *   name         its name in the chain ("a", "a-r2", "↻ a-r2")
 *   runnerName   the harness' own name, for the words a person reads
 *   status       queued | running | done | failed | stopped | interrupted | budget-stopped
 *   updated      when it last changed (ms)
 *   error        what it said when it failed
 *   next         the key of the attempt this one spawned (a retry)
 *   prev         the key of the attempt before it
 *   parent       the key of the attempt that carried this one on
 *   resolvedNote the owner's note ("marked as handled")
 *   stopped      true when it was stopped on purpose
 *   budget       { hit } — which limit it reached
 *   wrapUp       true when its wrap-up turn already ran
 *   facts        { exit, finalText, hasFinal, apiError, stopKind, session }
 *
 * The failure reasons are the portal's: limit (the plan ran out), auth (signed out), capacity (the model was busy),
 * refused (turned off), error (the work itself went wrong), budget (a limit of the owner's), stopped (someone ended
 * it on purpose) and crash (the process died without an answer).
 */

const { NO_RESULT } = require('./runerror');
const { stepUp, EFFORTS } = require('./effort');
const budget = require('./budget');

/** The runners the portal's chains are made of. */
const RUNNERS = /^(dsh|cx|cc|oc|pg|mm|cm)$/;

/** The reasons the runner switch owns: a limit, a lost sign-in, a busy model, a runner turned off. */
const SWITCHABLE = new Set(['limit', 'auth', 'capacity', 'refused']);

/** The reasons a job stopped, in words. */
const REASON_TEXT = {
    stopped: 'was cancelled before it finished',
    limit: 'hit its usage limit',
    auth: 'lost its sign-in',
    capacity: 'model was at capacity',
    refused: 'was turned off in the portal',
    error: 'stopped with an error',
    budget: 'stopped at its limit',
    unknown: 'stopped',
    crash: 'the process died without an answer',
    timeout: 'it ran out of time',
    incomplete: 'it stopped before the work was done',
    context: 'the context grew too big',
    hung: 'it went quiet for too long',
};

// A job that stopped for a reason the engine can fix by itself: the context is too big, the clock ran out, the agent
// said it was not done, the process died without an answer, or the log went quiet.
const CONTEXT_RE = /prompt is too long|context length|maximum context|context window|too many tokens|input too long|context_length_exceeded|exceeds the context|prompt exceeds/i;
const INCOMPLETE_RE = /i'?ll continue|ran out of|max(?:imum)? turns?|not finished|remaining steps|still (?:need|needs|to do|to finish)|more (?:work )?(?:to do|remains)|to be continued|incomplete/i;

/**
 * Why a run failed, from what it said.
 *
 * @param {string} text the error
 * @returns {string} limit | auth | capacity | refused | error | unknown
 */
function reason(text) {
    // Remove only the wrapper's speculative causes; retain any real diagnostic appended to it.
    const s = String(text || '').replace(NO_RESULT, 'Command Code ended without a result');
    if (!s) return 'unknown';
    if (/turned off in the agent portal|portal limit/i.test(s)) return 'refused';
    if (/usage limit|reached your [\w -]*limit|limit (exceeded|reached)|rate.?limit|quota|insufficient[ _]balance|insufficient_quota|plan_allowance_exhausted|out of credits|\b402\b|(?:HTTP(?: status)?|status(?: code)?|Request rejected)\s*[:=(]?\s*429\b/i.test(s)) return 'limit';
    if (/authenticat|log ?in again|run .?cmd login|\b401\b|api key (has )?expired|invalid api key|unauthori[sz]ed|not signed in/i.test(s)) return 'auth';
    if (/at capacity|overloaded|\b529\b|\b503\b|temporarily unavailable|server is busy/i.test(s)) return 'capacity';
    if (/mcode exec failed:.*Internal server error.*\(50[024]\)/i.test(s) || /(?:HTTP(?: status)?|status(?: code)?)\s*[:=]?\s*50[024]\b/i.test(s)) return 'capacity';
    return 'error';
}

/**
 * The job a name belongs to: "bench-7-finish", "bench7", "bench7-r2" and "bench7-c1" are one job.
 *
 * @param {string} name the attempt's name
 * @returns {string} the job's name
 */
function base(name) {
    let n = String(name || '').toLowerCase();
    for (let i = 0; i < 3; i++) n = n.replace(/[-_.](r\d+|c\d+|retry\d*|resume\d*|again|continued?|finish(ed)?|fix(es)?|followup|take\d+)$/, '');
    n = n.replace(/(\d)f$/, '$1');
    return n.replace(/[^a-z0-9]/g, '');
}

/**
 * The chain a job belongs to: the name without its attempt number ("x-r2", "x-c1" → "x"). The fence of a chain covers
 * every attempt of it.
 *
 * @param {string} name the attempt's name
 * @returns {string} the chain's root
 */
function chainRoot(name) {
    let n = String(name || '');
    for (let i = 0; i < 4; i++) {
        const m = n.match(/-(r\d+|c\d+)$/i);
        if (!m) break;
        n = n.slice(0, -m[0].length);
    }
    return n;
}

/**
 * Two names are one chain when one is the other plus a suffix: "x" and "x-b" (a renamed successor) are one job,
 * "seo-batch-a" and "seo-batch-b" are not.
 *
 * @param {string} a one name
 * @param {string} b the other
 * @returns {boolean} true when they are one chain
 */
function sameChain(a, b) {
    const x = chainRoot(a).toLowerCase(), y = chainRoot(b).toLowerCase();
    if (!x || !y) return false;
    return x === y || x.startsWith(y + '-') || y.startsWith(x + '-');
}

/** The attempt that carried each attempt on (the latest one wins). */
function carriedMap(runs, byKey) {
    const carried = new Map();
    for (const r of runs) if (r.parent && byKey.has(r.parent) && (!carried.has(r.parent) || carried.get(r.parent).updated < r.updated)) carried.set(r.parent, r);
    return carried;
}

/** The end of a chain: the run that ended it, and the runs it passed through. */
function settleChain(runs, byKey, carried, start) {
    let end = start, hops = 0;
    const trail = [start];
    while (hops++ < 12) {
        const c = carried.get(end.key);
        const n = end.next;
        const by = end.resolved && end.resolved.by;
        const step = c && c !== end ? c : n && byKey.has(n) && n !== end.key ? byKey.get(n) : by && byKey.has(by) && by !== end.key && by !== start.key ? byKey.get(by) : null;
        if (!step || trail.includes(step)) break;
        end = step;
        trail.push(end);
    }
    return { end, trail };
}

/**
 * The attempt that ended a chain, and the attempts it passed through.
 *
 * @param {object[]} attempts the attempts of the chain
 * @param {string|object} [start] the attempt to start from (the latest by default)
 * @returns {object|null} the attempt that ended the chain
 */
function settle(attempts, start) {
    const runs = annotate(attempts);
    if (!runs.length) return null;
    const from = (start && (start.key || start)) ? runs.find((r) => r.key === (start.key || start)) : null;
    const latest = runs.reduce((a, b) => (b.updated > a.updated ? b : a));
    const byKey = new Map(runs.map((r) => [r.key, r]));
    return settleChain(runs, byKey, carriedMap(runs, byKey), from || latest).end;
}

/**
 * The attempts of a chain, with the reason of each failure, what resolved it and the attempt number.
 *
 * @param {object[]} attempts the attempts
 * @returns {object[]} new attempts (the input is never changed)
 */
function annotate(attempts) {
    const runs = (attempts || []).map((a) => ({ ...a }));
    const byKey = new Map(runs.map((r) => [r.key, r]));
    const jobs = runs.filter((r) => RUNNERS.test(r.runner));
    const groups = new Map();
    for (const r of jobs) {
        const b = base(r.name);
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b).push(r);
    }
    // "crawl-candidates2" belongs with "crawl-candidates" when that job exists.
    for (const [b, list] of [...groups]) {
        const m = b.match(/^(.*[a-z])\d$/);
        if (m && groups.has(m[1])) { groups.get(m[1]).push(...list); groups.delete(b); }
    }
    // The chain of every job: the attempts of it ("x-r2", "x-c1") and its renamed successors ("x-b"). A renamed
    // successor belongs to the chain of the job it continues, even when the links between them are gone.
    const chains = new Map();
    for (const r of jobs) {
        const k = chainRoot(r.name).toLowerCase();
        if (!chains.has(k)) chains.set(k, []);
        chains.get(k).push(r);
    }
    const kinOf = (r) => {
        const k = chainRoot(r.name).toLowerCase(), out = [];
        for (const [root, list] of chains) if (root === k || root.startsWith(k + '-') || k.startsWith(root + '-')) out.push(...list);
        return out;
    };
    for (const r of jobs) {
        if (r.status === 'failed' || r.status === 'stopped' || r.status === 'interrupted') r.reason = r.status === 'failed' ? reason(r.error) : r.status === 'interrupted' ? 'crash' : 'stopped';
        if (r.status !== 'failed' && r.status !== 'stopped' && r.status !== 'interrupted') continue;
        // The owner stopped it on purpose (the portal, the budget or a human): it is not a failure to attend to.
        if (r.stopped) { r.resolved = { how: 'stopped', note: 'stopped on purpose' }; continue; }
        if (r.resolvedNote) { r.resolved = { how: 'note', note: r.resolvedNote }; continue; }
        // Follow explicit retry links to the end of the chain.
        let next = r.next, hops = 0, end = null;
        while (next && byKey.has(next) && hops++ < 8) { end = byKey.get(next); next = end.next; }
        if (!end) {
            const group = groups.get(base(r.name)) || [];
            const seen = new Set(group.map((s) => s.key));
            const kin = kinOf(r).filter((s) => !seen.has(s.key));
            const later = [...group, ...kin].filter((s) => s.key !== r.key && s.updated >= r.updated - 60000).sort((a, b) => b.updated - a.updated);
            end = later.find((s) => s.status === 'running' || s.status === 'queued') || later.find((s) => s.status === 'done') || later[0] || null;
        }
        if (end) {
            const how = end.status === 'done' ? 'done' : end.status === 'running' || end.status === 'queued' ? 'running' : 'failed';
            r.resolved = { how, by: end.key, byRunner: end.runnerName, note: how === 'done' ? `superseded by ${end.key}` : how === 'running' ? `taken over by ${end.key}` : `failed again as ${end.key}` };
            // The list says "finished by <name>" when there is one; the note keeps the key of the successor.
            if (how === 'done') r.resolved.byName = end.name;
        }
    }
    // Where each chain really ends (2026-10-29, the owner: a "✓ failed again as …" line, a run a later session
    // finished still called failed, a step-limit stop called a failure, and a page that said something else). A
    // successor is followed through its own retry link, through a session that carried it on (a portal "↻" continuation
    // names it as its parent) and through what resolved it, to the run that ended the chain. A step-limit stop with
    // nothing after it is unfinished work: it needs attention, like a failure.
    const carried = carriedMap(runs, byKey);
    // How a run in the path ended, in the words a person reads.
    const said = (x) => ({ done: 'finished', running: 'running', queued: 'queued', 'budget-stopped': 'stopped at its step limit', failed: 'failed', stopped: 'stopped', interrupted: 'crashed' })[x.status] || x.status;
    const trails = new WeakMap();   // the runs a chain passed through, kept off the runs (the list is sent as JSON)
    const settleFrom = (start) => {
        const t = settleChain(runs, byKey, carried, start);
        trails.set(t.end, t.trail);
        return t.end;
    };
    const ended = (r, end) => {
        const name = end.name;
        if (end.status === 'done') return { how: 'done', by: end.key, byName: name, byRunner: end.runnerName, note: `superseded by ${end.key}` };
        if (end.status === 'running' || end.status === 'queued') return { how: 'running', by: end.key, byName: name, byRunner: end.runnerName, note: `taken over by ${end.key}` };
        if (end.resolved && (end.resolved.how === 'note' || end.resolved.how === 'stopped')) return { how: 'note', by: end.key, byName: name, byRunner: end.runnerName, note: `carried on as ${name}: ${end.resolved.note}` };
        if (end.status === 'budget-stopped') return { how: 'budget', by: end.key, byName: name, byRunner: end.runnerName, note: `carried on as ${name}, which stopped at its step limit before it finished` };
        return { how: 'failed', by: end.key, byName: name, byRunner: end.runnerName, note: `tried again as ${name}, which failed too` };
    };
    const ending = (r, end) => ({ ...ended(r, end), path: [r, ...(trails.get(end) || [end]).filter((x) => x !== r)].map((x) => ({ key: x.key, name: x.name, state: said(x) })) });
    // The step-limit stops first (a handled note, then what carried them on), so a chain that ends in one reads it.
    const stops = runs.filter((r) => r.status === 'budget-stopped');
    for (const r of stops) {
        r.reason = 'budget';
        if (r.resolvedNote) r.resolved = { how: 'note', note: r.resolvedNote };
    }
    for (const r of stops) {
        if (r.resolved) continue;
        const end = settleFrom(r);
        if (end !== r) r.resolved = ending(r, end);
    }
    for (const r of runs) {
        if (r.status === 'budget-stopped' || !r.resolved || !r.resolved.by || !byKey.has(r.resolved.by)) continue;
        r.resolved = ending(r, settleFrom(byKey.get(r.resolved.by)));
    }
    // A handled note that names the job the work went to ("being integrated by mm:x") is followed to where that job
    // ended, so the line says whether the work was done, not only that someone wrote a note.
    const named = (note) => (String(note || '').match(/\b(?:dsh|cx|cc|oc|pg|mm|cm|cd):[A-Za-z0-9._-]*[A-Za-z0-9]/g) || []).find((k) => byKey.has(k));
    for (const r of runs) {
        const res = r.resolved;
        if (!res || res.how !== 'note') continue;
        const k = res.by ? named(byKey.get(res.by) && byKey.get(res.by).resolved && byKey.get(res.by).resolved.note) || named(res.note) : named(res.note);
        if (!k || k === r.key) continue;
        const end = settleFrom(byKey.get(k));
        if (end.status !== 'done' && end.status !== 'running' && end.status !== 'queued') continue;
        r.resolved = { ...ending(r, end), said: res.note };
        // The run whose note named it stays in the path ("a → a-r2 (stopped at its step limit) → integrate …").
        const via = res.by && byKey.get(res.by);
        if (via && !r.resolved.path.some((h) => h.key === via.key)) r.resolved.path.splice(1, 0, { key: via.key, name: via.name, state: said(via) });
    }
    // Attempt numbers along each chain (for "attempt 3").
    for (const r of jobs) {
        let n = 1, p = r.prev, hops = 0;
        while (p && byKey.has(p) && hops++ < 8) { n++; p = byKey.get(p).prev; }
        if (n > 1) r.attempt = n;
    }
    return runs;
}

/**
 * The next runner (and model) for a failed job, or null when nothing fits right now.
 *
 * @param {object} run the failed attempt
 * @param {object} ctx
 * @param {object} ctx.cfg the config (subagents per runner, fallback.order)
 * @param {object} ctx.health the health of each runner
 * @param {object} ctx.counts how many jobs each runner runs now
 * @param {object} ctx.models the catalogs of each runner
 * @param {string[]} ctx.runners every runner
 * @param {string} [ctx.tier] the tier of the job
 * @returns {{runner: string, model: string|null, why: string}|null} the next runner
 */
function nextRunner(run, { cfg, health, counts, models, runners, tier } = {}) {
    const why = run.reason;
    // A stop is not a failure: someone ended that run on purpose (a kill, a duplicate taken over), so a second runner
    // would only redo the work (2026-10-29: a stopped cc pin job was queued again on cm, and the mm duplicate with it).
    if (why === 'stopped') return null;
    // Phoenix Grove's Taster allowance is tiny: it takes only light jobs.
    const usable = (k) => (k !== 'pg' || tier === 'basic') && runners.includes(k) && cfg.subagents[k] && cfg.subagents[k].enabled && (counts[k] || 0) < cfg.subagents[k].max
        && health[k] && (health[k].state === 'ok');
    // A real error: a second opinion — the next runner in the order (not the same one), with the error in the brief.
    if (why === 'error') {
        const order = (cfg.fallback.order || []).filter((k) => runners.includes(k) && k !== run.runner);
        const k = order.find((x) => usable(x));
        return k ? { runner: k, model: cfg.subagents[k].model || null, why: `${run.runnerName} stopped with an error; a second try on another runner` } : null;
    }
    if (why === 'capacity' && models[run.runner] && cfg.subagents[run.runner] && cfg.subagents[run.runner].enabled) {
        const list = models[run.runner];
        const cur = run.model && list.indexOf(run.model);
        const other = list.find((m, i) => i > (cur >= 0 ? cur : 0) && m !== run.model);
        if (other) return { runner: run.runner, model: other, why: `${run.model || 'its model'} was at capacity` };
    }
    const order = (cfg.fallback.order || []).filter((k) => runners.includes(k));
    const start = order.indexOf(run.runner);
    const rotated = start >= 0 ? order.slice(start + 1).concat(order.slice(0, start)) : order;
    for (const k of rotated) {
        if (k === run.runner) continue;
        if (usable(k)) return { runner: k, model: cfg.subagents[k].model || null, why: `${run.runnerName} ${REASON_TEXT[why] || 'stopped'}` };
    }
    return null;
}

/**
 * The note a continued attempt gets: what the earlier attempt did and where it stopped.
 *
 * @param {object} run the earlier attempt
 * @param {string} logFile where its log is
 * @returns {string} the note
 */
function continuationNote(run, logFile) {
    return `\n\n---\n## Continuation (written by the agent portal)\n\nAn earlier attempt at this job ran on **${run.runnerName}** and ${REASON_TEXT[run.reason] || 'stopped'}${run.error ? `: "${String(run.error).slice(0, 200)}"` : ''}. Its log is ${logFile}.\nBefore anything else, look at the folder's current state (\`git status\`, \`git diff\`, \`git log -3\`) and the end of that log: keep the work it finished, do not redo it, and continue from where it stopped. If the job is already complete, check it and report that.\n`;
}

/**
 * The facts of an attempt, from what its transcript holds.
 *
 * @param {object} attempt the attempt
 * @param {object[]} [events] the transcript's events
 * @returns {object} { exit, finalText, hasFinal, apiError, stopKind, session }
 */
function facts(attempt = {}, events = null) {
    const f = { ...(attempt.facts || {}) };
    const list = events || f.events || [];
    let finalText = f.finalText || '', hasFinal = f.hasFinal || false, apiError = f.apiError || '';
    for (const e of list) {
        if (e.t === 'final') { hasFinal = true; if (e.text) finalText = e.text; if (e.isError && e.text && !apiError) apiError = e.text; }
        else if (e.t === 'error' && !apiError) apiError = String(e.text || '');
    }
    if (!apiError && attempt.error) apiError = String(attempt.error);
    return {
        exit: f.exit == null ? null : f.exit,
        finalText,
        hasFinal,
        apiError,
        stopKind: f.stopKind || '',
        session: f.session || null,
        usage: f.usage || null,
    };
}

/**
 * Why an attempt stopped, or null when nothing is to be done about it.
 *
 * The order matters: a context error explains the stop even when there is an API error on top of it, and a limit, a
 * lost sign-in or a busy model belong to the runner switch, not to a continue on the same runner.
 *
 * @param {object} attempt the attempt, with its facts
 * @returns {{reason: string, facts: object}|null} why it stopped
 */
function detect(attempt = {}) {
    // An attempt that finished is never continued.
    if (attempt.status === 'done') return null;
    const f = facts(attempt);
    if (CONTEXT_RE.test(f.apiError || '') || CONTEXT_RE.test(f.finalText || '')) return { reason: 'context', facts: f };
    // An attempt that was interrupted (killed, or a service restart) is a crash: its session can be resumed.
    if (attempt.status === 'interrupted') return { reason: 'crash', facts: f };
    const why = f.apiError ? reason(f.apiError) : 'error';
    if (SWITCHABLE.has(why)) return null;
    if (f.exit === 124) return { reason: 'timeout', facts: f };
    if (f.exit === 8) return { reason: 'incomplete', facts: f };
    if (/max_?tokens|length/i.test(f.stopKind || '')) return { reason: 'incomplete', facts: f };
    if (f.hasFinal && INCOMPLETE_RE.test(f.finalText)) return { reason: 'incomplete', facts: f };
    if (!f.hasFinal && !f.apiError) return { reason: 'crash', facts: f };
    return null;
}

/**
 * The next step of a chain: what should happen to the task now.
 *
 * @param {object[]} attempts the attempts (annotated or not)
 * @param {object} [opts] what the caller knows: { cfg, health, counts, models, runners, tier }
 * @returns {object} { action, why, … } — action is one of wait, done, switch, continue, restart, wrap-up, stop, failed
 */
function nextStep(attempts, opts = {}) {
    const runs = annotate(attempts);
    if (!runs.length) return { action: 'none', why: 'there are no attempts' };
    const end = chainEnd(runs);
    return step(runs, end, opts);
}

/** The end of a chain: its latest attempt, followed to whatever ended it. */
function chainEnd(runs) {
    if (!runs.length) return null;
    const latest = runs.reduce((a, b) => (b.updated > a.updated ? b : a));
    const byKey = new Map(runs.map((r) => [r.key, r]));
    return settleChain(runs, byKey, carriedMap(runs, byKey), latest).end;
}

/** The next step, given the chain's end. */
function step(runs, end, opts = {}) {
    if (!end) return { action: 'none', why: 'there are no attempts' };
    if (end.status === 'running' || end.status === 'queued') return { action: 'wait', why: 'the task is still running' };
    if (end.status === 'done') return { action: 'done', why: 'the task finished' };
    const why = end.reason || reason(end.error);
    if (why === 'stopped') return { action: 'stop', why: 'the task was stopped on purpose' };
    if (why === 'budget') {
        const hit = (end.budget && end.budget.hit) || 'steps';
        const wrap = budget.wrapUp(hit, { done: !!end.wrapUp });
        return { action: wrap.action, hit, prompt: wrap.prompt, why: wrap.why };
    }
    // The same session continues the task when it stopped early (crash, timeout, incomplete, hung); a context that
    // grew too big starts fresh with a compacted brief instead. This comes before the runner switch: a context that
    // overflowed is not a worker's fault, and another runner would hit the same wall.
    const hit = end.hung ? { reason: 'hung', facts: facts(end) } : detect(end);
    if (hit) {
        if (hit.reason === 'context') return { action: 'restart', why: 'the context grew too big: a fresh session with a compacted brief' };
        const session = hit.facts.session;
        if (!session) return { action: 'failed', why: `the task stopped (${hit.reason}) and there is no session to continue` };
        return { action: 'continue', session, why: `the task stopped (${hit.reason}): continue it in the same session` };
    }
    // The runner switch: a limit, a lost sign-in, a busy model, a runner turned off, or a real error (a second
    // opinion). A job retried three times is left to the owner.
    if (SWITCHABLE.has(why) || why === 'error') {
        const tries = end.attempt || 1;
        const max = why === 'error' ? 2 : 4;
        if (tries >= max) return { action: 'failed', why: `the task was already retried ${tries} times; the owner must decide` };
        const choice = nextRunner(end, opts);
        if (!choice) return { action: 'failed', why: `no other runner can take it now (${why})` };
        const out = { action: 'switch', runner: choice.runner, model: choice.model, why: choice.why };
        // A real error is retried one reasoning level up: the same attempt again rarely helps.
        if (why === 'error') {
            const up = stepUp(end.effort, EFFORTS[choice.runner]);
            if (up) out.effort = up;
        }
        return out;
    }
    return { action: 'failed', why: 'the task failed' };
}

/**
 * The outcome of a task and the next step: the whole chain, in one call.
 *
 * @param {object[]} attempts the attempts of the task
 * @param {object} [opts] what the caller knows: { cfg, health, counts, models, runners, tier }
 * @returns {{state: string, reason: string|null, resolved: object|null, attempt: number, path: object[], end: object, step: object, attempts: object[]}}
 */
function outcome(attempts, opts = {}) {
    const runs = annotate(attempts);
    const end = chainEnd(runs);
    const state = !end ? 'none' : end.status === 'done' ? 'done' : end.status === 'budget-stopped' ? 'budget-stopped'
        : end.status === 'failed' || end.status === 'interrupted' ? 'failed' : end.status;
    return {
        state,
        reason: end ? (end.reason || null) : null,
        resolved: end ? (end.resolved || null) : null,
        attempt: end ? (end.attempt || 1) : 0,
        path: (end && end.resolved && end.resolved.path) || [],
        end: end ? { key: end.key, runner: end.runner, name: end.name, status: end.status } : null,
        step: step(runs, end, opts),
        attempts: runs,
    };
}

module.exports = {
    RUNNERS, SWITCHABLE, REASON_TEXT,
    reason, base, chainRoot, sameChain,
    annotate, settle, nextRunner, continuationNote,
    facts, detect, nextStep, outcome,
};
