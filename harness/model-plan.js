'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const YAML = require('yaml');
const { validatePlan, resolvePlan, executePlan } = require('../engine/model-plan');
const { parseCatalog } = require('../server/data/ai-catalog');

const MAX_CONFIG = 64 * 1024;
const MAX_CHECK_OUTPUT = 4000;

/** Read only the project's models block, with errors tied to the file and line. */
function repositoryPlan(root) {
    const file = path.join(root, '.openvibe', 'codes.yml');
    if (!fs.existsSync(file)) return null;
    const real = fs.realpathSync(file);
    if (!real.startsWith(`${fs.realpathSync(root)}${path.sep}`)) throw new Error('.openvibe/codes.yml must be inside the repository');
    const source = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(source) > MAX_CONFIG) throw new Error('.openvibe/codes.yml is over 64 KiB');
    const doc = YAML.parseDocument(source, { uniqueKeys: true, maxAliasCount: 0, strict: true });
    if (doc.errors.length) throw new Error(`.openvibe/codes.yml:${doc.errors[0].linePos?.[0]?.line || 1}: ${doc.errors[0].message}`);
    const body = doc.toJS({ maxAliasCount: 0 });
    if (!body || typeof body !== 'object' || Array.isArray(body) || !body.models) throw new Error('.openvibe/codes.yml needs a models: block');
    try { return validatePlan(body.models); }
    catch (error) { throw new Error(`.openvibe/codes.yml models: ${error.message}`); }
}

/** Explicit task wins over repository, which wins over a saved project/account choice. */
function selectPlan({ saved = null, repository = null, task = null, preset = null } = {}) {
    if (task && preset) throw new Error('choose a plan or preset, not both');
    const { PRESETS } = require('../engine/model-plan');
    const picked = task || (preset ? PRESETS[preset] : null) || repository || saved;
    return picked ? validatePlan(picked) : null;
}

/** A repository plan is not saved on Codes; check its ids from AI before the first paid call. */
async function resolveRepositoryPlan(plan, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const url = String(env.OPENVIBE_AI_URL || 'https://ai.openvibe.services/v1').replace(/\/+$/, '');
    const token = env.OPENVIBE_AI_TOKEN || (env.OPENVIBE_APP_ID && env.OPENVIBE_APP_SECRET
        ? await require('./index').networkToken()(env, fetchImpl) : '');
    if (!token) throw new Error('.openvibe/codes.yml needs OpenVibe.AI access to check its models');
    let response;
    try {
        response = await fetchImpl(`${url.endsWith('/v1') ? url : `${url}/v1`}/models`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
        });
    } catch { throw new Error('OpenVibe.AI model registry did not answer for .openvibe/codes.yml'); }
    if (!response.ok) throw new Error(`OpenVibe.AI model registry answered ${response.status} for .openvibe/codes.yml`);
    const catalog = parseCatalog(await response.json());
    return resolvePlan(plan, catalog);
}

function projectCheck(kind, cwd) {
    const packageFile = path.join(cwd, 'package.json');
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')); } catch { /* not a Node project */ }
    if (!pkg?.scripts?.[kind]) return Promise.resolve({ kind, ok: false, output: `No ${kind} script is configured in package.json` });
    return new Promise((resolve) => {
        execFile('npm', ['run', kind, '--silent'], { cwd, timeout: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({ kind, ok: !error, exit_code: error?.code || 0, output: String(stdout || stderr || '').slice(-MAX_CHECK_OUTPUT) });
        });
    });
}

/** A plan uses only the OpenVibe.AI harness, which already supplies provider routing and receipts. */
async function runModelPlan({ plan, task, harness, cwd, diff, say, compact, permission = 'edit', sandboxed = false, check = projectCheck }) {
    const emit = (line) => say(line);
    const done = await executePlan(plan, {
        task,
        diff,
        check: (kind) => check(kind, cwd),
        onStep: (step) => {
            if (step.type === 'start' || step.type === 'end') emit({ t: 'step', event: step.type, role: step.role, phase: step.phase, model: step.model, outcome: step.outcome || null, tokens: step.tokens || 0, cost_usd: step.cost_usd || 0, duration_ms: step.duration_ms || 0, text: `${step.role} ${step.type === 'start' ? 'started' : step.outcome}`, metadata: { ov: { role: step.role, model: step.model, phase: step.phase, outcome: step.outcome || null } } });
            if (step.type === 'check') emit({ t: 'step', role: 'verifier', phase: step.kind, text: `${step.kind}: ${step.ok ? 'passed' : 'failed'}`, metadata: { ov: { role: 'verifier', check: step.kind, outcome: step.ok ? 'passed' : 'failed' } } });
        },
        invoke: async ({ role, phase, model, effort, budget, prompt }) => {
            const started = Date.now();
            const run = harness.run({
                prompt, task: phase === 'build' || phase === 'repair' ? 'edit' : 'review', agent: 'openvibe-ai',
                model: model === 'auto' ? 'openvibe/auto' : model, effort, cwd,
                permission: phase === 'build' || phase === 'repair' ? permission : 'read', handoff: false, maxAttempts: 1,
                sandboxed, ...(budget?.minutes ? { timeoutMs: budget.minutes * 60000 } : {}),
            });
            let last = null;
            for await (const event of run) {
                last = event;
                if (event.type === 'result') continue; // the plan emits one final done; role totals live on role steps
                const line = compact(event);
                for (const one of Array.isArray(line) ? line : line ? [line] : []) emit({ ...one, role, phase, metadata: { ov: { role, model, phase } } });
            }
            const usage = last?.usage || {};
            return {
                ok: last?.type === 'result' && !last?.is_error,
                refused: /model_not_found|model_unavailable|refus/i.test(String(last?.result || '')),
                text: String(last?.result || ''),
                resolved_model: last?.resolved_model || last?.model || (model === 'auto' ? 'openvibe/auto' : model),
                tokens: Number(last?.total_tokens) || Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0),
                cost_usd: Number(last?.total_cost_usd) || 0,
                duration_ms: Date.now() - started,
            };
        },
    });
    return {
        type: 'result', is_error: !done.ok, result: done.ok ? done.summary : done.reason,
        total_cost_usd: done.role_runs.reduce((sum, item) => sum + item.cost_usd, 0),
        total_tokens: done.role_runs.reduce((sum, item) => sum + item.tokens, 0),
        duration_ms: done.role_runs.reduce((sum, item) => sum + item.duration_ms, 0),
        role_runs: done.role_runs, escalation_reasons: done.reasons,
    };
}

module.exports = { repositoryPlan, selectPlan, resolveRepositoryPlan, projectCheck, runModelPlan };
