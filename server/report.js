'use strict';

/**
 * The session report of a finished task (Agent Streams S3).
 *
 * When a task ends, Codes sends its report to OpenVibe.Report: what was asked, what came out, the proof (the tests,
 * the screenshots and the review), what it cost and how it ended. The write is idempotent per (source, task ref), so
 * a task that ends twice keeps one report.
 *
 * The token is Codes' own, for the audience openvibe.report, with the capability report.session.write (Network's
 * principals seed). The report never holds the raw transcript: Report's house redactor runs over every text field
 * before anything is stored.
 *
 *   createReportClient({ config, fetchImpl, log })
 *     send(payload)   the report of one finished task
 */
const TOKEN_TTL_MS = 10 * 60_000;

function createReportClient({ config = {}, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() } = {}) {
    const base = String(config.reportInternalUrl || 'http://127.0.0.1:5080').replace(/\/+$/, '');
    let cached = null;

    /** Codes' service token for Report's audience. */
    async function token() {
        if (cached && cached.until > now()) return cached.token;
        const clientId = config.oauth && config.oauth.clientId;
        const clientSecret = config.oauth && config.oauth.clientSecret;
        if (!clientId || !clientSecret) throw new Error('Codes has no Network client secret, so it cannot write a session report');
        const body = new URLSearchParams({
            grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
            audience: 'openvibe.report', scope: 'report.session.write',
        });
        const res = await fetchImpl(`${config.networkInternalUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: body.toString(),
            signal: AbortSignal.timeout(15_000),
        });
        const doc = await res.json().catch(() => null);
        if (!res.ok || !doc || !doc.access_token) throw new Error(`OpenVibe.Network answered ${res.status}`);
        cached = { token: String(doc.access_token), until: now() + TOKEN_TTL_MS };
        return cached.token;
    }

    /** Send one task's report. Throws when Report does not answer; the caller decides what that means. */
    async function send(payload) {
        const t = await token();
        const res = await fetchImpl(`${base}/internal/session-reports`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${t}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15_000),
        });
        const doc = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error((doc && (doc.detail || doc.error)) || `OpenVibe.Report answered ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return doc;
    }

    return { send, token, baseUrl: base };
}

module.exports = { createReportClient };
