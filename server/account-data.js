'use strict';
/**
 * Account export and deletion → Codes (ADR-033; openvibe-sdk/account-data).
 *
 * What Codes holds about a person:
 * - the coding tasks they started (run_tasks, plan T16), with their session lines (codes_session_lines);
 * - each task's attempts (codes_attempts, C2), the task's proof (codes_task_proof, C8) and the events Codes took in
 *   about it (codes_events_inbox);
 * - the run tokens minted for their attempts (codes_run_tokens, C3: ids and expiry, never the token);
 * - their workspace choices (codes_user_settings, C4b) and their placement rules;
 * - the files they attached to a message (codes_attachments, owner 2026-11-07): names, types and sizes, never bytes;
 * - the placement counts learned about their tasks (placement_outcomes, A1): option keys and weights, never text;
 * - their conductor's turns (codes_conductor_messages, C9b) and the approvals it asked them (codes_approvals);
 * - the events Codes sent about them (codes_outbox);
 * - telemetry samples that name them: the SDK covers telemetry_samples itself (telemetry.json, then subject NULL).
 *
 * Export carries the tasks whole, and the task-keyed rows as session-lines.json, attempts.json and proof.json.
 * Deletion erases everything task-keyed and then the tasks, in one transaction. Telemetry samples stay as numbers with
 * the person's id removed. The Run jobs themselves are OpenVibe.Run's records (usage billed to the project) and are
 * Run's to answer for.
 *
 * test/account-data.test.js asserts uncovered() is empty, so a new table with a person column fails CI until it is
 * added to TABLES or TASK_KEYED, or exempted there with a reason.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const SESSION_LINES_MAX = 20000;
const TASK_ROWS_MAX = 20000;

const TABLES = [
    {
        table: 'run_tasks', subject: 'subject', file: 'run-tasks.json', order: 'created_at',
        columns: ['id', 'project_id', 'job_id', 'repo', 'ref', 'prompt', 'agent', 'push', 'pull_request', 'state', 'result', 'error', 'started_at', 'finished_at', 'created_at', 'updated_at', 'machine', 'pin', 'model_plan', 'plan_source', 'preset', 'role_runs'],
        // Erased by extraErase below, after the rows that point at these task ids (the SDK deletes the table's rows
        // before calling it, so a default delete here would lose the ids first).
        erase: { keep: 'erased with its task-keyed rows by the service extraErase' },
    },
    // Race mode (compare-arena-ecosystem.md §5): the person's races, their two sides and the match body they
    // recorded. The check rows hang under a race (codes_race_checks.race_id, ON DELETE CASCADE) and leave with it.
    {
        table: 'codes_races', subject: 'subject', file: 'races.json', order: 'created_at',
        columns: ['id', 'project_id', 'source_task_id', 'repo', 'ref', 'prompt', 'permission', 'budget', 'sides', 'shown', 'state', 'match_id', 'match_body', 'match_recorded', 'merged_slot', 'merged_judged', 'error', 'created_at', 'updated_at'],
    },
    { table: 'codes_user_settings', subject: 'subject', file: 'settings.json', order: 'updated_at' },
    { table: 'codes_model_plans', subject: 'subject', file: 'model-plans.json', order: 'updated_at' },
    // The files a person attached to a message (owner 2026-11-07): what they are and which turn they belong to. The
    // bytes are theirs too, but the export carries the record, not a second copy of every 20 MB file; deletion takes
    // the rows (and their bytes) with the person.
    { table: 'codes_attachments', subject: 'subject', file: 'attachments.json', order: 'created_at', columns: ['id', 'task_id', 'attempt_n', 'message_id', 'name', 'mime', 'size', 'created_at', 'linked_at'] },
    // Placement A1's learned counts: the person's rows leave and are erased with them. No text, no payload.
    { table: 'placement_outcomes', subject: 'person_id', file: 'placement-outcomes.json', order: 'updated_at', columns: ['person_id', 'option_key', 'step_kind', 'ok_w', 'n_w', 'updated_at'] },
    // What each of the person's machines reported with its heartbeat (Codes C9c): labels, numbers and times only, no
    // key, token or account name. Theirs to export and to erase.
    { table: 'codes_machine_fleet', subject: 'subject', file: 'fleet.json', order: 'machine', columns: ['machine', 'node_id', 'name', 'agent', 'installed', 'signed_in', 'windows', 'online', 'reported_at', 'updated_at'] },
    // The token itself is never stored; its jti is an internal handle and stays out of the export.
    { table: 'codes_run_tokens', subject: 'subject', file: 'run-tokens.json', order: 'created_at', columns: ['id', 'task_id', 'attempt_id', 'provider', 'expires_at', 'created_at'] },
    { table: 'codes_outbox', subject: 'subject', file: 'events-sent.json', order: 'created_at', columns: ['event_id', 'topic', 'created_at', 'published_at'] },
    // The OpenVibe Git link: which forge account, and since when. The sealed tokens never leave; erased with the rest.
    { table: 'codes_forge_links', subject: 'subject', file: 'openvibe-git-link.json', order: 'created_at', columns: ['forge_user', 'expires_at', 'created_at', 'updated_at'] },
    // Know K5: the lessons and facts the person's runs taught. Theirs to take and to erase; a row already shared
    // with a team leaves with its owner's account (the team's other rows stay).
    { table: 'codes_knowledge', subject: 'subject', file: 'knowledge.json', order: 'created_at', columns: ['id', 'kind', 'text', 'repo', 'paths', 'visibility', 'team_id', 'pinned', 'redacted', 'seen', 'source_task', 'source_agent', 'created_at', 'updated_at', 'last_seen_at'] },
    // The person's default audience for new run tasks (design 2026-11-06): what their next task starts as.
    { table: 'codes_share_defaults', subject: 'subject', file: 'share-defaults.json', order: 'updated_at' },
    // The skills hub (Compute plan §5): the records they own and the ones they chose to sync. A record's body lives
    // in its versions, which leave with the record; the share rows are erased in extraErase with the record's ids.
    {
        table: 'codes_skills', subject: 'owner_subject', file: 'skills.json', order: 'created_at',
        columns: ['id', 'kind', 'slug', 'title', 'official', 'tools', 'latest_version', 'created_at', 'updated_at'],
        erase: { keep: 'deleted in extraErase with its versions, assignments and share rows' },
    },
    { table: 'codes_skill_assignments', subject: 'subject', file: 'skill-assignments.json', order: 'created_at', columns: ['skill_id', 'project', 'created_at'] },
];

// The rows that hang under a person's tasks: exported under the task, erased before it.
const TASK_KEYED = [
    { table: 'codes_session_lines', file: 'session-lines.json', columns: 'l.task_id, l.seq, l.at, l.kind, l.body', order: 'l.seq ASC', kind: 'session_lines', max: SESSION_LINES_MAX },
    { table: 'codes_attempts', file: 'attempts.json', columns: 'l.id, l.task_id, l.n, l.agent, l.model, l.machine, l.state, l.reason, l.why, l.kind, l.cost_usd, l.tokens, l.steps, l.started_at, l.finished_at, l.created_at', order: 'l.n ASC', kind: 'attempts', max: TASK_ROWS_MAX },
    { table: 'codes_task_proof', file: 'proof.json', columns: 'l.task_id, l.attempt_n, l.n, l.kind, l.label, l.ok, l.skipped, l.summary, l.family, l.detail, l.created_at', order: 'l.n ASC', kind: 'proof', max: TASK_ROWS_MAX },
    // The conductor's turns (C9b): what the person said, and what the turn answered. An attached image is exported by
    // its name, type and size; its bytes stay in the database until the person's tasks are erased.
    {
        table: 'codes_conductor_messages', file: 'conductor-messages.json',
        columns: "l.id, l.task_id, l.n, l.prompt, l.state, l.job_id, l.error, l.created_at, l.started_at, l.finished_at, COALESCE((SELECT jsonb_agg(jsonb_build_object('name', a->>'name', 'mime', a->>'mime', 'size', a->'size')) FROM jsonb_array_elements(l.attachments) a), '[]'::jsonb) AS attachments",
        order: 'l.n ASC', kind: 'conductor_messages', max: TASK_ROWS_MAX,
    },
    // The approvals the person decided, and the ones still waiting when their account is erased.
    { table: 'codes_approvals', file: 'approvals.json', columns: 'l.id, l.task_id, l.tool, l.summary, l.decision, l.message, l.created_at, l.decided_at', order: 'l.created_at ASC', kind: 'approvals', max: TASK_ROWS_MAX },
    // A message sent while an attempt ran (ask 354): what the person said, taken by the next attempt.
    {
        table: 'codes_task_messages', file: 'task-messages.json',
        columns: 'l.id, l.task_id, l.n, l.text, l.state, l.created_at',
        order: 'l.n ASC', kind: 'task_messages', max: TASK_ROWS_MAX,
    },
    { table: 'codes_events_inbox', file: null, kind: 'events_received' },
    // The one notice sent per task and state (Codes C9c): no content of its own, erased with the task, not exported.
    { table: 'codes_notices', file: null, kind: 'notices' },
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
            // The person's own skills, their versions (ON DELETE CASCADE) and the share rows of those records.
            const skills = await t.many('SELECT id FROM codes_skills WHERE owner_subject = ANY($1::text[])', [subjects]);
            if (skills.length) {
                const ids = skills.map((r) => r.id);
                await t.exec("DELETE FROM share_members WHERE service = 'codes' AND kind = 'skill' AND resource_id = ANY($1::text[])", [ids]);
                await t.exec("DELETE FROM share_access_requests WHERE service = 'codes' AND kind = 'skill' AND resource_id = ANY($1::text[])", [ids]);
                await t.exec("DELETE FROM shares WHERE service = 'codes' AND kind = 'skill' AND resource_id = ANY($1::text[])", [ids]);
                add(erased, 'codes_skills', await t.exec('DELETE FROM codes_skills WHERE id = ANY($1::text[])', [ids]));
            }
            // The sharing system's own rows (openvibe-sdk/share): a member or an access request is this person, and
            // the share rows they own carry their subject too. The subject column is jsonb, so the table map cannot
            // express it and they are erased here.
            const forms = subjects.map((s) => JSON.stringify({ type: 'user', id: s }));
            const members = await t.exec('DELETE FROM share_members WHERE subject = ANY($1::jsonb[])', [forms]);
            const requests = await t.exec('DELETE FROM share_access_requests WHERE subject = ANY($1::jsonb[])', [forms]);
            const owned = await t.exec("DELETE FROM shares WHERE service = 'codes' AND owner_subject = ANY($1::jsonb[])", [forms]);
            if (Number(members) || Number(requests) || Number(owned)) {
                add(erased, 'share_rows', Number(members) + Number(requests) + Number(owned));
            }
        },
    });
}

// The sharing system's own tables carry a person (a member, an access request). Their subject column is jsonb, so
// the table map cannot express them: they are erased in extraErase, with the rest of the person's rows.
const EXEMPT = {
    share_members: 'the sharing system own member rows: the subject is a jsonb subject, so they are erased in extraErase',
    share_access_requests: 'the sharing system own access requests: the subject is a jsonb subject, so they are erased in extraErase',
    // created_by is the author of a version, not the person whose account is being erased: a record's versions leave
    // with the record (codes_skills), and a version never outlives it.
    codes_skill_versions: 'created_by is the author of a version, not a subject column; versions leave with their skill',
    // A check row names the person (subject) but hangs under its race (race_id, ON DELETE CASCADE): it is exported
    // and erased with codes_races, never on its own.
    codes_race_checks: 'the check jobs of a race: they hang under codes_races and leave with it (ON DELETE CASCADE)',
};

module.exports = { create, TABLES, TASK_KEYED, TOPICS, EXEMPT };
