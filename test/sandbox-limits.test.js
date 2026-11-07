'use strict';
/**
 * The chat plays sandbox's limits (Agent Streams S6, design 2026-11-06 §1, §3): a request cannot take the worker's
 * host down with it. Each sandbox runs in a cgroup of its own (sandbox/limits.js): a delegated cgroup v2 subtree
 * under the worker's systemd unit (Delegate=yes), or a transient scope of the user's systemd on a workstation.
 *
 *   - process count: pids.max holds a fork bomb;
 *   - memory: memory.max (no swap) kills the process that asks for too much, and the sandbox goes on;
 *   - disk: the workspace, the home folder and /tmp are size-limited tmpfs: a big write ends in ENOSPC;
 *   - CPU: cpu.max is the quota the worker set;
 *   - and the cgroup is removed with the sandbox.
 *
 * It needs bubblewrap and a cgroup the worker may create children in. Without them it prints
 * `sandbox limits: skipped (<why>)`. Locally: `ov test test/sandbox-limits.test.js` (a user systemd is enough), or
 * the production way, `systemd-run --user --scope -p Delegate=yes -E CODES_SANDBOX_LIMITS=cgroup node test/sandbox-limits.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { startWorld, shortRuntimeDir } = require('./helpers/sandbox-world');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}

(async () => {
    const { probeSupport, createSandbox } = require('../sandbox/session');
    const { detectLimits } = require('../sandbox/limits');
    const support = await probeSupport();
    if (!support.ok) { console.log(`sandbox limits: skipped (${support.reason})`); process.exit(0); }
    const limiter = await detectLimits({ mode: process.env.CODES_SANDBOX_LIMITS || 'auto' });
    if (!limiter.ok) { console.log(`sandbox limits: skipped (no cgroup to put a sandbox in: ${limiter.reason})`); process.exit(0); }
    console.log(`sandbox limits (${limiter.kind})`);

    const world = await startWorld();
    const runtimeDir = shortRuntimeDir();
    const limits = { memoryMb: 160, diskMb: 32, pids: 64, cpuPercent: 50 };
    const sbx = await createSandbox({ runtimeDir, egress: world.egress, limiter, limits, timeBoxMs: 5 * 60_000 });
    const read = (f) => fs.readFileSync(path.join(sbx.cgroup, f), 'utf8').trim();
    const readMaybe = (f) => { try { return read(f); } catch { return ''; } };

    await check('the sandbox runs in a cgroup of its own with the limits the worker set', async () => {
        assert.ok(sbx.cgroup && fs.existsSync(sbx.cgroup), `the cgroup is there: ${sbx.cgroup}`);
        const procs = read('cgroup.procs').split('\n').map(Number);
        assert.ok(procs.includes(sbx.pid), 'the sandbox\'s first process is in it');
        // The tmpfs areas are charged to the sandbox's memory too, so memory.max is memory + disk.
        assert.strictEqual(Number(read('memory.max')), (limits.memoryMb + 3 * limits.diskMb) * 1024 * 1024);
        assert.strictEqual(read('memory.swap.max'), '0');
        assert.strictEqual(Number(read('pids.max')), limits.pids);
        const [quota, period] = read('cpu.max').split(' ').map(Number);
        assert.strictEqual(Math.round((quota / period) * 100), limits.cpuPercent, `cpu.max: ${read('cpu.max')}`);
    });

    await check('a fork bomb stops at pids.max', async () => {
        const r = await sbx.exec(['sh', '-c', 'i=0; while [ $i -lt 100 ]; do i=$((i+1)); sleep 3 & done; wait'], { timeoutMs: 30_000 });
        // The kernel's own count of refused forks, not the shell's (dash gives up at the first "Cannot fork").
        const refused = Number((/^max (\d+)/m.exec(readMaybe('pids.events')) || [])[1]);
        assert.ok(refused > 0, `the cgroup refused forks (pids.events: ${readMaybe('pids.events')})`);
        assert.match(String(r.stderr), /Cannot fork|Resource temporarily unavailable/, 'the sandbox saw the refusal');
        const peak = readMaybe('pids.peak');
        if (peak) assert.ok(Number(peak) <= limits.pids, `the cgroup never held more than ${limits.pids} (peak ${peak})`);
        // The sleeps that did start finish on their own; the next checks need the room back.
        const until = Date.now() + 10_000;
        while (Number(readMaybe('pids.current')) > 16 && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
        assert.ok(Number(readMaybe('pids.current')) <= 16, `the sandbox drained (${readMaybe('pids.current')})`);
    });

    await check('memory.max kills the process that asks for too much, and the sandbox goes on', async () => {
        const r = await sbx.exec(['node', '-e', 'const a=[];for(let i=0;i<80;i++){a.push(Buffer.alloc(8*1024*1024,1))}console.log("allocated")'], { timeoutMs: 30_000 });
        assert.ok(r.signal === 'SIGKILL' || r.code === 137, `the allocation was killed: ${r.code}/${r.signal} ${r.stdout}`);
        assert.ok(!String(r.stdout).includes('allocated'));
        const after = await sbx.exec(['sh', '-c', 'echo still-here'], { timeoutMs: 10_000 });
        assert.strictEqual(String(after.stdout).trim(), 'still-here', 'the sandbox survives its own out-of-memory');
    });

    await check('the disk is a size-limited tmpfs: the workspace, home and /tmp end in ENOSPC', async () => {
        for (const dir of ['/workspace', '/home/agent', '/tmp']) {
            const r = await sbx.exec(['sh', '-c', `head -c ${(limits.diskMb + 8) * 1024 * 1024} /dev/zero > ${dir}/big; echo $?; rm -f ${dir}/big`], { timeoutMs: 30_000 });
            assert.match(String(r.stderr), /No space left on device/, `${dir}: ${r.stderr}`);
        }
    });

    await check('the cgroup is removed with the sandbox', async () => {
        const cg = sbx.cgroup;
        await sbx.wipe('end');
        const gone = Date.now() + 5000;
        while (fs.existsSync(cg) && Date.now() < gone) await new Promise((r) => setTimeout(r, 100));
        assert.ok(!fs.existsSync(cg), `${cg} is gone`);
    });

    await world.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
