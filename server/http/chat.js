'use strict';

/**
 * Codes as a chat app (plan L31, CH1; the owner, 2026-10-30: "the conversation system in ChatGPT or Claude Code:
 * sessions on the left, jump between them, each has its own conversation… you change the agent in the corner").
 *
 * For a signed-in person, `/` and `/tasks/:id` are one app: the rail of conversations on the left (the conductor
 * pinned, the rest by when they last moved), the conversation in the middle with the composer under it, and what the
 * work produced at the side (who worked on it, the changes, the proof, the pull request). Everything is rendered
 * here and works without JavaScript (every action is a form post); public/js/chat.js streams a running turn into the
 * thread, grows the composer and opens the rail and the side on a phone.
 *
 * A conversation is a run_tasks row: a coding task (its first message is the brief, each "carry on" is a turn, a
 * hand-over to another agent is a divider) or the conductor (each message is a turn of one Claude Code session).
 * A visitor who is not signed in falls through to the product's own home (server/http/c4.js).
 */
const express = require('express');
const { send } = require('../render/layout');
const { raw, esc } = require('../render/html');
const { markdown } = require('../render/markdown');
const { asyncRouter } = require('./router');
const { sessionLogOf } = require('../domain/run-tasks');
const models = require('../data/models');
const kit = require('openvibe-shared/kit');
const start = require('./start');

const LIVE = ['queued', 'placed', 'running'];
const safeId = (s) => /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(s || ''));

// Icons: one stroke family (24 grid, 1.8 stroke, round), drawn here so the page needs no icon font.
const P = {
    new: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    conductor: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.7 7.8 10.6 16M16.3 7.8 13.4 16M8.5 6h7"/>',
    agents: '<rect x="4" y="7" width="16" height="12" rx="4"/><path d="M12 3v4M9 12h.01M15 12h.01M9.5 16h5"/>',
    machines: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    memory: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h0a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3Z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h0a3 3 0 0 1-3-3"/>',
    usage: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
    rail: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
    side: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/>',
    read: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>',
    run: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    find: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4Z"/>',
    sub: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
    handover: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
    ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    bad: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
    files: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M10 13h4M12 11v4M10 18h4"/>',
    proof: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z"/><path d="m9 12 2 2 4-4"/>',
    pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4m0 0 2-2m-2 2 2 2"/>',
    attach: '<path d="m21 11-8.6 8.6a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7L10 17.4a1.7 1.7 0 0 1-2.4-2.4L15.5 7"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    repo: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3Z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15v4M17 17h4"/>',
    ov: '<circle cx="8.5" cy="12" r="5"/><path d="m14 7 3.5 10L21 7"/>',
    game: '<rect x="2.5" y="7" width="19" height="11" rx="5.5"/><path d="M7 11v3M5.5 12.5h3M15.5 12h.01M18 13.5h.01"/>',
    app: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
    play: '<path d="M8 5.5v13l10-6.5Z"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
};
const ico = (name, cls = '') => `<svg class="ch-i${cls ? ` ${cls}` : ''}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || P.tool}</svg>`;

// Each agent's face: its initials in its own colour, so a hand-over in the thread is visible at a glance.
const AGENTS = {
    'claude-code': ['Claude Code', 'C', '#d97757'], codex: ['Codex', 'Cx', '#10a37f'], opencode: ['OpenCode', 'O', '#7c6cff'],
    'command-code': ['Command Code', 'Cc', '#f59e0b'], aider: ['Aider', 'A', '#14b8a6'], deepseek: ['DeepSeek', 'D', '#4f7cff'],
    minimax: ['MiniMax', 'M', '#ec4899'], openai: ['Your model', 'Y', '#64748b'],
};
const agentOf = (id, names) => {
    const known = AGENTS[String(id || '').split(':')[0]];
    const name = (names && names.get(id)) || (known && known[0]) || (id ? String(id) : 'Auto');
    return { name, initials: known ? known[1] : name.slice(0, 1).toUpperCase(), color: known ? known[2] : '#64748b' };
};
const avatar = (a) => `<span class="ch-av" style="--av:${esc(a.color)}" aria-hidden="true">${esc(a.initials)}</span>`;

// A tool call's kind, by the names the agents give their tools.
function stepKind(name) {
    const n = String(name || '').toLowerCase();
    if (/^(read|view|cat|ls|glob|list|open)|read_file|list_dir/.test(n)) return 'read';
    if (/(grep|search|find|rg)/.test(n) && !/web/.test(n)) return 'find';
    if (/(edit|write|patch|apply|create|replace|multiedit|str_replace)/.test(n)) return 'edit';
    if (/(bash|shell|exec|run|command|terminal)/.test(n)) return 'run';
    if (/(web|fetch|browse|http|url)/.test(n)) return 'web';
    if (/(task|agent|delegate|subagent)/.test(n)) return 'sub';
    return 'tool';
}

const when = (value) => {
    // run_tasks keeps epoch milliseconds (bigint, read as a string); the attempts and lines keep timestamps.
    const ms = value instanceof Date ? value.getTime() : /^\d{10,}$/.test(String(value)) ? Number(value) : Date.parse(String(value || ''));
    return Number.isFinite(ms) ? ms : 0;
};
const ago = (value) => {
    const ms = when(value);
    if (!ms) return '';
    const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    return mins < 1 ? 'now' : mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
};
const minutes = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`);
const firstLine = (s, n = 64) => {
    const line = String(s || '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
    return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
const folderName = (f) => String(f || '').replace(/\/+$/, '').split('/').pop() || 'a folder';
const titleOf = (row) => (row.kind === 'conductor' ? `Conductor · ${folderName(row.folder)}` : (row.title || firstLine(row.prompt) || 'New task'));
const stateOf = (row) => {
    if (LIVE.includes(row.state)) return row.state === 'queued' ? ['Getting ready', 'busy'] : ['Working', 'busy'];
    if (row.outcome === 'stopped' || row.state === 'cancelled') return ['Stopped', 'idle'];
    if (row.outcome === 'unfinished' || row.state === 'failed' || row.error) return ["Didn't finish", 'bad'];
    if (row.kind === 'conductor') return ['Waiting for you', 'ok'];
    return ['Done', 'ok'];
};
const asObject = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; } }
    return null;
};
const repoLabel = (repo) => { try { return new URL(String(repo)).pathname.split('/').filter(Boolean).slice(-2).join('/').replace(/\.git$/i, ''); } catch { return ''; } };

function createChatRoutes(ctx) {
    const r = asyncRouter();
    const { config, store, harnesses, tasks, conductor, approvals, userSettings, github, machines } = ctx;
    const db = store.db;
    const form = express.urlencoded({ extended: false, limit: '32kb' });
    const viewer = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };
    const agentNames = () => new Map((harnesses?.list?.() || []).map((a) => [a.id, a.name]));

    // ── The rail ─────────────────────────────────────────────────────────────────────────────────────────────────
    async function conversations(subject) {
        return db.many(
            `SELECT id, kind, state, outcome, error, prompt, folder, agent, model, repo, created_at, updated_at, finished_at
               FROM run_tasks WHERE subject = $1 ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 120`, [subject],
        );
    }
    function railHtml(rows, currentId, waitingIds, here = '') {
        // The network's one sidebar (openvibe-shared kit.sidebar, plan L35): New chat and search on top, Codes' places as
        // vertical rows, then the conversations by when they last moved. A drawer on a phone (kit-web.js opens it).
        const now = new Date();
        const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const bucket = (row) => {
            const t = when(row.updated_at || row.created_at);
            return t >= day0 ? 'Today' : t >= day0 - 86400000 ? 'Yesterday' : t >= day0 - 6 * 86400000 ? 'This week' : 'Earlier';
        };
        const names = agentNames();
        const item = (row) => {
            const [, tone] = stateOf(row);
            const dot = waitingIds.has(row.id) ? 'needs' : tone === 'busy' ? 'busy' : tone === 'bad' ? 'bad' : null;
            const mark = row.kind === 'conductor' ? `<span class="ch-av ch-av-conductor" aria-hidden="true">${ico('conductor')}</span>` : avatar(agentOf(row.agent, names));
            return { href: `/tasks/${encodeURIComponent(row.id)}`, label: titleOf(row), mark, meta: dot ? '' : ago(row.updated_at || row.created_at), here: row.id === currentId, dot };
        };
        const pinned = rows.filter((x) => x.kind === 'conductor' && x.outcome !== 'stopped').slice(0, 2);
        const groups = [];
        for (const row of rows.filter((x) => !pinned.includes(x))) {
            const b = bucket(row);
            if (!groups.length || groups[groups.length - 1].title !== b) groups.push({ title: b, items: [] });
            groups[groups.length - 1].items.push(item(row));
        }
        const place = (label, href, icon, extra = {}) => ({ href, label, iconHtml: ico(icon), here: here === href, ...extra });
        return kit.sidebar({
            id: 'ch-rail', label: 'Codes',
            action: { href: '/', label: 'New chat', icon: 'pencil' },
            find: { action: '/tasks', name: 'q', placeholder: 'Search conversations', label: 'Search your conversations' },
            nav: [
                place('Conductor', '/conductor', 'conductor'),
                place('Agents', '/agents', 'agents'),
                place('Machines', '/machines', 'machines'),
                place('OpenVibe Git', '/git', 'repo'),
                place('Memory', '/memory', 'memory'),
                place('Usage', '/usage', 'usage'),
                ...(waitingIds.size ? [{ href: '/approvals', label: 'Approvals', icon: 'hand', here: here === '/approvals', count: waitingIds.size }] : []),
                place('Settings', '/settings', 'settings'),
            ],
            sections: [
                ...(pinned.length ? [{ title: 'Pinned', items: pinned.map(item) }] : []),
                ...groups,
                ...(rows.length ? [] : [{ title: '', items: [], empty: 'Your conversations appear here.' }]),
            ],
        });
    }

    // ── The thread ───────────────────────────────────────────────────────────────────────────────────────────────
    const you = (text, extra = '', caption = '') => `<div class="ch-turn ch-you">${caption ? `<span class="ch-cap">${esc(caption)}</span>` : ''}<div class="ch-bubble">${esc(text)}</div>${extra}</div>`;
    const divider = (text, icon = 'handover') => `<div class="ch-divider" role="note">${ico(icon)}<span>${esc(text)}</span></div>`;
    function stepsHtml(steps, ms, open = false) {
        if (!steps.length) return '';
        const list = steps.map((s) => `<li class="ch-step${s.ok === false ? ' is-bad' : ''}" data-kind="${s.kind}">${ico(s.kind)}<span class="ch-step-n">${esc(s.name)}</span><span class="ch-step-w">${esc(s.what || '')}</span></li>`).join('');
        const label = `Worked${ms ? ` ${minutes(ms)}` : ''} · ${steps.length} step${steps.length === 1 ? '' : 's'}`;
        return `<details class="ch-steps"${open ? ' open' : ''}><summary>${label}${ico('chevron', 'ch-caret')}</summary><ol>${list}</ol></details>`;
    }
    /** One agent's turn from its session lines: what it said, the steps it took, how it ended. */
    function agentTurn(a, lines, { live = false, attempt = null } = {}) {
        const steps = [];
        const said = [];
        let done = null;
        for (const l of lines) {
            const b = asObject(l.body) || { t: 'text', text: String(l.body || '') };
            const t = b.t || l.kind;
            if (t === 'tool') steps.push({ id: b.id, name: b.name || 'tool', what: b.what || '', kind: stepKind(b.name), ok: null });
            else if (t === 'tool_result') { const s = steps.slice().reverse().find((x) => x.id && x.id === b.id) || steps[steps.length - 1]; if (s) s.ok = b.ok !== false; }
            else if (t === 'text' && b.text) said.push(String(b.text));
            else if (t === 'done') done = b;
            else if (t === 'note' && b.text) said.push(`> ${String(b.text)}`);
        }
        const first = lines[0] && when(lines[0].at), last = lines.length && when(lines[lines.length - 1].at);
        const ms = first && last ? last - first : 0;
        // The last thing it said is its answer; what it said along the way folds into the steps.
        const answer = (done && done.text) || said[said.length - 1] || '';
        const along = said.slice(0, answer && said[said.length - 1] === answer ? -1 : undefined);
        const alongSteps = along.map((text) => ({ name: 'Said', what: firstLine(text, 140), kind: 'sub', ok: null }));
        const ran = attempt ? [attempt.model, attempt.effort ? effortWord(attempt.effort) : null].filter(Boolean).join(' · ') : '';
        const who = `<div class="ch-who">${avatar(a)}<b>${esc(a.name)}</b>${ran ? `<span>${esc(ran)}</span>` : ''}</div>`;
        const body = answer ? `<div class="ch-md">${markdown(answer)}</div>` : live ? '' : `<p class="ch-quiet">${esc(attempt && attempt.end_why ? attempt.end_why : 'It ended without a word.')}</p>`;
        const working = live ? `<div class="ch-working" data-ch-working><span class="ch-dots" aria-hidden="true"><i></i><i></i><i></i></span><span data-ch-working-text>${steps.length ? esc(`${steps[steps.length - 1].name} ${steps[steps.length - 1].what || ''}`.trim()) : 'Starting…'}</span></div>` : '';
        return `<div class="ch-turn ch-agent${live ? ' is-live' : ''}"${attempt ? ` data-attempt="${Number(attempt.n)}"` : ''}>${who}${stepsHtml([...alongSteps, ...steps], ms, live)}${body}${working}</div>`;
    }
    async function taskThread(row) {
        const names = agentNames();
        const attempts = tasks?.attempts ? (await tasks.attempts.list(row.id)).map((a) => ({ ...a, ...(tasks.attempts.present ? tasks.attempts.present(a) : {}) })) : [];
        let lines = await db.many('SELECT seq, at, kind, body, attempt_n FROM codes_session_lines WHERE task_id = $1 ORDER BY seq ASC LIMIT 4000', [row.id]);
        if (!lines.length) lines = (sessionLogOf(row) || []).map((body, i) => ({ seq: i + 1, at: null, kind: body && body.t, body, attempt_n: 1 }));
        const byAttempt = new Map();
        for (const l of lines) { const n = Number(l.attempt_n || 1); if (!byAttempt.has(n)) byAttempt.set(n, []); byAttempt.get(n).push(l); }
        const out = [you(row.prompt || '')];
        const live = LIVE.includes(row.state);
        let prev = null;
        for (const a of attempts) {
            const n = Number(a.n);
            if (prev) {
                const note = /^carried on by the owner: /.exec(a.why || '') ? String(a.why).replace(/^carried on by the owner: /, '') : null;
                if (note) out.push(you(note));
                if (a.agent && prev.agent && a.agent !== prev.agent) out.push(divider(`${agentOf(a.agent, names).name} took over${prev.end_why ? `: ${agentOf(prev.agent, names).name} ${prev.end_why}` : ''}`));
                else if (a.why && !note) out.push(divider(String(a.why), 'handover'));
            }
            const isLive = live && n === Number(attempts[attempts.length - 1].n);
            out.push(agentTurn(agentOf(a.agent || row.agent, names), byAttempt.get(n) || [], { live: isLive, attempt: a }));
            prev = a;
        }
        if (!attempts.length) out.push(agentTurn(agentOf(row.agent, names), lines, { live }));
        if (!live) out.push(await resultCard(row));
        return out.join('');
    }
    async function conductorThread(row, view) {
        const out = [];
        const names = agentNames();
        const a = agentOf('claude-code', names);
        const live = LIVE.includes(row.state);
        const msgs = view.messages || [];
        for (const m of msgs) {
            out.push(you(m.n === 1 ? (m.prompt || 'Pick up the plan') : m.prompt, (m.attachments || []).length ? `<p class="ch-files">${m.attachments.map((f, i) => `<a class="ch-chip" href="/api/v1/tasks/${encodeURIComponent(row.id)}/messages/${encodeURIComponent(m.id)}/attachments/${i}">${ico('attach')}${esc(f.name)}</a>`).join('')}</p>` : '', m.n === 1 ? 'Hand-over brief' : ''));
            if (m.state === 'running' || (live && m === msgs[msgs.length - 1] && m.state !== 'done')) {
                const lines = await db.many('SELECT seq, at, kind, body FROM codes_session_lines WHERE task_id = $1 ORDER BY seq DESC LIMIT 300', [row.id]);
                out.push(agentTurn(a, lines.reverse(), { live: true, attempt: { model: row.model } }));
            } else if (m.result && m.result.summary) {
                out.push(`<div class="ch-turn ch-agent"><div class="ch-who">${avatar(a)}<b>${esc(a.name)}</b>${row.model ? `<span>${esc(row.model)}</span>` : ''}</div><div class="ch-md">${markdown(m.result.summary)}</div></div>`);
            } else if (m.error) out.push(`<div class="ch-turn ch-agent"><div class="ch-who">${avatar(a)}<b>${esc(a.name)}</b></div><p class="ch-quiet">${esc(m.error)}</p></div>`);
            else if (m.state === 'queued') out.push(divider('Waiting for the turn before it to end', 'conductor'));
        }
        for (const ap of view.approvals || []) out.push(approvalCard(row, ap));
        return out.join('');
    }
    const approvalCard = (row, ap) => `<form class="ch-approval" method="post" action="/tasks/${encodeURIComponent(row.id)}/approvals/${encodeURIComponent(ap.id)}"><p class="ch-approval-h">${ico('proof')}<b>${esc(ap.tool || 'A tool')}</b> wants to run</p><code tabindex="0">${esc(ap.summary || '')}</code><div class="ch-approval-a"><button class="ch-btn" name="decision" value="allow">Allow</button><button class="ch-btn ch-btn-quiet" name="decision" value="deny">Deny</button></div></form>`;

    /** How the task ended, as one card: the files and the diff, the proof item by item, and the pull request or why none. */
    async function resultCard(row) {
        const result = asObject(row.result) || {};
        const files = Array.isArray(result.files) ? result.files.filter((f) => f && f.path) : [];
        const patch = typeof result.patch === 'string' ? result.patch : '';
        const push = asObject(result.push) || {};
        const proof = tasks?.proof ? tasks.proof.present(await tasks.proof.list(row.id)) : [];
        const [word, tone] = stateOf(row);
        const fold = (icon, head, body) => `<details class="ch-res-fold"><summary>${ico(icon)}${head}${ico('chevron', 'ch-caret')}</summary>${body}</details>`;
        const parts = [];
        if (tone === 'bad') parts.push(`<p class="ch-res-line is-bad">${ico('bad')}<span><b>${esc(word)}</b> ${esc(row.outcome_note || row.error || '')}</span></p>`);
        if (files.length || patch) {
            const added = files.reduce((n, f) => n + (Number(f.added) || 0), 0), removed = files.reduce((n, f) => n + (Number(f.removed) || 0), 0);
            parts.push(fold('files', `<b>${files.length} file${files.length === 1 ? '' : 's'} changed</b><span class="ch-add">+${added}</span><span class="ch-del">−${removed}</span>`,
                `<ul>${files.map((f) => `<li><code>${esc(f.path)}</code><span class="ch-add">+${esc(f.added ?? '·')}</span><span class="ch-del">−${esc(f.removed ?? '·')}</span></li>`).join('')}</ul>${patch ? `<details class="ch-diff"><summary>The diff${result.patch_truncated ? ' (cut to fit)' : ` · ${patch.split('\n').length} lines`}</summary><pre tabindex="0">${esc(patch)}</pre></details>` : ''}`));
        }
        if (proof.length) {
            const passed = proof.filter((p) => p.ok && !p.skipped).length;
            const item = (p) => {
                const state = p.skipped ? 'Skipped' : p.ok ? 'Passed' : 'Failed';
                const detail = asObject(p.detail) || {};
                const shots = p.kind === 'screenshots' && Array.isArray(detail.shots)
                    ? `<ul class="ch-shots">${detail.shots.map((x) => `<li class="${x.ok === false ? 'is-bad' : ''}">${esc(`${x.route || '/'} at ${Number(x.width) || 0} px`)}${x.summary ? `: ${esc(x.summary)}` : ''}</li>`).join('')}</ul>` : '';
                return `<li class="${p.skipped ? '' : p.ok ? 'is-ok' : 'is-bad'}">${ico(p.skipped ? 'tool' : p.ok ? 'ok' : 'bad')}<b>${esc(p.label || p.kind)}</b><em>${state}</em><span>${esc(p.summary || '')}</span>${shots}</li>`;
            };
            parts.push(fold('proof', `<b>Proof</b><span class="ch-muted">${passed} of ${proof.length} passed</span>`, `<ul class="ch-proof">${proof.map(item).join('')}</ul>`));
        } else parts.push(`<p class="ch-res-line ch-muted">${ico('proof')}<span>This task has no proof: it ended before proof was collected.</span></p>`);
        if (push.pull_request) parts.push(`<p class="ch-res-line">${ico('pr')}<a href="${esc(push.pull_request)}" rel="noopener noreferrer">The pull request</a>${push.branch ? `<span class="ch-muted">${esc(push.branch)}</span>` : ''}</p>`);
        else {
            const why = push.pull_request_error ? `The pull request was not opened: ${push.pull_request_error}`
                : push.pushed ? 'The branch was pushed, but no pull request was asked for.' : 'This task did not ask for a pull request.';
            parts.push(`<p class="ch-res-line ch-muted">${ico('pr')}<span>${esc(why)}${push.branch_url ? ` <a href="${esc(push.branch_url)}" rel="noopener noreferrer">${esc(push.branch || 'the branch')}</a>` : ''}</span></p>`);
        }
        return `<div class="ch-result">${parts.join('')}</div>`;
    }

    // ── The composer ─────────────────────────────────────────────────────────────────────────────────────────────
    function whoPicker(selected, { label = 'Who works on it', auto = null, cls = '' } = {}) {
        const all = models.choices(harnesses);
        const groups = new Map();
        for (const c of all.slice(1)) { if (!groups.has(c.group)) groups.set(c.group, []); groups.get(c.group).push(c); }
        const opt = (c) => `<option value="${esc(c.value)}"${selected === c.value ? ' selected' : ''}${c.note ? ` title="${esc(c.note)}"` : ''}>${esc(c.label)}</option>`;
        const first = auto ? `<option value="">${esc(auto)}</option>` : opt(all[0]);
        return `<label class="ch-pick${cls ? ` ${cls}` : ''}" title="${esc(label)}"><span class="ch-sr">${esc(label)}</span>${ico('agents')}<select name="who" data-ch-who>${first}${[...groups].map(([g, list]) => list.length > 1 ? `<optgroup label="${esc(g)}">${list.map(opt).join('')}</optgroup>` : opt(list[0])).join('')}</select>${ico('chevron', 'ch-caret')}</label>`;
    }
    // The effort in plain words (the shared ladder underneath; each agent gets the nearest level it accepts).
    const EFFORT = [['', 'Effort: auto'], ['low', 'Quick'], ['medium', 'Balanced'], ['high', 'Thorough'], ['max', 'Deepest']];
    const effortWord = (v) => (EFFORT.find(([k]) => k === v) || [null, v])[1];
    function effortPicker(selected = '', cls = '') {
        return `<label class="ch-pick${cls ? ` ${cls}` : ''}" title="How hard it thinks"><span class="ch-sr">Effort</span>${ico('sub')}<select name="effort" data-ch-effort>${EFFORT.map(([v, l]) => `<option value="${v}"${selected === v ? ' selected' : ''}>${l}</option>`).join('')}</select>${ico('chevron', 'ch-caret')}</label>`;
    }
    function composer({ action, api = '', placeholder, pickers = '', live = false, stopAction = '', hidden = '', note = '', id = '', where = '' }) {
        return `<form class="ch-composer"${id ? ` id="${esc(id)}"` : ''} method="post" action="${esc(action)}"${api ? ` data-ch-api="${esc(api)}"` : ''} data-ch-composer>${hidden}
<label class="ch-sr" for="ch-text">${esc(placeholder)}</label>
<textarea id="ch-text" name="text" rows="1" placeholder="${esc(placeholder)}" required data-ch-text></textarea>
<div class="ch-bar"><div class="ch-picks">${pickers}</div>${live && stopAction ? `<button class="ch-icon-btn ch-stop" formaction="${esc(stopAction)}" formnovalidate aria-label="Stop" title="Stop">${ico('stop')}</button>` : ''}<button class="ch-send" type="submit" aria-label="Send" title="Send">${ico('send')}</button></div>
${where}${note ? `<p class="ch-note" data-ch-status role="status">${note}</p>` : '<p class="ch-note" data-ch-status role="status"></p>'}
</form>`;
    }

    // ── Pages ────────────────────────────────────────────────────────────────────────────────────────────────────
    async function frame(req, res, { currentId = null, title, head = '', thread = '', composerHtml = '', side = '', streamUrl = '', empty = false, page = null, here = '', css = [], scripts = [] }) {
        const rows = await conversations(req.viewer.subject);
        const waiting = approvals ? await approvals.inbox(req.viewer.subject).catch(() => []) : [];
        const waitingIds = new Set(waiting.map((a) => a.task_id));
        const body = `<div class="ch${side ? ' has-side' : ''}${empty ? ' is-empty' : ''}${page != null ? ' is-page' : ''}" data-chat>
${railHtml(rows, currentId, waitingIds, here)}
<div class="ovk-sidebar-scrim" data-ovk-sidebar-scrim hidden></div>
<div class="ch-scrim" data-ch-scrim hidden></div>
<section class="ch-main" aria-label="Conversation">
<header class="ch-head">${kit.sidebarButton({ id: 'ch-rail', label: 'Your conversations' })}${head}${side ? `<button class="ch-icon-btn ch-side-open" type="button" data-ch-side-open aria-label="What it did" aria-controls="ch-side">${ico('side')}</button>` : ''}</header>
${page != null ? `<div class="ch-page">${page}</div>` : `<div class="ch-thread" id="ch-thread"${streamUrl ? ` data-ch-stream="${esc(streamUrl)}"` : ''}>${thread}</div>
${composerHtml}`}
</section>
${side}
</div>`;
        return send(res, 200, { viewer: req.viewer, config, path: req.originalUrl, title: `${title} · Codes`, css: [...css, 'css/chat.css'], styles: ['kit.css'], sharedScripts: ['kit-web.js'], scripts: [...scripts, 'js/chat.js'], body: raw(body) });
    }

    /** The side: who worked on it, and where the work is. */
    async function sideHtml(row) {
        const names = agentNames();
        const attempts = tasks?.attempts ? await tasks.attempts.list(row.id) : [];
        const result = asObject(row.result) || {};
        const repo = repoLabel(row.repo);
        const facts = [
            row.repo ? [ico('repo'), `<a href="${esc(row.repo)}" rel="noopener noreferrer">${esc(repo || 'The repository')}</a>`] : null,
            row.folder ? [ico('folder'), `<code>${esc(row.folder)}</code>`] : null,
            Number.isFinite(Number(result.cost_usd)) && Number(result.cost_usd) > 0 ? [ico('usage'), `about $${Number(result.cost_usd).toFixed(2)} of model use`] : null,
        ].filter(Boolean);
        const people = attempts.map((a) => { const g = agentOf(a.agent, names); return `<li>${avatar(g)}<span><b>${esc(g.name)}</b><small>${esc([a.model, tasks.attempts.wordsOf && a.reason ? tasks.attempts.wordsOf(a.reason) : a.state].filter(Boolean).join(' · '))}</small></span></li>`; }).join('');
        return `<aside class="ch-side" id="ch-side" aria-label="What it did"><div class="ch-side-head"><b>What it did</b><button class="ch-icon-btn" type="button" data-ch-side-close aria-label="Close">${ico('close')}</button></div>
${people ? `<section><p class="ch-group">Agents</p><ul class="ch-people">${people}</ul></section>` : ''}
${facts.length ? `<section><p class="ch-group">Where</p><ul class="ch-facts">${facts.map(([i, t]) => `<li>${i}<span>${t}</span></li>`).join('')}</ul></section>` : ''}
</aside>`;
    }

    ctx.chatShell = (req, res, { title, body, css = [], scripts = [], here = '' }) => frame(req, res, {
        title, page: body, here, css, scripts, head: '',
    });

    /** The person's machines, for the line that says where the work runs: never more than 1.5 s, never fatal. */
    async function machinesFor(req) {
        // The current token only: a refresh here would rotate the session with no response to save it on.
        const token = req.token || (req.viewer && req.viewer.token) || null;
        if (!token || !machines || !machines.list) return null;
        let timer;
        const late = new Promise((resolve) => { timer = setTimeout(resolve, 1500, null); if (timer.unref) timer.unref(); });
        const read = Promise.resolve().then(() => machines.list(token)).catch(() => null);
        const out = await Promise.race([read, late]).finally(() => clearTimeout(timer));
        return out && out.ok ? (out.machines || []).filter((m) => m && m.state !== 'revoked') : null;
    }
    /** Where an agent's work runs, in one line: the person's own computer (which one, or how to pair one). */
    function whereAgents(list) {
        const tail = '<span class="ch-where-tail">in a fresh copy of the code, with a pull request at the end</span>';
        if (list == null) return `${ico('machines')}<span>Runs on your computer ${tail}</span>`;
        if (!list.length) return `${ico('machines')}<span>Runs on your computer. <a href="/machines">Pair it first</a>: it takes a minute, and the task waits for it.</span>`;
        const on = list.find((m) => m.state === 'online');
        const m = on || list[0];
        const name = esc(m.name || m.node_id || 'your computer');
        return `${ico('machines')}<span>Runs on <b>${name}</b>${on ? ' <em class="ch-on">online</em>' : ' when it is on'} ${tail}</span>`;
    }

    // A new conversation: what you are making (something new, an OpenVibe project or your own code), the ideas rail,
    // and the composer. Every choice is a form field, so it all works without JavaScript; public/js/chat.js only makes
    // the rail move, fills the box from an idea and swaps the placeholder.
    r.get('/', async (req, res, next) => {
        if (!viewer(req)) return next();
        const settings = await userSettings.get(req.viewer.subject).catch(() => ({}));
        const [repos, mine] = await Promise.all([
            github ? github.recent(req.viewer.subject, 6).catch(() => []) : [],
            machinesFor(req),
        ]);
        const asked = String(req.query.repo || '');
        const repo = asked || (repos[0] && repos[0].url) || '';
        const mode = start.MODES.includes(req.query.mode) ? req.query.mode : asked ? 'code' : repos.length ? 'code' : 'new';
        const kind = start.KINDS[req.query.kind] ? req.query.kind : 'website';
        const chosenProject = start.project(req.query.project) ? String(req.query.project) : 'auto';
        const error = String(req.query.error || '').slice(0, 200);
        const name = String(req.viewer.displayName || req.viewer.username || '').split(' ')[0];

        // The three ways to start: radio cards above the composer (they belong to its form by id).
        const MODE_CARDS = [
            ['new', 'spark', 'Something new', 'A website, game or app. OpenVibe AI builds it online: nothing to install.'],
            ['openvibe', 'ov', 'An OpenVibe site', `Improve Live, Chat, Games or any of ${start.PROJECTS.length} projects.`],
            ['code', 'repo', 'Your code', 'Any Git repository, private ones too. Agents work on your computer.'],
        ];
        const modes = `<fieldset class="ch-modes"><legend class="ch-sr">What are you making?</legend>${MODE_CARDS.map(([v, icon, title, line]) => `<label class="ch-mode"><input type="radio" name="mode" value="${v}" form="ch-start"${mode === v ? ' checked' : ''} data-ch-mode><span class="ch-mode-i">${ico(icon)}</span><b>${esc(title)}</b><small>${esc(line)}</small></label>`).join('')}</fieldset>`;

        // The pickers: each shows for the way it belongs to (CSS reads the checked card).
        const kindPick = `<label class="ch-pick ch-for-new" title="What it is"><span class="ch-sr">What it is</span>${ico('web')}<select name="kind" data-ch-kind>${Object.entries(start.KINDS).map(([v, k]) => `<option value="${v}"${kind === v ? ' selected' : ''}>${esc(k.label)}</option>`).join('')}</select>${ico('chevron', 'ch-caret')}</label>`;
        const groups = [...new Set(start.PROJECTS.map((p) => p.group))];
        const projectPick = `<label class="ch-pick ch-for-openvibe" title="Which OpenVibe project"><span class="ch-sr">Which OpenVibe project</span>${ico('ov')}<select name="project" data-ch-project><option value="auto"${chosenProject === 'auto' ? ' selected' : ''}>Codes picks for you</option>${groups.map((g) => `<optgroup label="${esc(g)}">${start.PROJECTS.filter((p) => p.group === g).map((p) => `<option value="${esc(p.repository)}"${chosenProject === p.repository ? ' selected' : ''}${p.line ? ` title="${esc(p.line)}"` : ''}>${esc(p.name)}${p.domain ? ` · ${esc(p.domain)}` : ''}</option>`).join('')}</optgroup>`).join('')}</select>${ico('chevron', 'ch-caret')}</label>`;
        const repoPick = `<label class="ch-pick ch-pick-repo ch-for-code" title="Repository"><span class="ch-sr">Repository: owner/name or any Git URL</span>${ico('repo')}<input name="repo" type="text" inputmode="url" spellcheck="false" autocapitalize="off" value="${esc(repo)}" placeholder="owner/name or any Git URL" list="ch-repos" autocomplete="off" data-ch-repo data-ch-repo-url="/api/v1/me/repos"><datalist id="ch-repos">${repos.map((x) => `<option value="${esc(x.url)}">${esc(x.full_name)}</option>`).join('')}</datalist></label>`;
        const pickers = kindPick + projectPick + repoPick + whoPicker(settings.default_agent ? `${settings.default_agent}|` : '', { cls: 'ch-for-agents' }) + effortPicker('', 'ch-for-agents');
        // The repositories a person used last are a tap away (the box also searches every one they can reach).
        const newRepo = `<a class="ch-chip ch-chip-new" href="/git">${ico('new')}New on OpenVibe Git</a>`;
        const recent = `<div class="ch-recent ch-for-code" role="group" aria-label="Your repositories">${newRepo}${repos.length > 1 ? repos.map((x) => `<button class="ch-chip" type="button" data-ch-saved-repo="${esc(x.url)}">${ico('repo')}${esc(x.full_name)}</button>`).join('') : ''}</div>`;
        const picked = `<p class="ch-picked ch-for-openvibe" data-ch-picked data-ch-match-url="/chat/match" aria-live="polite">${ico('ov')}<span data-ch-picked-text>Say what you want changed and which site, in your own words: Codes works out which projects to change.</span></p>`;
        const where = `${recent}${picked}<p class="ch-where"><span class="ch-for-new">${ico('web')}<span>Built on OpenVibe’s servers at <b>openvibe.space</b> <span class="ch-where-tail">and you get a live link; you check it before anything is built</span></span></span><span class="ch-for-agents">${whereAgents(mine)}</span></p>`;

        // The ideas rail: it drifts sideways, stops under a pointer or the keyboard, and has its own pause. A press fills
        // the box (and picks the way it belongs to), ready to be changed. The second copy is only there for the loop.
        const sets = Object.fromEntries(start.MODES.map((m) => [m, start.ideasFor(m)]));
        const kindIcon = (i) => (i.kind === 'game' ? 'game' : i.kind === 'app' ? 'app' : i.kind === 'website' ? 'web' : i.mode === 'openvibe' ? 'ov' : 'spark');
        const card = (i, copy) => `<li><button class="ch-idea" type="button"${copy ? ' tabindex="-1"' : ''} data-ch-idea="${esc(i.text)}" data-ch-idea-mode="${esc(i.mode)}"${i.kind ? ` data-ch-idea-kind="${esc(i.kind)}"` : ''}>${ico(kindIcon(i))}<span>${esc(i.text)}</span></button></li>`;
        const rail = (list) => `<ul class="ch-spark-list">${list.map((i) => card(i, false)).join('')}</ul><ul class="ch-spark-list" aria-hidden="true">${list.map((i) => card(i, true)).join('')}</ul>`;
        const ideas = `<section class="ch-spark" aria-label="Ideas to start from" data-ch-ideas data-ch-ideasets="${esc(JSON.stringify(sets))}"><div class="ch-spark-view"><div class="ch-spark-track" data-ch-ideas-track>${rail(sets[mode])}</div></div><template data-ch-idea-icons>${['web', 'game', 'app', 'ov', 'spark'].map((n) => ico(n).replace('<svg ', `<svg data-icon="${n}" `)).join('')}</template><button class="ch-icon-btn ch-spark-pause" type="button" data-ch-ideas-pause aria-pressed="false" aria-label="Pause the ideas" title="Pause the ideas">${ico('pause', 'ch-i-pause')}${ico('play', 'ch-i-play')}</button></section>`;

        const thread = `<div class="ch-hello"><span class="ov-mark" data-size="56" aria-hidden="true"></span><h1>${name ? `What should we build, ${esc(name)}?` : 'What should we build?'}</h1><p>Say it the way you would to a friend. Pick what it is, and Codes sends it to the right place.</p>${error ? `<p class="ch-error" role="alert">${esc(error)}</p>` : ''}${modes}</div>`;
        return frame(req, res, {
            title: 'New chat', empty: true, head: '<h1 class="ch-title">New chat</h1>', thread,
            composerHtml: composer({ action: '/chat', id: 'ch-start', placeholder: mode === 'new' ? 'Describe your website, game or app' : 'Describe the change, question or fix', pickers, where }) + ideas,
        });
    });

    /** Which OpenVibe projects a request is about (start.matchProjects), for the composer as the person types. */
    r.get('/chat/match', (req, res) => {
        if (!viewer(req)) return res.status(401).json({ projects: [] });
        const projects = start.matchProjects(String(req.query.text || '').slice(0, 4000)).map((p) => ({ name: p.name, repository: p.repository }));
        return res.set('Cache-Control', 'no-store').json({ projects });
    });

    /** Start a conversation: the brief becomes a task on the person's project, and the page is its conversation. */
    r.post('/chat', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, '/auth/login?next=%2F');
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const b = req.body || {};
        // The way it starts: a form from before the three cards (or the API's shape) names only a repo or a project.
        const mode = start.MODES.includes(b.mode) ? b.mode : (b.project && !b.repo ? 'openvibe' : 'code');
        // A typed address that carries a password never goes back into a URL (logs keep URLs).
        const typed = String(b.repo || '');
        const keep = [['mode', mode], ['repo', /:\/\/[^/]*@|^[^/]*:[^/]*@/.test(typed) ? '' : typed], ['project', b.project], ['kind', b.kind]].filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(String(v).slice(0, 300))}`).join('');
        const back = (msg) => res.redirect(303, `/?error=${encodeURIComponent(msg)}${keep}`);
        const text = String(b.text || '').trim().slice(0, 16000);
        if (!text) return back('Write what you want made or changed first.');
        // Something new: OpenVibe AI builds it on openvibe.space. The words go there in the box; nothing is built
        // until the person presses Build, so a handed-over description is never spent behind their back.
        if (mode === 'new') return res.redirect(303, start.spaceHref({ kind: b.kind, text }));
        let repoUrl = '';
        let targets = null;   // several OpenVibe projects for one request: one task each, the first one opens
        if (mode === 'openvibe') {
            if (!b.project || b.project === 'auto') {
                const found = start.matchProjects(text);
                if (!found.length) return back('Say which OpenVibe site this is for, in your own words (like Live, Chat or Games, or "the navbar"), or pick it from the list.');
                targets = found;
                repoUrl = found[0].url;
            } else {
                const p = start.project(b.project);
                if (!p) return back('Pick one of the OpenVibe projects from the list.');
                repoUrl = p.url;
            }
        } else {
            repoUrl = start.normalizeRepo(b.repo);
            if (!repoUrl) return back(String(b.repo || '').trim() ? 'That is not a Git address Codes can clone: use https://…, git@host:owner/name or owner/name, with no password in it.' : 'Pick a repository (owner/name or any Git URL), choose an OpenVibe site, or start something new.');
        }
        const who = models.parse(b.who !== undefined ? b.who : (b.agent ? `${String(b.agent).trim()}|` : ''), harnesses);
        if (!who) return back('Choose who works on it from the list.');
        const agent = who.agent || '';
        let args;
        const { parseArgs } = require('../../harness/job');
        const jobInput = (repo, prompt) => JSON.stringify({ repo, prompt, agent: agent || null, ...(who.model ? { model: who.model } : {}), permission: 'edit', ...(b.effort ? { effort: String(b.effort) } : {}) });
        try {
            args = parseArgs(jobInput(repoUrl, text));
        } catch (e) { return back(`Check the repository: ${e.message}.`); }
        let project = null;
        try { project = (await tasks.latestProject?.(req.viewer.subject)) || await conductor.projectFor(req.viewer.token || null, req.viewer.subject); } catch { project = null; }
        if (!project) return back('Codes could not find or make a project for you on OpenVibe.Services: sign in again and retry.');
        if (agent) await userSettings.save(req.viewer.subject, { default_agent: agent }).catch(() => {});
        if (targets && targets.length > 1) {
            // One request across several projects: a task for each, each told what the others are, so the parts agree.
            const names = targets.map((x) => x.repository.replace(/^OpenVibers\//, ''));
            let first = null;
            for (const [i, x] of targets.entries()) {
                const note = `\n\n(This request spans ${names.join(', ')}. This task is the ${names[i]} part; the others are separate tasks. Change only what this repository needs, and keep the names and behaviour consistent with the other parts.)`;
                const each = parseArgs(jobInput(x.url, `${text}${note}`.slice(0, 16000)));
                const row = await tasks.start({ subject: req.viewer.subject, project: project.id || project, args: each });
                if (!first) first = row;
            }
            return res.redirect(303, `/tasks/${encodeURIComponent(first.id)}`);
        }
        const row = await tasks.start({ subject: req.viewer.subject, project: project.id || project, args });
        return res.redirect(303, `/tasks/${encodeURIComponent(row.id)}`);
    });

    // One conversation.
    r.get('/tasks/:id', async (req, res, next) => {
        if (!viewer(req)) return next();
        if (!safeId(req.params.id)) return next();
        const row = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 AND subject = $2', [req.params.id, req.viewer.subject]);
        if (!row) return next();
        const [word, tone] = stateOf(row);
        const live = LIVE.includes(row.state);
        const error = String(req.query.error || '').slice(0, 200);
        const head = `<h1 class="ch-title">${esc(titleOf(row))}</h1><span class="ch-state is-${tone}" data-ch-state>${tone === 'busy' ? '<span class="ch-dot is-busy"></span>' : ''}${esc(word)}</span>`;
        if (row.kind === 'conductor') {
            const view = await conductor.view(row);
            const last = await db.maybe('SELECT max(seq) AS seq FROM codes_session_lines WHERE task_id = $1', [row.id]);
            const model = String(row.model || 'opus');
            const pickers = `<span class="ch-chip ch-chip-static" title="The conductor runs Claude Code on your machine">${avatar(agentOf('claude-code'))}${esc(model)}</span><label class="ch-pick ch-pick-file" title="Attach an image">${ico('attach')}<span class="ch-sr">Attach an image</span><input type="file" accept="image/*" multiple data-ch-images></label>`;
            return frame(req, res, {
                currentId: row.id, title: 'Conductor', head, side: await sideHtml(row),
                thread: (error ? `<p class="ch-error" role="alert">${esc(error)}</p>` : '') + await conductorThread(row, view),
                streamUrl: `/api/v1/tasks/${encodeURIComponent(row.id)}/events?last_event_id=${last && last.seq != null ? Number(last.seq) : 0}`,
                composerHtml: row.outcome === 'stopped' ? '' : composer({ action: `/tasks/${encodeURIComponent(row.id)}/messages`, api: `/api/v1/conductor/${encodeURIComponent(row.id)}/messages`, placeholder: live ? 'Say something: it is the next turn' : 'What next?', pickers, note: live ? 'A message waits until the current turn ends; it is not lost.' : '' }),
            });
        }
        // The stream starts after the last line this page already shows.
        const seqRow = live ? await db.maybe('SELECT max(seq) AS seq FROM codes_session_lines WHERE task_id = $1', [row.id]) : null;
        const lastSeq = seqRow && seqRow.seq != null ? Number(seqRow.seq) : 0;
        const pickers = whoPicker('', { label: 'Who carries on', auto: `Same agent (${agentOf(row.agent, agentNames()).name})` }) + effortPicker('');
        return frame(req, res, {
            currentId: row.id, title: titleOf(row), head, side: await sideHtml(row),
            thread: (error ? `<p class="ch-error" role="alert">${esc(error)}</p>` : '') + await taskThread(row),
            streamUrl: live ? `/api/v1/tasks/${encodeURIComponent(row.id)}/events?last_event_id=${lastSeq}` : '',
            composerHtml: row.outcome === 'stopped' ? '' : composer({
                action: `/tasks/${encodeURIComponent(row.id)}/continue`, api: `/api/v1/tasks/${encodeURIComponent(row.id)}/continue`, live,
                stopAction: `/tasks/${encodeURIComponent(row.id)}/stop`,
                placeholder: live ? 'Wait for this turn, or stop it' : 'Ask for a change, or tell it what to do next', pickers,
            }),
        });
    });

    /** The next turn of a coding task: the same agent carries on with the note, or another one takes over. */
    r.post('/tasks/:id/continue', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        if (!safeId(req.params.id)) return res.status(404).send('Not found');
        const row = await db.maybe("SELECT * FROM run_tasks WHERE id = $1 AND subject = $2 AND kind <> 'conductor'", [req.params.id, req.viewer.subject]);
        if (!row) return res.status(404).send('Not found');
        const b = req.body || {};
        const who = models.parse(b.who !== undefined ? b.who : (b.agent ? `${String(b.agent).trim()}|` : ''), harnesses);
        if (!who) return res.redirect(303, `/tasks/${encodeURIComponent(row.id)}?error=${encodeURIComponent('Choose who carries on from the list.')}`);
        // The same agent with another model carries on; another agent takes over.
        const agent = who.agent && who.agent !== row.agent ? who.agent : null;
        const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(b.effort) ? b.effort : null;
        const out = await tasks.continueTask(row, { note: String(b.text || '').slice(0, 4000), agent, model: who.model, effort });
        return res.redirect(303, `/tasks/${encodeURIComponent(row.id)}${out.error ? `?error=${encodeURIComponent(out.error)}` : ''}`);
    });

    /** Stop the running turn. */
    r.post('/tasks/:id/stop', form, async (req, res) => {
        if (!viewer(req)) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        if (!safeId(req.params.id)) return res.status(404).send('Not found');
        const row = await db.maybe('SELECT * FROM run_tasks WHERE id = $1 AND subject = $2', [req.params.id, req.viewer.subject]);
        if (!row) return res.status(404).send('Not found');
        const out = await tasks.stopTask(row);
        return res.redirect(303, `/tasks/${encodeURIComponent(row.id)}${out.error ? `?error=${encodeURIComponent(out.error)}` : ''}`);
    });

    return r;
}

module.exports = { createChatRoutes, stepKind, titleOf, stateOf };
