'use strict';
/**
 * ADR-013 trust tiers (unreviewed, reviewed, first-party): databases written with the roadmap's
 * earlier names are migrated at boot — untrusted→unreviewed, verified|trusted→reviewed,
 * platform-maintained→first-party — including the history, and the CHECK constraint is rebuilt.
 * Running it again changes nothing. Tiers stay metadata.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openStore } = require('../server/db');
const { createTrust } = require('../server/domain/trust');
const { check, done } = require('./helpers/boot');

const A = (n) => `app_01JABCDEFGHJKMNPQRSTVWXYZ${n}`;

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codes-trust-'));
    const file = path.join(dir, 'codes.db');
    // A database as the first Codes build created it.
    const old = new Database(file);
    old.exec(`CREATE TABLE trust (
        app_id TEXT PRIMARY KEY,
        tier   TEXT NOT NULL CHECK (tier IN ('untrusted', 'verified', 'trusted', 'platform-maintained')),
        note   TEXT NOT NULL DEFAULT '', set_by TEXT NOT NULL, set_at TEXT NOT NULL);
      CREATE TABLE trust_history (id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, from_tier TEXT NOT NULL, to_tier TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', set_by TEXT NOT NULL, set_at TEXT NOT NULL);`);
    const ins = old.prepare('INSERT INTO trust VALUES (?, ?, ?, ?, ?)');
    ins.run(A(0), 'untrusted', 'n0', 'user:x', '2026-09-22T00:00:00Z');
    ins.run(A(1), 'verified', 'n1', 'user:x', '2026-09-22T00:00:00Z');
    ins.run(A(2), 'trusted', 'n2', 'user:x', '2026-09-22T00:00:00Z');
    ins.run(A(3), 'platform-maintained', 'n3', 'user:x', '2026-09-22T00:00:00Z');
    old.prepare('INSERT INTO trust_history (app_id, from_tier, to_tier, note, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)').run(A(3), 'trusted', 'platform-maintained', 'n', 'user:x', '2026-09-22T00:00:00Z');
    old.close();

    await check('old tier names are mapped and the CHECK only allows ADR-013 tiers', async () => {
        const store = openStore(file);
        const tiers = store.db.prepare('SELECT app_id, tier, note FROM trust ORDER BY app_id').all();
        assert.deepStrictEqual(tiers.map((r) => r.tier), ['unreviewed', 'reviewed', 'reviewed', 'first-party']);
        assert.deepStrictEqual(tiers.map((r) => r.note), ['n0', 'n1', 'n2', 'n3'], 'notes kept');
        assert.deepStrictEqual(store.db.prepare('SELECT from_tier, to_tier FROM trust_history').get(), { from_tier: 'reviewed', to_tier: 'first-party' });
        assert.throws(() => store.db.prepare("UPDATE trust SET tier = 'verified' WHERE app_id = ?").run(A(0)), /CHECK/);
        store.close();
    });

    await check('running it again changes nothing', async () => {
        const store = openStore(file);
        const sql = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trust'").get().sql;
        assert.ok(!/untrusted/.test(sql));
        assert.strictEqual(store.db.prepare('SELECT COUNT(*) AS n FROM trust').get().n, 4);
        const trust = createTrust({ store });
        assert.strictEqual(trust.get(A(0)).tier, 'unreviewed');
        assert.strictEqual(trust.get('app_01JZZZZZZZZZZZZZZZZZZZZZZZ').tier, 'unreviewed', 'the default is unreviewed');
        assert.deepStrictEqual(trust.TIERS, ['unreviewed', 'reviewed', 'first-party']);
        assert.throws(() => trust.set({ appId: A(0), tier: 'trusted', note: 'x', actor: { staff: true, label: 'user:x' } }), /tier is one of/);
        store.close();
    });

    await check('a fresh database is created on ADR-013 tiers', async () => {
        const store = openStore(path.join(dir, 'fresh.db'));
        assert.match(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'trust'").get().sql, /'unreviewed', 'reviewed', 'first-party'/);
        store.close();
    });

    fs.rmSync(dir, { recursive: true, force: true });
    done();
})();
