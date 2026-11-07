'use strict';
/**
 * The Dock's agent view (Dock plan 2026-10-30 K-D3; Agent Streams S1): Codes mints the person's view ticket server-side
 * and hands the Dock the embed, with the person's own token passed through to OpenVibe.Live — never a service token,
 * never another person's stream. Curtain now and End are Live's own routes, reached the same way; the still comes back
 * through Codes because an <img> cannot carry a bearer.
 *
 * Live is a stand-in on a local port (CODES_LIVE_URL): the api/streams/agent list, the view ticket, the curtain, the
 * end and the frame.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const LIVE_ID = 'ags_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

const STREAM = (o = {}) => ({
    id: LIVE_ID, owner: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', channel: 'ada', title: 'Fix the flaky upload test',
    task: { source: 'codes', ref: 'tsk_1', title: 'Fix the flaky upload test', url: 'https://openvibe.codes/run/tasks/tsk_1' },
    visibility: 'private', mode: 'watch', state: 'live', curtain: { up: false }, viewers: 2,
    started_at: '2026-11-06T10:00:00.000Z', ended_at: null, worked_seconds: 720, last_frame_url: null, vod_id: null,
    page_url: `https://openvibe.live/@ada/agents/${LIVE_ID}`, label: 'AI agent', ...o,
});

(async () => {
    // ── OpenVibe.Live's stand-in ────────────────────────────────
    const calls = [];
    const live = { streams: [], ticket: 'wvt_the_view_ticket', fail: false, authorizations: [] };
    const server = await new Promise((ok) => {
        const srv = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://x');
            const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
            live.authorizations.push(String(req.headers.authorization || ''));
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                calls.push({ method: req.method, path: url.pathname, body: body ? JSON.parse(body) : null });
                if (live.fail) return json(500, { error: 'Live is unwell', code: 'boom' });
                if (url.pathname === '/api/streams/agent/mine' && req.method === 'GET') {
                    const onlyLive = url.searchParams.get('live') === '1';
                    return json(200, { streams: live.streams.filter((s) => !onlyLive || s.state === 'live') });
                }
                const m = /^\/api\/streams\/agent\/(ags_[0-9A-Z]+)\/(view-ticket|curtain|end)$/.exec(url.pathname);
                if (m) {
                    if (m[2] === 'view-ticket') return json(200, { ticket: live.ticket, expires_at: new Date(Date.now() + 600_000).toISOString() });
                    if (m[2] === 'curtain') { live.streams = live.streams.map((s) => ({ ...s, curtain: { up: true } })); return json(200, { stream: STREAM({ curtain: { up: true } }) }); }
                    if (m[2] === 'end') { live.streams = live.streams.map((s) => ({ ...s, state: 'ended', last_frame_url: 'https://openvibe.live/api/streams/agent/' + LIVE_ID + '/frame' })); return json(200, { stream: STREAM({ state: 'ended' }) }); }
                }
                if (url.pathname === `/api/streams/agent/${LIVE_ID}/frame`) {
                    res.writeHead(200, { 'content-type': 'image/jpeg' });
                    return res.end(FRAME);
                }
                return json(404, { error: 'not found' });
            });
        });
        srv.listen(0, '127.0.0.1', () => ok(srv));
    });

    const t = await boot({ env: { CODES_LIVE_URL: `http://127.0.0.1:${server.address().port}` } });
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');

    try {
        await check('signed out, there is nothing to show', async () => {
            const res = await t.get('/api/v1/me/agent-view');
            assert.strictEqual(res.status, 401, res.text);
            assert.strictEqual(res.json().code, 'auth.required');
        });

        await check('a person with no stream gets { agent: null }', async () => {
            const res = await t.get('/api/v1/me/agent-view', { bearer: t.network.userToken(ada) });
            assert.strictEqual(res.status, 200, res.text);
            assert.deepStrictEqual(res.json(), { agent: null });
        });

        await check('the live stream comes with the embed, its ticket minted here, and the person\'s own token to Live', async () => {
            live.streams = [STREAM({ state: 'ended', last_frame_url: 'https://openvibe.live/x' }), STREAM()];
            live.authorizations.length = 0;   // this check's calls only (a token's iat is the second it was minted)
            const token = t.network.userToken(ada);
            const res = await t.get('/api/v1/me/agent-view', { bearer: token });
            assert.strictEqual(res.status, 200, res.text);
            const a = res.json().agent;
            assert.strictEqual(a.id, LIVE_ID);
            assert.strictEqual(a.state, 'live');
            assert.strictEqual(a.title, 'Fix the flaky upload test');
            assert.deepStrictEqual(a.task, STREAM().task);
            assert.deepStrictEqual([a.viewers, a.worked_seconds], [2, 720]);
            assert.strictEqual(a.embed_url, `https://openvibe.live/embed/agent/${LIVE_ID}?vt=wvt_the_view_ticket`);
            assert.strictEqual(a.page_url, `https://openvibe.live/@ada/agents/${LIVE_ID}`);
            assert.ok(!JSON.stringify(a).includes('wpt_'), 'no publish ticket anywhere');
            assert.ok(calls.some((c) => c.method === 'POST' && c.path === `/api/streams/agent/${LIVE_ID}/view-ticket`), 'the ticket was minted server-side');
            // Every call to Live carried the person's own token: Codes holds no token of its own here.
            for (const auth of live.authorizations) {
                assert.strictEqual(auth, `Bearer ${token}`, 'the person\'s own bearer, not a service token');
            }
            assert.notStrictEqual(ada.subject, bo.subject);
        });

        await check('the Dock may read it from any site, and the preflight says so', async () => {
            const get = await t.get('/api/v1/me/agent-view', { bearer: t.network.userToken(ada) });
            assert.strictEqual(get.headers.get('access-control-allow-origin'), '*');
            assert.match(String(get.headers.get('cache-control')), /no-store/);
            const pre = await fetch(`${t.base}/api/v1/me/agent-view?x=1`, {
                method: 'OPTIONS', headers: { origin: 'https://openvibe.live', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' },
            });
            assert.strictEqual(pre.status, 204);
            assert.strictEqual(pre.headers.get('access-control-allow-origin'), '*');
            assert.match(String(pre.headers.get('access-control-allow-headers')), /authorization/);
            assert.match(String(pre.headers.get('access-control-allow-methods')), /POST/);
        });

        await check('an ended stream is the still, with no embed and no ticket', async () => {
            live.streams = [STREAM({ state: 'ended', last_frame_url: 'https://openvibe.live/api/streams/agent/' + LIVE_ID + '/frame' })];
            const before = calls.filter((c) => c.path.endsWith('/view-ticket')).length;
            const res = await t.get('/api/v1/me/agent-view', { bearer: t.network.userToken(ada) });
            const a = res.json().agent;
            assert.strictEqual(a.state, 'ended');
            assert.strictEqual(a.embed_url, null);
            assert.strictEqual(a.last_frame_url, 'https://openvibe.codes/api/v1/me/agent-view/frame');
            assert.strictEqual(calls.filter((c) => c.path.endsWith('/view-ticket')).length, before, 'no ticket for an ended stream');
        });

        await check('the still comes back through Codes, from Live\'s own frame', async () => {
            const res = await t.get('/api/v1/me/agent-view/frame', { bearer: t.network.userToken(ada) });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.headers.get('content-type'), 'image/jpeg');
            assert.deepStrictEqual([...res.buffer], [...FRAME]);
            assert.match(String(res.headers.get('cache-control')), /private/);
            const anon = await t.get('/api/v1/me/agent-view/frame');
            assert.strictEqual(anon.status, 401);
        });

        await check('Curtain now and End are Live\'s routes, and the answer is the view read again', async () => {
            live.streams = [STREAM()];
            const curtain = await t.get('/api/v1/me/agent-view/curtain', { bearer: t.network.userToken(ada), method: 'POST', json: {} });
            assert.strictEqual(curtain.status, 200, curtain.text);
            const sent = calls.filter((c) => c.path === `/api/streams/agent/${LIVE_ID}/curtain`).pop();
            assert.deepStrictEqual(sent.body, { up: true, reason: 'manual' });
            assert.strictEqual(curtain.json().agent.curtain.up, true, 'the Dock paints the curtain Live now reports');

            const end = await t.get('/api/v1/me/agent-view/end', { bearer: t.network.userToken(ada), method: 'POST', json: {} });
            assert.strictEqual(end.status, 200, end.text);
            assert.ok(calls.some((c) => c.path === `/api/streams/agent/${LIVE_ID}/end`), 'End reached Live');
            assert.strictEqual(end.json().agent.state, 'ended');

            const anon = await t.get('/api/v1/me/agent-view/end', { method: 'POST', json: {} });
            assert.strictEqual(anon.status, 401);
        });

        await check('a Live that does not answer is a 502 problem the Dock can ignore', async () => {
            live.fail = true;
            const res = await t.get('/api/v1/me/agent-view', { bearer: t.network.userToken(ada) });
            assert.strictEqual(res.status, 502, res.text);
            assert.strictEqual(res.json().code, 'agent_view.unavailable');
            live.fail = false;
        });
    } finally {
        await t.close();
        server.close();
    }
    done();
})().catch((e) => { process.stdout.write(`${e && e.stack || e}\n`); process.exit(1); });
