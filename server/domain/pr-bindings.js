'use strict';

/**
 * A ticket follows its pull request (AL5).
 *
 * A binding is one row per ticket (task): the repo, the PR number, the role this ticket plays there
 * (review|verify|fix) and how the PR was found (created|worktree|review). A red check, a merge conflict or
 * a review comment on the PR wakes the SAME worker: a follow-up Run job on the PR branch, with the failing
 * evidence in its prompt. At most 3 automatic fixes per PR; a person's "stop" ends the binding; a merged or
 * closed PR ends it too. A bot's comment or a CI result never wakes an ended binding; a person's comment can
 * (it re-opens the binding and wakes it once). The worker never merges its own PR: a follow-up pushes the
 * same branch again (push.update, never a force push) and opens no new pull request; the harness has no merge
 * step at all.
 *
 * No polling: GitHub webhooks arrive through OpenVibe.Events (server/github.js there) as github.* envelopes,
 * delivered to Codes' /internal/events consumer, which calls handleGithubEvent here. The binding follows the
 * newest task: after a follow-up starts, the binding's task_id moves to it, so the next wake carries the same
 * ticket forward. Every bind, follow-up and end also writes a codes.pr.* outbox row (bound|followup|ended),
 * so the portal can show the ticket without reading this table.
 *
 * The switch is default-off: with CODES_PR_FOLLOW_ENABLED unset, red checks are recorded (ignored:
 * follow_disabled) and no follow-up starts.
 *
 *   const bindings = createPrBindings({ store, tasks, outbox, config, log });
 *   await bindings.maybeBind(taskRow);            // after a task ends with a PR: idempotent, in-tx safe
 *   await bindings.handleGithubEvent(envelope);   // → { outcome, task_ids, followed_up }
 */
const { parseArgs } = require('../../harness/job');

const ROLES = new Set(['review', 'verify', 'fix']);
const MAX_FIXES_PER_PR = 3;
/** Check conclusions that wake a verify|fix binding (a cancelled run is usually superseded, not broken). */
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);
/** A person's comment with this first word ends the binding instead of waking it. */
const STOP_RE = /^\s*stop\b/i;
const MAX_PROMPT = 16000;
const MAX_BODY = 4000;

const slug = (v) => (typeof v === 'string' ? v.toLowerCase() : null);
const num = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

/** owner/name and the PR number of a github.com pull URL, or null. */
function parsePrUrl(url) {
    if (typeof url !== 'string') return null;
    const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:\/|$)/.exec(url.trim());
    if (!m) return null;
    return { repo: `${m[1]}/${m[2]}`.toLowerCase(), number: Number(m[3]) };
}

function createPrBindings({ store, tasks, outbox = null, config = {}, log = console } = {}) {
    if (!store) throw new TypeError('pr-bindings need a store');
    const db = store.db;
    const enabled = Boolean(config.prFollow && config.prFollow.enabled);

    const emit = async (topic, subject, payload) => {
        if (!outbox || typeof outbox.emitPr !== 'function' || !subject) return null;
        try { return await outbox.emitPr(topic, subject, payload); } catch (e) { log.warn(`[Codes] pr-bindings outbox: ${e.message}`); return null; }
    };

    /**
     * Bind a finished task to the PR its result pushed (role fix, found when created). Idempotent: a task
     * binds its PR once. Uses the ambient transaction when called from run-tasks' recordState.
     */
    async function maybeBind(row) {
        if (!row || !row.id || !row.result) return null;
        let result = row.result;
        if (typeof result === 'string') { try { result = JSON.parse(result); } catch { return null; } }
        const push = result && typeof result.push === 'object' ? result.push : null;
        if (!push || push.pushed !== true || typeof push.pull_request !== 'string') return null;
        const pr = parsePrUrl(push.pull_request);
        if (!pr) return null;
        const branch = str(push.branch, 200);
        const seen = await db.maybe(
            'SELECT id FROM pr_bindings WHERE task_id = $1 AND repo = $2 AND pr_number = $3 AND state = $4',
            [row.id, pr.repo, pr.number, 'active'],
        );
        if (seen) return seen;
        const now = store.now();
        const bound = await db.one(
            `INSERT INTO pr_bindings (id, task_id, repo, pr_number, role, how_found, branch, state, fix_count, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'fix', 'created', $5, 'active', 0, $6, $6) RETURNING *`,
            [store.newId('prb'), row.id, pr.repo, pr.number, branch, now],
        );
        await emit('codes.pr.bound',
            row.subject, { task_id: row.id, repo: pr.repo, pr_number: pr.number, role: 'fix', branch });
        return bound;
    }

    const forPr = (repo, number, { activeOnly = false } = {}) => db.many(
        `SELECT * FROM pr_bindings WHERE repo = $1 AND pr_number = $2${activeOnly ? ` AND state = 'active'` : ''} ORDER BY created_at ASC`,
        [repo, number],
    );

    async function endAll(rows, reason) {
        for (const b of rows) {
            if (b.state === 'ended') continue;
            await db.exec(`UPDATE pr_bindings SET state = 'ended', ended_reason = $2, updated_at = $3 WHERE id = $1`,
                [b.id, reason, store.now()]);
            const owner = await db.maybe('SELECT subject FROM run_tasks WHERE id = $1', [b.task_id]);
            await emit('codes.pr.ended', owner && owner.subject,
                { task_id: b.task_id, repo: b.repo, pr_number: b.pr_number, reason });
        }
    }

    const fixesForPr = async (repo, number) => {
        const r = await db.maybe('SELECT COALESCE(SUM(fix_count), 0) AS n FROM pr_bindings WHERE repo = $1 AND pr_number = $2', [repo, number]);
        return Number((r && r.n) || 0);
    };

    /** The follow-up prompt: the failing evidence first, the original task after, the no-merge rule in both. */
    function followupPrompt({ binding, parent, evidence, fixN }) {
        const head = `Automatic follow-up ${fixN} of ${MAX_FIXES_PER_PR} for ${binding.repo} pull request #${binding.pr_number} (ticket task ${parent.id}).\n\nEvidence from the PR:\n${evidence}\n\nThe branch is ${binding.branch || '(the PR branch)'}: check it out, fix it there, and push the same branch again — no new branch, no new pull request, and never merge anything yourself.`;
        const tail = `\n\nThe original task was:\n${typeof parent.prompt === 'string' ? parent.prompt : ''}`;
        return (head + tail).slice(0, MAX_PROMPT);
    }

    /**
     * Start one follow-up Run job for the binding's ticket: same repo, the PR branch checked out and pushed
     * again (update, non-force), no new PR. The binding moves to the new task. Throws when Run refuses.
     */
    async function startFollowup(binding, evidence) {
        const parent = await db.maybe('SELECT * FROM run_tasks WHERE id = $1', [binding.task_id]);
        if (!parent) throw new Error(`ticket task ${binding.task_id} is gone`);
        if (!binding.branch) throw new Error('the binding names no branch to push again');
        const fixes = await fixesForPr(binding.repo, binding.pr_number);
        const prompt = followupPrompt({ binding, parent, evidence, fixN: fixes + 1 });
        const args = parseArgs(JSON.stringify({
            repo: parent.repo, ref: binding.branch, prompt, agent: parent.agent || null,
            push: { branch: binding.branch, pull_request: false, update: true },
        }));
        let actorRef = null;
        if (parent.actor_ref) { try { const p = typeof parent.actor_ref === 'string' ? JSON.parse(parent.actor_ref) : parent.actor_ref; if (p && typeof p === 'object') actorRef = p; } catch { actorRef = null; } }
        // The follow-up belongs to the same ticket on the same machine: the pin travels with it.
        const task = await tasks.start({ subject: parent.subject, project: parent.project_id, args, via: parent.via, key: null, actorRef, pin: parent.pin || null });
        await db.exec(`UPDATE pr_bindings SET task_id = $2, fix_count = fix_count + 1, last_wake_at = $3, last_wake_reason = $4, updated_at = $3 WHERE id = $1`,
            [binding.id, task.id, store.now(), evidence.slice(0, 120)]);
        await emit('codes.pr.followup', parent.subject,
            { task_id: task.id, parent_task_id: parent.id, repo: binding.repo, pr_number: binding.pr_number, fix_n: fixes + 1 });
        return task;
    }

    /** One wake across the PR's active bindings of the given roles. → { started, skipped } of task ids. */
    async function wake(rows, { roles, evidence, reason, eventId }) {
        const started = [];
        const skipped = [];
        if (!enabled) return { started, skipped, disabled: true };
        if (await fixesForPr(rows[0].repo, rows[0].pr_number) >= MAX_FIXES_PER_PR) return { started, skipped, capped: true };
        for (const b of rows) {
            if (!roles.has(b.role)) { skipped.push(b.task_id); continue; }
            const current = await db.maybe('SELECT id, state FROM run_tasks WHERE id = $1', [b.task_id]);
            if (current && !['succeeded', 'failed', 'cancelled', 'expired'].includes(current.state)) { skipped.push(b.task_id); continue; }
            try {
                const task = await startFollowup(b, evidence);
                started.push(task.id);
                log.info(`[Codes] pr-follow ${b.repo}#${b.pr_number} woke ${task.id} (${reason}, ${eventId})`);
            } catch (e) {
                log.warn(`[Codes] pr-follow ${b.repo}#${b.pr_number} failed to wake: ${e.message}`);
                skipped.push(b.task_id);
            }
        }
        return { started, skipped };
    }

    /**
     * A github.* envelope (already inbox-deduped by the consumer). → { outcome, task_ids, followed_up }.
     * outcome is what the consumer records: woke, stopped, reopened, ended:<reason>, ignored:<why>.
     */
    async function handleGithubEvent(event) {
        if (!event || typeof event.event_type !== 'string') return { outcome: 'ignored:payload', task_ids: [], followed_up: [] };
        const subject = event.subject && typeof event.subject === 'object' ? event.subject : null;
        const m = subject && typeof subject.id === 'string' ? /^([a-z0-9-]+(?:\/[a-z0-9._-]+))#(\d+)$/.exec(subject.id) : null;
        if (!m) return { outcome: 'ignored:payload', task_ids: [], followed_up: [] };
        const repo = m[1];
        const number = Number(m[2]);
        const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
        // The subject is the routing key (a check fans out one envelope per PR, so its payload names no number);
        // a payload that names another repo or PR is not ours.
        if (payload.repo !== undefined && slug(payload.repo) !== repo) return { outcome: 'ignored:payload', task_ids: [], followed_up: [] };
        if (payload.pr_number !== undefined && num(payload.pr_number) !== number) return { outcome: 'ignored:payload', task_ids: [], followed_up: [] };
        const rows = await forPr(repo, number);
        if (!rows.length) return { outcome: 'ignored:no_binding', task_ids: [], followed_up: [] };
        const active = rows.filter((b) => b.state === 'active');
        const isPerson = payload.author_type === 'User';

        if (event.event_type === 'github.check.completed') {
            if (!RED_CONCLUSIONS.has(payload.conclusion)) return { outcome: 'ignored:green', task_ids: rows.map((b) => b.task_id), followed_up: [] };
            if (!active.length) return { outcome: 'ignored:ended', task_ids: rows.map((b) => b.task_id), followed_up: [] };
            const evidence = `check "${payload.check_name || 'ci'}" concluded "${payload.conclusion}"`
                + `${payload.html_url ? ` (${payload.html_url})` : ''}${payload.head_sha ? ` at ${String(payload.head_sha).slice(0, 12)}` : ''}`
                + ` — find why it failed and fix the branch.`;
            const r = await wake(active, { roles: new Set(['verify', 'fix']), evidence, reason: 'red-check', eventId: event.event_id });
            if (r.disabled) return { outcome: 'ignored:follow_disabled', task_ids: active.map((b) => b.task_id), followed_up: [] };
            if (r.capped) return { outcome: 'ignored:max_fixes', task_ids: active.map((b) => b.task_id), followed_up: [] };
            return { outcome: r.started.length ? 'woke' : 'ignored:fix_running', task_ids: active.map((b) => b.task_id), followed_up: r.started };
        }

        if (event.event_type === 'github.pr.updated') {
            if (payload.action === 'closed') {
                const reason = payload.merged === true ? 'merged' : 'closed';
                await endAll(rows, reason);
                return { outcome: `ended:${reason}`, task_ids: rows.map((b) => b.task_id), followed_up: [] };
            }
            if (payload.mergeable_state === 'dirty') {
                if (!active.length) return { outcome: 'ignored:ended', task_ids: rows.map((b) => b.task_id), followed_up: [] };
                const evidence = `the pull request reports mergeable_state "dirty"${payload.html_url ? ` (${payload.html_url})` : ''}`
                    + ` — fetch the base, list the conflicted files, resolve them on the branch, and push it again.`;
                const r = await wake(active, { roles: new Set(['fix']), evidence, reason: 'conflict', eventId: event.event_id });
                if (r.disabled) return { outcome: 'ignored:follow_disabled', task_ids: active.map((b) => b.task_id), followed_up: [] };
                if (r.capped) return { outcome: 'ignored:max_fixes', task_ids: active.map((b) => b.task_id), followed_up: [] };
                return { outcome: r.started.length ? 'woke' : 'ignored:fix_running', task_ids: active.map((b) => b.task_id), followed_up: r.started };
            }
            return { outcome: 'ignored:no_conflict', task_ids: rows.map((b) => b.task_id), followed_up: [] };
        }

        if (event.event_type === 'github.pr.commented') {
            const body = str(payload.body, MAX_BODY) || '';
            if (STOP_RE.test(body) && isPerson) {
                if (!active.length) return { outcome: 'ignored:ended', task_ids: rows.map((b) => b.task_id), followed_up: [] };
                await endAll(active, 'stopped_by_person');
                return { outcome: 'stopped', task_ids: rows.map((b) => b.task_id), followed_up: [] };
            }
            if (!isPerson) return { outcome: active.length ? 'ignored:bot' : 'ignored:ended', task_ids: rows.map((b) => b.task_id), followed_up: [] };
            // A person's comment: on an ended binding it re-opens the ticket and wakes it once; otherwise it is
            // review feedback for the active bindings. Never past the per-PR fix cap.
            let targets = active;
            let reopened = false;
            if (!targets.length) {
                const last = rows[rows.length - 1];
                await db.exec(`UPDATE pr_bindings SET state = 'active', ended_reason = NULL, updated_at = $2 WHERE id = $1`, [last.id, store.now()]);
                targets = [{ ...last, state: 'active' }];
                reopened = true;
            }
            const evidence = `${payload.author || 'someone'} commented on the pull request${payload.html_url ? ` (${payload.html_url})` : ''}:\n${body} — address it on the branch and push it again.`;
            const r = await wake(targets, { roles: new Set(['review', 'fix']), evidence, reason: 'comment', eventId: event.event_id });
            if (r.disabled) return { outcome: 'ignored:follow_disabled', task_ids: targets.map((b) => b.task_id), followed_up: [] };
            if (r.capped) return { outcome: 'ignored:max_fixes', task_ids: targets.map((b) => b.task_id), followed_up: [] };
            if (!r.started.length) return { outcome: 'ignored:fix_running', task_ids: targets.map((b) => b.task_id), followed_up: [] };
            return { outcome: reopened ? 'reopened' : 'woke', task_ids: targets.map((b) => b.task_id), followed_up: r.started };
        }

        return { outcome: 'ignored:type', task_ids: rows.map((b) => b.task_id), followed_up: [] };
    }

    /** This ticket's bindings, newest first (for pages and the portal). */
    const listForTask = (taskId) => db.many('SELECT * FROM pr_bindings WHERE task_id = $1 ORDER BY created_at DESC', [taskId]);

    return { maybeBind, handleGithubEvent, listForTask, startFollowup, forPr, parsePrUrl, MAX_FIXES_PER_PR, RED_CONCLUSIONS };
}

module.exports = { createPrBindings, parsePrUrl, MAX_FIXES_PER_PR, RED_CONCLUSIONS, STOP_RE };
