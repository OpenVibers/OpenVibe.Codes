'use strict';
/**
 * The chat plays sandbox's egress proxy (sandbox/egress-proxy.js), in-process: the sandbox's only way out. These run
 * everywhere, CI included (the same refusals are tried from inside a real sandbox in sandbox-escape.test.js).
 *
 *   - the guard is openvibe-shared/egress: public unicast addresses only, checked AFTER DNS resolution (every
 *     answer must pass), and the socket opens to the address that was checked (no second lookup, no rebinding);
 *   - the host's own addresses are refused even when they are public;
 *   - ports 80 and 443 only: no SMTP, no database, no SSH, nothing else;
 *   - the proxy never follows a redirect: the client's next request is a new one, checked again;
 *   - a refusal is a 403 with X-OV-Egress, reported to the worker, and no socket is ever opened for it.
 */
const assert = require('assert');
const http = require('http');
const net = require('net');
const { createEgressProxy } = require('../sandbox/egress-proxy');
const { startWorld, ORIGIN_IP, SELF_IP } = require('./helpers/sandbox-world');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}

function dechunk(text) {
    let out = '';
    let rest = text;
    for (;;) {
        const i = rest.indexOf('\r\n');
        if (i < 0) return out;
        const n = parseInt(rest.slice(0, i), 16);
        if (!n) return out;
        out += rest.slice(i + 2, i + 2 + n);
        rest = rest.slice(i + 2 + n + 2);
    }
}

function raw(port, text) {
    return new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1');
        let buf = '';
        s.on('connect', () => s.write(text));
        s.on('data', (d) => { buf += d; });
        const done = () => {
            const [head, ...rest] = buf.split('\r\n\r\n');
            const lines = head.split('\r\n');
            const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] || '');
            const headers = {};
            for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
            let body = rest.join('\r\n\r\n');
            if (/chunked/i.test(headers['transfer-encoding'] || '')) body = dechunk(body);
            resolve({ status: m ? Number(m[1]) : null, headers, body });
        };
        s.on('end', done);
        s.on('error', done);
        setTimeout(() => { s.destroy(); done(); }, 3000);
    });
}
const get = (port, url, host) => raw(port, `GET ${url} HTTP/1.1\r\nHost: ${host || new URL(url).host}\r\nConnection: close\r\n\r\n`);
const connect = (port, authority) => raw(port, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);

(async () => {
    console.log('sandbox egress proxy');
    const world = await startWorld();
    const decisions = [];
    const proxy = createEgressProxy({ ...world.egress, onDecision: (d) => decisions.push(d) });
    await proxy.listen({ port: 0, host: '127.0.0.1' });
    const port = proxy.address().port;

    await check('the guard: public addresses pass, every private, local and reserved one is refused', async () => {
        assert.deepStrictEqual(await proxy.check('origin.example', 80), { ok: true, host: 'origin.example', port: 80, address: ORIGIN_IP, family: 4 });
        const refused = {
            '127.0.0.1': 'egress.private_address', '10.1.2.3': 'egress.private_address', '192.168.0.1': 'egress.private_address',
            '172.16.0.1': 'egress.private_address', '172.31.0.1': 'egress.private_address', '169.254.169.254': 'egress.private_address',
            '100.64.0.1': 'egress.private_address', '0.0.0.0': 'egress.private_address', '::1': 'egress.private_address',
            '::ffff:10.0.0.1': 'egress.private_address', 'fd00::1': 'egress.private_address', 'fe80::1': 'egress.private_address',
            '64:ff9b::a00:1': 'egress.private_address', '2002:a00:1::': 'egress.private_address',
            localhost: 'egress.internal_name', 'db.internal': 'egress.internal_name', 'nas.local': 'egress.internal_name', intranet: 'egress.internal_name',
            'private.example': 'egress.private_address', 'mixed.example': 'egress.private_address', 'meta.example': 'egress.private_address',
            'v6mapped.example': 'egress.private_address', [SELF_IP]: 'egress.host_address', 'self.example': 'egress.host_address',
            'nowhere.example': 'egress.dns',
        };
        for (const [host, code] of Object.entries(refused)) {
            const r = await proxy.check(host, 443);
            assert.strictEqual(r.ok, false, `${host} is refused`);
            assert.strictEqual(r.code, code, `${host}: ${r.code}`);
        }
        for (const p of [25, 587, 465, 22, 6379, 5432, 8080, 0, 65536, -1]) assert.strictEqual((await proxy.check('origin.example', p)).code, 'egress.port', `port ${p}`);
    });

    await check('GET through the proxy: the public origin answers, and the request goes to the address that was checked', async () => {
        const r = await get(port, 'http://origin.example/');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body, 'origin-ok');
        const d = decisions.find((x) => x.host === 'origin.example' && x.allowed);
        assert.strictEqual(d.address, ORIGIN_IP);
    });

    await check('GET refuses private targets in every spelling, with 403 and X-OV-Egress, and opens no socket', async () => {
        const urls = ['http://127.0.0.1/', `http://127.0.0.1:${world.canaryPort}/`, 'http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://[::1]/',
            'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data/',
            'http://private.example/', 'http://mixed.example/', `http://${SELF_IP}/`, 'http://origin.example:25/', 'http://origin.example:8080/'];
        for (const url of urls) {
            const r = await get(port, url);
            assert.strictEqual(r.status, 403, `${url}: ${r.status}`);
            assert.match(String(r.headers['x-ov-egress']), /^refused; code=egress\./, `${url} says why`);
        }
        assert.strictEqual(world.hits.canary, 0);
        assert.deepStrictEqual(world.hits.unexpectedDials, []);
    });

    await check('the Host header cannot steer the request: the request target decides, and Host is rewritten to it', async () => {
        const r = await get(port, 'http://origin.example/', `127.0.0.1:${world.canaryPort}`);
        assert.strictEqual(r.status, 200);
        const bad = await get(port, `http://127.0.0.1:${world.canaryPort}/`, 'origin.example');
        assert.strictEqual(bad.status, 403);
        assert.strictEqual(world.hits.canary, 0);
    });

    await check('an origin-form request (the proxy used as a server) and a non-HTTP scheme are refused', async () => {
        assert.strictEqual((await raw(port, 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')).status, 400);
        for (const u of ['ftp://origin.example/', 'gopher://origin.example:70/', 'file:///etc/passwd', 'ws://origin.example/']) {
            const r = await raw(port, `GET ${u} HTTP/1.1\r\nHost: origin.example\r\nConnection: close\r\n\r\n`);
            assert.ok(r.status === 403 || r.status === 400, `${u}: ${r.status}`);
        }
    });

    await check('CONNECT: 443 and 80 to a public address tunnel; private, SMTP and other ports are refused', async () => {
        const ok = await new Promise((resolve) => {
            const s = net.connect(port, '127.0.0.1', () => s.write('CONNECT origin.example:443 HTTP/1.1\r\nHost: origin.example:443\r\n\r\n'));
            let buf = ''; let open = false;
            s.on('data', (d) => { buf += d; if (!open && buf.includes('\r\n\r\n')) { open = /^HTTP\/1\.1 200/.test(buf); buf = ''; s.write('ping'); } });
            s.on('end', () => resolve({ open, reply: buf }));
            setTimeout(() => { s.destroy(); resolve({ open, reply: buf }); }, 3000);
        });
        assert.deepStrictEqual(ok, { open: true, reply: 'pong' });
        for (const a of ['127.0.0.1:443', '10.0.0.1:443', '[::1]:443', 'private.example:443', 'meta.example:80', 'origin.example:25', 'origin.example:587',
            'origin.example:465', 'smtp.example:25', 'origin.example:22', 'origin.example:6379', '2130706433:443', 'localhost:443', `${SELF_IP}:443`, 'origin.example', 'origin.example:abc']) {
            const r = await connect(port, a);
            assert.ok(r.status === 403 || r.status === 400, `CONNECT ${a}: ${r.status}`);
        }
        assert.deepStrictEqual(world.hits.unexpectedDials, []);
    });

    await check('a redirect is passed back, never followed: the next hop is a new request, checked again', async () => {
        const first = await get(port, `http://origin.example/redirect?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`);
        assert.strictEqual(first.status, 302);
        assert.strictEqual(first.headers.location, 'http://169.254.169.254/latest/meta-data/');
        const second = await get(port, first.headers.location);
        assert.strictEqual(second.status, 403);
        assert.deepStrictEqual(world.hits.unexpectedDials, []);
    });

    await check('a real HTTP client through the proxy gets the same answers', async () => {
        const viaProxy = (url) => new Promise((resolve, reject) => {
            const u = new URL(url);
            http.get({ host: '127.0.0.1', port, path: url, headers: { host: u.host } }, (res) => {
                let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
            }).on('error', reject);
        });
        assert.deepStrictEqual(await viaProxy('http://origin.example/'), { status: 200, body: 'origin-ok' });
        assert.strictEqual((await viaProxy('http://10.0.0.1/')).status, 403);
    });

    await check('every decision is reported (the worker logs them for the owner), refusals with their code', async () => {
        assert.ok(decisions.length > 20);
        for (const d of decisions) {
            assert.strictEqual(typeof d.allowed, 'boolean');
            if (!d.allowed) assert.match(d.code, /^egress\./);
            assert.ok(!('body' in d) && !('headers' in d), 'a decision carries no request content');
        }
    });

    await check('the proxy holds a bounded number of connections', async () => {
        const small = createEgressProxy({ ...world.egress, maxConnections: 2 });
        await small.listen({ port: 0, host: '127.0.0.1' });
        const p = small.address().port;
        const held = [net.connect(p, '127.0.0.1'), net.connect(p, '127.0.0.1')];
        await new Promise((r) => setTimeout(r, 100));
        const third = await raw(p, 'GET http://origin.example/ HTTP/1.1\r\nHost: origin.example\r\nConnection: close\r\n\r\n');
        assert.strictEqual(third.status, 503);
        for (const s of held) s.destroy();
        await small.close();
    });

    await check('a download that spends the session\'s budget is cut off, and new requests get 429 egress.budget', async () => {
        const budget = createEgressProxy({ ...world.egress, budgetDownBytes: 256, budgetUpBytes: 4096 });
        await budget.listen({ port: 0, host: '127.0.0.1' });
        const p = budget.address().port;
        const first = await get(p, 'http://origin.example/big?n=65536');
        assert.strictEqual(first.status, 200);
        assert.ok(first.body.length <= 256, `the body stops at the budget (${first.body.length} bytes)`);
        assert.ok(first.body.length > 0, 'some of it was delivered before the cut-off');
        const stats = budget.stats();
        assert.strictEqual(stats.spent, true, 'the session report says the budget is spent');
        assert.strictEqual(stats.spent_direction, 'down');
        assert.strictEqual(stats.down_bytes, 256, 'it counted exactly the budget');
        const second = await get(p, 'http://origin.example/');
        assert.strictEqual(second.status, 429);
        assert.match(String(second.headers['x-ov-egress']), /^refused; code=egress\.budget$/);
        assert.ok(budget.stats().budget_refusals >= 1);
        // The tunnel counts too, and closes when the budget is spent.
        const tunnel = createEgressProxy({ ...world.egress, budgetDownBytes: 2, budgetUpBytes: 4096 });
        await tunnel.listen({ port: 0, host: '127.0.0.1' });
        const t = await new Promise((resolve) => {
            const s = net.connect(tunnel.address().port, '127.0.0.1', () => s.write('CONNECT origin.example:443 HTTP/1.1\r\nHost: origin.example:443\r\n\r\n'));
            let buf = ''; let open = false;
            s.on('data', (d) => { buf += d; if (!open && buf.includes('\r\n\r\n')) { open = true; buf = ''; s.write('ping'); } });
            const done = () => resolve({ open, reply: buf });
            s.on('end', done);
            s.on('error', done);
            setTimeout(() => { s.destroy(); done(); }, 3000);
        });
        assert.strictEqual(t.open, true, 'the tunnel opened');
        await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual(tunnel.stats().spent, true, 'the tunnel spent the down budget and closed');
        assert.strictEqual(tunnel.stats().spent_direction, 'down');
        const after = await get(tunnel.address().port, 'http://origin.example/');
        assert.strictEqual(after.status, 429);
        assert.match(String(after.headers['x-ov-egress']), /code=egress\.budget/);

        // The other direction counts too: a tunnel whose upload spends the up budget closes as well.
        const upload = createEgressProxy({ ...world.egress, budgetDownBytes: 4096, budgetUpBytes: 2 });
        await upload.listen({ port: 0, host: '127.0.0.1' });
        const u = await new Promise((resolve) => {
            const s = net.connect(upload.address().port, '127.0.0.1', () => s.write('CONNECT origin.example:443 HTTP/1.1\r\nHost: origin.example:443\r\n\r\n'));
            let buf = ''; let open = false;
            s.on('data', (d) => { buf += d; if (!open && buf.includes('\r\n\r\n')) { open = true; s.write('ping'); } });
            const done = () => resolve({ open });
            s.on('end', done);
            s.on('error', done);
            setTimeout(() => { s.destroy(); done(); }, 3000);
        });
        assert.strictEqual(u.open, true, 'the tunnel opened');
        await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual(upload.stats().spent, true);
        assert.strictEqual(upload.stats().spent_direction, 'up', 'the up budget is the one that went');

        // Another session has its own budget: the same download there is not affected.
        const other = createEgressProxy({ ...world.egress, budgetDownBytes: 256, budgetUpBytes: 4096 });
        await other.listen({ port: 0, host: '127.0.0.1' });
        const ok = await get(other.address().port, 'http://origin.example/');
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.body, 'origin-ok');
        assert.strictEqual(other.stats().spent, false, 'a fresh session has its own budget');
        for (const s of [budget, tunnel, upload, other]) await s.close();
    });

    await check('a session holds at most the per-host connection cap', async () => {
        const capped = createEgressProxy({ ...world.egress, maxConnectionsPerHost: 2 });
        await capped.listen({ port: 0, host: '127.0.0.1' });
        const p = capped.address().port;
        const held = [];
        for (let i = 0; i < 2; i++) {
            await new Promise((resolve, reject) => {
                const s = net.connect(p, '127.0.0.1', () => s.write('CONNECT origin.example:443 HTTP/1.1\r\nHost: origin.example:443\r\n\r\n'));
                let buf = '';
                s.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) resolve(s); });
                s.on('error', reject);
                held.push(s);
                setTimeout(() => reject(new Error('the tunnel did not open')), 3000);
            });
        }
        const third = await get(p, 'http://origin.example/');
        assert.strictEqual(third.status, 429);
        assert.match(String(third.headers['x-ov-egress']), /code=egress\.connections/);
        assert.ok(capped.stats().connection_refusals >= 1);
        for (const s of held) s.destroy();
        await capped.close();
    });

    await check('a flood to one host is rate-limited, another host is not, and another session is unaffected', async () => {
        const limited = createEgressProxy({
            ...world.egress, hostRequests: { rate: 2, burst: 3 }, sessionRequests: { rate: 50, burst: 50 },
        });
        await limited.listen({ port: 0, host: '127.0.0.1' });
        const p = limited.address().port;
        const statuses = [];
        for (let i = 0; i < 6; i++) statuses.push((await get(p, 'http://origin.example/')).status);
        assert.deepStrictEqual(statuses.slice(0, 3), [200, 200, 200], 'the burst gets through');
        assert.ok(statuses.slice(3).every((s) => s === 429), `the flood is refused (${statuses.join(',')})`);
        const denied = await get(p, 'http://origin.example/');
        assert.match(String(denied.headers['x-ov-egress']), /code=egress\.rate/);
        // The per-host bucket is the host's: a different destination still has its own.
        assert.strictEqual((await get(p, 'http://alt.example/')).status, 200);
        assert.ok(limited.stats().rate_refusals >= 1);
        // A second session starts with its own buckets.
        const fresh = createEgressProxy({ ...world.egress, hostRequests: { rate: 2, burst: 3 } });
        await fresh.listen({ port: 0, host: '127.0.0.1' });
        assert.strictEqual((await get(fresh.address().port, 'http://origin.example/')).status, 200);
        await limited.close();
        await fresh.close();
    });

    await check('the per-session request rate is shared by the session\'s destinations', async () => {
        const limited = createEgressProxy({
            ...world.egress, hostRequests: { rate: 100, burst: 100 }, sessionRequests: { rate: 1, burst: 2 },
        });
        await limited.listen({ port: 0, host: '127.0.0.1' });
        const p = limited.address().port;
        assert.strictEqual((await get(p, 'http://origin.example/')).status, 200);
        assert.strictEqual((await get(p, 'http://alt.example/')).status, 200);
        const third = await get(p, 'http://origin.example/');
        assert.strictEqual(third.status, 429);
        assert.match(String(third.headers['x-ov-egress']), /code=egress\.rate/);
        await limited.close();
    });

    await proxy.close();
    await world.close();
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
