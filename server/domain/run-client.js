'use strict';
/**
 * OpenVibe.Run for Codes (plan T16): a coding task on the person's own machine is a Run job Codes starts for them —
 * project delegation (ADR-003 amendment 2026-10-12): Codes' own service token (audience openvibe.run, run.job.submit,
 * read, stream and cancel) with the person in X-OV-Subject and their project in X-OV-Project. Run checks the person is
 * an admin or owner of the project before every job, places it only on that person's own machine (contracts 0.161.0)
 * and lets Codes read, cancel and stream only the jobs Codes started for that person.
 *
 *   submit({ subject, project, args, key })  → the job (run.job-read-result@1)
 *   read(jobId, who) · cancel(jobId, who)     → the job
 *   streamUrl(jobId, who)                     → the job's SSE URL on Run with a one-use ticket
 *
 * The artifact is the job runner's protocol (`openvibe-codes@1.0.0`, harness/job.js JOB_PROTOCOL), which the person's
 * Node declares; a failure is a RunError carrying Run's status and code.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { JOB_PROTOCOL } = require('../../harness/job');

const SCOPE = 'run.job.submit run.job.read run.job.stream run.job.cancel';

class RunError extends Error {
    constructor(status, code, detail) { super(detail || code); this.status = status; this.code = code; }
}

function createRunClient({ config, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    const { clientId, clientSecret } = config.oauth;
    const tokens = clientSecret
        ? createServiceTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId, clientSecret, audience: 'openvibe.run', scope: SCOPE, fetch: fetchImpl, now })
        : null;
    const base = config.run.url;
    async function call(method, path, { subject, project, body, key } = {}) {
        if (!tokens) throw new RunError(503, 'run.unconfigured', 'Codes has no Network client secret, so it cannot start a job');
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method,
                headers: {
                    ...(await tokens.authHeaders()), Accept: 'application/json', 'X-OV-Subject': subject, 'X-OV-Project': project,
                    ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
            });
        } catch (e) {
            throw new RunError(503, 'run.unavailable', `OpenVibe.Run did not answer: ${e.message}`);
        }
        if (res.status === 401) tokens.invalidate && tokens.invalidate();
        const doc = await res.json().catch(() => null);
        if (!res.ok) throw new RunError(res.status, (doc && doc.code) || 'run.error', (doc && (doc.detail || doc.title)) || `Run answered ${res.status}`);
        return doc;
    }
    /**
     * A coding job for `subject` in `project`, only on that person's own machine. A conductor's turn asks for more: its
     * wall time (a session that works through a plan), its TTL and its own memory, all bounded here; and when its
     * machine is known (`node`, the OpenVibe.Bot device id `dev_…`), the job is pinned to it (contracts 0.250.0): Run
     * runs it nowhere else, and refuses it `409 run.job.node_offline` when the machine is away.
     */
    async function submit({ subject, project, args, key, limits = null, ttlMs = null, node = null }) {
        const wall = Math.max(1000, Math.min(90 * 60_000, Number(limits && limits.wall_ms) || Number(args && args.limits && args.limits.ms) || 30 * 60_000));
        const body = {
            class: 'code', artifact: { name: 'openvibe-codes', version: JOB_PROTOCOL }, args,
            limits: {
                wall_ms: wall,
                cpu_ms: Math.max(1000, Math.min(90 * 60_000, Number(limits && limits.cpu_ms) || wall)),
                mem_bytes: Math.max(1024 ** 2, Math.min(16 * 1024 ** 3, Number(limits && limits.mem_bytes) || 4 * 1024 ** 3)),
            },
            ttl_ms: Math.max(60_000, Math.min(86_400_000, Number(ttlMs) || 45 * 60_000)),
            egress: 'public',
            requirements: { kind: 'run.code', mobility: 'job', latency_class: 'background', objective: 'balanced', trust: ['user-owned'] },
            // The machine the job runs on, pinned: a conductor's folder and memory are there (Codes C9c). Absent, Run
            // places the job where it fits, as before.
            ...(node ? { node: String(node).slice(0, 64) } : {}),
        };
        const out = await call('POST', '/api/v1/jobs', { subject, project, body, key });
        return out.job;
    }
    const read = (jobId, who) => call('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`, who);
    const cancel = (jobId, who) => call('POST', `/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, who);
    async function streamUrl(jobId, who) {
        const t = await call('POST', `/api/v1/jobs/${encodeURIComponent(jobId)}/stream/ticket`, who);
        return `${base}/api/v1/jobs/${encodeURIComponent(jobId)}/stream?ticket=${encodeURIComponent(t.ticket)}`;
    }
    return { submit, read, cancel, streamUrl, enabled: !!tokens };
}

module.exports = { createRunClient, RunError, SCOPE };
