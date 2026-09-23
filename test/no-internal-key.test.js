'use strict';
/**
 * No X-Internal-Key anywhere (ADR-014: "No developer-facing path ever accepts X-Internal-Key").
 * Code, client scripts, deploy files, the environment template and the manifest proposals must not
 * mention it; the running portal never sends it to Network (the Network mock refuses any request
 * that carries one), and a request that presents one gets no special treatment.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const ROOT = path.join(__dirname, '..');
const PATTERN = /x-internal-key|internal[_-]?key|INTERNAL_API_KEY/i;

function files(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...files(p)); else out.push(p);
    }
    return out;
}

(async () => {
    await check('no mention in server/, public/, deploy/, docs/*.json, .env.example, package.json or CI', async () => {
        const targets = [
            ...files(path.join(ROOT, 'server')), ...files(path.join(ROOT, 'public')), ...files(path.join(ROOT, 'deploy')),
            ...files(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.json')),
            path.join(ROOT, '.env.example'), path.join(ROOT, 'package.json'), path.join(ROOT, '.github', 'workflows', 'ci.yml'),
        ].filter((f) => fs.existsSync(f));
        assert.ok(targets.length > 20);
        const hits = targets.filter((f) => PATTERN.test(fs.readFileSync(f, 'utf8')));
        assert.deepStrictEqual(hits.map((f) => path.relative(ROOT, f)), []);
    });

    const t = await boot();
    await check('a whole portal session never sends an internal key to Network', async () => {
        const u = t.network.addUser('nia');
        const p = await t.project(u);
        const a = await t.app(u, p);
        await t.grant(u, p, a.id, 'media.object.upload');
        await t.get(`/projects/${p}`, { as: u });
        await t.get(`/projects/${p}/apps/${a.id}`, { as: u });
        await t.get(`/projects/${p}/apps/${a.id}/playground/media`, { as: u, multipart: { fields: { credential_type: 'client_secret', credential: a.secret }, file: { name: 'x', content: 'x' } } });
        const sent = t.network.requests.filter((r) => r.headers['x-internal-key']);
        assert.strictEqual(sent.length, 0);
        assert.ok(t.network.requests.length > 10);
    });

    await check('presenting X-Internal-Key gets nothing: the API still wants an app token', async () => {
        const r = await t.get('/api/v1/apps/app_01JABCDEFGHJKMNPQRSTVWXYZ0/releases', { method: 'POST', headers: { 'x-internal-key': 'anything', 'content-type': 'application/json' }, body: '{}' });
        assert.strictEqual(r.status, 401);
        const page = await t.get('/projects', { headers: { 'x-internal-key': 'anything' } });
        assert.strictEqual(page.status, 401);
    });

    await t.close();
    done();
})();
