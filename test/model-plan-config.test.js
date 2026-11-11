'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PRESETS } = require('../engine/model-plan');
const { repositoryPlan, selectPlan, resolveRepositoryPlan, runModelPlan } = require('../harness/model-plan');
const { initial, createMapper } = require('../server/agent-ui/mapper');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-plan-config-'));
try {
    fs.mkdirSync(path.join(root, '.openvibe'));
    fs.writeFileSync(path.join(root, '.openvibe', 'codes.yml'), 'models:\n  mode: pair\n  roles:\n    - role: builder\n      model: auto\n      effort: high\n    - role: reviewer\n      model: auto\n      effort: medium\n  checks:\n    tests: true\n    reviewer: true\n');
    const repository = repositoryPlan(root);
    assert.equal(repository.mode, 'pair');
    assert.equal(selectPlan({ saved: PRESETS.Fast, repository }).mode, 'pair');
    assert.equal(selectPlan({ saved: PRESETS.Fast, repository, task: PRESETS.Council }).mode, 'council');
    fs.writeFileSync(path.join(root, '.openvibe', 'codes.yml'), 'models:\n  mode: pair\n  roles: invalid\n');
    assert.throws(() => repositoryPlan(root), /codes\.yml models: plan\.roles/);
} finally { fs.rmSync(root, { recursive: true, force: true }); }

(async () => {
    const resolved = await resolveRepositoryPlan({ ...PRESETS.Fast, roles: [{ role: 'builder', model: 'acme/gone@1', effort: 'low' }], ladder: ['openvibe/economy'] }, {
        env: { OPENVIBE_AI_URL: 'https://ai.test/v1', OPENVIBE_AI_TOKEN: 'stub' },
        fetchImpl: async (url) => {
            assert.equal(url, 'https://ai.test/v1/models');
            return { ok: true, json: async () => ({ data: [
                { id: 'acme/gone@1', availability: 'unavailable' },
                { id: 'openvibe/economy', availability: 'available' },
            ] }) };
        },
    });
    assert.equal(resolved.plan.roles[0].model, 'openvibe/economy');
    assert.equal(resolved.fallbacks.length, 1);
    const appUrls = [];
    const appResolved = await resolveRepositoryPlan(PRESETS.Fast, {
        env: { OPENVIBE_AI_URL: 'https://ai.test/v1', OPENVIBE_NETWORK_URL: 'https://network.test', OPENVIBE_APP_ID: 'app', OPENVIBE_APP_SECRET: 'stub' },
        fetchImpl: async (url) => {
            appUrls.push(url);
            return url.endsWith('/oauth/token')
                ? { ok: true, json: async () => ({ access_token: 'stub', expires_in: 300 }) }
                : { ok: true, json: async () => ({ data: [{ id: 'openvibe/auto', availability: 'available' }] }) };
        },
    });
    assert.equal(appResolved.plan.mode, 'single');
    assert.deepEqual(appUrls, ['https://network.test/oauth/token', 'https://ai.test/v1/models']);

    const calls = [];
    const lines = [];
    const ran = await runModelPlan({
        plan: PRESETS.Fast, task: 'fix', cwd: root, diff: async () => 'diff --git a/a b/a',
        harness: { run: (request) => {
            calls.push(request);
            return { async *[Symbol.asyncIterator]() { yield { type: 'result', result: request.task === 'edit' ? 'fixed' : 'PASS', total_tokens: 12, total_cost_usd: 0.001 }; } };
        } },
        check: async (kind) => ({ kind, ok: true }), say: (line) => lines.push(line), compact: () => null,
    });
    assert.equal(ran.is_error, false);
    assert.deepEqual(calls.map((call) => call.agent), ['openvibe-ai', 'openvibe-ai']);
    assert.deepEqual(ran.role_runs.map((run) => run.role), ['builder', 'verifier']);
    assert.equal(ran.total_tokens, 24);
    assert.equal(lines.filter((line) => line.t === 'step' && line.event === 'end').length, 2);

    const mapper = createMapper(initial('task_1', 'codes', new Date().toISOString()));
    await mapper.push({ t: 'step', event: 'start', role: 'builder', phase: 'build', model: 'openvibe/auto' }, 1, new Date().toISOString());
    await mapper.push({ t: 'step', event: 'end', role: 'builder', phase: 'build', model: 'openvibe/auto', outcome: 'passed', tokens: 100, cost_usd: 0.01, duration_ms: 100 }, 2, new Date().toISOString());
    assert.equal(mapper.events.filter((e) => e.event.type === 'STEP_STARTED').length, 1);
    const finished = mapper.events.find((e) => e.event.type === 'STEP_FINISHED').event;
    assert.equal(finished.metadata.ov.model, 'openvibe/auto');
    assert.equal(finished.metadata.ov.tokens, 100);
    console.log('model plan config: repository YAML, precedence, AI fallback, harness routing and AG-UI role metadata');
})().catch((error) => { console.error(error); process.exitCode = 1; });
