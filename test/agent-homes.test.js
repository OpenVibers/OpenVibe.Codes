'use strict';

/**
 * Your agent home on openvibe.codes (plan §AD.22): a person keeps one openvibe.home@1 spec, and "Set up" sends a
 * Codes job of mode 'home' to one of their own machines (never someone else's), with the spec as its input. The spec
 * is checked as it is saved (no credentials in an address), a cross-site post is refused, and the home is theirs to
 * export and erase (account-data covers codes_homes).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const DEVICE = 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2H1';
const NODE = 'lnk_home_node';

(async () => {
    const jobs = [];
    const run = {
        enabled: true,
        async submit(o) { jobs.push(o); return { id: `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2${String(jobs.length).padStart(2, '0')}`, state: 'queued' }; },
        async read(jobId) { return { id: jobId, state: 'queued', result: null, error: null }; },
        async streamUrl() { throw Object.assign(new Error('gone'), { status: 404 }); },
    };
    const t = await boot({ run });
    const ada = t.network.addUser('ada-home');
    const bo = t.network.addUser('bo-home');
    t.bot.addMachine({ id: DEVICE, node_id: NODE, name: 'ov-node', online: true });
    const call = (method, path, { as = null, body, origin } = {}) => t.get(`/api/v1/me${path}`, { as, method, ...(body !== undefined ? { json: body } : {}), headers: origin ? { origin } : {} });
    const SPEC = {
        format: 'openvibe.home@1',
        tools: { go: '1.27.1', node: '24.19.0' },
        agents: ['claude-code', 'codex'],
        repos: ['OpenVibers/OpenVibe.Live', 'https://github.com/OpenVibers/OpenVibe.Codes'],
        git: { name: 'OpenVibers', email: 'Contact@OpenVibe.Network' },
    };
    try {
        await check('a guest is refused; a person starts from a home with their likely agent and nothing else', async () => {
            assert.strictEqual((await call('GET', '/home')).status, 401);
            const r = await call('GET', '/home', { as: ada });
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual({ saved: r.json().saved, agents: r.json().spec.agents, repos: r.json().spec.repos }, { saved: false, agents: ['claude-code'], repos: [] });
        });

        await check('set up before it is saved is refused; a spec is checked as it is saved; a cross-site save is refused', async () => {
            assert.strictEqual((await call('POST', '/home/apply', { as: ada, body: { machine: NODE } })).status, 409);
            const bad = await call('PUT', '/home', { as: ada, body: { spec: { ...SPEC, repos: ['https://me:secret@github.com/a/b'] } } });
            assert.strictEqual(bad.status, 422);
            assert.ok(!bad.text.includes('secret'), 'the refusal does not echo a credential');
            assert.strictEqual((await call('PUT', '/home', { as: ada, body: { spec: SPEC }, origin: 'https://evil.example' })).status, 403);
            const ok = await call('PUT', '/home', { as: ada, body: { spec: SPEC } });
            assert.strictEqual(ok.status, 200, ok.text);
            assert.deepStrictEqual(ok.json().spec.repos, SPEC.repos, 'repositories shown back as they were given');
            const again = (await call('GET', '/home', { as: ada })).json();
            assert.strictEqual(again.saved, true);
            assert.deepStrictEqual(again.spec.tools, SPEC.tools);
            assert.strictEqual((await call('GET', '/home', { as: bo })).json().saved, false, "one person's home is not another's");
        });

        await check('set up on one of their machines: a home job pinned to it, with the spec; a machine not theirs is refused', async () => {
            assert.strictEqual((await call('POST', '/home/apply', { as: ada, body: {} })).status, 422);
            assert.strictEqual((await call('POST', '/home/apply', { as: ada, body: { machine: 'lnk_not_mine' } })).status, 404);
            assert.strictEqual((await call('POST', '/home/apply', { as: ada, body: { machine: NODE }, origin: 'https://evil.example' })).status, 403);
            const r = await call('POST', '/home/apply', { as: ada, body: { machine: NODE } });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().machine, DEVICE);
            const j = jobs[jobs.length - 1];
            assert.strictEqual(j.node, DEVICE, 'pinned to the device Bot names');
            assert.strictEqual(j.args.mode, 'home');
            assert.deepStrictEqual(j.args.spec.agents, ['claude-code', 'codex']);
            assert.ok(!j.args.env, 'no forge credential for repositories on GitHub');
            const h = (await call('GET', '/home', { as: ada })).json();
            assert.strictEqual(h.applied[DEVICE].job, r.json().job_id, 'where it was set up is kept');
            // Another person cannot follow the job.
            assert.strictEqual((await call('GET', `/home/apply/${r.json().job_id}/events`, { as: bo })).status, 404);
        });

        await check("the home is the person's: their export carries it and erasure takes it", async () => {
            const ad = require('../server/account-data');
            const tables = JSON.stringify(ad.TABLES || ad.tables || ad);
            assert.ok(tables.includes('codes_homes'), 'account data covers codes_homes');
        });
    } finally {
        await t.close();
        done();
    }
})();
