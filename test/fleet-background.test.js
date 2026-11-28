'use strict';
/**
 * The spare-usage planner's background read (plan AD.37; Contracts 0.455.0 bot.machine.read, Bot #537, Network #1183):
 * Codes reads a person's machines from Bot as itself, naming the person in X-OV-Subject, so the planner works from
 * fresh windows without the person's own token; a reading under ten minutes old is not read again; without the client
 * secret nothing is read.
 */
const assert = require('node:assert/strict');
const { boot, check, done } = require('./helpers/boot');
const { createFleet } = require('../server/domain/fleet');

(async () => {
    const t = await boot({});
    const ada = t.network.addUser('ada');
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const u = String(url);
        calls.push({ url: u, headers: init.headers || {} });
        if (u.endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'svc-token', token_type: 'Bearer', expires_in: 300 }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (u.endsWith('/api/v1/machines')) {
            return new Response(JSON.stringify({ machines: [{ id: 'dev_one', node_id: 'lnk_one', name: 'Desk', online: true, fleet: [{ agent: 'claude-code', installed: true, signed_in: true, windows: [{ name: 'week', pct: 30, resets_at: new Date(Date.now() + 3600e3).toISOString() }] }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('no', { status: 404 });
    };
    const config = { ...t.config, bot: { internalUrl: 'http://bot.test' }, networkInternalUrl: 'http://network.test', oauth: { ...t.config.oauth, clientId: 'codes', clientSecret: 'codes-secret' } };
    try {
        await check('Codes reads the person\'s machines as itself, naming them, and keeps the windows', async () => {
            const fleet = createFleet({ config, store: t.ctx.store, fetchImpl, log: { warn() {} } });
            const r = await fleet.refreshAsService(ada.subject);
            assert.equal(r.ok, true, JSON.stringify(r));
            const token = calls.find((c) => c.url.endsWith('/oauth/token'));
            assert.ok(token, 'a client-credentials token was asked for');
            const read = calls.find((c) => c.url === 'http://bot.test/api/v1/machines');
            assert.equal(read.headers.Authorization, 'Bearer svc-token');
            assert.equal(read.headers['X-OV-Subject'], ada.subject, 'the person is named');
            const latest = await fleet.latest(ada.subject);
            assert.equal(latest.machines.length, 1);
            assert.equal(latest.machines[0].agents[0].agent, 'claude-code');
        });

        await check('a fresh reading is not read again; without the client secret nothing is read', async () => {
            const fleet = createFleet({ config, store: t.ctx.store, fetchImpl, log: { warn() {} } });
            const before = calls.filter((c) => c.url.endsWith('/api/v1/machines')).length;
            const again = await fleet.refreshAsService(ada.subject);
            assert.equal(again.skipped, 'fresh');
            assert.equal(calls.filter((c) => c.url.endsWith('/api/v1/machines')).length, before);
            const off = createFleet({ config: { ...config, oauth: { clientId: 'codes', clientSecret: '' } }, store: t.ctx.store, fetchImpl, log: { warn() {} } });
            assert.equal((await off.refreshAsService(ada.subject)).skipped, 'unavailable');
        });
    } finally {
        await t.close();
    }
    done();
})();
