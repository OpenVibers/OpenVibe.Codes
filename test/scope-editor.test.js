'use strict';
/**
 * The scope editor offers only capabilities apps can be granted: active + public, or partner when
 * staff put it in this project's allowance. Even if Network's catalog listed something the pinned
 * contracts call first-party or internal, Codes would not offer it and would refuse to forward a
 * forged request for it (Network is never asked).
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const owner = t.network.addUser('lin');
    const projectId = await t.project(owner, 'Scopes');
    const app = await t.app(owner, projectId);
    const base = `/projects/${projectId}/apps/${app.id}`;

    const pub = contracts.capabilities.manifests.find((c) => c.visibility === 'public' && c.status === 'active');
    const internal = contracts.capabilities.manifests.find((c) => c.visibility === 'internal');
    const firstParty = contracts.capabilities.manifests.find((c) => c.visibility === 'first-party');
    const planned = contracts.capabilities.manifests.find((c) => c.visibility === 'public' && c.status !== 'active');
    // Partner capabilities do not exist in v0.26.0's manifests; the catalog Network serves can still
    // carry one (Network accepts the proposed visibility), so the mock lists two that the pinned
    // contracts do not know.
    const entry = (c) => ({ id: c.id, owner: c.owner, audience: `openvibe.${c.owner}`, visibility: c.visibility, description: c.description || '' });
    t.network.setCatalog([
        entry(pub),
        entry(internal),               // a buggy Network must not make Codes offer this
        entry(firstParty),
        ...(planned ? [entry(planned)] : []),
        { id: 'partnerx.thing.do', owner: 'partnerx', audience: 'openvibe.partnerx', visibility: 'partner', description: 'Partner thing A' },
        { id: 'partnerx.other.do', owner: 'partnerx', audience: 'openvibe.partnerx', visibility: 'partner', description: 'Partner thing B' },
    ]);
    t.network.setAllowance(projectId, ['partnerx.thing.do']);

    const offeredOn = (html) => {
        const table = (html.split('class="scope-editor"')[1] || '').split('</table>')[0];
        return [...table.matchAll(/<a href="\/docs\/capabilities\/([^"]+)"/g)].map((m) => m[1]);
    };

    await check('offers public capabilities with description, owner and visibility', async () => {
        const r = await t.get(base, { as: owner });
        assert.strictEqual(r.status, 200);
        const offered = offeredOn(r.text);
        assert.ok(offered.includes(pub.id));
        const row = r.text.split(`/docs/capabilities/${pub.id}"`)[1].split('</tr>')[0];
        assert.ok(row.includes(pub.owner) && row.includes('public'));
        if (pub.description) assert.ok(row.includes(pub.description.slice(0, 20).replace(/"/g, '&quot;').replace(/'/g, '&#39;')));
    });

    await check('never offers internal, first-party or non-active capabilities', async () => {
        const offered = offeredOn((await t.get(base, { as: owner })).text);
        assert.ok(!offered.includes(internal.id), `${internal.id} offered`);
        assert.ok(!offered.includes(firstParty.id), `${firstParty.id} offered`);
        if (planned) assert.ok(!offered.includes(planned.id), `${planned.id} offered`);
    });

    await check('offers a partner capability only when it is in this project\'s allowance', async () => {
        const offered = offeredOn((await t.get(base, { as: owner })).text);
        assert.ok(offered.includes('partnerx.thing.do'));
        assert.ok(!offered.includes('partnerx.other.do'));
    });

    await check('a forged request for an internal capability is refused before Network sees it', async () => {
        const before = t.network.requests.filter((x) => x.method === 'POST' && x.path.endsWith('/grants')).length;
        const r = await t.get(`${base}/grants`, { as: owner, form: { capability: internal.id } });
        assert.strictEqual(r.status, 422);
        assert.match(r.text, /codes\.not_grantable/);
        const after = t.network.requests.filter((x) => x.method === 'POST' && x.path.endsWith('/grants')).length;
        assert.strictEqual(after, before, 'no grant request reached Network');
    });

    await check('a forged request for a partner capability outside the allowance is refused too', async () => {
        const r = await t.get(`${base}/grants`, { as: owner, form: { capability: 'partnerx.other.do' } });
        assert.strictEqual(r.status, 422);
    });

    await check('an offered public capability is forwarded to Network and its answer shown', async () => {
        const r = await t.get(`${base}/grants`, { as: owner, form: { capability: pub.id } });
        assert.strictEqual(r.status, 303);
        assert.match(decodeURIComponent(r.headers.get('location')), new RegExp(`${pub.id.replace(/\./g, '\\.')}: requested`));
        const page = await t.get(base, { as: owner });
        assert.match(page.text, /outside the allowance/, 'a requested grant outside the allowance cannot be approved from Codes');
    });

    await check('the capability docs highlight exactly the grantable ones', async () => {
        const r = await t.get('/docs/capabilities?grantable=1');
        const listed = [...r.text.matchAll(/<a href="\/docs\/capabilities\/([^"]+)" class="grantable">/g)].map((m) => m[1]).sort();
        const expected = contracts.capabilities.manifests.filter((c) => c.status === 'active' && ['public', 'partner'].includes(c.visibility)).map((c) => c.id).sort();
        assert.deepStrictEqual(listed, expected);
    });

    await t.close();
    done();
})();
