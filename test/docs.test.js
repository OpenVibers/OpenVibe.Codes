'use strict';
/**
 * Generated docs match the pinned contracts and SDK versions: the tag pinned in package.json, the
 * installed package and what every page states are the same version, and every contract,
 * capability, event type and SDK module in those packages has its page — nothing more, nothing less.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

const pkg = require('../package.json');
const contractsVersion = require('openvibe-contracts/package.json').version;
const sdkPkg = require('openvibe-sdk/package.json');

(async () => {
    const t = await boot();

    await check('package.json pins the contracts, SDK and shared tags that are installed', async () => {
        const tag = (dep) => (pkg.dependencies[dep].match(/refs\/tags\/(v[0-9.]+)$/) || [])[1];
        assert.strictEqual(tag('openvibe-contracts'), 'v0.51.0');
        assert.strictEqual(tag('openvibe-sdk'), `v${sdkPkg.version}`);
        assert.strictEqual(tag('openvibe-shared'), `v${require('openvibe-shared/package.json').version}`);
        assert.strictEqual(sdkPkg.version, '0.11.0');
        // The contracts tag v0.51.0 carries the released codes manifest and codes.app-manifest@1.
        assert.ok(contracts.services.get('codes') && contracts.services.get('codes').status === 'alpha');
        assert.ok(contracts.resolve('codes.app-manifest@1'));
    });

    await check('every docs page states the versions it was generated from', async () => {
        for (const p of ['/docs', '/docs/contracts', '/docs/capabilities', '/docs/events', '/docs/sdk', '/docs/contracts/errors.problem', '/docs/sdk/core']) {
            const r = await t.get(p);
            assert.strictEqual(r.status, 200, p);
            assert.ok(r.text.includes(`openvibe-contracts v${contractsVersion}`), `${p} names the installed contracts version`);
            assert.ok(r.text.includes('OpenVibe.Contracts/tree/v0.51.0'), `${p} links the pinned tag`);
            if (contractsVersion !== '0.51.0') assert.ok(r.text.includes('(tag v0.51.0)'), `${p} says the tag differs from the package version`);
            assert.ok(r.text.includes(`openvibe-sdk v${sdkPkg.version}`), `${p} names the SDK version`);
        }
        const v = (await t.get('/api/v1/docs/versions')).json();
        assert.strictEqual(v.contracts, contractsVersion);
        assert.strictEqual(v.contracts_tag, 'v0.51.0');
        assert.strictEqual(v.sdk, sdkPkg.version);
    });

    await check('one page per contract in the catalog, with its version, fields and fixtures', async () => {
        const index = (await t.get('/docs/contracts')).text;
        for (const c of contracts.catalog) {
            assert.ok(index.includes(`/docs/contracts/${c.id}"`), `${c.id} listed`);
            const r = await t.get(`/docs/contracts/${c.id}`);
            assert.strictEqual(r.status, 200, c.id);
            assert.ok(r.text.includes(`<dd>${c.version}</dd>`), `${c.id} version`);
            const schema = contracts.schema(c.id);
            for (const field of Object.keys(schema.properties || {})) assert.ok(r.text.includes(`<code>${field}</code>`), `${c.id} field ${field}`);
            const fixtureDir = path.join(path.dirname(require.resolve('openvibe-contracts/package.json')), 'fixtures', c.id, 'valid');
            for (const f of fs.existsSync(fixtureDir) ? fs.readdirSync(fixtureDir) : []) assert.ok(r.text.includes(f.replace(/\.json$/, '')), `${c.id} fixture ${f}`);
            const raw = await t.get(`/docs/contracts/${c.id}.json`);
            assert.deepStrictEqual(JSON.parse(raw.text), schema);
        }
        assert.strictEqual((await t.get('/docs/contracts/no.such-contract')).status, 404);
    });

    await check('the capability catalog lists every capability manifest exactly once', async () => {
        const r = await t.get('/docs/capabilities');
        const listed = [...r.text.matchAll(/<a href="\/docs\/capabilities\/([^"]+)"/g)].map((m) => m[1]);
        assert.deepStrictEqual([...listed].sort(), contracts.capabilities.manifests.map((c) => c.id).sort());
    });

    await check('event types are exactly the service manifests\' eventsProduced', async () => {
        const r = await t.get('/docs/events');
        const expected = new Set(contracts.services.manifests.flatMap((m) => m.eventsProduced || []));
        for (const e of expected) assert.ok(r.text.includes(`<code>${e}</code>`), e);
        assert.strictEqual([...r.text.matchAll(/<tr><td><code>/g)].length, expected.size);
    });

    await check('the SDK reference has one page per exported types entry, declarations verbatim', async () => {
        const typed = Object.entries(sdkPkg.exports).filter(([, v]) => v && typeof v === 'object' && v.types);
        const r = await t.get('/docs/sdk');
        for (const [sub] of typed) {
            const slug = sub === '.' ? 'index' : sub.replace(/^\.\//, '').replace(/\//g, '-');
            assert.ok(r.text.includes(`/docs/sdk/${slug}"`), `module ${sub}`);
        }
        const media = await t.get('/docs/sdk/media');
        assert.ok(media.text.includes('export declare function createMediaClient'));
        const events = await t.get('/docs/sdk/events');
        assert.ok(events.text.includes('export declare function verifyDelivery'));
    });

    await check('policy pages render the published ADRs, not a paraphrase', async () => {
        const r = await t.get('/policy/compatibility');
        const adr = fs.readFileSync(path.join(path.dirname(require.resolve('openvibe-contracts/package.json')), 'docs', 'adr', 'ADR-016-active-client-updates.md'), 'utf8');
        assert.ok(r.text.includes('Mixed-version window'));
        assert.ok(adr.includes('Mixed-version window'));
        assert.ok(r.text.includes('ADR-002: Contract repository and compatibility policy'));
        const rfc = await t.get('/policy/rfc');
        const adrs = fs.readdirSync(path.join(path.dirname(require.resolve('openvibe-contracts/package.json')), 'docs', 'adr')).filter((f) => /^ADR-\d+/.test(f));
        for (const f of adrs) assert.ok(rfc.text.includes(`/docs/adr/${f.match(/^(ADR-\d+)/)[1]}"`), f);
        const lic = await t.get('/policy/licensing');
        assert.ok(lic.text.includes(sdkPkg.license) && lic.text.includes(require('openvibe-contracts/package.json').license));
    });

    await check('public docs are crawlable and cacheable; the sitemap lists them', async () => {
        const r = await t.get('/docs/capabilities');
        assert.match(r.text, /<meta name="robots" content="index, follow">/);
        assert.match(r.headers.get('cache-control'), /public/);
        const sm = await t.get('/sitemap.xml');
        assert.ok(sm.text.includes('/docs/contracts/mods.mod-manifest</loc>'));
        assert.ok(sm.text.includes('/docs/api</loc>') && sm.text.includes('/docs/api/tools</loc>'), 'the API explorer is in the sitemap');
    });

    await check('the API explorer lists every service document from the pinned contracts (WS-C task 6)', async () => {
        const index = contracts.openapi.index();
        assert.ok(index.length >= 20);
        const list = await t.get('/docs/api');
        assert.strictEqual(list.status, 200);
        for (const s of index) assert.ok(list.text.includes(`href="/docs/api/${s.service}"`), `${s.service} is listed`);
        assert.ok((await t.get('/docs')).text.includes('href="/docs/api"'), 'the docs index links it');
        const raw = await t.get('/docs/api/tools.json');
        assert.strictEqual(raw.status, 200);
        assert.match(raw.headers.get('content-type'), /application\/vnd\.oai\.openapi\+json/);
        assert.strictEqual(raw.headers.get('access-control-allow-origin'), '*');
        assert.deepStrictEqual(raw.json(), contracts.openapi.document('tools'), 'the document as the package ships it');
        const page = await t.get('/docs/api/tools');
        assert.strictEqual(page.status, 200);
        const doc = contracts.openapi.document('tools');
        const ops = Object.values(doc.paths).reduce((n, m) => n + Object.keys(m).length, 0);
        assert.strictEqual((page.text.match(/class="api-op"/g) || []).length, ops, 'one block per route');
        assert.ok(page.text.includes('id="cap-tools.job.create"') && page.text.includes('href="/docs/capabilities/tools.job.create"'), 'capabilities anchored and linked');
        assert.ok(page.text.includes('href="/docs/contracts/tools.job"'), 'schemas link to their contract pages');
        assert.ok(page.text.includes('<code>/api/v1/jobs/{id}</code>'));
        const pub = await t.get('/docs/api/tools?public=1');
        assert.ok((pub.text.match(/class="api-op"/g) || []).length <= ops);
        assert.strictEqual((await t.get('/docs/api/nope')).status, 404);
        assert.strictEqual((await t.get('/docs/api/nope.json')).status, 404);
        const cap = await t.get('/docs/capabilities/tools.job.create');
        assert.ok(cap.text.includes('href="/docs/api/tools#cap-tools.job.create"'), 'a capability links its routes');
    });

    await check('the update system page documents the feed, the markup and the helpers (WS-A task 4)', async () => {
        const r = await t.get('/docs/updates');
        assert.strictEqual(r.status, 200);
        for (const s of ['/api/v1/changelog', 'data-ov-shipped="latest"', 'frame.shipped(', 'updatesBody(', 'mountFrame', 'openvibe-shared v' + require('openvibe-shared/package.json').version])
            assert.ok(r.text.includes(s.replace(/"/g, '&quot;')) || r.text.includes(s), `names ${s}`);
        assert.ok((await t.get('/docs')).text.includes('href="/docs/updates"'), 'linked from the docs index');
        assert.ok((await t.get('/sitemap.xml')).text.includes('/docs/updates</loc>'));
    });

    await check('pages rendered for a signed-in person are never publicly cacheable', async () => {
        const u = t.network.addUser('pat');
        const r = await t.get('/docs', { as: u });
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    });

    await t.close();
    done();
})();
