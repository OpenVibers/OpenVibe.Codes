'use strict';
/**
 * Spare usage over HTTP (plan §AD.37): the person's session or their own Network token from another OpenVibe site (the
 * same list openvibe.my, Actor and Watch use); another person never sees the list; a cross-site cookie write is refused;
 * the page renders the meters, the settings and the list, and its forms add, pause and remove.
 */
const assert = require('node:assert/strict');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({});
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const api = (method, path, { as = null, bearer = null, body = undefined, origin = undefined } = {}) => {
        const headers = {};
        if (origin) headers.origin = origin;
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        return t.get(`/api/v1${path}`, { as, method, ...(body !== undefined ? { json: body } : {}), headers });
    };
    try {
        await check('a guest is refused; the person\'s own token from another site works, with CORS for OpenVibe origins', async () => {
            assert.equal((await api('GET', '/me/spare')).status, 401);
            assert.equal((await api('GET', '/me/usage')).status, 401);
            const r = await api('GET', '/me/spare', { bearer: t.network.userToken(ada), origin: 'https://openvibe.my' });
            assert.equal(r.status, 200, r.text);
            assert.equal(r.headers.get('access-control-allow-origin'), 'https://openvibe.my');
            assert.equal(r.json().settings.enabled, false);
            assert.deepEqual(r.json().tasks, []);
            const pre = await t.get('/api/v1/me/spare/tasks', { method: 'OPTIONS', headers: { origin: 'https://openvibe.actor' } });
            assert.equal(pre.status, 204);
            assert.match(pre.headers.get('access-control-allow-methods'), /PATCH/);
        });

        let id = null;
        await check('add, change, pause and remove over the API; another person sees none of it', async () => {
            const made = await api('POST', '/me/spare/tasks', { bearer: t.network.userToken(ada), body: { prompt: 'Add tests for fleet.js', repo: 'OpenVibers/OpenVibe.Codes', priority: 2, agent: 'codex' } });
            assert.equal(made.status, 201, made.text);
            id = made.json().task.id;
            assert.equal(made.json().task.repo, 'https://github.com/OpenVibers/OpenVibe.Codes');
            assert.equal(made.json().task.title, 'Add tests for fleet.js');
            const bad = await api('POST', '/me/spare/tasks', { bearer: t.network.userToken(ada), body: { prompt: 'x' } });
            assert.equal(bad.status, 422);
            const paused = await api('PATCH', `/me/spare/tasks/${id}`, { bearer: t.network.userToken(ada), body: { state: 'paused', priority: 1 } });
            assert.equal(paused.status, 200);
            assert.deepEqual([paused.json().task.state, paused.json().task.priority], ['paused', 1]);
            assert.equal((await api('PATCH', `/me/spare/tasks/${id}`, { bearer: t.network.userToken(bo), body: { state: 'queued' } })).status, 404, 'not bo\'s');
            assert.deepEqual((await api('GET', '/me/spare', { bearer: t.network.userToken(bo) })).json().tasks, []);
            const set = await api('PUT', '/me/spare', { bearer: t.network.userToken(ada), body: { enabled: true, reset_within_hours: 24, min_left_pct: 20 } });
            assert.equal(set.status, 200, set.text);
            assert.deepEqual([set.json().settings.enabled, set.json().settings.reset_within_hours, set.json().settings.min_left_pct], [true, 24, 20]);
            const crossCookie = await api('PUT', '/me/spare', { as: ada, origin: 'https://evil.example', body: { enabled: false } });
            assert.equal(crossCookie.status, 403, 'a cross-site cookie write is refused');
            const usage = await api('GET', '/me/usage', { bearer: t.network.userToken(ada) });
            assert.equal(usage.status, 200);
            assert.deepEqual(usage.json().spare, { enabled: true, queued: 0 });
        });

        await check('a first-party service acts for the person named in X-OV-Subject, with codes.task.read to read and codes.task.start to change', async () => {
        const reader = t.network.mintService('svc:actor', 'openvibe.codes', ['codes.task.read']);
        const starter = t.network.mintService('svc:actor', 'openvibe.codes', ['codes.task.start', 'codes.task.read']);
        const as = (token, subject) => ({ authorization: `Bearer ${token}`, ...(subject ? { 'x-ov-subject': subject } : {}) });
        const read = await t.get('/api/v1/me/spare', { headers: as(reader, ada.subject) });
        assert.equal(read.status, 200, read.text);
        assert.equal(read.json().settings.enabled, true);
        const refused = await t.get('/api/v1/me/spare/tasks', { method: 'POST', json: { prompt: 'x', repo: 'a/b' }, headers: as(reader, ada.subject) });
        assert.equal(refused.status, 403, 'reading is not changing');
        const added = await t.get('/api/v1/me/spare/tasks', { method: 'POST', json: { prompt: 'Docs for the API', repo: 'a/b' }, headers: as(starter, ada.subject) });
        assert.equal(added.status, 201, added.text);
        assert.equal((await t.get('/api/v1/me/spare', { headers: as(reader) })).status, 422, 'a service names the person');
    });

    await check('loops: the templates, a loop added over the API (a repeating task with its brief), and refusals', async () => {
        const loops = await api('GET', '/me/spare/loops');
        assert.equal(loops.status, 200);
        assert.deepEqual(loops.json().loops.map((l) => l.id), ['accessibility', 'security', 'latency', 'tests', 'docs', 'dependencies']);
        const made = await api('POST', '/me/spare/tasks', { bearer: t.network.userToken(ada), body: { loop: 'accessibility', repo: 'OpenVibers/OpenVibe.Live', site: 'https://openvibe.live' } });
        assert.equal(made.status, 201, made.text);
        const task = made.json().task;
        assert.deepEqual([task.title, task.repeat, task.priority], ['Accessibility loop', true, 4]);
        assert.match(task.prompt, /axe-core through Playwright/);
        assert.match(task.prompt, /live at https:\/\/openvibe\.live/);
        assert.match(task.prompt, /Open one pull request/);
        assert.equal((await api('POST', '/me/spare/tasks', { bearer: t.network.userToken(ada), body: { loop: 'vibes', repo: 'a/b' } })).status, 422);
        assert.equal((await api('POST', '/me/spare/tasks', { bearer: t.network.userToken(ada), body: { loop: 'security', repo: 'a/b', site: 'javascript:alert(1)' } })).status, 422);
        await api('DELETE', `/me/spare/tasks/${task.id}`, { bearer: t.network.userToken(ada) });
    });

    await check('the page: meters, settings and the list; its forms add, pause and remove', async () => {
            const page = await t.get('/settings/spare', { as: ada });
            assert.equal(page.status, 200);
            assert.match(page.text, /What your agents have left/);
            assert.match(page.text, /name="reset_within_hours" min="1" max="168" value="24"/);
            assert.match(page.text, /Add tests for fleet.js/);
            assert.match(page.text, /name="loop" value="security"/);
            assert.match((await t.get('/settings/agents', { as: ada })).text, /href="\/settings\/spare">Spare usage<\/a>/);
            const add = await t.get('/settings/spare/tasks', { as: ada, method: 'POST', form: { prompt: 'Fix the accessibility findings on the home page', repo: 'OpenVibers/OpenVibe.Live', agent: 'any', priority: '3' }, redirect: 'manual' });
            assert.equal(add.status, 303, add.text);
            const list = (await api('GET', '/me/spare', { as: ada })).json().tasks;
            assert.equal(list.length, 3, 'the API\'s, the service\'s and the form\'s');
            const rm = await t.get(`/settings/spare/tasks/${id}`, { as: ada, method: 'POST', form: { do: 'remove' }, redirect: 'manual' });
            assert.equal(rm.status, 303);
            assert.equal((await api('GET', '/me/spare', { as: ada })).json().tasks.length, 2);
        });
    } finally {
        await t.close();
    }
    done();
})();
