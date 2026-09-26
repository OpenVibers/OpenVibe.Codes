'use strict';
/**
 * A project's usage page (WS-N task 4): /projects/:project/usage renders what Network's
 * GET /api/v1/projects/:project/usage answers (usage by service, capability and day, quotas with
 * their headroom, errors by code and the sampled failures with trace ids) next to the limits of the
 * services the project used, server-side and complete without JavaScript. Only the owner, admins and
 * staff see it (and Network is not asked for anyone else); the range filters are a GET form whose
 * values reach Network as offered; a Network failure is shown as it answered. Never "free".
 */
const assert = require('assert');
const http = require('http');
const { usageQuery } = require('../server/render/usage');

const EVENTS_LIMITS = {
    service: 'events', scope: 'per project and environment (ADR-014)',
    limits: [
        { id: 'publish_per_minute', label: 'Events published per minute', capability: 'events.app.publish', unit: 'per_minute', production: 120, sandbox: 30, exceeded: '429 events.quota_exceeded' },
        { id: 'subscriptions', label: 'Webhook subscriptions', capability: 'events.app.subscribe', unit: 'count', production: 20, sandbox: 5, exceeded: '429 events.quota_exceeded' },
    ],
};
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const JOB = 'job_01JAB2C3D4E5F6G7H8J9K0MNPR';

function usageFor(projectId) {
    const today = new Date().toISOString().slice(0, 10);
    return {
        project_id: projectId, env: 'all', range: { days: 30, from: today, to: today }, generated_at: new Date().toISOString(),
        last_recorded_at: new Date().toISOString(),
        freshness: 'Usage arrives as hourly rollups a few minutes after each hour closes (UTC); the current hour is not counted yet.',
        totals: [
            { service: 'tools', capability: 'tools.job.create', unit: 'jobs', env: 'production', quantity: 4200, errors: 3 },
            { service: 'events', capability: 'events.app.publish', unit: 'events', env: 'sandbox', quantity: 1800, errors: 61 },
        ],
        daily: [
            { day: today, service: 'tools', capability: 'tools.job.create', dimension: 'img.process', unit: 'jobs', env: 'production', quantity: 4200, errors: 3 },
            { day: today, service: 'events', capability: 'events.app.publish', dimension: null, unit: 'events', env: 'sandbox', quantity: 1800, errors: 61 },
        ],
        quotas: [
            { capability: 'tools.job.create', limit: 5000, window: 'day', unit: 'jobs', enforced_by: 'openvibe.tools', used: 4200, remaining: 800, window_start: `${today}T00:00:00.000Z`, note: null },
            { capability: 'events.app.publish', limit: 120, window: 'minute', unit: 'events', enforced_by: 'openvibe.events', used: null, remaining: null, window_start: null, note: 'a minute window is enforced by the service as it happens; hourly rollups cannot show it' },
        ],
        errors: {
            total: 64,
            by_code: [
                { service: 'events', capability: 'events.app.publish', code: 'events.quota_exceeded', count: 60 },
                { service: 'tools', capability: 'tools.job.create', code: 'tools.job.timeout', count: 3 },
            ],
            recent: [
                { at: new Date().toISOString(), env: 'production', service: 'tools', capability: 'tools.job.create', code: 'tools.job.timeout', status: 504, trace_id: TRACE, ref: JOB },
                { at: new Date().toISOString(), env: 'sandbox', service: 'events', capability: 'events.app.publish', code: 'events.quota_exceeded', status: 429, trace_id: null, ref: null },
            ],
        },
    };
}

(async () => {
    const limitsServer = http.createServer((req, res) => {
        if (req.url !== '/limits.json') { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(EVENTS_LIMITS));
    });
    await new Promise((r) => limitsServer.listen(0, '127.0.0.1', r));
    process.env.OV_EVENTS_INTERNAL_URL = `http://127.0.0.1:${limitsServer.address().port}`;
    const { boot, check, done } = require('./helpers/boot');
    const t = await boot();
    const owner = t.network.addUser('ona');
    const admin = t.network.addUser('ada');
    const dev = t.network.addUser('dev');
    const viewer = t.network.addUser('vee');
    const stranger = t.network.addUser('sam');
    const staff = t.network.addUser('staff', { role: 'admin' });
    const projectId = await t.project(owner, 'Metered');
    for (const [who, role] of [['ada', 'admin'], ['dev', 'developer'], ['vee', 'viewer']]) {
        assert.strictEqual((await t.get(`/projects/${projectId}/members`, { as: owner, form: { username: who, role } })).status, 303);
    }
    const page = `/projects/${projectId}/usage`;
    const usageAsked = (from) => t.network.requests.slice(from).filter((x) => x.path === `/api/v1/projects/${projectId}/usage`);

    await check('before any usage: an honest empty page', async () => {
        const r = await t.get(page, { as: owner });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.match(r.text, /No usage has been recorded for this project yet/);
        assert.match(r.text, /No usage in these days/);
        assert.match(r.text, /No quotas are recorded for this project/);
    });

    t.network.setUsage(projectId, usageFor(projectId));

    await check('the owner sees usage by service, capability and day, quota headroom, errors and trace ids, server-rendered', async () => {
        const r = await t.get(page, { as: owner });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        const body = r.text;
        assert.match(body, /<h1>Usage <small>Metered<\/small><\/h1>/);
        assert.match(body, /hourly rollups/);
        // Summary and by day.
        assert.match(body, /4,200<\/span> jobs/);
        assert.match(body, /<code>tools\.job\.create<\/code>/);
        assert.match(body, /<code>img\.process<\/code>/);
        assert.match(body, /1,800<\/span> events/);
        assert.match(body, /61<\/span> errors \(3\.4%\)/);
        // Quotas: a meter for the day window, the reason for the minute one.
        assert.match(body, /<meter class="headroom" min="0" max="5000" value="4200" low="4000" high="4750" optimum="0">84%<\/meter>/);
        assert.match(body, /800<\/span> left/);
        assert.match(body, /a minute window is enforced by the service as it happens/);
        assert.match(body, /recorded limit — enforced by <code>openvibe\.tools<\/code>/);
        // Service limits of the services used: Events publishes them, Tools does not yet.
        assert.match(body, /Events published per minute/);
        assert.match(body, /30 a minute/);
        assert.match(body, /OpenVibe Tools does not publish its limits yet/);
        // Errors.
        assert.match(body, /<code>events\.quota_exceeded<\/code>/);
        assert.match(body, /64<\/span> errors in these days/);
        assert.ok(body.includes(`<code>${TRACE}</code>`), 'the sampled trace id');
        assert.ok(body.includes(`<code>${JOB}</code>`), 'the failed job');
        // Works without JavaScript: the range is a GET form; nothing here needs a script of Codes'.
        assert.match(body, new RegExp(`<form method="get" action="/projects/${projectId}/usage"`));
        assert.ok(!/src="\/js\//.test(body), 'no Codes script on the page');
        assert.ok(!/\bfree\b|\$0/i.test(body), 'never "free" or "$0"');
    });

    await check('the range filters reach Network as offered; anything else falls back to 30 days, both environments', async () => {
        const before = t.network.requests.length;
        let r = await t.get(`${page}?days=7&env=sandbox`, { as: owner });
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<option value="7" selected>/);
        assert.match(r.text, /<option value="sandbox" selected>/);
        assert.deepStrictEqual(usageAsked(before).map((x) => x.query), ['?days=7&env=sandbox']);
        const again = t.network.requests.length;
        r = await t.get(`${page}?days=365&env=staging`, { as: owner });
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<option value="30" selected>/);
        assert.deepStrictEqual(usageAsked(again).map((x) => x.query), ['?days=30&env=all']);
        assert.deepStrictEqual(usageQuery({ days: '90', env: 'production' }), { days: 90, env: 'production' });
        assert.deepStrictEqual(usageQuery({ days: '1; drop', env: '<x>' }), { days: 30, env: 'all' });
    });

    await check('admins and staff see it; developers and viewers get 403 without Network being asked; strangers 404', async () => {
        assert.strictEqual((await t.get(page, { as: admin })).status, 200);
        assert.strictEqual((await t.get(page, { as: staff })).status, 200);
        const before = t.network.requests.length;
        for (const who of [dev, viewer]) {
            const r = await t.get(page, { as: who });
            assert.strictEqual(r.status, 403, who.username);
            assert.match(r.text, /for its owner and admins/);
        }
        assert.strictEqual(usageAsked(before).length, 0, 'Network was not asked for their usage');
        assert.strictEqual((await t.get(page, { as: stranger })).status, 404);
        const anon = await t.get(page);
        assert.strictEqual(anon.status, 401);
    });

    await check('the project page links to the usage page for its owner, and no longer says usage is not collected', async () => {
        const r = await t.get(`/projects/${projectId}`, { as: owner });
        assert.ok(r.text.includes(`href="/projects/${projectId}/usage"`));
        assert.ok(!/no usage numbers are collected/.test(r.text));
        const d = await t.get(`/projects/${projectId}`, { as: dev });
        assert.ok(!d.text.includes(`href="/projects/${projectId}/usage"`), 'no link for a developer');
    });

    await check('a Network failure is shown as it answered, never as an empty page', async () => {
        t.network.setDown(true);
        const r = await t.get(page, { as: owner });
        t.network.setDown(false);
        assert.ok(r.status >= 500, String(r.status));
        assert.ok(!/No usage in these days/.test(r.text));
    });

    await t.close();
    limitsServer.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
