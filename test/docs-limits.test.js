'use strict';
/**
 * /docs/limits (WS-N task 7) renders each enforcing service's /limits.json and nothing of its own:
 * the numbers are the ones the service answered (0 is "none", null is "no limit"), a service not
 * answering shows a problem and no numbers, and grantable capabilities whose owner publishes no
 * limits are listed as such. The copy never calls anything free.
 */
const assert = require('assert');
const http = require('http');

const HOST = {
    service: 'host', scope: 'per project and environment; projects per owner',
    limits: [
        { id: 'custom_domains', label: 'Custom domains', capability: 'host.site.manage', unit: 'count', production: 5, sandbox: 0, exceeded: '429 quota.custom_domains' },
        { id: 'storage_bytes', label: 'Stored bytes (every deploy kept)', capability: 'host.site.manage', unit: 'bytes', production: 1073741824, sandbox: 104857600, exceeded: '413 quota.storage' },
        { id: 'deploys_per_day', label: 'Deploys in 24 hours', capability: 'host.site.manage', unit: 'per_day', production: 50, sandbox: 20, exceeded: '429 quota.deploys_per_day' },
    ],
};
const EVENTS = {
    service: 'events', scope: 'per project and environment (ADR-014)',
    limits: [
        { id: 'publish_per_minute', label: 'Events published per minute', capability: 'events.app.publish', unit: 'per_minute', production: 120, sandbox: 30, exceeded: '429 events.quota_exceeded' },
        { id: 'subscriptions', label: 'Webhook subscriptions', capability: 'events.app.subscribe', unit: 'count', production: null, sandbox: 5, exceeded: '429 events.quota_exceeded' },
        { id: 'retention_days', label: 'Days an event is kept', capability: 'events.app.read', unit: 'days', production: 30, sandbox: 7, exceeded: 'pruned' },
    ],
};

function serve(body) {
    const s = http.createServer((req, res) => {
        if (!s.up) { res.statusCode = 503; return res.end('{}'); }
        if (req.url !== '/limits.json') { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
    });
    s.up = true;
    return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

(async () => {
    const host = await serve(HOST);
    const events = await serve(EVENTS);
    process.env.OV_HOST_INTERNAL_URL = `http://127.0.0.1:${host.address().port}`;
    process.env.OV_EVENTS_INTERNAL_URL = `http://127.0.0.1:${events.address().port}`;
    const { boot, check, done } = require('./helpers/boot');
    const t = await boot();

    await check('the page shows what each service answered', async () => {
        const r = await t.get('/docs/limits');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        for (const s of ['1 GB', '100 MB', '50 in 24 hours', '120 a minute', '30 a minute', '7 days', 'quota.custom_domains', 'events.quota_exceeded',
            'openvibe.host/limits.json', 'events.openvibe.network/limits.json', 'per project and environment (ADR-014)']) {
            assert.ok(r.text.includes(s), `the page says ${s}`);
        }
        assert.match(r.text, /Custom domains<\/td><td[^>]*>[^<]*<a[^>]*><code>host\.site\.manage<\/code><\/a><\/td><td[^>]*>none<\/td>/, 'sandbox 0 reads "none"');
        assert.match(r.text, /Webhook subscriptions.*?<td[^>]*>5<\/td><td[^>]*>no limit<\/td>/s, 'production null reads "no limit"');
        assert.ok(!/\bfree\b/i.test(r.text.replace(/<[^>]+>/g, ' ')), 'no "free" copy');
        assert.ok(r.text.includes('Other capabilities') && r.text.includes('/docs/capabilities/media.object.upload'), 'owners without /limits.json are listed');
        assert.ok(!/Other capabilities[\s\S]*events\.app\.publish \(/.test(r.text), 'a covered owner is not listed again');
        assert.ok((await t.get('/docs')).text.includes('href="/docs/limits"'), 'the docs index links it');
        assert.ok((await t.get('/sitemap.xml')).text.includes('/docs/limits'), 'and the sitemap');
    });

    await check('a service down on a cold cache: its problem, no numbers; the others still show', async () => {
        events.up = false;
        for (const k of Object.keys(require.cache)) if (k.includes('/server/http/docs.js')) delete require.cache[k];
        const t2 = await boot();
        const r = await t2.get('/docs/limits');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('OpenVibe Events&#39;s limits could not be read') || r.text.includes("OpenVibe Events's limits could not be read"), 'the problem is shown');
        assert.ok(!r.text.includes('120 a minute'), 'no Events numbers without Events');
        assert.ok(r.text.includes('50 in 24 hours'), 'Host still shows');
        await t2.close();
    });

    await t.close();
    host.close();
    events.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
