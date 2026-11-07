'use strict';
/**
 * The chat plays sandbox, from the inside (Agent Streams S6, design 2026-11-06 §1, §5 and §9). A viewer's request
 * is untrusted text, so every attempt below is made FROM INSIDE a real sandbox (bubblewrap, sandbox/session.js) by a
 * probe running as the agent would, and each one must be refused:
 *
 *   - the host network: no interface but the sandbox's own loopback; no TCP or UDP to 127.0.0.1 (the host's), the
 *     host's addresses, 10/8, 192.168/16, 172.16/12, 169.254.169.254 or even a public address, directly;
 *   - through the egress proxy (the only way out): the same addresses in every spelling, a name that resolves to
 *     one, a name with one private answer among public ones, an http redirect to one, SMTP (25, 587, 465) and any
 *     port but 80 and 443; the public web still works (the positive control, so no refusal here is vacuous);
 *   - the host's secrets: its environment, ~/.ssh, the worker's token (file and env), any /proc of the host, an
 *     abstract socket, an inherited file descriptor; and the sandbox holds no capability and cannot write outside
 *     its own workspace;
 *   - Wipe now: every process of the sandbox is gone, the session's directory, proxy and cgroup are gone, and the
 *     next sandbox starts with an empty workspace; the time box wipes on its own.
 *
 * It needs bubblewrap and unprivileged user namespaces. Where they are missing (a CI runner without bubblewrap, or
 * with kernel.apparmor_restrict_unprivileged_userns=1) it prints `sandbox escape: skipped (<why>)`; run it where they
 * are (the worker's host, or a workstation) to prove it: `ov test test/sandbox-escape.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startWorld, shortRuntimeDir, processTree, alive, probe, ORIGIN_IP, SELF_IP } = require('./helpers/sandbox-world');

let failures = 0;
async function check(name, fn) {
    const t0 = Date.now();
    try { await fn(); console.log('  ✓', name, process.env.VERBOSE_TIMES ? `(${Date.now() - t0} ms)` : ''); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}

const refusedByProxy = (r) => r && r.result && r.result.status === 403 && /refused/.test(String(r.result.headers && r.result.headers['x-ov-egress']));
const describe = (r) => JSON.stringify(r.result).slice(0, 300);

(async () => {
    const { probeSupport, createSandbox } = require('../sandbox/session');
    const support = await probeSupport();
    if (!support.ok) {
        console.log(`sandbox escape: skipped (${support.reason})`);
        process.exit(0);
    }
    console.log(`sandbox escape (bubblewrap ${support.version}, seccomp ${support.seccomp ? 'on' : 'off'})`);
    const world = await startWorld();
    const runtimeDir = shortRuntimeDir();
    const egressLog = [];
    const open = (extra = {}) => createSandbox({
        runtimeDir, egress: world.egress, allowUnlimited: true, limiter: null,
        limits: { memoryMb: 512, diskMb: 64, pids: 128, cpuPercent: 100 }, timeBoxMs: 5 * 60_000,
        onEgress: (d) => egressLog.push(d), ...extra,
    });
    const sbx = await open();
    const hostHome = os.homedir();

    await check('the sandbox has no network but its own loopback', async () => {
        const [r] = await probe(sbx, [{ kind: 'interfaces' }]);
        assert.deepStrictEqual(r.result.dev, ['lo'], `interfaces: ${describe(r)}`);
    });

    await check('no direct TCP or UDP reaches the host, the private ranges, the metadata address or even the public web', async () => {
        const targets = [
            ['127.0.0.1', world.canaryPort], ...world.hostLan.map((ip) => [ip, world.canaryPort]),
            ['10.0.0.1', 80], ['192.168.1.1', 80], ['172.16.0.1', 80], ['172.17.0.1', 80], ['169.254.169.254', 80],
            ['100.64.0.1', 80], [ORIGIN_IP, 80], [ORIGIN_IP, 443], ['1.1.1.1', 25], ['8.8.8.8', 587], ['::1', world.canaryPort],
        ];
        const plan = targets.map(([host, port]) => ({ kind: 'tcp', host, port }))
            .concat([{ kind: 'udp', host: '8.8.8.8', port: 53 }, { kind: 'udp', host: '169.254.169.254', port: 53 }]);
        for (const r of await probe(sbx, plan)) {
            assert.ok(!r.result.connected && !r.result.sent, `${r.kind} ${r.host}:${r.port} must fail: ${describe(r)}`);
            if (r.host === '127.0.0.1' || r.host === '::1') assert.strictEqual(r.result.error, 'ECONNREFUSED', 'the loopback is the sandbox\'s own: nothing listens there');
            else assert.ok(['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(r.result.error), `${r.host} has no route: ${describe(r)}`);
        }
        assert.strictEqual(world.hits.canary, 0, 'the host\'s canary server was never reached');
    });

    await check('the proxy refuses 127.0.0.1, the host\'s own addresses and every private range, in every spelling', async () => {
        const urls = [
            `http://127.0.0.1:${world.canaryPort}/`, `http://127.0.0.1/`, `http://localhost:${world.canaryPort}/`, 'http://2130706433/',
            'http://0x7f000001/', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/',
            ...world.hostLan.map((ip) => `http://${ip}:${world.canaryPort}/`), `http://${SELF_IP}/`, 'http://self.example/',
            'http://10.0.0.1/', 'http://10.255.255.254/', 'http://192.168.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/',
            'http://172.31.255.254/', 'http://172.17.0.1/', 'http://169.254.169.254/latest/meta-data/iam/', 'http://100.64.0.1/',
            'http://[fd00::1]/', 'http://[fe80::1]/', 'http://metadata.google.internal/', 'http://printer.local/',
        ];
        const results = await probe(sbx, urls.map((url) => ({ kind: 'http', url })));
        for (const r of results) assert.ok(refusedByProxy(r), `${r.url} must be refused by the egress proxy: ${describe(r)}`);
        assert.strictEqual(world.hits.canary, 0, 'the host\'s canary server was never reached');
    });

    await check('a name that resolves to a private address is refused after resolution (and one private answer is enough)', async () => {
        const names = ['private.example', 'lan.example', 'docker.example', 'meta.example', 'loop.example', 'cgnat.example', 'mixed.example', 'v6loop.example', 'v6mapped.example'];
        const plan = names.flatMap((n) => [{ kind: 'http', url: `http://${n}/` }, { kind: 'connect', authority: `${n}:443` }]);
        for (const r of await probe(sbx, plan)) {
            if (r.kind === 'http') assert.ok(refusedByProxy(r), `${r.url}: ${describe(r)}`);
            else assert.strictEqual(r.result.status, 403, `CONNECT ${r.authority}: ${describe(r)}`);
        }
    });

    await check('an http redirect to a private address is refused at the hop that follows it', async () => {
        const to = [`http://127.0.0.1:${world.canaryPort}/`, 'http://169.254.169.254/latest/meta-data/', 'http://private.example/', 'http://10.0.0.1:8080/'];
        const plan = to.map((t) => ({ kind: 'http', url: `http://origin.example/redirect?to=${encodeURIComponent(t)}`, follow: true }));
        for (const r of await probe(sbx, plan)) {
            const hops = r.result.hops || [];
            assert.strictEqual(hops[0] && hops[0].status, 302, `the public origin answered its redirect: ${describe(r)}`);
            assert.strictEqual(hops.length, 2, `the redirect was followed once: ${describe(r)}`);
            assert.ok(refusedByProxy(r), `the second hop is refused: ${describe(r)}`);
        }
        assert.strictEqual(world.hits.canary, 0);
    });

    await check('SMTP (25, 587, 465) and every port but 80 and 443 are refused, with CONNECT and without', async () => {
        const ports = [25, 587, 465, 22, 21, 53, 3306, 5432, 6379, 8080, 9222, 11211];
        const plan = ports.flatMap((p) => [{ kind: 'connect', authority: `origin.example:${p}` }, { kind: 'http', url: `http://origin.example:${p}/` }])
            .concat([{ kind: 'connect', authority: 'smtp.example:25' }, { kind: 'raw', request: 'EHLO sandbox\r\n\r\n' }]);
        for (const r of await probe(sbx, plan)) {
            if (r.kind === 'raw') assert.ok(r.result.status === 400 || r.result.status === null, `a non-HTTP greeting gets nothing: ${describe(r)}`);
            else assert.strictEqual(r.result.status, 403, `${r.authority || r.url}: ${describe(r)}`);
        }
    });

    await check('only http and https: no other scheme passes the proxy', async () => {
        const plan = ['ftp://origin.example/', 'gopher://origin.example/', 'file:///etc/passwd', 'ws://origin.example/'].map((u) => ({ kind: 'raw', request: `GET ${u} HTTP/1.1\r\nHost: origin.example\r\nConnection: close\r\n\r\n` }));
        for (const r of await probe(sbx, plan)) assert.ok(r.result.status === 403 || r.result.status === 400, `${r.request.split(' ')[1]}: ${describe(r)}`);
    });

    await check('the positive control: the public web answers through the proxy, http and an https tunnel', async () => {
        const [a, b] = await probe(sbx, [{ kind: 'http', url: 'http://origin.example/' }, { kind: 'connect', authority: 'origin.example:443', payload: 'ping' }]);
        assert.strictEqual(a.result.status, 200, describe(a));
        assert.strictEqual(a.result.body, 'origin-ok');
        assert.strictEqual(b.result.status, 200, describe(b));
        assert.strictEqual(b.result.reply, 'pong', 'the tunnel carries bytes both ways');
        assert.deepStrictEqual(world.hits.unexpectedDials, [], 'the proxy never opened a socket to a refused address');
        assert.ok(egressLog.some((d) => d.allowed === false && d.code === 'egress.private_address'), 'refusals are reported to the worker');
    });

    await check('the environment holds nothing of the host: no variable of it, no token, no canary', async () => {
        const [r] = await probe(sbx, [{ kind: 'env' }]);
        const env = r.result.env;
        const allowed = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_ALL|TERM|TMPDIR|PWD|SHLVL|_|OLDPWD|http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY|no_proxy|NO_PROXY|npm_config_cache|OV_SANDBOX(_[A-Z_]+)?)$/;
        for (const k of Object.keys(env)) assert.ok(allowed.test(k), `${k} is not a variable the sandbox gives: the host's environment leaked`);
        assert.ok(!JSON.stringify(env).includes(world.canary), 'no canary in the environment');
        assert.strictEqual(env.HOME, '/home/agent');
    });

    await check('no host file is there: ~/.ssh, the home folder, the worker\'s token, /root, the runtime directory, D-Bus, Docker', async () => {
        const paths = [path.join(hostHome, '.ssh'), path.join(hostHome, '.ssh/id_ed25519'), path.join(hostHome, '.ssh/id_rsa'), hostHome,
            world.tokenFile, world.secretDir, '/root/.ssh', '/root', runtimeDir, sbx.dir, '/run/user', '/run/dbus/system_bus_socket',
            '/var/run/docker.sock', '/run/docker.sock', '/etc/openvibe', '/etc/shadow', '/etc/ssh', '/etc/ssl/private', '/opt/openvibe.codes',
            '/var/lib', '/sys/fs/cgroup', '/usr/local/bin'];
        const [r, home] = await probe(sbx, [{ kind: 'exists', paths }, { kind: 'readdir', path: '/home' }]);
        assert.deepStrictEqual(r.result.exists, [], `these host paths are visible inside: ${r.result.exists.join(', ')}`);
        assert.deepStrictEqual(home.result.entries, ['agent'], 'only the agent\'s own empty home is under /home');
    });

    await check('the worker\'s token and the host\'s canaries are nowhere inside: files, /proc, the user list', async () => {
        const needles = [world.canary, path.basename(world.secretDir)];
        const [g, pw] = await probe(sbx, [{ kind: 'grep', needles, roots: ['/workspace', '/home', '/tmp', '/run', '/etc', '/opt/ov', '/dev/shm'] }, { kind: 'read', path: '/etc/passwd' }]);
        assert.deepStrictEqual(g.result.found, [], `a canary was found inside: ${g.result.found.join(', ')}`);
        const users = pw.result.text.trim().split('\n').map((l) => l.split(':')[0]).sort();
        assert.deepStrictEqual(users, ['agent', 'nobody'], 'the user list is the sandbox\'s own, not the host\'s');
        assert.ok(!pw.result.text.includes(os.userInfo().username + ':'), 'the host user is not named');
    });

    await check('no host process, socket or file descriptor reaches in: an abstract socket and every open fd', async () => {
        const [a, f] = await probe(sbx, [{ kind: 'abstract', name: world.abstractName }, { kind: 'fds' }]);
        assert.strictEqual(a.result.error, 'ECONNREFUSED', `the host's abstract socket is unreachable: ${describe(a)}`);
        assert.strictEqual(world.hits.abstract, 0);
        const leaked = f.result.links.filter((l) => l.startsWith(hostHome) || l.includes(world.secretDir) || l.startsWith(runtimeDir) || l.includes('worker-secret'));
        assert.deepStrictEqual(leaked, [], 'no fd of the host is open inside');
    });

    await check('no capability, no new privileges, the seccomp filter, and nothing writable outside the sandbox\'s own areas', async () => {
        const plan = [{ kind: 'status' }, ...['/usr/x', '/etc/x', '/opt/ov/x', '/run/ov/net/x', '/x', '/proc/sys/kernel/hostname'].map((p) => ({ kind: 'write', path: p })),
            ...['/workspace/ok', '/home/agent/ok', '/tmp/ok'].map((p) => ({ kind: 'write', path: p }))];
        const [s, ...writes] = await probe(sbx, plan);
        const status = Object.fromEntries(s.result.status.map((l) => l.split(':\t')));
        for (const c of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.strictEqual(status[c], '0000000000000000', `${c} is empty`);
        assert.strictEqual(status.NoNewPrivs, '1');
        if (support.seccomp) assert.strictEqual(status.Seccomp, '2', 'the seccomp filter is on');
        for (const w of writes) {
            const mine = /^\/(workspace|home\/agent|tmp)\//.test(w.path);
            if (mine) assert.strictEqual(w.result.wrote, true, `${w.path} is the sandbox's own`);
            else assert.ok(w.result.error, `${w.path} must not be writable: ${describe(w)}`);
        }
    });

    await check('no nested namespace and no kernel keyring: unshare and keyctl are refused', async () => {
        const r = await sbx.exec(['sh', '-c', 'unshare -U true 2>/dev/null && echo unshared || echo refused'], { timeoutMs: 10_000 });
        assert.strictEqual(String(r.stdout).trim(), 'refused', 'a nested user namespace is refused');
        // The kernel keyring holds a login's keys; keyctl(KEYCTL_GET_KEYRING_ID, KEY_SPEC_SESSION_KEYRING) asks for it.
        const nr = { x64: 250, arm64: 219 }[process.arch];
        const py = await sbx.exec(['sh', '-c', 'command -v python3 || true'], { timeoutMs: 10_000 });
        if (support.seccomp && nr && String(py.stdout).trim()) {
            const k = await sbx.exec(['python3', '-c', `import ctypes,os;l=ctypes.CDLL(None,use_errno=True);r=l.syscall(${nr},0,-3,0);print(r, os.strerror(ctypes.get_errno()) if r<0 else "")`], { timeoutMs: 10_000 });
            assert.match(String(k.stdout).trim(), /^-1 Operation not permitted$/, `keyctl is refused by the seccomp filter: ${k.stdout}${k.stderr}`);
        } else {
            console.log('     (keyctl: no python3 inside or no seccomp filter; the keyring check needs both)');
        }
    });

    await check('Wipe now: every process, the workspace, the directory, the proxy socket and the cgroup are gone', async () => {
        const w = await open();
        await w.writeFile('/workspace/left-behind.txt', `${world.canary}`);
        await w.exec(['sh', '-c', 'setsid sleep 300 >/dev/null 2>&1 & nohup sleep 301 >/dev/null 2>&1 & echo started'], { timeoutMs: 10_000 });
        const tree = processTree(w.pid);
        assert.ok(tree.length >= 4, `the sandbox has its processes on the host: ${tree.join(',')}`);
        const dir = w.dir;
        const cg = w.cgroup;
        assert.ok(fs.existsSync(path.join(dir, 'net', 'egress.sock')), 'the proxy socket is there while the sandbox runs');
        assert.ok(w._pidns, 'the worker knows the sandbox\'s pid namespace, so it can prove it empty');
        const out = await w.wipe('wipe_now');
        assert.deepStrictEqual(out, { reason: 'wipe_now' }, 'no process outlived the wipe');
        assert.strictEqual(w.state, 'wiped');
        for (const pid of tree) assert.ok(!alive(pid), `pid ${pid} of the sandbox is gone`);
        assert.ok(!fs.existsSync(dir), 'the session directory is gone');
        if (cg) assert.ok(!fs.existsSync(cg), 'the cgroup is gone');
        await assert.rejects(() => w.exec(['true']), /wiped|ended/, 'nothing runs in a wiped sandbox');
        const next = await open();
        const ls = await next.exec(['sh', '-c', 'ls -A /workspace /home/agent /tmp'], { timeoutMs: 10_000 });
        assert.strictEqual(String(ls.stdout).replace(/^\/[^\n]*:\n?/gm, '').trim(), '', `a fresh sandbox is empty: ${ls.stdout}`);
        await next.wipe('end');
    });

    await check('the time box wipes the sandbox on its own', async () => {
        const t = await open({ timeBoxMs: 1500 });
        const tree = processTree(t.pid);
        const ended = await Promise.race([t.ended, new Promise((r) => setTimeout(() => r({ reason: 'still running' }), 6000))]);
        assert.strictEqual(ended.reason, 'time_box');
        for (const pid of tree) assert.ok(!alive(pid), `pid ${pid} is gone`);
        assert.ok(!fs.existsSync(t.dir));
    });

    await sbx.wipe('end');
    await world.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
