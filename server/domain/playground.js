'use strict';

/**
 * Playgrounds that cannot exceed the project's grants (ADR-014 acceptance).
 *
 *   events   publish one test event            needs events.event.publish   (audience openvibe.events)
 *   media    upload one small file (sandbox)   needs media.object.upload    (audience openvibe.media,
 *                                                                              namespace = project id)
 *
 * The order is fixed and every step can refuse:
 *   1. app     the app (as Network reports it to the signed-in member) is active and is a SANDBOX app
 *   2. grant   Network lists the capability among the app's APPROVED grants; if not, nothing else
 *              happens — no token is requested, no service is called — and the page says which
 *              grant is missing and whether it can ever be granted (the pinned catalog's visibility)
 *   3. input   the request is valid (an event envelope validates as events.event-envelope@1)
 *   4. token   the APP's own token: minted by Network from the client secret the developer typed for
 *              this request, or pasted; then verified offline — signed by Network, for this app, this
 *              project, env sandbox, this audience, and carrying the capability
 *   5. call    the service is called through openvibe-sdk with that token, and its answer is shown
 *
 * Codes' own credentials are never used, no shared loopback key exists anywhere, and the secret or token
 * is never stored, logged or rendered: run logs keep only ids, outcome, status and problem code,
 * with any echo of the credential scrubbed from the detail.
 */
const contracts = require('openvibe-contracts');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { createEventsClient } = require('openvibe-sdk/events');
const { createMediaClient } = require('openvibe-sdk/media');
const { verifyJwt } = require('../auth/keys');
const { GRANTABLE_VISIBILITIES } = require('../docs/generate');

const contractsVersion = require('openvibe-contracts/package.json').version;

const KINDS = {
    // `needs`: the capability the APP must hold (owned by Events / Media; Codes guards nothing with it).
    events: { needs: 'events.event.publish', audience: 'openvibe.events', label: 'Events: publish a test event' },
    media: { needs: 'media.object.upload', audience: 'openvibe.media', label: 'Media: upload a file to the sandbox' },
};

function scrub(text, secrets) {
    let s = String(text || '').slice(0, 500);
    for (const x of secrets) if (x && x.length >= 8) s = s.split(x).join('[redacted]');
    return s.replace(/ovsec_[A-Za-z0-9_-]+/g, '[redacted]').replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]');
}

/** Why a capability is not granted, from the pinned catalog. */
function grantAdvice(capability) {
    const cap = contracts.capabilities.get(capability);
    if (!cap) return { grantable: false, text: `${capability} is not in openvibe-contracts ${contractsVersion}.` };
    if (!GRANTABLE_VISIBILITIES.has(cap.visibility)) {
        return { grantable: false, text: `${capability} is ${cap.visibility} in openvibe-contracts ${contractsVersion}: Network never grants it to apps, so this playground cannot run until ${cap.owner} publishes a public capability for it.` };
    }
    if (cap.status !== 'active') return { grantable: false, text: `${capability} is ${cap.status}; it can be granted once it is active.` };
    return { grantable: true, text: `Request ${capability} on the app page. An owner or admin approves it, and only inside the project's allowance (staff set the allowance).` };
}

function createPlayground({ store, config, network, keys, fetchImpl, log = console }) {
    const { db } = store;

    function record(run) {
        const id = store.newId('run');
        db.prepare(`INSERT INTO playground_runs (id, at, actor, project_id, app_id, kind, capability, credential, outcome, stage, http_status, code, detail, ref)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, store.iso(), run.actor, run.project_id, run.app_id, run.kind, run.capability, run.credential, run.outcome, run.stage,
                run.http_status || null, run.code || null, run.detail || '', run.ref || null);
        return id;
    }

    const runsFor = (appId, limit = 20) => db.prepare('SELECT id, at, actor, kind, capability, credential, outcome, stage, http_status, code, detail, ref FROM playground_runs WHERE app_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(String(appId), limit);
    const recentCount = (actor) => db.prepare('SELECT COUNT(*) AS n FROM playground_runs WHERE actor = ? AND at > ?').get(actor, new Date(store.now() - 3600_000).toISOString()).n;

    /** Steps 1–2 only: may this app run this playground at all? */
    function precheck(app, kind) {
        const k = KINDS[kind];
        if (!k) return { ok: false, stage: 'input', code: 'playground.unknown', detail: 'no such playground' };
        if (app.revoked_at) return { ok: false, stage: 'app', code: 'playground.app_revoked', detail: 'this app is revoked in Network' };
        if (app.environment !== 'sandbox') return { ok: false, stage: 'app', code: 'playground.production_app', detail: 'playgrounds run only sandbox apps; create a sandbox app in this project to try things out' };
        const grants = Array.isArray(app.grants) ? app.grants : [];
        if (!grants.includes(k.needs)) {
            const advice = grantAdvice(k.needs);
            return { ok: false, stage: 'grant', code: 'playground.grant_missing', detail: `this app does not hold ${k.needs} (audience ${k.audience}). ${advice.text}`, missing: k.needs, grantable: advice.grantable };
        }
        return { ok: true };
    }

    /** Build the events envelope from form input. → { envelope } | { error } */
    function eventInput(input) {
        let payload = {};
        const raw = String(input.payload || '').trim();
        if (raw) {
            if (raw.length > 16 * 1024) return { error: 'payload is at most 16 KB' };
            try { payload = JSON.parse(raw); } catch (err) { return { error: `payload is not JSON: ${err.message.slice(0, 120)}` }; }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'payload must be a JSON object' };
        }
        const envelope = {
            event_id: contracts.ids.newId('event', store.now()),
            event_type: String(input.event_type || '').trim(),
            version: 1,
            source: String(input.source || '').trim(),
            actor: { type: 'app', id: input.appId },
            timestamp: new Date(store.now()).toISOString(),
            visibility: 'internal',
            subject: { type: String(input.subject_type || 'test').trim().slice(0, 40) || 'test', id: String(input.subject_id || 'test-1').trim().slice(0, 120) || 'test-1' },
            payload,
        };
        const v = contracts.validate('events.event-envelope@1', envelope);
        if (!v.valid) return { error: `the event does not validate as events.event-envelope@1: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}` };
        return { envelope };
    }

    async function appToken(app, k, credential) {
        let token;
        if (credential.type === 'client_secret') {
            const got = await network.appToken({ appId: app.id, clientSecret: credential.value, audience: k.audience, scope: k.needs });
            if (!got.ok) return { ok: false, http_status: got.status, code: got.code, detail: `Network refused the token request: ${got.detail || got.code}` };
            token = got.token;
        } else {
            token = credential.value;
        }
        await keys.ensure();
        const v = verifyJwt(token, { publicKey: keys.get(), issuer: config.networkIssuer, audience: k.audience, now: store.now() });
        if (!v.ok) return { ok: false, code: 'playground.token_invalid', detail: `the token is not usable: ${v.reason}` };
        const c = v.claims;
        const problems = [];
        if (c.sub !== `app:${app.id}`) problems.push(`it belongs to ${String(c.sub).slice(0, 60)}, not app:${app.id}`);
        if (c.project_id !== undefined && c.project_id !== app.project_id) problems.push('it is for another project');
        if (c.env !== 'sandbox') problems.push(`its env is ${c.env === undefined ? 'unset' : c.env}, not sandbox`);
        if (!Array.isArray(c.cap) || !c.cap.includes(k.needs)) problems.push(`it does not carry ${k.needs}`);
        if (problems.length) return { ok: false, code: 'playground.token_refused', detail: `the token was refused: ${problems.join('; ')}` };
        return { ok: true, token };
    }

    function sdkClient(token) {
        return createClient({
            autoDiscover: false, retries: 0, timeoutMs: 10_000, deadlineMs: 15_000, token,
            baseUrls: { events: config.playground.eventsUrl, media: config.playground.mediaUrl },
            ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
    }

    /**
     * run({ actor, app, kind, credential: { type: 'client_secret' | 'access_token', value }, input, file })
     * → { outcome: 'ok' | 'refused' | 'failed', stage, code, detail, http_status, result, runId }
     */
    async function run({ actor, app, kind, credential, input = {}, file = null }) {
        const k = KINDS[kind];
        const secrets = [credential && credential.value].filter(Boolean);
        const base = { actor, project_id: app.project_id, app_id: app.id, kind, capability: k ? k.needs : String(kind), credential: 'none' };
        const finish = (out) => {
            const safe = { ...out, detail: scrub(out.detail, secrets) };
            const runId = record({ ...base, ...safe });
            return { ...safe, runId };
        };

        if (recentCount(actor) >= config.playground.runsPerHour) {
            return { outcome: 'refused', stage: 'rate', code: 'playground.rate_limited', detail: `at most ${config.playground.runsPerHour} playground runs an hour` };
        }
        const pre = precheck(app, kind);
        if (!pre.ok) return { ...finish({ outcome: 'refused', stage: pre.stage, code: pre.code, detail: pre.detail }), missing: pre.missing, grantable: pre.grantable };

        let envelope = null;
        if (kind === 'events') {
            const e = eventInput({ ...input, appId: app.id });
            if (e.error) return finish({ outcome: 'refused', stage: 'input', code: 'playground.invalid_input', detail: e.error });
            envelope = e.envelope;
        } else {
            if (!file || !file.buffer || !file.buffer.length) return finish({ outcome: 'refused', stage: 'input', code: 'playground.invalid_input', detail: 'choose a file' });
            if (file.buffer.length > config.playground.maxUploadBytes) return finish({ outcome: 'refused', stage: 'input', code: 'playground.invalid_input', detail: `playground uploads are at most ${config.playground.maxUploadBytes} bytes` });
        }

        if (!credential || !credential.value || !['client_secret', 'access_token'].includes(credential.type)) {
            return finish({ outcome: 'refused', stage: 'token', code: 'playground.no_credential', detail: 'enter the app\'s client secret (used once, never stored) or an access token you minted for it' });
        }
        base.credential = credential.type;
        const tok = await appToken(app, k, credential);
        if (!tok.ok) return finish({ outcome: 'refused', stage: 'token', code: tok.code, detail: tok.detail, http_status: tok.http_status });

        const client = sdkClient(tok.token);
        try {
            if (kind === 'events') {
                const events = createEventsClient(client, { source: envelope.source, baseUrl: config.playground.eventsUrl });
                const out = await events.publish(envelope);
                return { ...finish({ outcome: 'ok', stage: 'done', http_status: 200, detail: out.duplicate ? 'accepted (duplicate event_id)' : `accepted as seq ${out.seq}`, ref: out.event_id }), result: { event_id: out.event_id, seq: out.seq, duplicate: out.duplicate } };
            }
            const media = createMediaClient(client, { app: app.project_id, baseUrl: config.playground.mediaUrl, publicOrigin: config.playground.mediaUrl });
            const out = await media.files.upload(file.buffer, { filename: file.filename, contentType: file.mimeType });
            return { ...finish({ outcome: 'ok', stage: 'done', http_status: 201, detail: `stored ${out.size} bytes`, ref: out.key }), result: { key: out.key, public_url: out.public_url, size: out.size, mime: out.mime, sha256: out.sha256 } };
        } catch (err) {
            if (isOpenVibeError(err)) {
                const service = kind === 'events' ? 'OpenVibe.Events' : 'OpenVibe.Media';
                const unreachable = !err.status;
                return finish({ outcome: 'failed', stage: 'call', http_status: err.status || null, code: err.code,
                    detail: unreachable ? `${service} did not answer (${err.code})` : `${service} answered ${err.status}: ${err.detail || err.title || err.code}` });
            }
            log.error('[Codes] playground error:', scrub(err && err.message, secrets));
            return finish({ outcome: 'failed', stage: 'call', code: 'playground.error', detail: 'unexpected error calling the service' });
        }
    }

    return { run, precheck, runsFor, grantAdvice, KINDS };
}

module.exports = { createPlayground, KINDS, grantAdvice, scrub };
