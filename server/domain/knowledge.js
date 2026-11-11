'use strict';

/**
 * Know K5: workspace knowledge on OpenVibe.Codes.
 *
 * The lessons and facts a person's own coding runs taught them (what failed and why, the repository's commands, its
 * traps), stored here and nowhere else. A row is private to the person unless they share it with a team — a Network
 * developer project, the same prj_… a run belongs to. A shared row is readable by the project's members and by nobody
 * else; only its owner may edit, pin, share or delete it.
 *
 * Secrets never reach the table: every text is scrubbed before it is written (server/domain/knowledge scrubs with the
 * same provider-key, GitHub-token, JWT, private-key and key=value patterns the harness uses, plus the shapes a person's
 * files carry). A capture is idempotent per (subject, kind, dedupe key), so the same ending seen twice raises `seen`
 * and moves the row's date instead of writing a second one.
 *
 *   projectsOf(token)                 the person's projects (teams), from Network with their own token
 *   list({ subject, teamIds, … })     the rows the person may read
 *   remember({ … })                   add one row (redacted, deduped), or raise the one it repeats
 *   edit/pin/remove/share/unshare     the owner's changes
 *   captureTask(row)                  what a finished run taught: its Learned: lines, a failure, a failed command
 *   captureSummary(row, ending)       the session summary: one rewritten row per repository ("Previously")
 *   recall({ subject, projectId, … }) the few rows the next run's prompt gets, with the previous session first
 *   block(rows)                       those rows as the prompt's own section
 *
 * A store that cannot be reached gives no rows, never an error: a run must not fail because memory is unavailable.
 */

const crypto = require('crypto');
const { scrub: harnessScrub } = require('../../engine/redact');

const KINDS = ['lesson', 'fact'];
const MAX_TEXT = 2000;
const MAX_BLOCK = 1600;
const MAX_CAPTURE = 6;

// The shapes a coding tool's output carries that the harness scrubber does not name yet: Slack, AWS, Google, npm,
// Hugging Face, SendGrid, env-style assignments and connection strings. Each match becomes [redacted].
const EXTRA_SECRETS = [
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    /\bAIza[0-9A-Za-z_-]{30,}/g,
    /\bnpm_[A-Za-z0-9]{30,}/g,
    /\bhf_[A-Za-z0-9]{30,}/g,
    /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    /\b([A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|credentials|cookie|session))(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi,
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:@\s/]+:[^@\s/]+@/gi,
];

/** A text with every secret it names replaced; → { text, redacted }. */
function scrub(input) {
    let text = String(input == null ? '' : input);
    const before = text;
    text = harnessScrub(text);
    for (const re of EXTRA_SECRETS) {
        text = text.replace(re, (match, name, sep) => {
            if (typeof name === 'string' && typeof sep === 'string') return `${name}${sep}[redacted]`;
            if (/^-----BEGIN/.test(match)) return '[redacted]';
            if (/^[a-z]+:\/\//i.test(match)) return match.replace(/:\/\/.*$/, '://[redacted]');
            return '[redacted]';
        });
    }
    return { text, redacted: text !== before };
}

/** One line of text, with control characters removed and the length capped. */
function clean(input, max = MAX_TEXT) {
    const text = String(input == null ? '' : input)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\r\n?/g, '\n')
        .trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The repository a row is about, normalized for matching: host/owner/name, or the raw value when it is not a URL. */
function repoOf(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return null;
    if (raw === 'bench://') return 'bench';
    const ssh = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(raw);
    if (ssh) return `${ssh[1].toLowerCase()}/${ssh[2].replace(/\.git$/i, '')}`;
    try {
        const url = new URL(raw);
        if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return clean(raw, 200);
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length >= 2) return `${url.hostname.toLowerCase()}/${parts.slice(0, 2).join('/').replace(/\.git$/i, '')}`;
        return `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git$/i, '')}`;
    } catch {
        // A bare owner/name is a GitHub repository (the page's form and the API accept both shapes).
        return /^[\w.-]+\/[\w.-]+$/.test(raw) ? `github.com/${raw.replace(/\.git$/i, '')}` : clean(raw, 200);
    }
}

const normalize = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\w ./:-]+/g, '').trim();

/** The key a repeated row is recognized by: the kind, repo and normalized text. */
function dedupeKey({ kind, text, repo }) {
    return crypto.createHash('sha256').update(`${kind}\u0000${repo || ''}\u0000${normalize(text)}`).digest('hex');
}

const pathsOf = (paths) => [...new Set((Array.isArray(paths) ? paths : []).map((p) => String(p || '').trim()).filter(Boolean))].slice(0, 12);

/** One row per person and repository: what the last session there was asked, and how it ended. The fixed key means
 * every task rewrites the same row instead of adding one (the upsert keeps the first text, so the writer removes
 * the old row first and remembers the new one). */
function summaryKey(repo) {
    return `summary:${repoOf(repo) || 'workspace'}`.slice(0, 200);
}

/** The one-line session summary. The ending's state in plain words, with its first line of why. */
function summaryText({ repo, prompt, ending } = {}) {
    const where = repoOf(repo) || 'this workspace';
    const asked = clean(String(prompt || '').split(/\r?\n/)[0], 120) || 'a task';
    const state = String((ending && ending.state) || 'unfinished');
    const word = { done: 'finished', succeeded: 'finished', failed: 'failed', cancelled: 'cancelled', expired: 'expired', stopped: 'stopped' }[state] || state;
    const why = ending && (ending.error || ending.note) ? ` — ${clean(String(ending.error || ending.note).split(/\r?\n/)[0], 160)}` : '';
    return `Previously on ${where}: ${asked} — ${word}${why}.`;
}

/** The paths a text names, the way the portal's lessons store reads them (a small, useful signal). */
function pathsIn(text) {
    const value = String(text || '');
    const found = new Set();
    // A path with at least one folder: src/app.js, openvibe-shared/serve.js.
    for (const m of value.matchAll(/(?:^|[\s`'"(])((?:[\w.-]+\/){1,6}[\w.-]+\.[A-Za-z0-9]{1,8})(?=[\s`'"),.:;]|$)/g)) found.add(m[1]);
    // A bare filename a run can act on (package.json, server.js); a version number is not a path.
    for (const m of value.matchAll(/(?:^|[\s`'"(])([\w.-]+\.(?:js|mjs|cjs|ts|json|md|go|py|rb|rs|java|kt|sql|yml|yaml|toml|sh|css|html|jsx|tsx))(?=[\s`'"),.:;]|$)/gi)) found.add(m[1]);
    return [...found].slice(0, 12);
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') { try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch { return []; } }
    return [];
}

const iso = (ms) => (Number.isFinite(Number(ms)) ? new Date(Number(ms)).toISOString() : null);

/** What a row looks like outside the store. The owner's subject is not exposed: a reader knows whose row it is only
 *  as "yours" or "a teammate's". */
function present(row, { subject } = {}) {
    if (!row) return null;
    return {
        id: row.id,
        kind: row.kind,
        text: row.text,
        repo: row.repo || null,
        paths: asArray(row.paths),
        pinned: !!row.pinned,
        visibility: row.visibility,
        team_id: row.team_id || null,
        mine: subject ? row.subject === subject : undefined,
        source: row.source_task ? { task: row.source_task, job: row.source_job || null, agent: row.source_agent || null } : null,
        seen: Number(row.seen) || 1,
        redacted: !!row.redacted,
        dream_status: row.dream_status || 'active',
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
        last_seen_at: iso(row.last_seen_at),
    };
}

/** The lessons and facts a job's prompt gets, from the rows already found. */
function block(rows, { limit = 6 } = {}) {
    const picked = (Array.isArray(rows) ? rows : []).slice(0, Math.max(1, limit));
    if (!picked.length) return '';
    const lines = picked.map((row) => {
        const tags = [row.kind, row.pinned ? 'pinned' : null, row.repo || null].filter(Boolean).join(' · ');
        const day = String(iso(row.last_seen_at) || '').slice(0, 10);
        const text = clean(row.text, 320);
        return `- [${tags}${day ? ` · ${day}` : ''}] ${text}`;
    });
    const text = [
        '## What earlier runs learned (OpenVibe.Codes Knowledge)',
        '',
        'These come from your own runs and your team’s, on this repository. They may be out of date: check the files.',
        '',
        ...lines,
    ].join('\n');
    return text.length > MAX_BLOCK ? `${text.slice(0, MAX_BLOCK - 1)}…` : text;
}

/** The Learned: lines in an agent's report (the house rules' own block). */
function learnedLines(text) {
    const out = [];
    let on = false;
    for (const line of String(text || '').split(/\r?\n/)) {
        const inline = /^\s*Learned\s*:\s*(.*)$/i.exec(line);
        if (inline) {
            on = true;
            if (inline[1].trim()) out.push(inline[1].trim());
            continue;
        }
        if (!on) continue;
        if (!line.trim()) { if (out.length) break; continue; }
        const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
        if (bullet) out.push(bullet[1].trim());
        else if (/^\s+/.test(line) && out.length) out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
        else break;
    }
    return out.filter(Boolean).slice(0, 5);
}

/** The Fact: lines in an agent's report. */
function factLines(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const m = /^\s*(?:[-*•]\s*)?Fact\s*:\s*(.+)$/i.exec(line);
        if (m) out.push(m[1].trim());
    }
    return out.filter(Boolean).slice(0, 5);
}

/** A command a repository's runs use: tests, builds and installs, not one-off reads. */
const COMMAND = /^(?:npm|pnpm|yarn|bun|node|npx|pytest|python(?:3)? -m pytest|go test|cargo test|cargo build|make|just|deno test|php|ruby|bundle exec|mvn|gradle|dotnet test|mix test)\b/;

function createKnowledge({ store, config = {}, fetchImpl = globalThis.fetch, log = console } = {}) {
    const db = store.db;
    const now = () => store.now();

    /** The person's projects (their teams), from Network with their own token. A Network that cannot answer gives none. */
    async function projectsOf(token) {
        if (!token || !config.networkInternalUrl) return [];
        try {
            const res = await fetchImpl(`${String(config.networkInternalUrl).replace(/\/+$/, '')}/api/v1/projects`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) return [];
            const doc = await res.json().catch(() => null);
            return (Array.isArray(doc && doc.projects) ? doc.projects : [])
                .filter((p) => p && p.id && !p.archived_at)
                .map((p) => ({ id: p.id, name: p.name || p.id, role: p.role || null }));
        } catch (e) {
            log.warn(`[Codes] knowledge: Network did not answer the projects: ${String((e && e.message) || e).slice(0, 160)}`);
            return [];
        }
    }

    const teamIdsOf = async (token) => (await projectsOf(token)).map((p) => p.id);

    /**
     * The rows a person may read: their own, plus the team-shared rows of the teams named. With teamIds null, only
     * private rows are read (an internal caller with no person token, e.g. a run started by a service).
     */
    async function list({ subject, teamIds = null, q = null, repo = null, kind = null, pinned = false, limit = 100 } = {}) {
        const teams = Array.isArray(teamIds) ? teamIds.filter(Boolean) : [];
        const max = Math.max(1, Math.min(500, Number(limit) || 100));
        return await db.many(
            `SELECT * FROM codes_knowledge
              WHERE (subject = $1 OR (visibility = 'team' AND team_id = ANY($2::text[])))
                AND ($3::text IS NULL OR kind = $3)
                AND ($4::boolean IS NOT TRUE OR pinned = true)
                AND ($5::text IS NULL OR repo = $5)
                AND ($6::text IS NULL OR position(lower($6) in lower(text)) > 0)
              ORDER BY pinned DESC, last_seen_at DESC, created_at DESC
              LIMIT $7`,
            [subject, teams, kind, !!pinned, repo, q ? String(q).slice(0, 200) : null, max],
        );
    }

    /** One row the person may read, or null. */
    async function get({ subject, id, teamIds = [] }) {
        const teams = Array.isArray(teamIds) ? teamIds.filter(Boolean) : [];
        return await db.maybe(
            `SELECT * FROM codes_knowledge WHERE id = $1 AND (subject = $2 OR (visibility = 'team' AND team_id = ANY($3::text[])))`,
            [String(id || ''), subject, teams],
        );
    }

    /** Add one row, or raise the one it repeats. → { row, created, redacted }. A fixed `key` names the row instead
     * of the text hash: the same key rewritten is the same row (the session summary), never a second one. */
    async function remember({ subject, kind = 'lesson', text, repo = null, paths = [], sourceTask = null, sourceJob = null, sourceAgent = null, teamId = null, pinned = false, visibility = null, key = null } = {}) {
        const k = KINDS.includes(kind) ? kind : 'lesson';
        const fixed = key == null ? null : String(key).slice(0, 200).trim() || null;
        const cleaned = scrub(clean(text));
        if (!cleaned.text || cleaned.text === '[redacted]') {
            throw Object.assign(new Error('there is nothing to remember after removing the secrets'), { status: 422, code: 'knowledge.empty' });
        }
        const repository = repoOf(repo);
        const allPaths = [...new Set([...pathsOf(paths), ...pathsIn(cleaned.text)])].slice(0, 12);
        const at = now();
        const id = store.newId('kn');
        const share = visibility === 'team' && teamId ? { visibility: 'team', team_id: String(teamId) } : { visibility: 'private', team_id: null };
        const row = await db.one(
            `INSERT INTO codes_knowledge
                (id, subject, team_id, visibility, kind, text, repo, paths, source_task, source_job, source_agent,
                 dedupe_key, seen, pinned, redacted, created_at, updated_at, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, 1, $13, $14, $15, $15, $15)
             ON CONFLICT (subject, kind, dedupe_key) WHERE dedupe_key IS NOT NULL
             DO UPDATE SET seen = CASE WHEN EXCLUDED.source_task IS NOT NULL AND codes_knowledge.source_task = EXCLUDED.source_task
                                       THEN codes_knowledge.seen ELSE codes_knowledge.seen + 1 END,
                           last_seen_at = EXCLUDED.last_seen_at,
                           updated_at = EXCLUDED.updated_at,
                           dream_status = 'active',
                           source_task = COALESCE(EXCLUDED.source_task, codes_knowledge.source_task),
                           source_job = COALESCE(EXCLUDED.source_job, codes_knowledge.source_job),
                           source_agent = COALESCE(EXCLUDED.source_agent, codes_knowledge.source_agent)
             RETURNING *, (xmax = 0) AS created`,
            [id, subject, share.team_id, share.visibility, k, cleaned.text, repository, JSON.stringify(allPaths),
                sourceTask ? String(sourceTask) : null, sourceJob ? String(sourceJob) : null, sourceAgent ? String(sourceAgent) : null,
                fixed || dedupeKey({ kind: k, text: cleaned.text, repo: repository }), !!pinned, cleaned.redacted, at],
        );
        return { row, created: !!row.created, redacted: cleaned.redacted };
    }

    /** The owner's edit of one row: its text and kind (a new dedupe key follows the new text). */
    async function edit({ subject, id, text, kind, pinned } = {}) {
        const row = await db.maybe('SELECT * FROM codes_knowledge WHERE id = $1 AND subject = $2', [String(id || ''), subject]);
        if (!row) return null;
        const k = KINDS.includes(kind) ? kind : row.kind;
        const cleaned = scrub(clean(text == null ? row.text : text));
        if (!cleaned.text || cleaned.text === '[redacted]') {
            throw Object.assign(new Error('there is nothing to remember after removing the secrets'), { status: 422, code: 'knowledge.empty' });
        }
        const repository = repoOf(row.repo);
        return await db.one(
            `UPDATE codes_knowledge SET text = $2, kind = $3, dedupe_key = $4, redacted = $5,
                    source_task = NULL, source_job = NULL, dream_status = 'active',
                    pinned = COALESCE($6::boolean, pinned), updated_at = $7
              WHERE id = $1 RETURNING *`,
            [row.id, cleaned.text, k, dedupeKey({ kind: k, text: cleaned.text, repo: repository }), cleaned.redacted,
                typeof pinned === 'boolean' ? pinned : null, now()],
        );
    }

    /** Pin or unpin the owner's row. */
    async function pin({ subject, id, pinned = true } = {}) {
        return await db.maybe('UPDATE codes_knowledge SET pinned = $3, updated_at = $4 WHERE id = $1 AND subject = $2 RETURNING *',
            [String(id || ''), subject, !!pinned, now()]);
    }

    /** The owner's row, gone. */
    async function remove({ subject, id } = {}) {
        return await db.maybe('DELETE FROM codes_knowledge WHERE id = $1 AND subject = $2 RETURNING *', [String(id || ''), subject]);
    }

    /** Share the owner's row with one of their teams. The route has already checked the person is a member. */
    async function share({ subject, id, teamId } = {}) {
        return await db.maybe(`UPDATE codes_knowledge SET visibility = 'team', team_id = $3, updated_at = $4
                                WHERE id = $1 AND subject = $2 RETURNING *`, [String(id || ''), subject, String(teamId || ''), now()]);
    }

    /** The owner's row, private again. */
    async function unshare({ subject, id } = {}) {
        return await db.maybe(`UPDATE codes_knowledge SET visibility = 'private', team_id = NULL, updated_at = $3
                                WHERE id = $1 AND subject = $2 RETURNING *`, [String(id || ''), subject, now()]);
    }

    /**
     * What one finished run taught, captured idempotently: the agent's Learned: and Fact: lines, a failure with its
     * reason, the command that failed, and the commands the repository's runs use. Never the whole transcript.
     */
    async function captureTask(row) {
        if (!row || !row.id || !row.subject) return [];
        const result = row.result && typeof row.result === 'object' ? row.result : {};
        const logLines = Array.isArray(result.log) ? result.log : [];
        const summary = String(result.summary || '');
        const texts = [summary, ...logLines.filter((l) => l && (l.t === 'text' || l.t === 'done')).map((l) => String(l.text || ''))];
        const agent = (Array.isArray(result.agents) && result.agents[0]) || row.agent || null;
        const repo = repoOf(row.repo);
        const day = new Date(now()).toISOString().slice(0, 10);
        const entries = [];

        for (const text of texts) {
            for (const line of learnedLines(text)) entries.push({ kind: 'lesson', text: line });
            for (const line of factLines(text)) entries.push({ kind: 'fact', text: line });
        }

        const failed = result.ok === false || (row.state && row.state !== 'succeeded');
        if (failed) {
            const why = clean(String(row.error || result.error || summary || 'no error was reported').split(/\r?\n/)[0], 320);
            entries.push({ kind: 'lesson', text: `${repo || 'This workspace'}: ${agent || 'an agent'} did not finish — ${why}` });
            // The command that failed: the tool result keeps the id of the tool call that ran it.
            const commands = new Map();
            for (const line of logLines) {
                if (line && line.t === 'tool' && line.id && line.input && line.input.command) commands.set(String(line.id), String(line.input.command));
            }
            const bad = [...logLines].reverse().find((l) => l && l.t === 'tool_result' && l.ok === false && String(l.output || '').trim());
            if (bad) {
                const command = commands.get(String(bad.id || ''));
                const output = clean(String(bad.output || '').split(/\r?\n/).slice(0, 3).join(' '), 240);
                entries.push({ kind: 'lesson', text: `${repo || 'This repository'}: \`${command || 'a command'}\` failed — ${output}` });
            }
        }

        // The commands this repository's runs use, as facts: tests, builds and installs, at most two.
        const seenCommands = new Set();
        for (const line of logLines) {
            const command = line && line.t === 'tool' && line.input && line.input.command ? String(line.input.command).trim() : '';
            if (!command || !COMMAND.test(command) || seenCommands.has(command)) continue;
            seenCommands.add(command);
            entries.push({ kind: 'fact', text: `${repo || 'This workspace'}: \`${clean(command, 160)}\` is a command its runs use (ran by ${agent || 'an agent'} on ${day}).` });
            if (seenCommands.size >= 2) break;
        }

        const out = [];
        for (const entry of entries.slice(0, MAX_CAPTURE)) {
            try {
                const saved = await remember({
                    subject: row.subject, kind: entry.kind, text: entry.text, repo, paths: pathsIn(entry.text),
                    sourceTask: row.id, sourceJob: row.job_id || null, sourceAgent: agent,
                });
                out.push(saved.row);
            } catch (e) {
                if (!e || e.code !== 'knowledge.empty') log.warn(`[Codes] knowledge capture for ${row.id}: ${String((e && e.message) || e).slice(0, 160)}`);
            }
        }
        return out;
    }

    /** Write this task as the repository's session summary: what it was asked, how its last attempt ended. */
    async function captureSummary(row, ending = null) {
        if (!row || !row.id || !row.subject) return null;
        const key = summaryKey(row.repo);
        const text = summaryText({ repo: row.repo, prompt: row.prompt, ending });
        const agent = (row.result && typeof row.result === 'object' && Array.isArray(row.result.agents) && row.result.agents[0])
            || row.agent || null;
        try {
            await db.exec('DELETE FROM codes_knowledge WHERE subject = $1 AND kind = $2 AND dedupe_key = $3',
                [row.subject, 'fact', key]);
            const saved = await remember({
                subject: row.subject, kind: 'fact', text, repo: row.repo, key,
                sourceTask: row.id, sourceJob: row.job_id || null, sourceAgent: agent,
            });
            return saved.row;
        } catch (e) {
            if (!e || e.code !== 'knowledge.empty') log.warn(`[Codes] knowledge summary for ${row.id}: ${String((e && e.message) || e).slice(0, 160)}`);
            return null;
        }
    }

    /** Recheck a bounded batch of auto-captured rows against the saved task transcript, once per day.
     * Re-capture restores missed observations through remember's exact dedupe key. A row the transcript no longer
     * supports stays visible to its owner but cannot steer a later run. Owner edits become manual rows and are never
     * touched by this pass. The cursor carries a large backlog across nights. */
    async function dream({ force = false, limit = 50 } = {}) {
        const at = now();
        const state = await db.maybe('SELECT last_at, cursor FROM codes_knowledge_dream_state WHERE name = $1', ['nightly']);
        if (!force && state && at - Number(state.last_at) < 86400e3) return { skipped: true, processed: 0, unsupported: 0 };
        const batch = Math.max(1, Math.min(100, Number(limit) || 50));
        const tasks = await db.many(`SELECT t.id, t.subject, t.repo, t.job_id, t.agent, t.state, t.error,
                    t.result - 'patch' - 'files' AS result
                FROM run_tasks t
                WHERE t.id > $1 AND t.state IN ('succeeded', 'failed', 'cancelled', 'expired')
                  AND EXISTS (SELECT 1 FROM codes_knowledge k WHERE k.source_task = t.id AND k.subject = t.subject
                              AND k.dedupe_key NOT LIKE 'summary:%')
                ORDER BY t.id LIMIT $2`, [state && state.cursor || '', batch]);
        let unsupported = 0;
        for (const task of tasks) {
            const before = await db.many(`SELECT id FROM codes_knowledge
                WHERE source_task = $1 AND subject = $2 AND pinned = false AND visibility = 'private'
                  AND updated_at = last_seen_at AND dedupe_key NOT LIKE 'summary:%'`, [task.id, task.subject]);
            const supported = new Set((await captureTask(task)).map((row) => row.id));
            for (const row of before) {
                if (supported.has(row.id)) continue;
                await db.exec(`UPDATE codes_knowledge SET dream_status = 'unsupported'
                    WHERE id = $1 AND source_task = $2 AND subject = $3 AND pinned = false AND visibility = 'private'
                      AND updated_at = last_seen_at`,
                [row.id, task.id, task.subject]);
                unsupported++;
            }
        }
        const cursor = tasks.length === batch ? tasks[tasks.length - 1].id : '';
        await db.exec(`INSERT INTO codes_knowledge_dream_state (name, last_at, cursor) VALUES ($1, $2, $3)
            ON CONFLICT (name) DO UPDATE SET last_at = EXCLUDED.last_at, cursor = EXCLUDED.cursor`,
        ['nightly', at, cursor]);
        return { skipped: false, processed: tasks.length, unsupported, cursor };
    }

    /** Rank the rows a next run should see: pinned first, then this repository, then the words it shares with the brief. */
    function rank(rows, { repo, prompt } = {}) {
        const words = new Set(String(prompt || '').toLowerCase().match(/[a-z0-9_./-]{4,}/g) || []);
        const at = now();
        return (Array.isArray(rows) ? rows : [])
            .map((row) => {
                let score = 0;
                if (row.pinned) score += 10;
                if (repo && row.repo === repo) score += 4;
                const text = String(row.text || '').toLowerCase();
                for (const w of words) if (text.includes(w)) score += 1;
                const days = Math.max(0, (at - Number(row.last_seen_at || 0)) / 86400000);
                score += Math.max(0, 3 - days / 7);
                return { row, score };
            })
            .filter((x) => x.score > 0 && (x.row.pinned || (repo && x.row.repo === repo) || x.score > 3))
            .sort((a, b) => b.score - a.score || Number(b.row.last_seen_at) - Number(a.row.last_seen_at) || String(a.row.id).localeCompare(String(b.row.id)))
            .map((x) => x.row);
    }

    /**
     * The rows the next run's prompt gets. `projectId` is the run's own project: its team-shared rows are read without
     * asking Network again (the run was started in that project, so the person belongs to it).
     */
    async function recall({ subject, projectId = null, repo = null, prompt = '', limit = 6 } = {}) {
        const teams = projectId && String(projectId).startsWith('prj_') ? [projectId] : [];
        const rows = await list({ subject, teamIds: teams, limit: 200 });
        // The session summary stands apart from the ranked rows: it is the last session, not a lesson, and the next
        // run reads it first. It is keyed by repository, so a summary from another repository never leaks in.
        const key = summaryKey(repo);
        const previous = rows.find((r) => r.kind === 'fact' && r.dedupe_key === key) || null;
        const rest = rows.filter((r) => r !== previous && (r.dream_status || 'active') === 'active');
        const picked = rank(rest, { repo: repoOf(repo), prompt }).slice(0, Math.max(1, Math.min(8, limit)));
        return { rows: picked, previous, previousText: previous ? previous.text : '', text: block(picked, { limit: picked.length }) };
    }

    return {
        projectsOf, teamIdsOf, list, get, remember, edit, pin, remove, share, unshare, captureTask, captureSummary, dream,
        summaryKey, summaryText, recall, rank,
        block, present: (row, opts) => present(row, opts), scrub, repoOf, learnedLines, factLines, KINDS,
    };
}

module.exports = {
    createKnowledge, block, scrub, repoOf, learnedLines, factLines, dedupeKey, pathsIn, present, KINDS, MAX_TEXT,
    summaryKey, summaryText,
};
