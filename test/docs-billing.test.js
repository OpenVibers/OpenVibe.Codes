'use strict';
/**
 * /docs/billing (WS-K task 10) renders OpenVibe.Billing's /policy.json and nothing of its own: the
 * numbers on the page are the ones Billing answered, and Billing not answering is a 502 with a
 * problem box, never numbers from anywhere else.
 */
const assert = require('assert');
const http = require('http');

const POLICY = {
    authority: 'live', wording_date: '2026-09-26',
    currencies: { vibes: { bought_with_money: true, cash_value_per_100_cents: 100, withdrawable: 'only Vibes you received' }, opencoins: { bought_with_money: false, withdrawable: false }, channel_points: { bought_with_money: false, withdrawable: false } },
    purchase: { min_vibes: 100, max_vibes: 10000000, tiers: [{ from: 100, to: 499, price_per_100_cents: 150, creator_value_per_100_cents: 100, openvibe_keeps_pct: 33.3 }, { from: 500, to: null, price_per_100_cents: 137, creator_value_per_100_cents: 100, openvibe_keeps_pct: 27 }] },
    tips: { creator_receives_pct: 100 },
    subscription: { price_cents: 499, period_days: 31, creator_share_pct: 70, creator_share_cents: 349, site_route_fee_pct: 10, site_route_fee_cents: 50 },
    cashout: { min_vibes: 500, min_cents: 500, hold_days: 14 },
};

(async () => {
    let up = true;
    const billing = http.createServer((req, res) => {
        if (!up) { res.statusCode = 503; return res.end('{}'); }
        if (req.url !== '/policy.json') { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(POLICY));
    });
    await new Promise((r) => billing.listen(0, '127.0.0.1', r));
    process.env.OV_BILLING_INTERNAL_URL = `http://127.0.0.1:${billing.address().port}`;
    const { boot, check, done } = require('./helpers/boot');
    const t = await boot();

    await check('the page shows what Billing answered', async () => {
        const r = await t.get('/docs/billing');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        for (const s of ['$1.37', '27%', '500 or more', '$4.99 for 31 days', '70% ($3.49)', '10% ($0.50)', '500 Vibes ($5.00)', '14 days', 'openvibe.live', 'billing.openvibe.network/policy']) {
            assert.ok(r.text.includes(s), `the page says ${s}`);
        }
        assert.ok((await t.get('/docs')).text.includes('href="/docs/billing"'), 'the docs index links it');
    });

    await check('Billing down on a cold cache: a problem, no numbers', async () => {
        up = false;
        // A fresh process has no cache; drop this one's by booting a second app.
        for (const k of Object.keys(require.cache)) if (k.includes('/server/http/docs.js')) delete require.cache[k];
        const t2 = await boot();
        const r = await t2.get('/docs/billing');
        assert.strictEqual(r.status, 502);
        assert.ok(r.text.includes('The billing policy could not be read'));
        assert.ok(!r.text.includes('$4.99'), 'no numbers without Billing');
        await t2.close();
    });

    await t.close();
    billing.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
