'use strict';

/**
 * AI Exchange P9: OpenVibe.Codes reads OpenVibe.AI's model catalog, behind CODES_AI_CATALOG.
 *
 * The parsing is exact and ordered: the dynamic aliases come before the exact ids, an output price is the integer
 * nano-USD rate in dollars without a float, and a legacy single `openvibe` answer is today's behavior, not a catalog.
 * The page keeps today's one OpenVibe.AI entry while the flag is off or AI's own catalog is off; with both on it
 * offers the aliases and exact ids with their prices and availability.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { parseCatalog, usdPerMillion, catalogChoices, priceDesc } = require('../server/data/ai-catalog');
const { createAiCatalog } = require('../server/domain/ai-catalog');
const { usageOf } = require('../server/domain/run-tasks');
const models = require('../server/data/models');
const { refusalOf } = require('../harness/adapters/api');

const CATALOG = {
    object: 'list',
    data: [
        {
            id: 'acme/m1:q4_k_m@rev1', object: 'model', display_name: 'alpha-1', family: 'm', variant: 'original',
            quant: 'q4_k_m', revision: 'rev1', availability: 'available', dynamic: false,
            retail_rate: { output_nano_usd_per_m: '1500000000', input_nano_usd_per_m: '1000000000', per_request_nano_usd: '0' },
        },
        { id: 'openvibe/economy', name: 'Economy', policy: 'cheapest', dynamic: true, availability: 'available', description: 'The lowest cost per successful answer.' },
        {
            id: 'acme/m3@rev3', object: 'model', display_name: 'gamma', availability: 'unavailable', dynamic: false,
            retail_rate: { output_nano_usd_per_m: '123456789' },
        },
        { id: 'openvibe', name: 'OpenVibe AI', policy: 'auto', dynamic: true, availability: 'available' },
        { id: 'openvibe/auto', name: 'Auto', policy: 'auto', dynamic: true, availability: 'available' },
    ],
};

/** A stand-in OpenVibe.AI: GET /v1/models in a mode, so a test can turn its own catalog off. */
async function fakeAi() {
    const st = { mode: 'catalog', calls: [] };
    const server = http.createServer((req, res) => {
        st.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || null });
        if (req.method === 'GET' && req.url === '/v1/models') {
            const body = st.mode === 'legacy'
                ? { object: 'list', data: [{ id: 'openvibe', object: 'model', owned_by: 'openvibe' }] }
                : CATALOG;
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(body));
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found', code: 'not_found' } }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        url: `http://127.0.0.1:${server.address().port}`, st,
        setMode: (m) => { st.mode = m; },
        close: () => new Promise((r) => server.close(r)),
    };
}

(async () => {
    await check('the catalog is parsed exactly: aliases first, then exact ids, with integer nano-USD prices', () => {
        const catalog = parseCatalog(CATALOG);
        assert.deepStrictEqual(catalog.entries.map((e) => e.id), [
            'openvibe/auto', 'openvibe/economy', 'openvibe', 'acme/m1:q4_k_m@rev1', 'acme/m3@rev3',
        ], 'the dynamic aliases, in order, before every exact id');
        assert.deepStrictEqual(catalog.aliases, ['openvibe/auto', 'openvibe/economy', 'openvibe']);
        assert.deepStrictEqual(catalog.models, ['acme/m1:q4_k_m@rev1', 'acme/m3@rev3']);
        const byId = new Map(catalog.entries.map((e) => [e.id, e]));
        assert.deepStrictEqual([byId.get('openvibe/auto').dynamic, byId.get('openvibe/auto').badge], [true, 'Dynamic']);
        assert.strictEqual(byId.get('acme/m1:q4_k_m@rev1').desc, '$1.50 per million output tokens');
        assert.strictEqual(byId.get('acme/m3@rev3').desc, '$0.123456789 per million output tokens');
        assert.deepStrictEqual([byId.get('acme/m1:q4_k_m@rev1').state, byId.get('acme/m1:q4_k_m@rev1').badge], ['ok', 'Available']);
        assert.deepStrictEqual([byId.get('acme/m3@rev3').state, byId.get('acme/m3@rev3').badge], ['bad', 'Unavailable']);
        assert.deepStrictEqual(catalogChoices(catalog), catalog.entries);
        assert.deepStrictEqual([usdPerMillion('1500000000'), usdPerMillion('123456789'), usdPerMillion('0'), usdPerMillion('nope')],
            ['1.50', '0.123456789', '0.00', null]);
        assert.strictEqual(priceDesc({ retail_rate: { output_nano_usd_per_m: '2000000000' } }), '$2.00 per million output tokens');
    });

    await check('a legacy single openvibe model, or anything that is not a catalog, is null (today\'s behavior)', () => {
        assert.strictEqual(parseCatalog({ data: [{ id: 'openvibe', object: 'model' }] }), null);
        assert.strictEqual(parseCatalog({ data: [] }), null);
        assert.strictEqual(parseCatalog({ nope: true }), null);
        assert.strictEqual(parseCatalog({ data: [{ id: 'acme/no-exact-id', display_name: 'listed but not addressable' }] }), null);
    });

    await check('the fetched catalog is cached about five minutes, and a flag off or a legacy answer is no catalog', async () => {
        const calls = [];
        let now = 1_000_000;
        const fetchImpl = async (url) => {
            calls.push(String(url));
            if (String(url).endsWith('/oauth/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'svc-token', expires_in: 300 }) };
            return { ok: true, status: 200, json: async () => CATALOG };
        };
        const config = {
            networkInternalUrl: 'http://network.test', oauth: { clientId: 'codes', clientSecret: 's'.repeat(40) },
            ai: { url: 'http://ai.test', audience: 'openvibe.ai' },
            aiCatalog: { enabled: true, ttlMs: 60_000 },
        };
        const catalog = createAiCatalog({ config, fetchImpl, now: () => now });
        const first = await catalog.read();
        assert.ok(first && first.entries.length, 'the catalog was read');
        await catalog.read();
        assert.strictEqual(calls.filter((u) => u.endsWith('/v1/models')).length, 1, 'the second read is cached');
        assert.ok(calls.some((u) => u.endsWith('/v1/models')), 'read from AI');
        now += 60_001;
        await catalog.read();
        assert.strictEqual(calls.filter((u) => u.endsWith('/v1/models')).length, 2, 'the cache expired after the ttl');

        const off = createAiCatalog({ config: { ...config, aiCatalog: { enabled: false } }, fetchImpl, now: () => now });
        assert.strictEqual(await off.read(), null);
        assert.deepStrictEqual(await off.choices(), []);
        const before = calls.length;
        await off.read();
        assert.strictEqual(calls.length, before, 'the flag off never calls AI');

        const legacy = createAiCatalog({
            config, now: () => now,
            fetchImpl: async (url) => (String(url).endsWith('/oauth/token')
                ? { ok: true, status: 200, json: async () => ({ access_token: 'svc-token', expires_in: 300 }) }
                : { ok: true, status: 200, json: async () => ({ data: [{ id: 'openvibe' }] }) }),
        });
        assert.strictEqual(await legacy.read(), null, 'AI\'s own catalog off is today\'s one model');
    });

    await check('the picker maps every catalog id unchanged, and an exact-id refusal keeps AI\'s code', () => {
        const harnesses = { list: () => [{ id: 'openvibe-ai', name: 'OpenVibe.AI' }, { id: 'claude-code', name: 'Claude Code' }] };
        const catalog = parseCatalog(CATALOG);
        const choices = models.choices(harnesses, catalog.entries).filter((c) => c.agent === 'openvibe-ai');
        assert.deepStrictEqual(choices.map((c) => c.model), ['openvibe/auto', 'openvibe/economy', 'openvibe', 'acme/m1:q4_k_m@rev1', 'acme/m3@rev3']);
        assert.deepStrictEqual([choices[0].state, choices[0].badge, choices[0].detail], ['ok', 'Dynamic', catalog.entries[0].desc]);
        assert.strictEqual(models.parse('openvibe-ai|acme/m1:q4_k_m@rev1', harnesses, { aiCatalog: true }).model, 'acme/m1:q4_k_m@rev1', 'sent unchanged');
        assert.strictEqual(models.parse('openvibe-ai|acme/m1:q4_k_m@rev1', harnesses), null, 'flag off keeps today: only the default model');
        assert.match(refusalOf('OpenVibe.AI', 404, { error: { message: 'no artifact acme/x@r', code: 'ai.model_not_found' } }, 'acme/x@r'), /refused the model acme\/x@r: HTTP 404 ai\.model_not_found/);
        assert.match(refusalOf('OpenVibe.AI', 429, { error: { message: 'slow down' } }, 'x'), /HTTP 429: slow down/);
    });

    await check('the run records the resolved model from the disclosure where it records the model', () => {
        assert.strictEqual(usageOf({ resolved_model: 'acme/m1:q4_k_m@rev1', log: [{ t: 'agent', model: 'acme/m1:q4_k_m@rev1' }] }).model, 'acme/m1:q4_k_m@rev1');
        assert.strictEqual(usageOf({ log: [{ t: 'agent', model: 'openvibe/auto' }, { t: 'done', resolved_model: 'acme/m3@rev3', model: 'acme/m3@rev3' }] }).model, 'acme/m3@rev3', 'a resolved exact id wins');
        assert.strictEqual(usageOf({ log: [{ t: 'agent', model: 'requested' }] }).model, 'requested', 'today\'s behavior without a disclosure');
    });

    const ai = await fakeAi();
    const on = await boot({ env: { CODES_AI_CATALOG: '1', CODES_AI_CATALOG_TTL_MS: '0', CODES_AI_URL: ai.url } });
    const ada = on.network.addUser('ada');
    try {
        await check('with both flags on, the picker offers the aliases first and then the exact ids, with prices and availability', async () => {
            const r = await on.get('/', { as: ada });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            const alias = r.text.indexOf('value="openvibe-ai|openvibe/auto"');
            const economy = r.text.indexOf('value="openvibe-ai|openvibe/economy"');
            const exact = r.text.indexOf('value="openvibe-ai|acme/m1:q4_k_m@rev1"');
            const unavailable = r.text.indexOf('value="openvibe-ai|acme/m3@rev3"');
            assert.ok(alias > 0, 'the auto alias is offered');
            assert.ok(economy > alias, 'the aliases keep their order');
            assert.ok(exact > economy, 'the exact ids come after the aliases');
            assert.ok(unavailable > exact, 'every exact id is offered');
            assert.match(r.text.slice(alias, alias + 400), /data-badge="Dynamic"/);
            assert.match(r.text.slice(exact, exact + 400), /data-desc="\$1\.50 per million output tokens"/);
            assert.match(r.text.slice(unavailable, unavailable + 400), /data-state="bad"/);
            assert.match(r.text.slice(unavailable, unavailable + 400), /data-badge="Unavailable"/);
            assert.ok(ai.st.calls.some((c) => c.url === '/v1/models'), 'Codes read AI\'s catalog');
            assert.ok(ai.st.calls.some((c) => /^Bearer /.test(c.auth || '')), 'with a token');
        });

        await check('with AI\'s own catalog off, the picker keeps today\'s single OpenVibe.AI entry', async () => {
            ai.setMode('legacy');
            const r = await on.get('/', { as: ada });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('value="openvibe-ai|"'), 'the default OpenVibe.AI entry is still there');
            assert.ok(!r.text.includes('openvibe-ai|openvibe/auto'), 'no alias from a legacy answer');
            assert.ok(!r.text.includes('openvibe-ai|acme/m1:q4_k_m@rev1'), 'no exact id from a legacy answer');
        });
    } finally {
        await on.close();
    }

    // The flag off is exactly today: the old single entry, and AI is never asked for a catalog.
    const before = ai.st.calls.length;
    const off = await boot({ env: { CODES_AI_URL: ai.url } });
    try {
        const r = await off.get('/', { as: off.network.addUser('ada') });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('value="openvibe-ai|"'));
        assert.ok(!r.text.includes('openvibe-ai|openvibe/auto'));
        assert.strictEqual(ai.st.calls.length, before, 'the flag off never asked AI for a catalog');
    } finally {
        await off.close();
        await ai.close();
    }

    console.log('ai-catalog: aliases before exact ids, exact nano-USD prices, and today\'s picker while either flag is off');
    done();
})().catch((e) => { console.error(e); process.exit(1); });
