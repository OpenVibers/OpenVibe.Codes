'use strict';
/**
 * The chat plays sandbox worker's parts that need no bubblewrap (these run everywhere, CI included; the real sandbox
 * is tried in sandbox-escape, sandbox-limits and sandbox-tools):
 *
 *   - the bubblewrap command line: every namespace, nothing of the host but the read-only list, nothing writable but
 *     the tmpfs areas, a cleared environment;
 *   - the seccomp program: the architecture check first, the denied calls, nothing for an unknown architecture;
 *   - the heartbeat signature;
 *   - the supervisor's protocol (run here without a sandbox): the terminal, the editor confined to the workspace,
 *     time-outs and capped output;
 *   - the worker: ready only with the self-test and the limits; its check-ins to Codes (signed) and Live (its own
 *     service token, every stream it serves) carry the isolation facts and no secret; its local API; the time box
 *     bounds; and no room means no new sandbox.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}

(async () => {
    console.log('sandbox worker');
    const { buildArgs, etcFiles } = require('../sandbox/bwrap');
    const seccomp = require('../sandbox/seccomp');
    const signature = require('../sandbox/signature');
    const { values } = require('../sandbox/limits');
    const { createWorker, loadConfig } = require('../sandbox/worker');
    const tmp = fs.mkdtempSync(path.join('/tmp', 'ovsbx-unit-'));

    await check('bubblewrap: every namespace, no capability, a cleared environment, killed with the worker', () => {
        const { args } = buildArgs({ sessionEtc: tmp, netDir: tmp, supervisorPath: path.join(__dirname, '..', 'sandbox', 'supervisor.js'), diskMb: 64, seccompFd: 3 });
        for (const a of ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup', '--disable-userns',
            '--die-with-parent', '--new-session', '--clearenv']) assert.ok(args.includes(a), `${a} is there`);
        assert.ok(!args.includes('--share-net'), 'the host network is never shared');
        assert.deepStrictEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
        assert.deepStrictEqual(args.slice(args.indexOf('--seccomp'), args.indexOf('--seccomp') + 2), ['--seccomp', '3']);
        assert.ok(args.indexOf('--remount-ro') >= 0 && args.includes('/'), 'the root is read-only');
    });

    await check('bubblewrap: nothing of the host but the read-only list; writable areas are tmpfs only', () => {
        const { args, env } = buildArgs({ sessionEtc: tmp, netDir: tmp, supervisorPath: path.join(__dirname, '..', 'sandbox', 'supervisor.js'), diskMb: 64 });
        const binds = [];
        for (let i = 0; i < args.length; i++) {
            if (['--bind', '--dev-bind', '--bind-try', '--dev-bind-try'].includes(args[i])) assert.fail(`a writable bind: ${args.slice(i, i + 3).join(' ')}`);
            if (args[i] === '--ro-bind' || args[i] === '--ro-bind-try') binds.push([args[i + 1], args[i + 2]]);
        }
        const forbidden = ['/', '/home', '/root', '/etc', '/var', '/run', '/opt', '/srv', '/mnt', '/media', '/sys', '/proc', '/dev', os.homedir(), '/etc/ssl', '/etc/ssl/private', '/etc/openvibe', '/etc/shadow', '/etc/passwd', '/etc/ssh'];
        for (const [src] of binds) assert.ok(!forbidden.includes(src), `${src} is never bound`);
        const allowedTargets = /^(\/usr|\/etc\/.+|\/run\/ov\/net|\/opt\/ov\/supervisor\.js|\/opt\/node|\/opt\/browser|\/(bin|sbin|lib|lib32|lib64|libx32))$/;
        for (const [, dest] of binds) assert.match(dest, allowedTargets, `${dest} is on the list`);
        const tmpfs = args.map((a, i) => (a === '--tmpfs' ? args[i + 1] : null)).filter(Boolean).sort();
        assert.deepStrictEqual(tmpfs.filter((p) => p !== '/usr/local'), ['/dev/shm', '/home/agent', '/tmp', '/workspace']);
        for (const p of ['/tmp', '/home/agent', '/workspace']) {
            const i = args.findIndex((a, k) => a === '--tmpfs' && args[k + 1] === p);
            assert.deepStrictEqual(args.slice(i - 2, i), ['--size', String(64 * 1024 * 1024)], `${p} is size-limited`);
        }
        assert.deepStrictEqual(Object.keys(env).filter((k) => /SECRET|TOKEN|KEY|PASS|DATABASE|AWS|GITHUB/i.test(k)), [], 'no secret-shaped variable');
        assert.strictEqual(env.HOME, '/home/agent');
        assert.strictEqual(env.https_proxy, 'http://127.0.0.1:3128');
    });

    await check('the sandbox\'s own /etc: its user list and no DNS', () => {
        const f = etcFiles();
        assert.deepStrictEqual(f.passwd.trim().split('\n').map((l) => l.split(':')[0]), ['agent', 'nobody']);
        assert.ok(!/nameserver/.test(f['resolv.conf']), 'no nameserver: names resolve at the proxy');
    });

    await check('seccomp: the architecture is checked first, the denied calls answer EPERM, an unknown one has no filter', () => {
        for (const arch of ['x64', 'arm64']) {
            const prog = seccomp.compile(arch);
            assert.strictEqual(prog.length % 8, 0);
            assert.strictEqual(prog.readUInt16LE(0), 0x20, 'it loads the architecture first');
            assert.strictEqual(prog.readUInt32LE(4), 4);
            assert.strictEqual(prog.readUInt32LE(12), seccomp.AUDIT_ARCH[arch]);
            assert.strictEqual(prog.readUInt32LE(20), 0x80000000, 'another architecture kills the process');
            assert.strictEqual(prog.readUInt32LE(prog.length - 4), 0x7fff0000, 'the rest is allowed');
            for (const name of ['keyctl', 'add_key', 'ptrace', 'unshare', 'setns', 'mount', 'bpf', 'io_uring_setup', 'perf_event_open']) assert.ok(seccomp.denied(arch).includes(name), `${arch} denies ${name}`);
        }
        assert.strictEqual(seccomp.compile('ia32'), null);
        const header = '/usr/include/x86_64-linux-gnu/asm/unistd_64.h';
        if (fs.existsSync(header)) {
            const nr = Object.fromEntries([...fs.readFileSync(header, 'utf8').matchAll(/#define __NR_(\w+)\s+(\d+)/g)].map((m) => [m[1], Number(m[2])]));
            for (const [name, n] of Object.entries(seccomp.SYSCALLS.x64)) assert.strictEqual(nr[name], n, `x86-64 ${name} is ${nr[name]}`);
        }
    });

    await check('the heartbeat signature: the secret, the body and the time all count', () => {
        const body = '{"worker_id":"sbw-x"}';
        const h = signature.sign('s3cret', body, 1_700_000_000_000);
        assert.deepStrictEqual(signature.verify({ secrets: ['s3cret'], header: h, body, now: 1_700_000_000_500 }), { ok: true, t: 1_700_000_000_000 });
        assert.strictEqual(signature.verify({ secrets: ['other'], header: h, body, now: 1_700_000_000_500 }).code, 'signature.invalid');
        assert.strictEqual(signature.verify({ secrets: ['s3cret'], header: h, body: `${body} `, now: 1_700_000_000_500 }).code, 'signature.invalid');
        assert.strictEqual(signature.verify({ secrets: ['s3cret'], header: h, body, now: 1_700_000_100_000 }).code, 'signature.stale');
        assert.strictEqual(signature.verify({ secrets: [], header: h, body }).code, 'sandbox.not_configured');
        assert.strictEqual(signature.verify({ secrets: ['s3cret'], header: 'v1=abc', body }).code, 'signature.missing');
    });

    await check('the cgroup values: memory counts the tmpfs areas, cpu is a quota of 100 ms', () => {
        assert.deepStrictEqual(values({ memoryMb: 1024, diskMb: 256, pids: 128, cpuPercent: 150 }), { memory: (1024 + 768) * 1024 * 1024, pids: 128, cpu: '150000 100000', cpuPercent: 150 });
    });

    // ── The supervisor, run here without a sandbox (its protocol, not its isolation) ──
    const ws = path.join(tmp, 'workspace');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside');
    fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(ws, 'link-out'));
    const sup = spawn(process.execPath, [path.join(__dirname, '..', 'sandbox', 'supervisor.js')], {
        env: { PATH: process.env.PATH, OV_SANDBOX_WORKSPACE: ws, OV_SANDBOX_PROXY_PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const frames = [];
    const waiters = [];
    let sbuf = '';
    sup.stdout.on('data', (d) => {
        sbuf += d;
        let i;
        while ((i = sbuf.indexOf('\n')) >= 0) {
            const f = JSON.parse(sbuf.slice(0, i));
            sbuf = sbuf.slice(i + 1);
            frames.push(f);
            for (const w of [...waiters]) if (w.test(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
        }
    });
    const waitFrame = (test) => new Promise((resolve) => { const hit = frames.find(test); if (hit) resolve(hit); else waiters.push({ test, resolve }); });
    let seq = 0;
    const ask = async (msg) => {
        const id = ++seq;
        sup.stdin.write(`${JSON.stringify({ ...msg, id })}\n`);
        const end = await waitFrame((f) => f.id === id && (f.ev === 'exit' || f.ev === 'done'));
        const out = Buffer.concat(frames.filter((f) => f.id === id && f.ev === 'out' && f.fd === 1).map((f) => Buffer.from(f.data, 'base64'))).toString();
        return { ...end, out };
    };
    await waitFrame((f) => f.ev === 'ready');

    await check('the supervisor: a command runs in the workspace, with input, and its exit code comes back', async () => {
        const r = await ask({ op: 'exec', argv: ['sh', '-c', 'pwd; cat; exit 4'], stdin: Buffer.from('hello').toString('base64') });
        assert.strictEqual(r.code, 4);
        assert.strictEqual(r.out, `${fs.realpathSync(ws)}\nhello`);
    });

    await check('the supervisor: a command that runs too long is killed, and its output is capped', async () => {
        const slow = await ask({ op: 'exec', argv: ['sleep', '20'], timeoutMs: 300 });
        assert.strictEqual(slow.signal, 'SIGKILL');
        assert.strictEqual(slow.timedOut, true);
        const big = await ask({ op: 'exec', argv: ['sh', '-c', 'head -c 300000 /dev/zero'], maxOutput: 1000 });
        assert.strictEqual(big.out.length, 1000);
        assert.strictEqual(big.truncated, true);
    });

    await check('the supervisor: the editor writes, reads and lists the workspace, and refuses anything outside it', async () => {
        assert.strictEqual((await ask({ op: 'write', path: 'game/index.html', data: Buffer.from('<canvas>').toString('base64') })).ok, true);
        const r = await ask({ op: 'read', path: '/workspace/game/index.html'.replace('/workspace', ws) });
        assert.strictEqual(Buffer.from(r.data, 'base64').toString(), '<canvas>');
        const l = await ask({ op: 'list', path: 'game' });
        assert.deepStrictEqual(l.entries.map((e) => e.name), ['index.html']);
        for (const p of ['../outside.txt', '/etc/passwd', 'link-out', `${ws}/../outside.txt`]) {
            const x = await ask({ op: 'read', path: p });
            assert.strictEqual(x.ok, false, `${p} is refused`);
            assert.match(x.error, /outside the workspace/);
        }
        const w = await ask({ op: 'write', path: 'link-out', data: Buffer.from('x').toString('base64') });
        assert.strictEqual(w.ok, false, 'a write through a link out of the workspace is refused');
        assert.strictEqual(fs.readFileSync(path.join(tmp, 'outside.txt'), 'utf8'), 'outside');
        assert.strictEqual((await ask({ op: 'exec', argv: ['true'], cwd: '/etc' })).code, 127, 'a working directory outside the workspace is refused');
    });

    await check('the supervisor: an unknown request is an error, garbage is ignored, and the process lives on', async () => {
        sup.stdin.write('not json\n{"x":1}\n');
        assert.strictEqual((await ask({ op: 'format-disk' })).ok, false);
        assert.strictEqual((await ask({ op: 'ping' })).ok, true);
    });
    sup.stdin.end();

    // ── The worker, with a fake sandbox and fake neighbours ──
    const calls = [];
    const fakeFetch = async (url, init) => { calls.push({ url, init }); return { status: 200, text: async () => '' }; };
    const CODES_SECRET = 'codes-secret-for-the-test-0123456789';
    const fakeSandboxes = [];
    const fakeCreate = async (o) => {
        const sbx = {
            id: o.id, state: 'running', opts: o,
            info: () => ({ id: o.id, state: sbx.state, ends_at: new Date(Date.now() + o.timeBoxMs).toISOString() }),
            wipe: async (reason) => { sbx.state = 'wiped'; endResolve({ reason }); return { reason }; },
            exec: async (argv) => ({ code: 0, signal: null, stdout: argv.join(' '), stderr: '' }),
        };
        let endResolve;
        sbx.ended = new Promise((r) => { endResolve = r; });
        fakeSandboxes.push(sbx);
        return sbx;
    };
    const config = {
        ...loadConfig({ CODES_SANDBOX_RUNTIME_DIR: tmp, CODES_SANDBOX_LIVE_STREAMS: 'ags_owner1,bad stream!,ags_owner2', CODES_SANDBOX_LIVE_URL: 'http://live.test', CODES_SANDBOX_CODES_URL: 'http://codes.test', CODES_SANDBOX_WORKER_SECRET: CODES_SECRET, CODES_SANDBOX_MAX_SESSIONS: '2' }),
        socket: path.join(tmp, 'w.sock'),
    };
    const passed = { ok: true, checks: Object.fromEntries(require('../sandbox/selftest').CHECKS.map((c) => [c, true])), failed: [], at: new Date().toISOString() };
    const make = (over = {}) => createWorker({
        config, createSandbox: fakeCreate, fetchImpl: fakeFetch, log: { log() {}, error() {} },
        support: { ok: true, version: '0.9.0', seccomp: true }, limiter: { ok: true, kind: 'cgroup' },
        runSelfTest: async () => passed, tokens: { getToken: async () => 'svc-token-for-live' }, ...over,
    });

    await check('the worker is ready only with the self-test passed and the limits there', async () => {
        const w = make();
        await w.selfTest();
        assert.strictEqual(w.health().ready, true);
        const noLimits = make({ limiter: { ok: false, kind: 'none', reason: 'no cgroup' } });
        await noLimits.selfTest();
        assert.strictEqual(noLimits.health().ready, false);
        assert.ok(noLimits.health().reasons.some((r) => /limits/.test(r)));
        const failing = make({ runSelfTest: async () => ({ ...passed, ok: false, failed: ['egress_refuses_private'], checks: { ...passed.checks, egress_refuses_private: false } }) });
        await failing.selfTest();
        assert.strictEqual(failing.health().ready, false);
        assert.strictEqual(failing.health().isolation.egress.public_only, false);
        await assert.rejects(() => failing.openSession({}), /not ready/, 'a worker that is not ready makes no sandbox');
    });

    await check('the check-ins: Codes signed, Live with the worker\'s own token for every stream it serves, the facts and no secret', async () => {
        const w = make();
        await w.selfTest();
        calls.length = 0;
        await w.openSession({ stream_id: 'ags_session3' });
        await w.announce();
        const codes = calls.filter((c) => c.url === 'http://codes.test/internal/sandbox-workers/heartbeat');
        assert.strictEqual(codes.length, 1);
        assert.strictEqual(signature.verify({ secrets: [CODES_SECRET], header: codes[0].init.headers[signature.HEADER], body: codes[0].init.body }).ok, true);
        const live = calls.filter((c) => c.url.startsWith('http://live.test/')).map((c) => c.url).sort();
        assert.deepStrictEqual(live, ['http://live.test/api/streams/agent/ags_owner1/plays/worker', 'http://live.test/api/streams/agent/ags_owner2/plays/worker', 'http://live.test/api/streams/agent/ags_session3/plays/worker']);
        for (const c of calls.filter((x) => x.url.startsWith('http://live.test/'))) assert.strictEqual(c.init.headers.authorization, 'Bearer svc-token-for-live');
        const body = JSON.parse(calls[0].init.body);
        assert.strictEqual(body.ready, true);
        assert.strictEqual(body.isolation.network_namespace, true);
        assert.strictEqual(body.isolation.host_credentials, 'none');
        assert.strictEqual(body.isolation.limits.enforced, true);
        // The five facts Live's registration requires (server/agent-streams/sandbox.js REQUIRED_ISOLATION), exactly.
        assert.deepStrictEqual(
            {
                host_network: body.isolation.host_network, credentials: body.isolation.credentials, profile: body.isolation.profile,
                egress_proxy: body.isolation.egress_proxy, workspace: body.isolation.workspace,
            },
            { host_network: false, credentials: false, profile: false, egress_proxy: true, workspace: 'ephemeral' },
            'the report says what Live needs to register a sandbox worker');
        for (const c of calls) {
            assert.ok(!String(c.init.body).includes(CODES_SECRET), 'the Codes secret never travels');
            assert.ok(!String(c.init.body).includes(tmp), 'no path of the host');
            assert.ok(!/svc-token/.test(String(c.init.body)), 'no token in a body');
        }
    });

    await check('no service token, no Live check-in; no Codes secret, no heartbeat', async () => {
        const w = make({ tokens: null, config: { ...config, codes: { url: 'http://codes.test', secret: '' } } });
        await w.selfTest();
        calls.length = 0;
        await w.announce();
        assert.deepStrictEqual(calls, []);
    });

    await check('a session\'s time box is the owner\'s 5 to 30 minutes, and no room means no new sandbox', async () => {
        const w = make();
        await w.selfTest();
        fakeSandboxes.length = 0;
        const a = await w.openSession({ time_box_minutes: 90 });
        const b = await w.openSession({ time_box_minutes: 1 });
        assert.strictEqual(fakeSandboxes[0].opts.timeBoxMs, 30 * 60_000);
        assert.strictEqual(fakeSandboxes[1].opts.timeBoxMs, 5 * 60_000);
        await assert.rejects(() => w.openSession({}), /no room/);
        await assert.rejects(() => w.openSession({ stream_id: '../x' }), /no room|bad stream/);
        await a.sbx.wipe('end');
        await w.openSession({});
        await b.sbx.wipe('end');
    });

    await check('the local API: a Unix socket only the worker\'s user and group may use; health, sessions, Wipe now', async () => {
        const w = make();
        fs.mkdirSync(path.join(tmp, 's-stale0001', 'net'), { recursive: true });
        await w.start();
        try {
            assert.ok(!fs.existsSync(path.join(tmp, 's-stale0001')), 'a crashed worker\'s leftover sandbox directory is swept at start');
            assert.strictEqual(fs.statSync(config.socket).mode & 0o777, 0o660);
            const req = (method, p, body) => new Promise((resolve, reject) => {
                const r = http.request({ socketPath: config.socket, method, path: p, headers: { 'content-type': 'application/json' } }, (res) => {
                    let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, json: t ? JSON.parse(t) : null }));
                });
                r.on('error', reject);
                r.end(body ? JSON.stringify(body) : undefined);
            });
            const h = await req('GET', '/health');
            assert.strictEqual(h.json.ready, true);
            const s = await req('POST', '/sessions', { stream_id: 'ags_x', time_box_minutes: 10 });
            assert.strictEqual(s.status, 201);
            const e = await req('POST', `/sessions/${s.json.id}/exec`, { argv: ['echo', 'hi'] });
            assert.strictEqual(e.json.stdout, 'echo hi');
            const wiped = await req('POST', `/sessions/${s.json.id}/wipe`);
            assert.strictEqual(wiped.json.reason, 'wipe_now');
            assert.strictEqual(wiped.json.state, 'wiped');
            assert.strictEqual((await req('GET', '/sessions/zzzzzzzzzz')).status, 404);
            assert.strictEqual((await req('GET', '/sessions/../../etc')).status, 404);
        } finally { await w.stop(); }
        assert.ok(!fs.existsSync(config.socket), 'the socket is removed when the worker stops');
    });

    await check('the command line: --check prints the health and fails when the worker would not be ready (no limits here)', async () => {
        const run = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'openvibe-sandbox-worker.js'), '--check'], {
            env: { PATH: process.env.PATH, CODES_SANDBOX_RUNTIME_DIR: path.join(tmp, 'check'), CODES_SANDBOX_LIMITS: 'none', CODES_SANDBOX_WORKER_SECRET: 'not-printed-0123456789' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        run.stdout.on('data', (d) => { out += d; });
        run.stderr.on('data', () => {});
        const code = await new Promise((r) => run.on('exit', r));
        assert.strictEqual(code, 1, 'not ready without limits');
        const h = JSON.parse(out);
        assert.strictEqual(h.ready, false);
        assert.ok(h.reasons.some((r) => /limits/.test(r)), h.reasons.join('; '));
        assert.ok(!out.includes('not-printed-0123456789'), 'the secret is not printed');
    });

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
