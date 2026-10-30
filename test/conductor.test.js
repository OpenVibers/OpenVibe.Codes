'use strict';

/**
 * Codes C9b: the conductor. One long-lived task whose single attempt is one Claude Code session on a machine the person
 * chooses; a message is the next turn of that session (Claude Code `--resume`), queued while a turn runs.
 *
 * What this checks: the shape the task, its attempt and its first turn are written with; the hand-over brief; a message
 * that waits while a turn runs and starts when it ends, resuming the session; an idle conductor (succeeded, no outcome)
 * and a stopped one; and the server's rule that a conductor may start sub-tasks on any agent except an Anthropic one.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const TASK = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;
const NODE = 'nod_01J8Z3Q4R5S6T7V8W9X0Y1Z2N1';

(async () => {
    const calls = [];
    const jobs = new Map();
    let counter = 0;
    const run = {
        enabled: true,
        async submit(o) {
            counter++;
            const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2K${String(counter).padStart(2, '0')}`;
            jobs.set(id, { id, state: 'queued', args: o.args });
            calls.push(['submit', o]);
            return { id, state: 'queued' };
        },
        async read(jobId) { return jobs.get(jobId) || { id: jobId, state: 'running' }; },
        async cancel(jobId) { calls.push(['cancel', jobId]); const j = jobs.get(jobId); if (j) j.state = 'cancelled'; return j; },
        async streamUrl() { throw new Error('no stream in this test'); },
    };
    const t = await boot({ run });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    t.network.addNode(ada.subject, { principal: NODE, node_id: 'node_ada', name: 'ada-laptop', status: 'active', last_seen_at: new Date().toISOString() });

    const submits = () => calls.filter((c) => c[0] === 'submit');
    const get = (path, as = ada) => t.get(path, { as });
    const post = (path, body, as = ada) => t.get(path, { as, json: body });
    const rowOf = async (id) => await db.one('SELECT * FROM run_tasks WHERE id = $1', [id]);
    const messagesOf = async (id) => await db.many('SELECT * FROM codes_conductor_messages WHERE task_id = $1 ORDER BY n ASC', [id]);
    const attemptOf = async (id) => await db.one('SELECT * FROM codes_attempts WHERE task_id = $1 ORDER BY n ASC LIMIT 1', [id]);

    /** A turn ends: the state change, then the decision (what the events consumer does). */
    const endTurn = async (id, { state = 'succeeded', session = null, summary = 'Carried the plan on.' } = {}) => {
        const row = await rowOf(id);
        const job = {
            id: row.job_id, state,
            result: { ok: state === 'succeeded', summary, log: session ? [{ t: 'agent', agent: 'claude-code', session }] : [] },
        };
        const updated = await t.ctx.tasks.applyEvent(row, { state, job, error: state === 'succeeded' ? null : 'the turn failed' });
        return await t.ctx.tasks.afterEnd(updated.id);
    };

    let taskId = null;
    try {
        await check('a conductor is one task, one attempt and a hand-over brief', async () => {
            const res = await post('/api/v1/conductor', { folder: '/home/ada/openvibe', machine: NODE, model: 'opus', safety: 'ask', note: 'carry on with C9b' });
            assert.strictEqual(res.status, 201, res.text);
            const view = res.json();
            assert.ok(TASK.test(view.task.id));
            taskId = view.task.id;
            const row = await rowOf(taskId);
            assert.strictEqual(row.kind, 'conductor');
            assert.strictEqual(row.folder, '/home/ada/openvibe');
            assert.strictEqual(row.model, 'opus');
            assert.strictEqual(row.safety, 'ask');
            assert.strictEqual(row.machine, NODE);
            assert.strictEqual(row.agent, 'claude-code');
            assert.strictEqual(row.repo, 'conductor:///home/ada/openvibe');
            const attempt = await attemptOf(taskId);
            assert.strictEqual(attempt.agent, 'claude-code');
            assert.strictEqual(attempt.model, 'opus');
            assert.strictEqual(attempt.machine, NODE);
            assert.strictEqual(attempt.kind, 'first');
            assert.strictEqual(view.messages.length, 1);
            const first = view.messages[0];
            assert.strictEqual(first.n, 1);
            assert.match(first.prompt, /RESUME-2026-10-30\.md/, 'the hand-over brief names the resume note');
            assert.match(first.prompt, /codes_task_start/, 'the hand-over brief names the Codes tools');
            assert.strictEqual(first.state, 'running');
            const submit = submits().at(-1)[1];
            assert.strictEqual(submit.args.kind, 'conductor');
            assert.strictEqual(submit.args.folder, '/home/ada/openvibe');
            assert.strictEqual(submit.args.agent, 'claude-code');
            assert.strictEqual(submit.args.model, 'opus');
            assert.strictEqual(submit.args.safety, 'ask');
            assert.strictEqual(submit.args.mcp, true);
            assert.strictEqual(submit.args.resume, undefined, 'the first turn starts the session');
            assert.ok(submit.limits && submit.limits.wall_ms >= 60_000, 'a turn gets a wall time');
        });

        await check('a message waits while a turn runs, then is the next turn of the same session', async () => {
            const before = submits().length;
            const res = await post(`/api/v1/conductor/${taskId}/messages`, { text: 'now do the second piece' });
            assert.strictEqual(res.status, 201, res.text);
            const answer = res.json();
            assert.strictEqual(answer.message.state, 'queued');
            assert.strictEqual(answer.started, false, 'nothing starts while a turn runs');
            assert.strictEqual(submits().length, before, 'no job was started');

            const ended = await endTurn(taskId, { session: 'sess_abc' });
            assert.strictEqual(ended.state, 'queued', 'the next turn is on its way');
            const messages = await messagesOf(taskId);
            assert.deepStrictEqual(messages.map((m) => m.state), ['done', 'running']);
            const attempt = await attemptOf(taskId);
            assert.strictEqual(attempt.session, 'sess_abc', 'the session is kept on the attempt');
            const submit = submits().at(-1)[1];
            assert.strictEqual(submit.args.resume, 'sess_abc', 'the next turn resumes the conversation');
            assert.strictEqual(submit.args.prompt, 'now do the second piece');
        });

        await check('a turn that ends with nothing queued leaves the conductor idle, not finished', async () => {
            const ended = await endTurn(taskId, { session: 'sess_abc', summary: 'Everything is in order.' });
            assert.strictEqual(ended.state, 'succeeded');
            assert.strictEqual(ended.outcome, null, 'it is not done: it waits for the person');
            const attempt = await attemptOf(taskId);
            assert.strictEqual(attempt.state, 'waiting');
            const view = (await get(`/api/v1/conductor/${taskId}`)).json();
            assert.strictEqual(view.idle, true);
            assert.strictEqual(view.messages.at(-1).state, 'done');
            assert.strictEqual(view.messages.at(-1).result.summary, 'Everything is in order.');
        });

        await check('a failing turn is unfinished, and a message still carries on', async () => {
            const res = await post(`/api/v1/conductor/${taskId}/messages`, { text: 'try once more' });
            assert.strictEqual(res.status, 201, res.text);
            const ended = await endTurn(taskId, { state: 'failed' });
            assert.strictEqual(ended.outcome, 'unfinished');
            const messages = await messagesOf(taskId);
            assert.strictEqual(messages.at(-1).state, 'failed');
            assert.match(ended.outcome_note, /write a message to carry on/i);
        });

        await check('the rule: no Anthropic sub-task, on any agent, and an unnamed agent is not Anthropic', async () => {
            const refused = await post(`/api/v1/conductor/${taskId}/tasks`, { prompt: 'do a thing', repo: 'https://github.com/octocat/Hello-World', agent: 'claude-code' });
            assert.strictEqual(refused.status, 422, refused.text);
            assert.strictEqual(refused.json().code, 'conductor.anthropic_subtask');
            const refusedModel = await post(`/api/v1/conductor/${taskId}/tasks`, { prompt: 'do a thing', repo: 'https://github.com/octocat/Hello-World', agent: 'codex', model: 'claude-opus-5-5' });
            assert.strictEqual(refusedModel.status, 422);
            const before = submits().length;
            const started = await post(`/api/v1/conductor/${taskId}/tasks`, { prompt: 'fix the parser', repo: 'https://github.com/octocat/Hello-World' });
            assert.strictEqual(started.status, 201, started.text);
            const submit = submits().at(-1)[1];
            assert.strictEqual(submits().length, before + 1);
            assert.strictEqual(submit.args.agent, 'codex', 'an unnamed agent is a non-Anthropic one');
            assert.ok(!submit.args.push, 'a sub-task does not push');
            const sub = started.json().task;
            assert.notStrictEqual(sub.id, taskId, 'a sub-task is its own task');
            const subRow = await rowOf(sub.id);
            assert.strictEqual(subRow.kind, 'code', 'a sub-task is a coding task, not a conductor');
            assert.strictEqual(subRow.via, 'conductor');
        });

        await check('the page: the conductor is a conversation, not a diff', async () => {
            const res = await get(`/tasks/${taskId}`);
            assert.strictEqual(res.status, 200);
            assert.match(res.text, /Hand-over brief/, 'the first turn is labelled');
            assert.match(res.text, /data-c4-conductor-stream/, 'the transcript streams over the C2 events');
            assert.match(res.text, /What next\?|Say something/, 'the box for the next turn');
        });

        await check('stopping a conductor stops its turn and its queue: nothing carries on', async () => {
            const queued = await post(`/api/v1/conductor/${taskId}/messages`, { text: 'one more' });
            assert.strictEqual(queued.status, 201, queued.text);
            const before = submits().length;
            const stopped = await post(`/api/v1/conductor/${taskId}/stop`, {});
            assert.strictEqual(stopped.status, 200, stopped.text);
            assert.strictEqual(stopped.json().task.outcome || 'stopped', 'stopped');
            const row = await rowOf(taskId);
            assert.strictEqual(row.outcome, 'stopped');
            const messages = await messagesOf(taskId);
            assert.ok(messages.every((m) => m.state !== 'queued' && m.state !== 'running'), JSON.stringify(messages.map((m) => m.state)));
            assert.strictEqual(submits().length, before, 'no job was started after the stop');
        });

        await check('a conductor belongs to its person: another person sees a 404', async () => {
            const res = await get(`/api/v1/conductor/${taskId}`, bo);
            assert.strictEqual(res.status, 404);
        });

        await check('the person\'s own token as a Bearer is enough (what the CLI and the MCP use)', async () => {
            const token = t.network.userToken(ada);
            const res = await fetch(`${t.base}/api/v1/conductor/${taskId}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
            const raw = await res.text();
            assert.strictEqual(res.status, 200, raw);
            const doc = JSON.parse(raw);
            assert.strictEqual(doc.task.id, taskId);
            assert.strictEqual(doc.kind, 'conductor');
        });

    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
