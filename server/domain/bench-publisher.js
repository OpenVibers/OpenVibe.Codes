'use strict';

const { createServiceTokenClient } = require('openvibe-sdk/auth');

const object = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    return null;
};
const normalize = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

function grade(expected, output) {
    if (expected == null) return null;
    if (typeof expected === 'string') return normalize(expected) === normalize(output) ? 100 : 0;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return null;
    if (typeof expected.exactly === 'string') return normalize(expected.exactly) === normalize(output) ? 100 : 0;
    if (typeof expected.contains === 'string') return String(output || '').includes(expected.contains) ? 100 : 0;
    if (typeof expected.not_contains === 'string') return String(output || '').includes(expected.not_contains) ? 0 : 100;
    return null;
}

function createBenchPublisher({ config, store, fetchImpl = globalThis.fetch, log = console }) {
    const tokens = config.oauth.clientSecret ? createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret, audience: 'openvibe.bench', scope: 'bench.run.publish', fetch: fetchImpl,
    }) : null;
    const publishing = new Set();

    async function onTaskTerminal(row) {
        const actorRef = object(row && row.actor_ref);
        const meta = actorRef && actorRef.bench;
        if (!meta || !meta.run_id || !meta.task_count || !tokens) return;
        const key = String(meta.run_id);
        if (publishing.has(key)) return;
        const siblings = await store.db.many(
            "SELECT * FROM run_tasks WHERE subject = $1 AND actor_ref->'bench'->>'run_id' = $2 ORDER BY created_at, id",
            [row.subject, key]);
        if (siblings.length < Number(meta.task_count) || siblings.some((x) => !['succeeded', 'failed', 'cancelled', 'expired'].includes(x.state))) return;
        publishing.add(key);
        try {
            const details = siblings.map((taskRow) => {
                const taskMeta = (object(taskRow.actor_ref) || {}).bench || {};
                const result = object(taskRow.result) || {};
                const automatic = (taskMeta.judges || []).some((j) => ['test_suite', 'automatic_grader'].includes(j.type));
                const score = automatic ? (grade(taskMeta.expected, result.output) ?? 0) : null;
                const taskId = String(taskMeta.task_id || taskRow.id);
                const renderKey = `${meta.run_id}~${Buffer.from(taskId).toString('base64url')}`;
                const base = String(config.bench.renderOrigin).replace(/\/+$/, '');
                return {
                    task_id: taskId, score,
                    cost_usd: Number(result.cost_usd) || 0,
                    ms: Number(result.duration_ms) || 0,
                    tokens: Number(result.tokens) || 0,
                    artifacts: [{ kind: String(taskMeta.kind || 'text'), url: `${base}/render/w/${renderKey}`, payload: { text: String(result.output || result.summary || taskRow.error || '').slice(0, 200000) } }],
                    transcript_url: `${String(config.baseUrl).replace(/\/+$/, '')}/run/tasks/${taskRow.id}`,
                };
            });
            const scoreRows = details.filter((t) => t.score != null);
            const score = scoreRows.length === details.length ? scoreRows.reduce((n, t) => n + t.score, 0) / scoreRows.length : null;
            const body = {
                id: meta.run_id, benchmark: meta.benchmark, model: meta.model, provider: meta.provider || 'unknown',
                route: { provider: meta.provider || 'unknown', model: meta.model },
                harness: { name: meta.harness, version: meta.harness_version || 'unknown' }, settings: {},
                executor: { kind: 'codes', id: String(row.id) }, tasks: details, score,
                cost_usd: details.reduce((n, t) => n + t.cost_usd, 0), ms: details.reduce((n, t) => n + t.ms, 0),
                tokens: details.reduce((n, t) => n + t.tokens, 0), provenance: 'verified', session: meta.session,
            };
            const response = await fetchImpl(`${String(config.bench.url).replace(/\/+$/, '')}/api/v1/runs`, {
                method: 'POST', headers: { ...(await tokens.authHeaders()), 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
            });
            if (!response.ok) throw new Error(`Bench answered ${response.status}`);
        } catch (e) {
            publishing.delete(key);
            throw e;
        }
    }

    return { onTaskTerminal };
}

module.exports = { createBenchPublisher, grade };
