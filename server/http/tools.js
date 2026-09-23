'use strict';

/**
 * Developer tools that need no project: the OAuth callback helper, the webhook tester and signed-
 * event inspector, and the manifest validator. All usable without JavaScript; the webhook page adds
 * an optional in-browser computation (public/js/webhook.js) so a secret need not leave the browser.
 *
 * Secrets typed here are used for one computation and dropped: never stored, logged or rendered
 * back (forms come back with the secret field empty).
 */
const express = require('express');
const { asyncRouter } = require('./router');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { html, raw, code, table, notice, badge, time } = require('../render/html');
const { send } = require('../render/layout');
const webhooks = require('../domain/webhooks');
const manifests = require('../domain/manifests');
const { pkcePair } = require('../auth/sso');

function createToolRoutes(ctx) {
    const { config, docs } = ctx;
    const r = asyncRouter();
    const form = express.urlencoded({ extended: false, limit: '300kb' });
    const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
    const eventTypes = docs.events.map((e) => e.type);

    // ── OAuth callback helper ───────────────────────────────
    r.get('/oauth', (req, res) => {
        const clientId = typeof req.query.client_id === 'string' ? req.query.client_id.trim().slice(0, 40) : '';
        const redirectUri = typeof req.query.redirect_uri === 'string' && req.query.redirect_uri ? req.query.redirect_uri.trim().slice(0, 500) : `${config.baseUrl}/oauth/test-callback`;
        const scope = typeof req.query.scope === 'string' ? req.query.scope.trim().slice(0, 500) : '';
        let built = null;
        if (clientId) {
            const { verifier, challenge } = pkcePair();
            const state = crypto.randomBytes(12).toString('hex');
            const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' });
            if (scope) q.set('scope', scope);
            built = { url: `${config.networkUrl}/oauth/authorize?${q}`, verifier, challenge, state };
        }
        send(res, 200, {
            viewer: req.viewer, config, path: req.originalUrl, title: 'OAuth callback helper', index: !clientId,
            crumbs: [{ label: 'OAuth' }],
            body: html`<h1>Sign people in to your app (authorization code + PKCE)</h1>
<ol class="steps">
<li><strong>Register a redirect URI</strong> on your app (project → app → redirect URIs). It must match exactly. https is required; <code>http://localhost</code>, <code>127.0.0.1</code> and <code>[::1]</code> are allowed for sandbox apps only. To try the flow before your own callback exists, register <code>${config.baseUrl}/oauth/test-callback</code>: it shows what Network sent and never uses it.</li>
<li><strong>Make a PKCE pair.</strong> A random <code>code_verifier</code> (43–128 characters) and <code>code_challenge = BASE64URL(SHA-256(code_verifier))</code>. Network requires <code>code_challenge_method=S256</code> for every app, public or confidential. The SDK does it: <code>createPkcePair()</code>, <code>startAuthorization()</code> in <a href="/docs/sdk/auth-browser"><code>openvibe-sdk/auth</code></a>.</li>
<li><strong>Send the browser to</strong> <code>${config.networkUrl}/oauth/authorize</code> with <code>response_type=code</code>, <code>client_id</code> (your app id), <code>redirect_uri</code>, <code>state</code>, the challenge, and optionally <code>scope</code> (capability ids, which limit what the code can yield). <code>prompt=none</code> is refused for apps: a person always chooses to continue. A sandbox app can be authorized only by members of its project.</li>
<li><strong>Network redirects back</strong> with <code>code</code> and your <code>state</code> (or <code>error</code>). Check the state. Codes are single use and expire after 5 minutes; a failed PKCE check burns the code.</li>
<li><strong>Exchange on your server</strong>: <code>POST ${config.networkUrl}/oauth/token</code> with <code>grant_type=authorization_code</code>, <code>client_id</code>, <code>code</code>, <code>redirect_uri</code>, <code>code_verifier</code>, <code>audience</code> (the service you will call, e.g. <code>openvibe.media</code>) and, for a confidential app, <code>client_secret</code>. The token lasts 5 minutes and carries <code>on_behalf_of</code> (the person) and <code>cap</code> (your approved grants for that audience). Apps get no refresh token.</li>
</ol>
<h2>Build a test authorization URL</h2>
<form method="get" action="/oauth" class="stack">
<label>Your app's client id <input name="client_id" value="${clientId}" placeholder="app_01…" pattern="app_[0-9A-HJKMNP-TV-Z]{26}" required></label>
<label>Redirect URI <input name="redirect_uri" value="${redirectUri}" size="60"></label>
<label>Scope (optional, capability ids separated by spaces) <input name="scope" value="${scope}" size="60"></label>
<button type="submit">Build URL</button></form>
${built ? html`<div class="result"><p>Open this URL to start the flow (it goes to OpenVibe.Network; Codes is not involved in the exchange):</p>
<p><a href="${built.url}" rel="noreferrer">${built.url}</a></p>
<dl class="facts"><dt>state</dt><dd>${code(built.state)}</dd><dt>code_challenge</dt><dd>${code(built.challenge)}</dd>
<dt>code_verifier</dt><dd>${code(built.verifier)} <span class="muted small">made just now for this test and not kept anywhere; you need it for the exchange</span></dd></dl></div>` : ''}`,
        });
    });

    r.get('/oauth/test-callback', (req, res) => {
        const q = (k) => (typeof req.query[k] === 'string' ? req.query[k].slice(0, 2000) : null);
        const got = { code: q('code'), state: q('state'), error: q('error'), error_description: q('error_description') };
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');
        send(res, got.error ? 400 : 200, {
            viewer: req.viewer, config, path: '/oauth/test-callback', title: 'OAuth test callback', noReferrer: true,
            crumbs: [{ label: 'OAuth', href: '/oauth' }, { label: 'Test callback' }],
            body: html`<h1>What Network sent back</h1>
<p>Codes shows this and does nothing else with it: it <strong>never exchanges the code</strong> and keeps no copy. Exchange it on your own server within 5 minutes, once.</p>
${table(['Parameter', 'Value'], Object.entries(got).filter(([, v]) => v !== null).map(([k, v]) => [code(k), code(v)]), { empty: 'No code, state or error in this request. Network redirects here with ?code=…&state=… after a person continues.' })}
${got.error ? notice(html`Network returned <code>${got.error}</code>${got.error_description ? html`: ${got.error_description}` : ''}. <code>access_denied</code> means the person declined; <code>interaction_required</code> means <code>prompt=none</code> was sent (apps must not).`, 'warn') : ''}
${got.code ? html`<h2>Exchange it (on your server)</h2>
<p>Send <code>client_secret</code> only for a confidential app, and only from a server — never from a browser.</p>
<pre><code>curl -X POST ${config.networkUrl}/oauth/token \\
  -d grant_type=authorization_code \\
  -d client_id="$CLIENT_ID" \\
  -d client_secret="$CLIENT_SECRET" \\
  -d code=${got.code} \\
  -d redirect_uri=${config.baseUrl}/oauth/test-callback \\
  -d code_verifier="$CODE_VERIFIER" \\
  -d audience=openvibe.media</code></pre>` : ''}`,
        });
    });

    // ── Webhook tester and signed-event inspector ───────────
    const webhookPage = (req, res, { status = 200, verify = null, sample = null, values = {} } = {}) => send(res, status, {
        viewer: req.viewer, config, path: '/tools/webhooks', title: 'Webhook tester', index: true, scripts: ['js/webhook.js'],
        crumbs: [{ label: 'Webhooks' }],
        body: html`<h1>Webhook tester and signed-event inspector</h1>
<p>OpenVibe.Events delivers each event as <code>POST</code> with the body <code>{"event": &lt;envelope&gt;, "seq": &lt;n&gt;}</code> and these headers, signed with your subscription secret:</p>
<ul>
<li><code>X-OpenVibe-Signature: sha256=&lt;hex HMAC-SHA256 of the raw body&gt;</code> (v1).</li>
<li><code>X-OpenVibe-Timestamp: &lt;unix seconds&gt;</code>, the time this attempt was sent. Every retry gets a new one.</li>
<li><code>X-OpenVibe-Signature-V2: t=&lt;that timestamp&gt;,v2=&lt;hex HMAC-SHA256 of "&lt;t&gt;.&lt;raw body&gt;"&gt;</code> (v2).</li>
</ul>
<p>Verify against the <strong>raw bytes</strong>, before parsing, with a constant-time comparison. v1 covers only the body, so a captured delivery verifies forever. v2 also covers the time: refuse it when <code>t</code> is more than 300 seconds from your clock, in either direction. When the v2 header is present but does not verify or is stale, reject the delivery. Never fall back to v1. <code>parseDelivery(raw, headers, secret, { requireV2: true })</code> in <a href="/docs/sdk/events"><code>openvibe-sdk/events</code></a> (0.4.0 and later) does all of this, and also refuses deliveries that carry only v1. <code>verifyDelivery()</code> checks v1 only; <code>verifyDeliveryV2()</code> checks v2 and the window. The tester below checks both, says whether the timestamp is inside the window now, and decides as a receiver that requires v2 does: v1 is shown for reference and never decides.</p>
<h2>Verify a delivery</h2>
<form method="post" action="/tools/webhooks/verify" class="stack" id="verify-form">
<label>Raw body <textarea name="body" rows="8" required spellcheck="false">${values.body || ''}</textarea></label>
<label>X-OpenVibe-Signature-V2 <input name="signature_v2" value="${values.signature_v2 || ''}" size="80" spellcheck="false" autocomplete="off" placeholder="t=1790000000,v2=…"></label>
<label>X-OpenVibe-Timestamp <span class="muted small">(optional; when given it must equal t=)</span> <input name="timestamp" value="${values.timestamp || ''}" size="14" spellcheck="false" autocomplete="off" inputmode="numeric"></label>
<label>X-OpenVibe-Signature <span class="muted small">(v1, optional)</span> <input name="signature" value="${values.signature || ''}" size="80" spellcheck="false" autocomplete="off" placeholder="sha256=…"></label>
<label>Subscription secret <input type="password" name="secret" value="" autocomplete="off" required></label>
<p class="muted small">Without JavaScript the form is sent to Codes, which computes the HMAC and forgets the secret. With JavaScript it is computed in your browser and nothing is sent.</p>
<button type="submit">Verify</button></form>
<div id="verify-result">${verify ? verifyResult(verify) : ''}</div>
<h2>Generate a sample delivery</h2>
<form method="post" action="/tools/webhooks/sample" class="stack">
<label>Event type <select name="event_type">${eventTypes.map((t) => html`<option${t === values.event_type ? raw(' selected') : ''}>${t}</option>`)}</select></label>
<label>Secret to sign with <input type="password" name="secret" value="" autocomplete="off" required></label>
<button type="submit">Generate</button></form>
${sample ? html`<div class="result"><p>A delivery exactly as Events would send it (event types from <code>openvibe-contracts v${docs.contractsVersion}</code>). The envelope ${sample.envelopeValid ? 'validates' : 'does NOT validate'} as events.event-envelope@1. The payload is empty: contracts define no payload schema for this event type yet, and Codes does not invent one.</p>
${table(['Header', 'Value'], Object.entries(sample.headers).map(([k, v]) => [code(k), code(v)]))}
<p>Body (byte for byte):</p><pre><code>${sample.body}</code></pre>
<p>Replay it against your own endpoint (Codes never sends requests to your URLs). The v2 timestamp is the time you pressed Generate, so a receiver refuses the replay once it is more than ${webhooks.V2_WINDOW_SEC} seconds old: generate a fresh one, or use it to check that your endpoint does refuse a stale delivery.</p><pre><code>${webhooks.curlFor(sample.headers, sample.body)}</code></pre></div>` : ''}`,
    });

    function verifyResult(v) {
        if (!v.v1) return html`<div class="result bad" role="status"><p><strong>Cannot check.</strong> ${v.reason || ''}</p></div>`;
        const { v1, v2 } = v;
        const age = v2.ageSec == null ? '' : v2.ageSec >= 0 ? `${v2.ageSec} s ago` : `${-v2.ageSec} s in the future`;
        return html`<div class="result ${v.accepted ? 'ok' : 'bad'}" role="status"><p><strong>${v.accepted ? 'Accepted: v2 verifies and is inside the window.' : 'Refused: a receiver that requires v2 rejects this delivery.'}</strong>${v.accepted ? '' : html` ${v2.reason || ''}`}</p>
<h3>v2 (X-OpenVibe-Signature-V2) ${badge(v2.valid ? 'valid' : v2.signatureValid ? 'stale' : 'NOT valid', v2.valid ? 'ok' : v2.signatureValid ? 'warn' : 'bad')}</h3>
<dl class="facts">${v2.timestamp != null ? html`<dt>Timestamp</dt><dd>${code(String(v2.timestamp))} ${v2.timestamp < 8.64e9 ? time(new Date(v2.timestamp * 1000).toISOString()) : ''}, ${age} by this server's clock</dd>
<dt>Window</dt><dd>${v2.withinWindow ? html`${badge('inside', 'ok')} within ±${v2.windowSec} s` : html`${badge('outside', 'bad')} more than ${v2.windowSec} s from now`}</dd>
<dt>Signature</dt><dd>${v2.signatureValid ? 'matches this body and secret' : 'does not match this body and secret'}</dd>` : ''}
${v2.timestampsAgree != null ? html`<dt>X-OpenVibe-Timestamp</dt><dd>${code(v2.statedTimestamp)} ${v2.timestampsAgree ? 'equals t=' : html`${badge('differs from t=', 'bad')}`}</dd>` : ''}
<dt>Expected</dt><dd>${code(v2.expected || '(needs a t= value)')}</dd><dt>Given</dt><dd>${code(v2.given || '(none)')}</dd></dl>
<h3>v1 (X-OpenVibe-Signature) ${badge(v1.valid ? 'valid' : v1.present ? 'NOT valid' : 'not given', v1.valid ? 'ok' : v1.present ? 'bad' : '')}</h3>
<p class="muted small">Shown for reference. v1 covers only the body, so it cannot tell a replay from a delivery; it never decides.${v1.present && !v1.valid ? html` ${v1.reason}` : ''}</p>
<dl class="facts"><dt>Expected</dt><dd>${code(v1.expected)}</dd><dt>Given</dt><dd>${code(v1.given || '(none)')}</dd></dl>
<h3>Body</h3>
<dl class="facts"><dt>Size</dt><dd>${v.bodyBytes} bytes</dd>
${v.parsed && v.parsed.event_type ? html`<dt>Event</dt><dd>${code(v.parsed.event_type)} ${code(v.parsed.event_id || '')} seq ${v.parsed.seq}; envelope ${v.parsed.envelopeValid ? 'validates' : html`does not validate: ${v.parsed.envelopeErrors.map((e) => `${e.path} ${e.message}`).join('; ')}`}</dd>` : ''}
${v.parsed && v.parsed.note ? html`<dt>Shape</dt><dd>${v.parsed.note}</dd>` : ''}</dl></div>`;
    }

    r.get('/tools/webhooks', (req, res) => webhookPage(req, res));
    r.post('/tools/webhooks/verify', limiter, form, (req, res) => {
        const b = req.body || {};
        const v = webhooks.inspect({ rawBody: typeof b.body === 'string' ? b.body.replace(/\r\n/g, '\n') : '', signature: b.signature, signatureV2: b.signature_v2, timestamp: b.timestamp, secret: typeof b.secret === 'string' ? b.secret : '' });
        webhookPage(req, res, { status: v.accepted ? 200 : 422, verify: v, values: { body: b.body, signature: b.signature, signature_v2: b.signature_v2, timestamp: b.timestamp } });
    });
    r.post('/tools/webhooks/sample', limiter, form, (req, res) => {
        const b = req.body || {};
        const type = eventTypes.includes(b.event_type) ? b.event_type : null;
        if (!type || !b.secret) return webhookPage(req, res, { status: 422, values: { event_type: b.event_type } });
        const e = docs.events.find((x) => x.type === type);
        webhookPage(req, res, { sample: webhooks.sample({ eventType: type, secret: String(b.secret), producer: e && e.producers[0] }), values: { event_type: type } });
    });

    // ── Manifest validator ──────────────────────────────────
    const validatorPage = (req, res, { status = 200, kind = 'app', text = null, result = null, parseError = null } = {}) => send(res, status, {
        viewer: req.viewer, config, path: '/manifests/validate', title: 'Manifest validator', index: true,
        crumbs: [{ label: 'Manifests' }],
        body: html`<h1>Manifest validator</h1>
<p>Checks an app manifest or a mod manifest with <code>openvibe-contracts v${docs.contractsVersion}</code>: the JSON Schema first, then that every requested capability exists and can be granted to apps, that version ranges parse, and that consumed events are produced by someone. Nothing is stored. To publish a release, open your app's page.</p>
<ul class="plain small muted"><li>app: <a href="/docs/contracts/codes.app-manifest"><code>codes.app-manifest@1</code></a></li><li>mod: <a href="/docs/contracts/mods.mod-manifest"><code>mods.mod-manifest@1</code></a></li></ul>
<form method="post" action="/manifests/validate" class="stack">
<label>Kind <select name="kind"><option value="app"${kind === 'app' ? raw(' selected') : ''}>app</option><option value="mod"${kind === 'mod' ? raw(' selected') : ''}>mod</option></select></label>
<label>Manifest (JSON) <textarea name="manifest" rows="18" spellcheck="false">${text != null ? text : JSON.stringify(manifests.template(kind), null, 2)}</textarea></label>
<button type="submit">Validate</button></form>
${parseError ? notice(parseError, 'bad') : ''}
${result ? validationResult(result) : ''}`,
    });

    r.get('/manifests/validate', (req, res) => validatorPage(req, res, { kind: req.query.kind === 'mod' ? 'mod' : 'app' }));
    r.post('/manifests/validate', limiter, form, (req, res) => {
        const b = req.body || {};
        const kind = b.kind === 'mod' ? 'mod' : 'app';
        const p = manifests.parse(b.manifest);
        if (p.error) return validatorPage(req, res, { status: 422, kind, text: b.manifest || '', parseError: p.error });
        const result = manifests.validate(kind, p.manifest, { eventTypes: docs.eventTypes });
        validatorPage(req, res, { status: result.valid ? 200 : 422, kind, text: b.manifest, result });
    });

    return r;
}

function validationResult(v) {
    return html`<div class="result ${v.valid ? 'ok' : 'bad'}" role="status"><p><strong>${v.valid ? 'Valid.' : `${v.errors.length} error${v.errors.length === 1 ? '' : 's'}.`}</strong>${v.schema ? html` Checked with <code>${v.schema.id}</code> ${v.schema.version}.` : ''}</p>
${v.errors.length ? html`<h3>Errors</h3><ul>${v.errors.map((e) => html`<li><code>${e.path}</code> ${e.message}</li>`)}</ul>` : ''}
${v.warnings.length ? html`<h3>Warnings</h3><ul>${v.warnings.map((e) => html`<li><code>${e.path}</code> ${e.message}</li>`)}</ul>` : ''}</div>`;
}

module.exports = { createToolRoutes, validationResult };
