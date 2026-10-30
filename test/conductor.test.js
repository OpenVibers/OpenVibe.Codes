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
const DEVICE = 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2N1';

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
    // The same machine on OpenVibe.Bot (Codes C9c): the device id is what Run places a job on, the node id what
    // Network knows it by. A conductor's turns are pinned to it.
    const mineBot = () => t.bot.addMachine({ id: DEVICE, node_id: NODE, name: 'ada-laptop', online: true });
    mineBot();

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
            assert.strictEqual(submit.node, DEVICE, 'the turn is pinned to the chosen machine, by its OpenVibe.Bot device id');
            assert.strictEqual(row.pin, DEVICE, 'the pin is kept on the conductor');
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
            assert.strictEqual(submit.node, DEVICE, 'every turn of the session is pinned to the same machine');
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

        await check('a conductor is started only where its folder is: no such machine on Bot, away, or Bot itself away', async () => {
            const other = 'nod_01J8Z3Q4R5S6T7V8W9X0Y1Z2N2';
            t.network.addNode(ada.subject, { principal: other, node_id: 'node_ada_desktop', name: 'ada-desktop', status: 'active', last_seen_at: new Date().toISOString() });
            const before = submits().length;
            const unknown = await post('/api/v1/conductor', { folder: '/home/ada/openvibe', machine: other });
            assert.strictEqual(unknown.status, 422, unknown.text);
            assert.strictEqual(unknown.json().code, 'conductor.machine_invalid', 'a machine Codes cannot find on Bot is never a guess');
            t.bot.addMachine({ id: 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2N2', node_id: other, name: 'ada-desktop', online: false });
            const away = await post('/api/v1/conductor', { folder: '/home/ada/openvibe', machine: other });
            assert.strictEqual(away.status, 409, away.text);
            assert.strictEqual(away.json().code, 'conductor.machine_offline');
            t.bot.setDown(true);
            const down = await post('/api/v1/conductor', { folder: '/home/ada/openvibe', machine: NODE });
            assert.strictEqual(down.status, 503, down.text);
            assert.strictEqual(down.json().code, 'conductor.machine_unpinned');
            assert.strictEqual(submits().length, before, 'no job was started for a conductor that could not be pinned');

            // The pin is kept on the conductor: a later turn starts on the same machine without asking Bot again.
            const res = await post(`/api/v1/conductor/${taskId}/messages`, { text: 'now the next piece' });
            t.bot.setDown(false);
            assert.strictEqual(res.status, 201, res.text);
            assert.strictEqual(submits().at(-1)[1].node, DEVICE, 'the stored pin starts the turn, even with Bot away');
            const ended = await endTurn(taskId, { session: 'sess_abc' });
            assert.strictEqual(ended.state, 'succeeded', 'idle again');
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
            // An unnamed agent is auto (Codes C9c): the router names one from the fleet, and never an Anthropic one.
            assert.strictEqual(submit.args.agent, 'opencode', 'an unnamed agent is the one the router picked, from a non-Anthropic ladder');
            assert.ok(!/claude/.test(String(submit.args.agent)), 'never an Anthropic agent');
            assert.ok(!submit.args.push, 'a sub-task does not push');
            assert.strictEqual(submit.node, undefined, 'a sub-task is placed by Run wherever it fits, not pinned');
            const sub = started.json().task;
            assert.notStrictEqual(sub.id, taskId, 'a sub-task is its own task');
            const subRow = await rowOf(sub.id);
            assert.strictEqual(subRow.kind, 'code', 'a sub-task is a coding task, not a conductor');
            assert.strictEqual(subRow.via, 'conductor');
        });

        await check('the start form: a model list the login offers, and the folders the machine has worked in', async () => {
            const res = await get('/conductor');
            assert.strictEqual(res.status, 200);
            assert.match(res.text, /<select name="model" data-c4-model>/, 'the model is a list');
            for (const label of ['Opus 5.5 (default)', 'Sonnet 5.5', 'Haiku 5.5', 'Other…']) assert.ok(res.text.includes(label), `${label} is offered`);
            assert.match(res.text, /data-c4-folder-pick/, 'the recent folders are a choice beside the typed path');
            assert.ok(res.text.includes(`data-machine="${NODE}"`), 'this conductor&rsquo;s folder is one, on its machine');
            assert.ok(res.text.includes('/home/ada/openvibe'), 'and it is the folder this person has used');
        });

        await check('a recent folder and a model the person named start a conductor', async () => {
            const res = await t.get('/conductor', { as: ada, form: { folder: '', folder_pick: '/home/ada/openvibe', machine: NODE, model: 'other', model_other: 'claude-opus-5-5', safety: 'ask' } });
            assert.strictEqual(res.status, 303, res.text);
            const id = decodeURIComponent(String(res.headers.get('location') || '').split('/').pop());
            const row = await rowOf(id);
            assert.strictEqual(row.folder, '/home/ada/openvibe', 'the picked folder');
            assert.strictEqual(row.model, 'claude-opus-5-5', 'the model behind Other…');
            await post(`/api/v1/conductor/${id}/stop`, {});
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
