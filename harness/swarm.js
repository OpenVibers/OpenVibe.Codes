'use strict';

/**
 * A swarm: one goal split into tickets that run at once, each on its own agent in its own git worktree, and merged back
 * into one branch. The best of the open designs studied 11-15, combined: DeepSeek Harness's agent teams (a shared task
 * board every worker reads), ClawTeam (a worker per git worktree), DeepSeek's Super-Agent (tickets with a fixed scope),
 * and Codes' own routing and hand-off (each worker is a whole harness run: it falls through to the next agent when one
 * fails). The person's own branch and working tree are never touched: the result is a branch to look at and merge.
 *
 *   const swarm = createSwarm({ harness });
 *   for await (const e of swarm.run({ goal, cwd, agents, maxTickets, concurrency, permission, planner, signal })) …
 *
 * 1. Plan: the planner (any agent, read only) answers a JSON list of tickets: a title, a brief and the files it owns.
 * 2. Board: the tickets, written to <Codes home>/swarms/<id>/board.json and kept current: who works on what, done or not.
 * 3. Work: each ticket on its own branch `ovswarm/<id>/<ticket>` in its own worktree, at most `concurrency` at once,
 *    on the agent the plan named, else the next of `agents`, else routing. Its prompt carries the goal, its ticket and
 *    the board (the other tickets and their files: stay out of them). What it changed is committed on its branch.
 * 4. Merge: the done tickets merge one by one into `ovswarm/<id>/merged`; a conflict goes to a resolver run in the
 *    merge worktree, and a merge that still conflicts is undone and its ticket marked `conflict`.
 *
 * Events: { type: 'system', subtype: 'swarm', phase, … } for each step, the workers' own events tagged with
 * `_ticket`, and one final { type: 'result', swarm } with the board.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_TICKETS = 8;
const TICKET_ID = /^t[1-9][0-9]?$/;

function git(cwd, args, opts = {}) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout || 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) } }).trim();
}

/** The person's git identity when one is set, else the swarm's own, for the commits on its branches. */
function identity(cwd) {
    let name = '';
    let email = '';
    try { name = git(cwd, ['config', 'user.name']); } catch { /* unset */ }
    try { email = git(cwd, ['config', 'user.email']); } catch { /* unset */ }
    return ['-c', `user.name=${name || 'OpenVibe Codes swarm'}`, '-c', `user.email=${email || 'swarm@openvibe.codes'}`];
}

/** The tickets in a planner's answer: the last JSON array in it (fenced or not), checked and cut to max. */
function parsePlan(text, max = MAX_TICKETS) {
    const s = String(text || '');
    const candidates = [];
    for (const m of s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
    const first = s.indexOf('[');
    const last = s.lastIndexOf(']');
    if (first !== -1 && last > first) candidates.push(s.slice(first, last + 1));
    for (const c of candidates.reverse()) {
        let list;
        try { list = JSON.parse(c); } catch { continue; }
        if (list && !Array.isArray(list) && Array.isArray(list.tickets)) list = list.tickets;
        if (!Array.isArray(list)) continue;
        const tickets = [];
        for (const t of list) {
            if (!t || typeof t !== 'object') continue;
            const title = String(t.title || '').trim().slice(0, 120);
            const brief = String(t.brief || t.description || t.task || '').trim().slice(0, 4000);
            if (!title || !brief) continue;
            const files = (Array.isArray(t.files) ? t.files : []).map((f) => String(f).trim()).filter((f) => f && !f.startsWith('/') && !f.split('/').includes('..')).slice(0, 40);
            const agent = typeof t.agent === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(t.agent) ? t.agent : null;
            tickets.push({ id: `t${tickets.length + 1}`, title, brief, files, agent });
            if (tickets.length >= max) break;
        }
        if (tickets.length) return tickets;
    }
    return [];
}

function plannerPrompt(goal, max) {
    return `You are the lead of a team of coding agents working at the same time, each in its own copy of this repository.
Read the repository as much as you need, change nothing, and split the goal below into at most ${max} independent
tickets that can be done in parallel. Give each ticket the files it owns: two tickets never own the same file, so their
work merges cleanly. Prefer fewer, larger tickets over many tiny ones; one ticket is right for a small goal.

Answer with only a JSON array, in a \`\`\`json block:
[{"title": "short title", "brief": "what to do, precisely, with what done looks like", "files": ["path/one.js", "dir/"]}]

The goal:
${goal}`;
}

function workerPrompt(goal, ticket, board) {
    const others = board.tickets.filter((t) => t.id !== ticket.id)
        .map((t) => `- ${t.id} ${t.title}${t.files.length ? ` (owns: ${t.files.join(', ')})` : ''}`).join('\n');
    return `You are one of ${board.tickets.length} coding agents working on the same goal at the same time, each in its own
copy of this repository. Do your ticket only, completely, and leave the rest to the others.

The goal: ${goal}

Your ticket (${ticket.id}): ${ticket.title}
${ticket.brief}
${ticket.files.length ? `\nYou own these files: ${ticket.files.join(', ')}. Change other files only when your ticket cannot work without it.` : ''}
${others ? `\nThe others (do not do their work, and stay out of their files):\n${others}` : ''}

When you are done, say in two or three sentences what you changed.`;
}

function resolverPrompt(goal, ticket, files) {
    return `Two coding agents worked on the same goal in parallel, and merging their work left conflict markers
(<<<<<<<, =======, >>>>>>>) in: ${files.join(', ')}. Resolve every conflict so both changes keep working: keep what each
side meant, remove every marker, change nothing else.

The goal: ${goal}
The ticket being merged (${ticket.id}): ${ticket.title}: ${ticket.brief}`;
}

function createSwarm({ harness, now = () => Date.now() } = {}) {
    if (!harness || typeof harness.run !== 'function') throw new TypeError('createSwarm needs a harness');

    function run({ goal, cwd = process.cwd(), agents = [], maxTickets = 4, concurrency = 3, permission = 'edit', planner = null, signal } = {}) {
        if (!goal || !String(goal).trim()) throw new Error('a swarm needs a goal');
        if (!['edit', 'full'].includes(permission)) throw new Error('a swarm changes files: permission is edit or full');
        const repo = git(path.resolve(cwd), ['rev-parse', '--show-toplevel']);
        const id = `sw_${new Date(now()).toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;
        const home = path.join(harness.store.root, 'swarms', id);
        const base = git(repo, ['rev-parse', 'HEAD']);
        const ident = identity(repo);
        const max = Math.max(1, Math.min(MAX_TICKETS, Number(maxTickets) || 4));
        const width = Math.max(1, Math.min(8, Number(concurrency) || 3));
        const board = { id, goal: String(goal), repo, base, created_at: new Date(now()).toISOString(), tickets: [], merged_branch: null, status: 'planning' };
        const save = () => { fs.mkdirSync(home, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(home, 'board.json'), `${JSON.stringify(board, null, 2)}\n`, { mode: 0o600 }); };
        const say = (phase, extra = {}) => ({ type: 'system', subtype: 'swarm', swarm_id: id, phase, ...extra });

        const queue = [];
        let wake = null;
        let finished = false;
        const emit = (e) => { queue.push(e); if (wake) { const w = wake; wake = null; w(); } };

        async function collect(runIter, ticketId) {
            let final = null;
            for await (const e of runIter) {
                if (e.type === 'result') final = e;
                else emit({ ...e, _ticket: ticketId });
            }
            return final;
        }

        async function plan() {
            const status = git(repo, ['status', '--porcelain']);
            if (status) throw new Error('the working tree has uncommitted changes: commit or stash them first (the workers start from HEAD)');
            save();
            emit(say('plan', { text: 'the lead splits the goal into tickets' }));
            const res = await collect(harness.run({ prompt: plannerPrompt(goal, max), task: 'review', agent: planner, cwd: repo, permission: 'read', handoff: true, signal }), 'lead');
            const tickets = parsePlan(res && res.result, max);
            board.tickets = (tickets.length ? tickets : [{ id: 't1', title: String(goal).slice(0, 120), brief: String(goal), files: [], agent: null }])
                .map((t, i) => ({ ...t, agent: t.agent || agents[i % (agents.length || 1)] || null, status: 'queued', branch: `ovswarm/${id}/${t.id}`, run_id: null, summary: null, changed: [] }));
            board.status = 'working';
            save();
            emit(say('board', { tickets: board.tickets.map(({ id: tid, title, files, agent }) => ({ id: tid, title, files, agent })), text: tickets.length ? `${board.tickets.length} ticket(s)` : 'the plan named no tickets: one ticket for the whole goal' }));
        }

        async function work(ticket) {
            const dir = path.join(home, 'work', ticket.id);
            git(repo, ['worktree', 'add', '-q', '-b', ticket.branch, dir, base]);
            ticket.status = 'working';
            save();
            emit(say('ticket', { ticket: ticket.id, text: `${ticket.title}${ticket.agent ? ` (${ticket.agent})` : ''}` }));
            try {
                const r = harness.run({ prompt: workerPrompt(goal, ticket, board), task: 'edit', agent: ticket.agent, cwd: dir, permission, handoff: !ticket.agent, signal });
                ticket.run_id = r.runId;
                const res = await collect(r, ticket.id);
                ticket.summary = res ? String(res.result || '').slice(0, 1000) : null;
                git(dir, ['add', '-A']);
                const changed = git(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
                ticket.changed = changed;
                if (changed.length) git(dir, [...ident, 'commit', '-q', '-m', `${ticket.id}: ${ticket.title}`]);
                ticket.status = signal && signal.aborted ? 'stopped' : res && !res.is_error && changed.length ? 'done' : changed.length ? 'partial' : 'failed';
            } catch (err) {
                ticket.status = 'failed';
                ticket.summary = String(err.message || err).slice(0, 500);
            } finally {
                try { git(repo, ['worktree', 'remove', '--force', dir]); } catch { /* left for git worktree prune */ }
                save();
                emit(say('ticket_end', { ticket: ticket.id, status: ticket.status, changed: ticket.changed.length }));
            }
        }

        async function workAll() {
            const pending = [...board.tickets];
            const lanes = Array.from({ length: Math.min(width, pending.length) }, async () => {
                for (let t = pending.shift(); t; t = pending.shift()) {
                    if (signal && signal.aborted) { t.status = 'stopped'; continue; }
                    await work(t);
                }
            });
            await Promise.all(lanes);
        }

        async function merge() {
            const ready = board.tickets.filter((t) => (t.status === 'done' || t.status === 'partial') && t.changed.length);
            if (!ready.length) return;
            board.status = 'merging';
            const branch = `ovswarm/${id}/merged`;
            const dir = path.join(home, 'merge');
            git(repo, ['worktree', 'add', '-q', '-b', branch, dir, base]);
            try {
                for (const t of ready) {
                    emit(say('merge', { ticket: t.id, text: `merging ${t.title}` }));
                    try {
                        git(dir, [...ident, 'merge', '--no-ff', '--no-edit', '-m', `merge ${t.id}: ${t.title}`, t.branch]);
                        t.merged = true;
                        continue;
                    } catch { /* a conflict: the resolver tries */ }
                    const files = git(dir, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
                    emit(say('conflict', { ticket: t.id, files, text: `conflict in ${files.join(', ')}: a resolver takes it` }));
                    const res = await collect(harness.run({ prompt: resolverPrompt(goal, t, files), task: 'edit', agent: planner, cwd: dir, permission: 'edit', handoff: true, signal }), `${t.id}:resolve`);
                    const left = files.filter((f) => { try { return /^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return false; } });
                    if (res && !res.is_error && !left.length) {
                        git(dir, ['add', '-A']);
                        git(dir, [...ident, 'commit', '-q', '--no-edit']);
                        t.merged = true;
                        t.resolved = files;
                    } else {
                        try { git(dir, ['merge', '--abort']); } catch { /* nothing to abort */ }
                        t.status = 'conflict';
                        emit(say('conflict_left', { ticket: t.id, files: left.length ? left : files, text: `${t.title} still conflicts: left on its branch ${t.branch}` }));
                    }
                }
                board.merged_branch = board.tickets.some((t) => t.merged) ? branch : null;
            } finally {
                try { git(repo, ['worktree', 'remove', '--force', dir]); } catch { /* prune later */ }
                if (!board.merged_branch) { try { git(repo, ['branch', '-D', branch]); } catch { /* none */ } }
            }
        }

        (async () => {
            let error = null;
            try {
                await plan();
                await workAll();
                await merge();
            } catch (err) {
                error = String(err.message || err);
            }
            const done = board.tickets.filter((t) => t.merged).length;
            board.status = error ? 'failed' : signal && signal.aborted ? 'stopped' : done ? (done === board.tickets.length ? 'done' : 'partial') : 'failed';
            save();
            const text = error || (board.merged_branch
                ? `${done} of ${board.tickets.length} ticket(s) merged into ${board.merged_branch} (from ${base.slice(0, 7)}); your branch is unchanged: git diff HEAD...${board.merged_branch}`
                : 'no ticket produced a change to merge');
            emit({ type: 'result', subtype: board.status === 'done' ? 'success' : 'error', is_error: board.status !== 'done' && board.status !== 'partial', result: text, swarm: board });
            finished = true;
            if (wake) { const w = wake; wake = null; w(); }
        })();

        const iterator = (async function* events() {
            while (true) {
                if (queue.length) { yield queue.shift(); continue; }
                if (finished) return;
                await new Promise((r) => { wake = r; });
            }
        }());
        iterator.swarmId = id;
        iterator.board = board;
        return iterator;
    }

    return { run };
}

module.exports = { createSwarm, parsePlan, plannerPrompt, workerPrompt };
