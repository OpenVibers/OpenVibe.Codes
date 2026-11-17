'use strict';

/**
 * Imported sessions on openvibe.codes (plan §AD.22): `openvibe-codes import` uploads a session as its owner (a Network
 * token as a Bearer), the person sees it, their machine reads it with the same token, and a conductor started from it
 * resumes it: the first attempt's session is the imported one and every turn names where to read it.
 */
const assert = require('assert');
const zlib = require('zlib');
const p = require('../engine/portable');
const { boot, check, done } = require('./helpers/boot');

const SID = '11111111-2222-4333-8444-555555555555';
const doc = () => {
    const records = [
        { type: 'system', subtype: 'compact_boundary', uuid: 'b0', parentUuid: null, sessionId: SID, cwd: '/home/ada/site' },
        { type: 'user', uuid: 'b1', parentUuid: 'b0', sessionId: SID, cwd: '/home/ada/site', message: { role: 'user', content: 'Ship the import' } },
        { type: 'assistant', uuid: 'b2', parentUuid: 'b1', sessionId: SID, cwd: '/home/ada/site', message: { role: 'assistant', content: [{ type: 'text', text: 'Shipped.' }] } },
    ];
    return p.portable(records, { harness: 'claude-code', session_id: SID, cwd: '/home/ada/site', git_branch: 'main', version: '2.1.326' });
};

(async () => {
    const jobs = [];
    const run = {
        submit: async (j) => { jobs.push(j); return { id: `job_${String(jobs.length).padStart(26, '0')}`, state: 'queued' }; },
        get: async () => null,
    };
    const t = await boot({ run });
    const ada = t.network.addUser('ada-imports');
    const bo = t.network.addUser('bo-imports');
    const adaToken = t.network.userToken(ada);
    const up = (body, bearer = adaToken) => t.get('/api/v1/sessions/imports', { method: 'POST', bearer, body, headers: { 'content-type': 'application/octet-stream' } });
    let imp = null;
    try {
        await check('the CLI uploads a session as its owner; the document is checked, not trusted', async () => {
            const r = await up(zlib.gzipSync(JSON.stringify(doc())));
            assert.strictEqual(r.status, 201, r.text);
            imp = r.json().import;
            assert.ok(/^imp_[0-9A-HJKMNP-TV-Z]{26}$/.test(imp.id));
            assert.deepStrictEqual([imp.harness, imp.session_id, imp.title, imp.resumable, imp.messages, imp.source_cwd], ['claude-code', SID, 'Ship the import', true, 2, '/home/ada/site']);
            assert.deepStrictEqual(imp.preview.map((m) => m.text), ['Ship the import', 'Shipped.']);
            assert.strictEqual((await up(Buffer.from('{"format":"other"}'))).status, 422);
            assert.strictEqual((await up(zlib.gzipSync(JSON.stringify({ ...doc(), session_id: '../etc' })))).status, 422);
            assert.strictEqual((await up(zlib.gzipSync(JSON.stringify(doc())), 'not-a-token')).status, 401);
        });

        await check("they see it, their machine reads it with their token, and nobody else's does", async () => {
            const list = await t.get('/api/v1/sessions/imports', { as: ada });
            assert.deepStrictEqual(list.json().imports.map((i) => i.id), [imp.id]);
            const one = await t.get(`/api/v1/sessions/imports/${imp.id}`, { bearer: adaToken });
            assert.strictEqual(one.json().import.title, 'Ship the import');
            const bytes = await t.get(`/api/v1/sessions/imports/${imp.id}/document`, { bearer: adaToken });
            assert.strictEqual(bytes.status, 200);
            assert.strictEqual(JSON.parse(zlib.gunzipSync(bytes.buffer).toString()).session_id, SID);
            assert.strictEqual((await t.get(`/api/v1/sessions/imports/${imp.id}`, { as: bo })).status, 404, 'another person: not found');
            assert.strictEqual((await t.get(`/api/v1/sessions/imports/${imp.id}/document`, { as: bo })).status, 404);
        });

        await check('the conductor page offers it, and a conductor started from it resumes it on the machine', async () => {
            const page = await t.get(`/conductor?import=${imp.id}`, { as: ada });
            assert.ok(page.text.includes('Continuing your imported session') && page.text.includes(`value="${imp.id}"`), 'the pick is on the form');
            assert.ok(page.text.includes('Your imported sessions'));
            const conductor = t.ctx.conductor;
            const project = 'prj_01M7A6T4Y2ZNWTMM8VR6HW5T17';
            const imported = await t.ctx.sessionImports.get(ada.subject, imp.id);
            const made = await conductor.create({ subject: ada.subject, project, folder: '/srv/openvibe/work', imported });
            assert.strictEqual(made.task.import_id, imp.id);
            assert.strictEqual(made.task.agent, 'claude-code', 'the session\'s own agent leads');
            const att = await t.ctx.store.db.one('SELECT session FROM codes_attempts WHERE task_id = $1 ORDER BY n LIMIT 1', [made.task.id]);
            assert.strictEqual(att.session, SID, 'the first attempt resumes the imported session');
            const args = jobs.length ? jobs[jobs.length - 1].args : null;
            if (args) {
                assert.strictEqual(args.resume, SID);
                assert.deepStrictEqual(args.import, { url: `${t.config.baseUrl}/api/v1/sessions/imports/${imp.id}/document`, session: SID });
            }
        });

        await check('forgetting it removes it', async () => {
            const del = await t.get(`/api/v1/sessions/imports/${imp.id}`, { method: 'DELETE', bearer: adaToken });
            assert.deepStrictEqual(del.json(), { removed: true });
            assert.strictEqual((await t.get(`/api/v1/sessions/imports/${imp.id}`, { as: ada })).status, 404);
        });
    } finally {
        await t.close();
        done();
    }
})();
