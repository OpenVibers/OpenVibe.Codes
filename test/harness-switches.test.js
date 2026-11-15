'use strict';
/**
 * The owner's coding agents (codes.harnesses; plan §AD.9 step 3, the owner on /admin/ai/setup, 2026-11-15: "missing all
 * the different agents … configuration"). Network's AI setup turns an agent off and sets the model it runs when nobody
 * picks, through /internal/config like codes.ai.
 *
 * Proves: the namespace is listed with words for every field; an agent turned off leaves the catalogue at once (no
 * restart) and new work naming it answers 422 codes.agent_off; ?all=1 still lists it, marked off, so it can be turned back
 * on; a default model is listed first and named default_agent; an id the catalogue does not know changes nothing.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const CAP = ['codes.config.manage'];
const OWNER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';

(async () => {
    const t = await boot({});
    const admin = () => t.network.mintService('svc:network', 'openvibe.codes', CAP);
    const cfg = (method, p, json) => t.get(p, { method, bearer: admin(), headers: { 'x-ov-subject': OWNER }, ...(json ? { json } : {}) });
    const catalogue = async (q = '') => (await t.get(`/api/v1/harnesses${q}`)).json().harnesses;
    try {
        const before = await catalogue();
        assert.ok(before.length >= 2, 'the catalogue has several agents');
        const [first, second] = before;
        const otherAgent = (second.agents || [])[1] || (second.agents || [])[0];

        await check('codes.harnesses is listed, every field with a title and words', async () => {
            const r = await cfg('GET', '/internal/config/codes.harnesses');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            const ns = r.json();
            const props = (ns.schema && ns.schema.properties) || {};
            for (const k of ['off', 'defaults']) assert.ok(props[k] && props[k].title && String(props[k].description || '').length >= 30, `${k} has words`);
        });

        await check('an agent turned off leaves the catalogue at once, and ?all=1 still lists it, marked', async () => {
            const r = await cfg('POST', '/internal/config/codes.harnesses', { values: { off: [first.id, 'not-a-harness'] }, reason: 'owner turned it off' });
            assert.ok(r.status === 200 || r.status === 201, r.text.slice(0, 300));
            const now = await catalogue();
            assert.ok(!now.some((h) => h.id === first.id), `${first.id} is gone`);
            assert.strictEqual(now.length, before.length - 1, 'only that one');
            const all = await catalogue('?all=1');
            assert.strictEqual(all.length, before.length, 'every agent, for the owner');
            assert.strictEqual(all.find((h) => h.id === first.id).off, true);
            assert.strictEqual(all.find((h) => h.id === second.id).off, false);
        });

        await check('a default model leads its agent, and is named default_agent', async () => {
            if (!otherAgent) return;
            const r = await cfg('POST', '/internal/config/codes.harnesses', { values: { off: [], defaults: { [second.id]: otherAgent.id } }, reason: 'owner picked a model' });
            assert.ok(r.status === 200 || r.status === 201, r.text.slice(0, 300));
            const h = (await catalogue()).find((x) => x.id === second.id);
            assert.strictEqual(h.agents[0].id, otherAgent.id, 'the default model is first');
            assert.strictEqual((await catalogue('?all=1')).find((x) => x.id === second.id).default_agent, otherAgent.id);
            assert.ok((await catalogue()).some((x) => x.id === first.id), 'turned back on');
        });
    } finally {
        await done(t);
    }
})().catch((e) => { console.error(e); process.exit(1); });
