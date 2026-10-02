'use strict';
/**
 * openvibe-sdk/service (plan T16/J2): the entry point's graceful stop runs its close steps in order
 * (outbox.stop, then store.close) and resolves exit 0; a second signal while stopping is a no-op.
 */
const assert = require('assert');
const http = require('http');
const { check, done } = require('./helpers/boot');
const { createLifecycle } = require('../server/index');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

(async () => {
    await check('the entry point stop runs outbox.stop then store.close, then exits 0', async () => {
        const steps = [];
        const ctx = {
            outbox: { stop: async () => { steps.push('outbox.stop'); } },
            store: { close: async () => { steps.push('store.close'); } },
        };
        const server = http.createServer((req, res) => res.end('ok'));
        await listen(server);

        const exits = [];
        const lifecycle = createLifecycle({ server, ctx, exit: (code) => exits.push(code), signals: false });
        const code = await lifecycle.stop('SIGTERM');

        assert.strictEqual(code, 0);
        assert.deepStrictEqual(exits, [0]);
        assert.deepStrictEqual(steps, ['outbox.stop', 'store.close']);
        assert.strictEqual(server.listening, false);
    });

    await check('a second signal while stopping is a no-op', async () => {
        let stops = 0; let closes = 0; let exits = 0;
        const ctx = {
            outbox: { stop: async () => { stops += 1; } },
            store: { close: async () => { closes += 1; } },
        };
        const server = http.createServer((req, res) => res.end('ok'));
        await listen(server);

        const lifecycle = createLifecycle({ server, ctx, exit: () => { exits += 1; }, signals: false });
        const first = lifecycle.stop('SIGTERM');
        const second = lifecycle.stop('SIGINT');

        assert.strictEqual(first, second);
        assert.deepStrictEqual(await Promise.all([first, second]), [0, 0]);
        assert.strictEqual(stops, 1);
        assert.strictEqual(closes, 1);
        assert.strictEqual(exits, 1);
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
