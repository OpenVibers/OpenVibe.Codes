'use strict';

/**
 * Trust tiers (ADR-013, binding): unreviewed, reviewed, first-party.
 *
 * METADATA ONLY. "A tier changes defaults and discovery, but never the grant check." Nothing in
 * Codes (or anywhere) reads a tier to allow an action; the tier is shown next to releases and
 * carried in codes.app.* event payloads. Every app starts unreviewed; Codes staff change it, with
 * a note, and every change is kept. Older names are migrated at boot (server/db.js).
 */
const TIERS = ['unreviewed', 'reviewed', 'first-party'];
const APP_ID_RE = /^app_[0-9A-HJKMNP-TV-Z]{26}$/;

function createTrust({ store }) {
    const { db } = store;

    function get(appId) {
        const r = db.prepare('SELECT * FROM trust WHERE app_id = ?').get(String(appId));
        return r ? { tier: r.tier, note: r.note, set_by: r.set_by, set_at: r.set_at } : { tier: 'unreviewed', note: '', set_by: null, set_at: null };
    }

    function set({ appId, tier, note, actor }) {
        if (!actor || !actor.staff) throw Object.assign(new Error('only Codes staff set trust tiers'), { status: 403, code: 'trust.staff_only' });
        if (!APP_ID_RE.test(String(appId))) throw Object.assign(new Error('not an app id'), { status: 422, code: 'trust.invalid' });
        if (!TIERS.includes(tier)) throw Object.assign(new Error(`tier is one of ${TIERS.join(', ')}`), { status: 422, code: 'trust.invalid' });
        const clean = String(note || '').trim().slice(0, 500);
        if (!clean) throw Object.assign(new Error('say why (the note is public)'), { status: 422, code: 'trust.invalid' });
        const before = get(appId).tier;
        const t = store.iso();
        db.transaction(() => {
            db.prepare(`INSERT INTO trust (app_id, tier, note, set_by, set_at) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(app_id) DO UPDATE SET tier = excluded.tier, note = excluded.note, set_by = excluded.set_by, set_at = excluded.set_at`)
                .run(appId, tier, clean, actor.label, t);
            db.prepare('INSERT INTO trust_history (app_id, from_tier, to_tier, note, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)')
                .run(appId, before, tier, clean, actor.label, t);
        })();
        return get(appId);
    }

    const history = (appId) => db.prepare('SELECT from_tier, to_tier, note, set_by, set_at FROM trust_history WHERE app_id = ? ORDER BY id DESC').all(String(appId));
    const listSet = () => db.prepare('SELECT * FROM trust ORDER BY set_at DESC LIMIT 200').all();

    return { get, set, history, listSet, TIERS };
}

module.exports = { createTrust, TIERS };
