'use strict';
/**
 * The agent's tools in the chat plays sandbox (Agent Streams S6, design 2026-11-06 §1): a terminal, an editor and a
 * browser, all inside the sandbox (sandbox/session.js, sandbox/supervisor.js).
 *
 *   - the terminal runs as the sandbox's own user in /workspace, takes input, and can have a terminal device;
 *   - the editor reads, writes and lists files in the workspace only (a path outside it is refused);
 *   - the browser (headless Chromium, started inside) reaches the public web through the egress proxy, and a page
 *     that points at the host or a private address gets nothing from it.
 *
 * It needs bubblewrap (and, for the browser, a headless Chromium: CODES_SANDBOX_BROWSER, or Playwright's
 * chrome-headless-shell). Without them it prints `sandbox tools: skipped (<why>)`.
 */
const assert = require('assert');
const fs = require('fs');
const { startWorld, shortRuntimeDir } = require('./helpers/sandbox-world');

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); } catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}

(async () => {
    const { probeSupport, createSandbox } = require('../sandbox/session');
    const { findBrowser } = require('../sandbox/browser');
    const support = await probeSupport();
    if (!support.ok) { console.log(`sandbox tools: skipped (${support.reason})`); process.exit(0); }
    const browserPath = findBrowser();
    console.log(`sandbox tools (browser: ${browserPath || 'none'})`);

    const world = await startWorld();
    const runtimeDir = shortRuntimeDir();
    const sbx = await createSandbox({
        runtimeDir, egress: world.egress, allowUnlimited: true, limiter: null, browserPath,
        limits: { memoryMb: 1024, diskMb: 128, pids: 256, cpuPercent: 100 }, timeBoxMs: 5 * 60_000,
    });

    await check('the terminal: the sandbox\'s own user, in /workspace, with input', async () => {
        const who = await sbx.exec(['sh', '-c', 'id -un; id -u; pwd; uname -n'], { timeoutMs: 10_000 });
        assert.deepStrictEqual(String(who.stdout).trim().split('\n'), ['agent', '1000', '/workspace', 'sandbox']);
        const shell = await sbx.exec(['sh', '-s'], { stdin: 'mkdir -p snake && cd snake && echo "<canvas></canvas>" > index.html && ls\n', timeoutMs: 10_000 });
        assert.strictEqual(String(shell.stdout).trim(), 'index.html');
        const failed = await sbx.exec(['sh', '-c', 'echo oops >&2; exit 3'], { timeoutMs: 10_000 });
        assert.strictEqual(failed.code, 3);
        assert.strictEqual(String(failed.stderr).trim(), 'oops');
    });

    await check('the terminal can have a terminal device, and a command that runs too long is stopped', async () => {
        const tty = await sbx.exec(['tty'], { tty: true, timeoutMs: 10_000 });
        assert.match(String(tty.stdout), /\/dev\/pts\/\d+/, `a pty: ${tty.stdout}${tty.stderr}`);
        const slow = await sbx.exec(['sleep', '30'], { timeoutMs: 500 });
        assert.strictEqual(slow.signal, 'SIGKILL');
        assert.strictEqual(slow.timedOut, true);
    });

    await check('the editor: read, write and list in the workspace; nothing outside it', async () => {
        await sbx.writeFile('/workspace/snake/index.html', '<canvas></canvas>\n');
        await sbx.writeFile('/workspace/snake/game.js', 'let score = 0;\n');
        assert.strictEqual(String(await sbx.readFile('/workspace/snake/game.js')), 'let score = 0;\n');
        assert.strictEqual(String(await sbx.readFile('snake/game.js')), 'let score = 0;\n', 'a relative path is in the workspace');
        const names = (await sbx.list('/workspace/snake')).map((e) => `${e.name}:${e.type}`).sort();
        assert.deepStrictEqual(names, ['game.js:file', 'index.html:file']);
        for (const p of ['/etc/passwd', '/workspace/../etc/passwd', '../etc/hosts', '/proc/self/environ', '/opt/ov/supervisor.js']) {
            await assert.rejects(() => sbx.readFile(p), /outside the workspace/, `${p} is refused`);
        }
        await assert.rejects(() => sbx.writeFile('/workspace/../tmp/x', 'x'), /outside the workspace/);
        const editors = await sbx.exec(['sh', '-c', 'for e in vim vi nano; do command -v $e; done'], { timeoutMs: 10_000 });
        assert.ok(String(editors.stdout).trim(), 'a terminal editor is there too');
    });

    await check('the browser opens the public web through the proxy, and nothing of the host', async () => {
        if (!browserPath) { console.log('sandbox tools: skipped (no headless Chromium: set CODES_SANDBOX_BROWSER or install Playwright\'s chrome-headless-shell)'); return; }
        const page = await sbx.openPage('http://origin.example/page');
        assert.strictEqual(page.ok, true, JSON.stringify(page).slice(0, 300));
        assert.strictEqual(page.title, 'Origin page');
        assert.match(page.text, /origin-ok/);
        assert.ok(page.screenshot && page.screenshot.length > 100, 'a screenshot of the page');
        for (const url of [`http://127.0.0.1:${world.canaryPort}/`, `http://localhost:${world.canaryPort}/`, 'http://169.254.169.254/latest/meta-data/', 'http://private.example/',
            ...world.hostLan.map((ip) => `http://${ip}:${world.canaryPort}/`), `https://origin.example:${world.canaryPort}/`]) {
            const r = await sbx.openPage(url);
            assert.ok(!String(r.text || '').includes(world.canary), `${url} showed the host's canary`);
        }
        assert.strictEqual(world.hits.canary, 0, 'the host\'s canary server was never reached by the browser');
        assert.deepStrictEqual(world.hits.unexpectedDials, []);
    });

    await sbx.wipe('end');
    await world.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : '\nall passed');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
