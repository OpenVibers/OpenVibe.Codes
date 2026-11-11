'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { boot, check, done } = require('./helpers/boot');
const { PRESETS } = require('../engine/model-plan');

(async () => {
    const ai = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [
            { id: 'openvibe/auto', dynamic: true, availability: 'available' },
            { id: 'openvibe/economy', dynamic: true, availability: 'available' },
            { id: 'acme/strong@1', availability: 'available', retail_rate: { output_nano_usd_per_m: '1000000000' } },
            { id: 'acme/gone@1', availability: 'unavailable' },
        ] }));
        res.statusCode = 404; res.end('{}');
    });
    await new Promise((resolve) => ai.listen(0, '127.0.0.1', resolve));
    const submitted = [];
    const run = { enabled: true, submit: async (input) => { submitted.push(input); return { id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state: 'queued' }; } };
    const t = await boot({ env: { CODES_MODEL_PLANS: '1', CODES_AI_URL: `http://127.0.0.1:${ai.address().port}` }, run });
    const ada = t.network.addUser('ada');
    const token = t.network.mintService('svc:actor', 'openvibe.codes', ['codes.task.start', 'codes.task.read']);
    const headers = { Authorization: `Bearer ${token}`, 'X-OV-Subject': ada.subject };
    const call = async (method, path, body) => {
        const response = await fetch(`${t.base}/api/v1${path}`, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, body: await response.json() };
    };
    try {
        await check('presets and account/project plan API validate against the AI registry', async () => {
            const presets = await call('GET', '/model-plans/presets');
            assert.equal(presets.status, 200);
            assert.deepEqual(Object.keys(presets.body.presets), ['Fast', 'Balanced', 'Deep', 'Council']);
            const before = await call('GET', '/model-plans');
            assert.equal(before.body.account.mode, 'pair');
            const saved = await call('PUT', '/model-plans', { plan: PRESETS.Fast });
            assert.equal(saved.status, 200, JSON.stringify(saved.body));
            assert.equal(saved.body.resolved.mode, 'single');
            const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
            const withProject = await call('PUT', `/model-plans?project=${project}`, { plan: PRESETS.Deep });
            assert.equal(withProject.status, 200, JSON.stringify(withProject.body));
            assert.equal((await call('GET', `/model-plans?project=${project}`)).body.effective.mode, 'pair');
            const bad = await call('PUT', '/model-plans', { plan: { ...PRESETS.Fast, roles: [{ role: 'builder', model: 'acme/gone@1', effort: 'low' }] } });
            assert.equal(bad.status, 422);
            const fallback = await call('PUT', '/model-plans', { plan: { ...PRESETS.Fast, roles: [{ role: 'builder', model: 'acme/gone@1', effort: 'low' }], ladder: ['acme/strong@1'] } });
            assert.equal(fallback.status, 200, JSON.stringify(fallback.body));
            assert.equal(fallback.body.fallbacks[0].model, 'acme/strong@1');
        });
        await check('task preset reaches Run with the AI harness and records its resolved plan', async () => {
            const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
            await t.ctx.store.db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, prompt, state, created_at, updated_at)
                VALUES ('tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2T1', $1, $2, 'https://github.com/a/b', 'previous', 'succeeded', 1, 2)`, [ada.subject, project]);
            const created = await call('POST', '/tasks', { repo: 'https://github.com/a/b', prompt: 'Fix the parser', preset: 'Council' });
            assert.equal(created.status, 201, JSON.stringify(created.body));
            assert.equal(submitted.at(-1).args.agent, 'openvibe-ai');
            assert.equal(submitted.at(-1).args.plan.mode, 'council');
            assert.equal(submitted.at(-1).args.plan_source, 'task');
            assert.equal(created.body.task.model_plan.mode, 'council');
            await t.ctx.store.db.exec('UPDATE run_tasks SET role_runs = $2::jsonb WHERE id = $1', [created.body.task.id, JSON.stringify([
                { role: 'builder', phase: 'build', model: 'openvibe/auto', effort: 'high', outcome: 'passed', tokens: 45, cost_usd: 0.02, duration_ms: 900 },
            ])]);
            const recorded = await call('GET', `/tasks/${created.body.task.id}`);
            assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
            assert.equal(recorded.body.role_runs[0].tokens, 45);
            assert.equal(recorded.body.role_runs[0].model, 'openvibe/auto');
            const page = await t.get('/settings/model-plan', { as: ada });
            assert.equal(page.status, 200);
            assert.match(page.text, /Save model plan/);
        });
        await check('weekly admin page is owner-only and tuning requires its button', async () => {
            const other = await t.get('/admin/model-plans', { as: ada });
            assert.equal(other.status, 403);
            const owner = t.network.addUser('owner', { role: 'owner' });
            const page = await t.get('/admin/model-plans', { as: owner });
            assert.equal(page.status, 200, page.text.slice(0, 300));
            assert.match(page.text, /Model plan outcomes/);
            assert.match(page.text, /Presets/);
            const presets = await call('GET', '/model-plans/presets');
            assert.equal(presets.body.presets.Fast.roles[0].effort, 'low', 'reading the page never tunes');
        });
        done();
    } finally { await t.close(); await new Promise((resolve) => ai.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
