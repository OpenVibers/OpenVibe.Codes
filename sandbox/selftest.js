'use strict';
/**
 * The sandbox worker's self-test: before it says it is healthy, and every few minutes after, the worker makes a real
 * sandbox and tries from inside what the escape tests try (test/sandbox-escape.test.js, in short). What it finds is
 * what it reports to Codes and Live as its isolation; it is healthy only when every check passed.
 *
 *   network_namespace       the only interface is the sandbox's own loopback
 *   no_direct_egress        a TCP connection to a public address fails (no route): nothing leaves but by the proxy
 *   egress_refuses_private  through the proxy, the host's 127.0.0.1 and the cloud metadata address are refused (403)
 *   clean_env               the environment is the sandbox's own allowlist, nothing of the worker's
 *   no_host_files           the worker's home, its credentials, its runtime directory and /etc/openvibe are not there
 *   no_capabilities         no capability, no_new_privs set
 *   seccomp                 the filter is on (where the architecture has one)
 *   limits                  the sandbox's cgroup has the memory, pids and cpu limits the worker set
 *   wipe                    after the wipe, no process of it is left and its directory and cgroup are gone
 *
 * No check needs the internet: the refusals are the proxy's own, before any connection.
 *
 *   runSelfTest({ createSandbox, limiter, runtimeDir, nodePath, hidden, egress, log }) → { ok, checks, failed, at, isolation }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_ALLOWED = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_ALL|TERM|TMPDIR|PWD|SHLVL|_|http_proxy|https_proxy|HTTP_PROXY|HTTPS_PROXY|no_proxy|NO_PROXY|npm_config_cache|OV_SANDBOX(_[A-Z_]+)?)$/;
const CHECKS = ['network_namespace', 'no_direct_egress', 'egress_refuses_private', 'clean_env', 'no_host_files', 'no_capabilities', 'seccomp', 'limits', 'wipe'];

const PROBE = String.raw`'use strict';
const net = require('net'); const fs = require('fs');
const hidden = JSON.parse(process.argv[2] || '[]');
const PROXY = Number(process.env.OV_SANDBOX_PROXY_PORT || 3128);
const tcp = (host, port) => new Promise((r) => { const s = net.connect({ host, port }); const t = setTimeout(() => { s.destroy(); r('TIMEOUT'); }, 3000); s.on('connect', () => { clearTimeout(t); s.destroy(); r('CONNECTED'); }); s.on('error', (e) => { clearTimeout(t); r(e.code); }); });
const viaProxy = (url) => new Promise((r) => { const s = net.connect(PROXY, '127.0.0.1'); let b = ''; const t = setTimeout(() => { s.destroy(); r(b); }, 4000); s.on('connect', () => s.write('GET ' + url + ' HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')); s.on('data', (d) => { b += d; }); s.on('close', () => { clearTimeout(t); r(b); }); s.on('error', () => {}); });
(async () => {
  const dev = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);
  const status = Object.fromEntries(fs.readFileSync('/proc/self/status', 'utf8').split('\n').map((l) => l.split(':\t')).filter((x) => x.length === 2));
  const out = {
    dev, direct: await tcp('1.1.1.1', 443),
    loop: (await viaProxy('http://127.0.0.1:9/')).split('\r\n').slice(0, 2).join('|'),
    meta: (await viaProxy('http://169.254.169.254/latest/meta-data/')).split('\r\n').slice(0, 2).join('|'),
    env: Object.keys(process.env), visible: hidden.filter((p) => { try { fs.lstatSync(p); return true; } catch { return false; } }),
    caps: ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((c) => status[c]), nnp: status.NoNewPrivs, seccomp: status.Seccomp,
  };
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
})();
`;

const refused = (head) => /^HTTP\/1\.1 403 /.test(head) && /X-OV-Egress: refused/i.test(head);

async function runSelfTest({ createSandbox, limiter, runtimeDir, nodePath, hidden = [], egress = {}, seccompExpected = true, log = console }) {
    const checks = Object.fromEntries(CHECKS.map((c) => [c, false]));
    const at = new Date().toISOString();
    let sbx = null;
    let error = null;
    try {
        sbx = await createSandbox({
            runtimeDir, limiter: limiter && limiter.ok ? limiter : null, allowUnlimited: !(limiter && limiter.ok), egress, nodePath,
            limits: { memoryMb: 256, diskMb: 16, pids: 64, cpuPercent: 50 }, timeBoxMs: 60_000, id: `selftest-${Date.now().toString(36)}`, log,
        });
        const paths = [...new Set([os.homedir(), path.join(os.homedir(), '.ssh'), runtimeDir, sbx.dir, '/etc/openvibe', '/root', ...hidden].filter(Boolean))];
        await sbx.writeFile('/workspace/.selftest.js', PROBE);
        const r = await sbx.exec(['node', '/workspace/.selftest.js', JSON.stringify(paths)], { timeoutMs: 30_000 });
        if (r.code !== 0) throw new Error(`the probe failed (${r.code}/${r.signal}): ${r.stderr.slice(0, 200)}`);
        const p = JSON.parse(r.stdout);
        checks.network_namespace = Array.isArray(p.dev) && p.dev.length === 1 && p.dev[0] === 'lo';
        checks.no_direct_egress = ['ENETUNREACH', 'EHOSTUNREACH'].includes(p.direct);
        checks.egress_refuses_private = refused(String(p.loop).replace('|', '\r\n')) && refused(String(p.meta).replace('|', '\r\n'));
        checks.clean_env = Array.isArray(p.env) && p.env.every((k) => ENV_ALLOWED.test(k));
        checks.no_host_files = Array.isArray(p.visible) && p.visible.length === 0;
        checks.no_capabilities = p.caps.every((c) => c === '0000000000000000') && p.nnp === '1';
        checks.seccomp = seccompExpected ? p.seccomp === '2' : true;
        if (limiter && limiter.ok && sbx.cgroup) {
            const read = (f) => fs.readFileSync(path.join(sbx.cgroup, f), 'utf8').trim();
            checks.limits = Number(read('pids.max')) === 64 && Number(read('memory.max')) > 0 && /^\d+ \d+$/.test(read('cpu.max'));
        }
    } catch (err) {
        error = String(err.message).slice(0, 300);
        log.error('[sandbox] self-test:', error);
    }
    if (sbx) {
        const dir = sbx.dir;
        const cg = sbx.cgroup;
        const out = await sbx.wipe('selftest');
        checks.wipe = !out.leftover && !fs.existsSync(dir) && (!cg || !fs.existsSync(cg)) && sbx.state === 'wiped';
    }
    const failed = CHECKS.filter((c) => !checks[c]);
    return { ok: failed.length === 0, checks, failed, at, ...(error ? { error } : {}) };
}

module.exports = { runSelfTest, CHECKS, ENV_ALLOWED };
