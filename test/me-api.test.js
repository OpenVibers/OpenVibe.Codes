'use strict';
/**
 * User JSON API for coding tasks (server/http/me-api.js): a signed-in person can list, start, read and cancel their own
 * tasks at /api/v1/me/tasks without a service token. A first task auto-creates a project when the person has none.
 */
const assert = require('assert');
const { validate } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const calls = [];
    let state = 'queued';
    const run = {
        enabled: true,
        async submit(o) { calls.push(['submit', o]); return { id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state: 'queued' }; },
        async read(jobId, who) { calls.push(['read', jobId, who]); return { id: jobId, state, result: null, error: null }; },
        async cancel(jobId, who) { calls.push(['cancel', jobId, who]); state = 'cancelled'; return { id: jobId, state }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run });
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');

    const call = async (method, path, { as = null, body = undefined, origin } = {}) => {
        const headers = {};
        if (origin) headers.origin = origin;
        return t.get(`/api/v1/me${path}`, { as, method, ...(body !== undefined ? { json: body } : {}), headers });
    };

    const ask = { repo: 'https://github.com/OpenVibers/OpenVibe.Codes', prompt: 'Add a test.' };

    try {
        await check('a guest is refused', async () => {
            assert.strictEqual((await call('GET', '/tasks')).status, 401);
            assert.strictEqual((await call('POST', '/tasks', { body: ask })).status, 401);
        });

        await check('a first task creates a project, starts the Run job and validates as codes.task-start-result@1', async () => {
            const r = await call('POST', '/tasks', { as: ada, body: ask });
            assert.strictEqual(r.status, 201, r.text);
            const json = r.json();
            assert.ok(validate('codes.task-start-result@1', json).valid, JSON.stringify(validate('codes.task-start-result@1', json).errors));
            assert.strictEqual(json.task.state, 'queued');
            assert.strictEqual(json.task.repo, ask.repo);
            const submit = calls.find((c) => c[0] === 'submit')[1];
            assert.strictEqual(submit.subject, ada.subject);
            assert.ok(submit.project, 'a project was created');
            // The harness's environment (Codes C3) is not part of the task's own arguments: it carries the run token.
            const { env, ...submitted } = submit.args;
            const args = Object.fromEntries(['repo', 'ref', 'prompt', 'permission', 'push', 'agent', 'model'].map((key) => [key, submitted[key]]));
            // A task with no agent named is auto (Codes C9c): the router names the agent it picked, so the task and its
            // first attempt carry it (no fleet has been reported here, so the standard ladder starts at MiniMax).
            assert.deepStrictEqual(args, { repo: ask.repo, ref: null, prompt: ask.prompt, permission: 'edit', push: null, agent: 'minimax-code', model: null });
            assert.deepStrictEqual(Object.keys(env || {}).sort(), ['OPENAI_API_KEY', 'OPENAI_BASE_URL'], 'the harness gets a run token and OpenVibe.AI\'s address');
        });

        await check('the task is listed and readable by its owner, not by another person', async () => {
            const list = await call('GET', '/tasks', { as: ada });
            assert.strictEqual(list.status, 200);
            const tasks = list.json().tasks;
            assert.strictEqual(tasks.length, 1);
            const id = tasks[0].id;
            const one = await call('GET', `/tasks/${id}`, { as: ada });
            assert.strictEqual(one.status, 200);
            assert.ok(validate('codes.task@1', one.json()).valid);
            assert.strictEqual(one.json().id, id);
            const other = await call('GET', `/tasks/${id}`, { as: bo });
            assert.strictEqual(other.status, 404);
        });

        await check('cancel reaches Run and returns the final state', async () => {
            const list = await call('GET', '/tasks', { as: ada });
            const id = list.json().tasks[0].id;
            const c = await call('POST', `/tasks/${id}/cancel`, { as: ada });
            assert.strictEqual(c.status, 200);
            assert.strictEqual(c.json().state, 'cancelled');
            assert.ok(calls.some((x) => x[0] === 'cancel'));
        });

        await check('a cross-site JSON post is refused', async () => {
            const r = await call('POST', '/tasks', { as: ada, body: ask, origin: 'https://evil.example' });
            assert.strictEqual(r.status, 403);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
