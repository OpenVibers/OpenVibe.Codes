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

    await proxy.close();
    await world.close();
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
