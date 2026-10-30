'use strict';

/**
 * The Agents page shows the fleet (Codes C9c): one calm row per agent, what each machine reports with its heartbeat —
 * a meter per limit window, and when it frees.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const ada = t.network.addUser('ada');
    const RESET = '2026-11-04T00:00:00Z';
    await t.ctx.store.db.exec(
        `INSERT INTO codes_machine_fleet (subject, machine, node_id, name, agent, installed, signed_in, windows, online, reported_at, updated_at)
         VALUES ($1,'dev_ada_laptop','nod_ada','ada-laptop','codex',true,true,$2::jsonb,true,now(),now()),
                ($1,'dev_ada_laptop','nod_ada','ada-laptop','minimax-code',true,true,'[]'::jsonb,true,now(),now()),
                ($1,'dev_ada_laptop','nod_ada','ada-laptop','opencode',true,false,'[]'::jsonb,true,now(),now())`,
        [ada.subject, JSON.stringify([{ name: 'week', used: 96, limit: 100, pct: 96, resets_at: RESET }])],
    );

    try {
        await check('the Agents page lists each agent of the fleet with a meter and when its window frees', async () => {
            const r = await t.get('/agents', { as: ada });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('Your fleet'), 'the fleet card');
            assert.ok(r.text.includes('c4-fleet-row'), 'a row per agent');
            assert.ok(r.text.includes('c4-meter'), 'a meter per window');
            assert.ok(r.text.includes('c4-meter-fill is-full'), 'a full window is drawn full');
            assert.ok(r.text.includes('week'), 'the window is named');
            assert.ok(r.text.includes('frees Wed 00:00 UTC'), 'when it frees, in UTC');
            assert.ok(r.text.includes('96% used') || r.text.includes('96 of 100'), 'how much is used');
            assert.ok(r.text.includes('ada-laptop'), 'the machine that reported it');
        });

        await check('each agent gets the state a person reads: full, has room, or sign in', async () => {
            const r = await t.get('/agents', { as: ada });
            assert.ok(r.text.includes('>Full<'), 'Codex at 96% is full');
            assert.ok(r.text.includes('>Has room<'), 'MiniMax has room');
            assert.ok(r.text.includes('>Sign in<'), 'OpenCode is not signed in');
            assert.ok(r.text.includes('not signed in'));
        });

        await check('with nothing reported the page says so and links to pairing a machine', async () => {
            const bo = t.network.addUser('bo');
            const r = await t.get('/agents', { as: bo });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('No machine has reported its agents yet'));
            assert.ok(r.text.includes('/machines'));
        });
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await t.close();
    }
    done();
})();
