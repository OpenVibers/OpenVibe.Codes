'use strict';
// The docs tests fetch one page per contract (hundreds); the per-address limit would answer 429 part-way.
process.env.CODES_RATE_LIMIT_PER_MIN = process.env.CODES_RATE_LIMIT_PER_MIN || '100000';
/**
 * Boots Codes on a temp database with mocks of Network, Events and Media, captures every log line
 * (the app's logger AND console), and returns a small HTTP client. Every test file gets its own.
 *
 *   const t = await boot();
 *   t.get(path, { as: user, form, json, multipart: { fields, file }, headers, method })
 *   t.signIn(user) → cookie header value (codes_at = a Network user token, as after /auth/callback)
 *   t.csrf(user), t.logs(), t.dbDump(), t.project(user, name), t.app(user, projectId, body)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startNetwork, startEvents, startMedia } = require('./mocks');

const captured = [];
for (const m of ['log', 'info', 'warn', 'error']) {
    const orig = console[m].bind(console);
    console[m] = (...a) => { captured.push(a.map(String).join(' ')); if (process.env.VERBOSE) orig(...a); };
}

async function boot(opts = {}) {
    const network = await startNetwork(opts.network || {});
    const events = await startEvents(network);
    const media = await startMedia(network);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codes-test-'));
    const dbPath = path.join(dir, 'codes.db');
    const env = {
        NODE_ENV: 'test', PORT: '0', BASE_URL: 'https://openvibe.codes', TRUST_PROXY: '1',
        CODES_DB_PATH: dbPath,
        OV_NETWORK_URL: network.url, OV_NETWORK_INTERNAL_URL: network.url,
        OV_OAUTH_CLIENT_ID: 'codes', OV_OAUTH_CLIENT_SECRET: 'codes-secret', COOKIE_SECURE: 'false',
        CODES_FORM_SECRET: 'test-form-secret',
        CODES_PLAYGROUND_EVENTS_URL: events.url, CODES_PLAYGROUND_MEDIA_URL: media.url,
        CODES_EXPORT_EVENTS_URL: events.url, CODES_EXPORT_MEDIA_URL: media.url,
        CODES_REGISTRY_TTL_MS: '0',
        ...(opts.relay ? { EVENTS_URL: events.url, EVENTS_RELAY_INTERVAL_MS: '50' } : {}),
        ...(opts.env || {}),
    };
    const configLib = require('../../server/config');
    const { createApp } = require('../../server/app');
    const log = { log: (...a) => captured.push(a.map(String).join(' ')), warn: (...a) => captured.push(a.map(String).join(' ')), error: (...a) => captured.push(a.map(String).join(' ')), info: (...a) => captured.push(a.map(String).join(' ')) };

    const config = configLib.load(env);
    const built = createApp({ config, log });
    await built.ctx.keys.ensure();
    if (opts.relay) built.ctx.outbox.start();
    const server = await new Promise((resolve) => { const s = http.createServer(built.app); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const signIn = (user) => `codes_at=${network.userToken(user)}`;
    const csrf = (user) => require('../../server/auth/forms').csrfToken({ formSecret: env.CODES_FORM_SECRET }, user);

    async function get(p, o = {}) {
        const headers = { ...(o.headers || {}) };
        if (o.as) headers.cookie = [signIn(o.as), headers.cookie].filter(Boolean).join('; ');
        if (o.cookie) headers.cookie = o.cookie;
        let body = o.body;
        if (o.json !== undefined) { body = JSON.stringify(o.json); headers['content-type'] = 'application/json'; }
        if (o.form) {
            const f = { ...o.form };
            if (o.as && f.csrf === undefined) f.csrf = csrf(o.as);
            body = new URLSearchParams(f).toString();
            headers['content-type'] = 'application/x-www-form-urlencoded';
        }
        if (o.multipart) {
            const fd = new FormData();
            const fields = { ...(o.multipart.fields || {}) };
            if (o.as && fields.csrf === undefined) fields.csrf = csrf(o.as);
            for (const [k, v] of Object.entries(fields)) fd.append(k, v);
            if (o.multipart.file) fd.append('file', new Blob([o.multipart.file.content], { type: o.multipart.file.type || 'text/plain' }), o.multipart.file.name || 'f.txt');
            body = fd;
        }
        const res = await fetch(base + p, { method: o.method || (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
        const buf = Buffer.from(await res.arrayBuffer());
        const text = buf.toString('utf8');
        return { status: res.status, headers: res.headers, text, buffer: buf, json() { return JSON.parse(text); } };
    }

    /** Every value in every table of Codes' database, as one string. */
    function dbDump() {
        const db = built.ctx.store.db;
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
        return tables.map((tname) => JSON.stringify(db.prepare(`SELECT * FROM "${tname}"`).all())).join('\n');
    }

    async function project(user, name = 'Test project') {
        const r = await get('/projects', { as: user, form: { name } });
        if (r.status !== 303) throw new Error(`project: ${r.status} ${r.text.slice(0, 300)}`);
        return r.headers.get('location').split('/').pop();
    }
    /** Create an app through the portal; returns { id, secret, page }. */
    async function app(user, projectId, body = {}) {
        const r = await get(`/projects/${projectId}/apps`, { as: user, form: { name: 'Test app', environment: 'sandbox', type: 'confidential', redirect_uris: '', ...body } });
        if (r.status === 303) return { id: r.headers.get('location').split('/').pop().split('?')[0], secret: null, page: r };
        if (r.status !== 200) throw new Error(`app: ${r.status} ${r.text.slice(0, 300)}`);
        const secret = (r.text.match(/ovsec_[A-Za-z0-9_-]{43}/) || [null])[0];
        const id = (r.text.match(/app_[0-9A-HJKMNP-TV-Z]{26}/) || [null])[0];
        return { id, secret, page: r };
    }
    /** Approve a grant the way Network would after staff put it in the allowance. */
    async function grant(owner, projectId, appId, capability) {
        network.setAllowance(projectId, [...new Set([...network.state.projects.get(projectId).allowance, capability])]);
        const r = await get(`/projects/${projectId}/apps/${appId}/grants`, { as: owner, form: { capability } });
        if (r.status !== 303) throw new Error(`grant: ${r.status} ${r.text.slice(0, 300)}`);
    }

    const t = {
        base, network, events, media, config, ctx: built.ctx, dbPath, get, signIn, csrf, dbDump, project, app, grant,
        logs: () => captured.join('\n'),
        async close() {
            await new Promise((r) => server.close(r));
            await built.ctx.outbox.stop();
            built.ctx.store.close();
            await network.close(); await events.close(); await media.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
    return t;
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); process.stdout.write(`  ✓ ${name}\n`); } catch (e) { failures++; process.stdout.write(`  ✗ ${name}\n      ${(e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')}\n`); }
}
function done() { process.stdout.write(failures ? `\n${failures} failed\n` : '\nall passed\n'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done };
