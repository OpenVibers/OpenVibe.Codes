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
const { html, raw, code, table, notice } = require('../render/html');
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
<p>OpenVibe.Events delivers each event as <code>POST</code> with the body <code>{"event": &lt;envelope&gt;, "seq": &lt;n&gt;}</code> and <code>X-OpenVibe-Signature: sha256=&lt;hex HMAC-SHA256 of the raw body under your subscription secret&gt;</code>. Verify against the <strong>raw bytes</strong>, before parsing, with a constant-time comparison; <code>verifyDelivery()</code> in <a href="/docs/sdk/events"><code>openvibe-sdk/events</code></a> does exactly that.</p>
<h2>Verify a delivery</h2>
<form method="post" action="/tools/webhooks/verify" class="stack" id="verify-form">
<label>Raw body <textarea name="body" rows="8" required spellcheck="false">${values.body || ''}</textarea></label>
<label>X-OpenVibe-Signature <input name="signature" value="${values.signature || ''}" size="80" spellcheck="false" autocomplete="off"></label>
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
<p>Replay it against your own endpoint (Codes never sends requests to your URLs):</p><pre><code>${webhooks.curlFor(sample.headers, sample.body)}</code></pre></div>` : ''}`,
    });

    function verifyResult(v) {
        return html`<div class="result ${v.valid ? 'ok' : 'bad'}" role="status"><p><strong>${v.valid ? 'Signature valid.' : 'Signature NOT valid.'}</strong> ${v.reason || ''}</p>
${v.expected ? html`<dl class="facts"><dt>Expected</dt><dd>${code(v.expected)}</dd><dt>Given</dt><dd>${code(v.given || '(none)')}</dd><dt>Body</dt><dd>${v.bodyBytes} bytes</dd>
${v.parsed && v.parsed.event_type ? html`<dt>Event</dt><dd>${code(v.parsed.event_type)} ${code(v.parsed.event_id || '')} seq ${v.parsed.seq}; envelope ${v.parsed.envelopeValid ? 'validates' : html`does not validate: ${v.parsed.envelopeErrors.map((e) => `${e.path} ${e.message}`).join('; ')}`}</dd>` : ''}
${v.parsed && v.parsed.note ? html`<dt>Body</dt><dd>${v.parsed.note}</dd>` : ''}</dl>` : ''}</div>`;
    }

    r.get('/tools/webhooks', (req, res) => webhookPage(req, res));
    r.post('/tools/webhooks/verify', limiter, form, (req, res) => {
        const b = req.body || {};
        const v = webhooks.inspect({ rawBody: typeof b.body === 'string' ? b.body.replace(/\r\n/g, '\n') : '', signature: b.signature, secret: typeof b.secret === 'string' ? b.secret : '' });
        webhookPage(req, res, { status: v.valid ? 200 : 422, verify: v, values: { body: b.body, signature: b.signature } });
    });
    r.post('/tools/webhooks/sample', limiter, form, (req, res) => {
        const b = req.body || {};
        const type = eventTypes.includes(b.event_type) ? b.event_type : null;
        if (!type || !b.secret) return webhookPage(req, res, { status: 422, values: { event_type: b.event_type } });
        const e = docs.events.find((x) => x.type === type);
        webhookPage(req, res, { sample: webhooks.sample({ eventType: type, secret: String(b.secret), producer: e && e.producers[0] }), values: { event_type: type } });
    });

    // ── Manifest validator ──────────────────────────────────
    const info = manifests.appSchemaInfo();
    const validatorPage = (req, res, { status = 200, kind = 'app', text = null, result = null, parseError = null } = {}) => send(res, status, {
        viewer: req.viewer, config, path: '/manifests/validate', title: 'Manifest validator', index: true,
        crumbs: [{ label: 'Manifests' }],
        body: html`<h1>Manifest validator</h1>
<p>Checks an app manifest or a mod manifest with <code>openvibe-contracts v${docs.contractsVersion}</code>: the JSON Schema first, then that every requested capability exists and can be granted to apps, that version ranges parse, and that consumed events are produced by someone. Nothing is stored. To publish a release, open your app's page.</p>
<ul class="plain small muted"><li>mod: <a href="/docs/contracts/mods.mod-manifest"><code>mods.mod-manifest@1</code></a> (released)</li>
<li>app: <code>${info.id}@1</code> ${info.released ? '(released)' : html`— a proposal Codes validates with until Contracts releases it (<a href="https://github.com/OpenVibers/OpenVibe.Codes/blob/main/docs/contracts-proposal/codes/app-manifest.v1.json">schema</a>)`}</li></ul>
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
