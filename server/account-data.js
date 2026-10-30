'use strict';
/**
 * Account export and deletion → Codes (ADR-033; openvibe-sdk/account-data).
 *
 * What Codes holds about a person:
 * - the coding tasks they started (run_tasks, plan T16), with their session lines (codes_session_lines);
 * - each task's attempts (codes_attempts, C2), the task's proof (codes_task_proof, C8) and the events Codes took in
 *   about it (codes_events_inbox);
 * - the run tokens minted for their attempts (codes_run_tokens, C3: ids and expiry, never the token);
 * - their workspace choices (codes_user_settings, C4b);
 * - the events Codes sent about them (codes_outbox);
 * - telemetry samples that name them.
 *
 * Export carries the tasks whole, and the task-keyed rows as session-lines.json, attempts.json and proof.json.
 * Deletion erases everything task-keyed and then the tasks, in one transaction. Telemetry samples stay as numbers with
 * the person's id removed. The Run jobs themselves are OpenVibe.Run's records (usage billed to the project) and are
 * Run's to answer for.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const SESSION_LINES_MAX = 20000;
const TASK_ROWS_MAX = 20000;

const TABLES = [
    {
        table: 'run_tasks', subject: 'subject', file: 'run-tasks.json', order: 'created_at',
        columns: ['id', 'project_id', 'job_id', 'repo', 'ref', 'prompt', 'agent', 'push', 'pull_request', 'state', 'result', 'error', 'started_at', 'finished_at', 'created_at', 'updated_at'],
        // Erased by extraErase below, after the rows that point at these task ids (the SDK deletes the table's rows
        // before calling it, so a default delete here would lose the ids first).
        erase: { keep: 'erased with its task-keyed rows by the service extraErase' },
    },
    { table: 'codes_user_settings', subject: 'subject', file: 'settings.json', order: 'updated_at' },
    // The token itself is never stored; its jti is an internal handle and stays out of the export.
    { table: 'codes_run_tokens', subject: 'subject', file: 'run-tokens.json', order: 'created_at', columns: ['id', 'task_id', 'attempt_id', 'provider', 'expires_at', 'created_at'] },
    { table: 'codes_outbox', subject: 'subject', file: 'events-sent.json', order: 'created_at', columns: ['event_id', 'topic', 'created_at', 'published_at'] },
    {
        table: 'telemetry_samples', subject: 'subject', file: 'telemetry.json', order: 'at',
        columns: ['at', 'operation', 'resource', 'status', 'latency_ms'],
        // The sample stays (latency and error rates are the service's), without the person in it.
        erase: { anonymize: {} },
    },
];

// The rows that hang under a person's tasks: exported under the task, erased before it.
const TASK_KEYED = [
    { table: 'codes_session_lines', file: 'session-lines.json', columns: 'l.task_id, l.seq, l.at, l.kind, l.body', order: 'l.seq ASC', kind: 'session_lines', max: SESSION_LINES_MAX },
    { table: 'codes_attempts', file: 'attempts.json', columns: 'l.id, l.task_id, l.n, l.agent, l.model, l.machine, l.state, l.reason, l.why, l.kind, l.cost_usd, l.tokens, l.steps, l.started_at, l.finished_at, l.created_at', order: 'l.n ASC', kind: 'attempts', max: TASK_ROWS_MAX },
    { table: 'codes_task_proof', file: 'proof.json', columns: 'l.task_id, l.attempt_n, l.n, l.kind, l.label, l.ok, l.skipped, l.summary, l.family, l.detail, l.created_at', order: 'l.n ASC', kind: 'proof', max: TASK_ROWS_MAX },
    { table: 'codes_events_inbox', file: null, kind: 'events_received' },
];

async function exists(q, table) {
    return Boolean(await q.maybe('SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1', [table]));
}

function create({ db, log = console }) {
    return createAccountData({
        db, service: 'codes', tables: TABLES, log,
        // The task-keyed rows of their tasks, newest tasks first (at most max rows each).
        extraExport: async (d, subject) => {
            const files = [];
            for (const k of TASK_KEYED) {
                if (!k.file || !(await exists(d, k.table))) continue;
                const rows = await d.many(
                    `SELECT ${k.columns} FROM ${k.table} l JOIN run_tasks r ON r.id = l.task_id
                     WHERE r.subject = $1 ORDER BY r.created_at DESC, ${k.order} LIMIT ${k.max}`, [subject]);
                if (rows.length) files.push({ name: k.file, content: rows });
            }
            return files;
        },
        extraErase: async (t, subjects, { erased, retained, add }) => {
            const rows = await t.many('SELECT id FROM run_tasks WHERE subject = ANY($1::text[])', [subjects]);
            if (rows.length) {
                const ids = rows.map((r) => r.id);
                for (const k of TASK_KEYED) {
                    if (!(await exists(t, k.table))) continue;
                    add(erased, k.kind, await t.exec(`DELETE FROM ${k.table} WHERE task_id = ANY($1::text[])`, [ids]));
                }
            }
            delete retained.run_tasks;
            add(erased, 'run_tasks', await t.exec('DELETE FROM run_tasks WHERE subject = ANY($1::text[])', [subjects]));
        },
    });
}

module.exports = { create, TABLES, TASK_KEYED, TOPICS };
