'use strict';
/**
 * Account export and deletion → Codes (ADR-033; openvibe-sdk/account-data). What Codes holds about a person is the
 * coding tasks they started on their own machine (run_tasks, plan T16) and the session lines of those tasks
 * (codes_session_lines): what they asked, the Run job, its result and its session. The export carries the tasks whole
 * and their sessions as session-lines.json; a deletion erases the session lines and then the tasks, in one
 * transaction. The Run jobs themselves are OpenVibe.Run's records (usage billed to the project) and are Run's to
 * answer for.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const SESSION_LINES_MAX = 20000;

const TABLES = [
    {
        table: 'run_tasks', subject: 'subject', file: 'run-tasks.json', order: 'created_at',
        columns: ['id', 'project_id', 'job_id', 'repo', 'ref', 'prompt', 'agent', 'push', 'pull_request', 'state', 'result', 'error', 'started_at', 'finished_at', 'created_at', 'updated_at'],
        // Erased by extraErase below, after the session lines that point at these task ids (the SDK deletes the
        // table's rows before calling it, so a default delete here would lose the ids first).
        erase: { keep: 'erased with its codes_session_lines by the service extraErase' },
    },
];

function create({ db, log = console }) {
    return createAccountData({
        db, service: 'codes', tables: TABLES, log,
        // The sessions of their tasks, line by line, in task and stream order (at most SESSION_LINES_MAX, oldest
        // tasks first out).
        extraExport: async (d, subject) => {
            const lines = await d.many(
                `SELECT l.task_id, l.seq, l.at, l.kind, l.body FROM codes_session_lines l JOIN run_tasks r ON r.id = l.task_id
                 WHERE r.subject = $1 ORDER BY r.created_at DESC, l.seq ASC LIMIT ${SESSION_LINES_MAX}`, [subject]);
            return lines.length ? [{ name: 'session-lines.json', content: lines }] : [];
        },
        extraErase: async (t, subjects, { erased, retained, add }) => {
            const rows = await t.many('SELECT id FROM run_tasks WHERE subject = ANY($1::text[])', [subjects]);
            if (rows.length) {
                const ids = rows.map((r) => r.id);
                add(erased, 'session_lines', await t.exec('DELETE FROM codes_session_lines WHERE task_id = ANY($1::text[])', [ids]));
            }
            delete retained.run_tasks;
            add(erased, 'run_tasks', await t.exec('DELETE FROM run_tasks WHERE subject = ANY($1::text[])', [subjects]));
        },
    });
}

module.exports = { create, TABLES, TOPICS };
