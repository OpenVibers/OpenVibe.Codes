'use strict';
/**
 * codes.moderation.action (ADR-022): Codes staff acting on someone else's app goes to Network's
 * moderation audit log, in the transaction that makes the change.
 *   - staff revoking a release of a project they cannot manage: exactly one event (release.revoked)
 *   - a member revoking their own release: none (it is not moderation)
 *   - staff setting a trust tier: exactly one event (app.trust_changed, from and to); refused: none
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const manifests = require('../server/domain/manifests');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const owner = t.network.addUser('mona');
    const staff = t.network.addUser('root', { role: 'admin' });
    const projectId = await t.project(owner, 'Moderated');
    const app = await t.app(owner, projectId, { name: 'Moderated' });
    const base = `/projects/${projectId}/apps/${app.id}`;
    const manifest = (version) => JSON.stringify({ ...manifests.template('app', { appId: app.id, projectId, environment: 'sandbox', name: 'Moderated' }), version });
    const moderation = () => t.ctx.store.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all()
        .map((r) => JSON.parse(r.envelope)).filter((e) => e.event_type === 'codes.moderation.action');
    const published = async (version) => {
        const r = await t.get(`${base}/releases`, { as: owner, form: { kind: 'app', manifest: manifest(version), intent: 'create' } });
        const id = r.headers.get('location').split('/').pop();
        assert.strictEqual((await t.get(`/releases/${id}/publish`, { as: owner, form: {} })).status, 303);
        return id;
    };
    const valid = (e) => {
        assert.strictEqual(contracts.validate('events.event-envelope@1', e).valid, true, JSON.stringify(e));
        const r = contracts.validate('codes.moderation.action@1', e.payload);
        assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
        assert.strictEqual(e.source, 'codes');
        assert.strictEqual(e.visibility, 'internal');
        assert.deepStrictEqual(e.actor, { type: 'user', id: staff.subject });
    };

    await check('the owner revoking their own release is not moderation: no event', async () => {
        const id = await published('1.0.0');
        const r = await t.get(`/releases/${id}/revoke`, { as: owner, form: { reason: 'Mine to pull', confirm: '1' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(moderation().length, 0);
    });

    await check('staff revoking someone else\'s release: exactly one valid codes.moderation.action', async () => {
        const id = await published('1.1.0');
        const r = await t.get(`/releases/${id}/revoke`, { as: staff, form: { reason: 'Malware in the bundle', confirm: '1' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        const ev = moderation();
        assert.strictEqual(ev.length, 1);
        valid(ev[0]);
        assert.deepStrictEqual(ev[0].subject, { type: 'moderation_action', id: `release:${id}` });
        assert.strictEqual(ev[0].payload.action, 'release.revoked');
        assert.deepStrictEqual(ev[0].payload.target, { type: 'release', id, owner_subject: owner.subject });
        assert.strictEqual(ev[0].payload.actor_subject, staff.subject);
        assert.strictEqual(ev[0].payload.reason, 'Malware in the bundle');
        assert.strictEqual(ev[0].payload.details.was, 'published');
    });

    await check('staff setting a trust tier: exactly one event; a refused change: none', async () => {
        assert.strictEqual((await t.get('/staff/trust', { as: owner, form: { app_id: app.id, tier: 'reviewed', note: 'me' } })).status, 403);
        assert.strictEqual(moderation().length, 1);
        const r = await t.get('/staff/trust', { as: staff, form: { app_id: app.id, tier: 'reviewed', note: 'Read the source' } });
        assert.strictEqual(r.status, 303);
        const ev = moderation();
        assert.strictEqual(ev.length, 2);
        const e = ev[1];
        valid(e);
        assert.strictEqual(e.payload.action, 'app.trust_changed');
        assert.deepStrictEqual(e.payload.target, { type: 'app', id: app.id, owner_subject: null });
        assert.strictEqual(e.payload.reason, 'Read the source');
        assert.deepStrictEqual(e.payload.details, { from: 'unreviewed', to: 'reviewed' });
    });

    await t.close();
    done();
})();
