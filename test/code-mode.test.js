'use strict';
/**
 * Code mode for headless Claude Code (2026-11-18, harness/code-mode.js). Claude Code's own Code Mode needs an
 * interactive terminal, so a Codes job brings its own as an MCP server beside the agent: search and execute, a script in
 * openvibe-sdk/code-mode's sandbox whose only way out is the repository's tools, within the job's folder and permission.
 *
 * - The server speaks MCP over stdio: initialize (with instructions), tools/list, search, execute.
 * - execute runs one script that greps, reads and edits; only its return value and logs come back.
 * - Within the folder only: a path outside it, a .env file and (by permission) a write or a command are refused; the
 *   deny list holds (git push, sudo, rm -rf); the script itself has no files of its own.
 * - A job with code_mode on Claude Code gets the MCP config and mcp__ov_code; an older Node says why it is off.
 *   node test/code-mode.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const codeMode = require('../harness/code-mode');
const { parseArgs } = require('../harness/job');

const BIN = path.join(__dirname, '..', 'bin', 'openvibe-codes.js');
let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n${e && e.stack}`); } };

function repo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), "const greet = (n) => `hi ${n}`;\nmodule.exports = { greet };\n");
    fs.writeFileSync(path.join(dir, 'src', 'b.js'), "const { greet } = require('./a');\nconsole.log(greet('ada'));\n");
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=nope\n');
    return dir;
}

/** The server as Claude Code starts it: `openvibe-codes code-mode --root … --permission …`, JSON-RPC lines on stdio. */
function server(root, permission) {
    const child = spawn(process.execPath, [BIN, 'code-mode', '--root', root, '--permission', permission], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', next = 1;
    const waiting = new Map();
    child.stdout.on('data', (c) => {
        buf += c.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            const w = waiting.get(msg.id); if (w) { waiting.delete(msg.id); w(msg); }
        }
    });
    const rpc = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    const call = async (name, args) => {
        const r = await rpc('tools/call', { name, arguments: args });
        const text = r.result.content[0].text;
        let json = null; try { json = JSON.parse(text); } catch { json = null; }
        return { isError: !!r.result.isError, text, json };
    };
    return { rpc, call, close: () => child.kill() };
}

(async () => {
    const why = codeMode.ready();
    if (why) { console.log(`code-mode: skipped here (${why})`); return; }

    await check('MCP over stdio: initialize with instructions, two tools, search with types', async () => {
        const root = repo();
        const s = server(root, 'edit');
        try {
            const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
            assert.strictEqual(init.result.serverInfo.name, 'ov_code');
            assert.match(init.result.instructions, /one JavaScript script/);
            const list = await s.rpc('tools/list', {});
            assert.deepStrictEqual(list.result.tools.map((t) => t.name), ['search', 'execute']);
            const found = await s.call('search', { query: 'replace text in a file' });
            assert.match(found.text, /^edit\(input: \{/m);
            const all = await s.call('search', {});
            for (const n of ['read', 'grep', 'glob', 'ls', 'edit', 'write', 'sh']) assert.match(all.text, new RegExp(`^${n}\\(`, 'm'), n);
        } finally { s.close(); }
    });

    await check('execute: one script greps, reads, edits and runs a command; only its value comes back', async () => {
        const root = repo();
        const s = server(root, 'edit');
        try {
            await s.rpc('initialize', {});
            const r = await s.call('execute', { code: `
                const hits = await tools.grep({ pattern: '\\\\bgreet\\\\b' });
                const files = [...new Set(hits.matches.map((m) => m.file))];
                const read = await Promise.all(files.map((f) => tools.read({ path: f })));
                await tools.edit({ path: 'src/a.js', old: 'hi \${n}', new: 'hello \${n}' });
                const ran = await tools.sh({ cmd: 'node src/b.js' });
                console.log('files', files.length);
                return { files, lines: read.map((x) => x.lines), out: ran.stdout.trim() };
            ` });
            assert.strictEqual(r.isError, false, r.text);
            assert.deepStrictEqual(r.json.value.files.sort(), ['src/a.js', 'src/b.js']);
            assert.strictEqual(r.json.value.out, 'hello ada', 'the edit landed and the command saw it');
            assert.deepStrictEqual(r.json.logs, ['files 2']);
            assert.ok(r.json.calls >= 4);
            assert.match(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8'), /hello \$\{n\}/);
        } finally { s.close(); }
    });

    await check('within the folder: outside, .env, the deny list, and the sandbox has no files of its own', async () => {
        const root = repo();
        const s = server(root, 'edit');
        try {
            await s.rpc('initialize', {});
            const out = async (code) => (await s.call('execute', { code })).json;
            assert.match((await out("return await tools.read({ path: '../../etc/passwd' })")).error, /outside this job's folder/);
            assert.match((await out("return await tools.read({ path: '.env' })")).error, /\.env files are never read/);
            assert.ok(!JSON.stringify(await out("return await tools.ls({ path: '.' })")).includes('.env'), 'ls does not list it');
            assert.ok(!JSON.stringify(await out("return await tools.glob({ pattern: '**/*' })")).includes('.env'));
            assert.match((await out("return await tools.sh({ cmd: 'git push origin main' })")).error, /git push/);
            assert.match((await out("return await tools.sh({ cmd: 'sudo ls' })")).error, /sudo/);
            assert.match((await out("return await tools.sh({ cmd: 'rm -rf src' })")).error, /rm -rf/);
            assert.match((await out("return await tools.sh({ cmd: 'cat .env' })")).error, /\.env/);
            assert.ok(fs.existsSync(path.join(root, 'src', 'a.js')), 'nothing was removed');
            const own = await out("const fs = require('fs'); return fs.readFileSync('/etc/hostname', 'utf8')");
            assert.strictEqual(own.ok, false, 'the script cannot reach files itself');
        } finally { s.close(); }
    });

    await check('read permission: read, grep, glob and ls only; files: no commands', async () => {
        const root = repo();
        const r = codeMode.createRepoTools({ root, permission: 'read' });
        assert.deepStrictEqual(r.defs.map((d) => d.name), ['read', 'grep', 'glob', 'ls']);
        assert.match((await r.call('edit', { path: 'src/a.js', old: 'hi', new: 'yo' })).error, /no tool edit/);
        const f = codeMode.createRepoTools({ root, permission: 'files' });
        assert.ok(f.defs.some((d) => d.name === 'edit') && !f.defs.some((d) => d.name === 'sh'));
        assert.strictEqual((await f.call('edit', { path: 'src/a.js', old: 'greet', new: 'hey' })).ok, false, 'greet is there twice: say more, or all');
        assert.strictEqual((await f.call('edit', { path: 'src/a.js', old: 'greet', new: 'hey', all: true })).value.replaced, 2);
        const full = codeMode.createRepoTools({ root, permission: 'full' });
        assert.match((await full.call('sh', { cmd: 'git push' })).error, /git push/, 'full still never pushes');
        assert.strictEqual((await full.call('sh', { cmd: 'echo ok' })).value.stdout.trim(), 'ok');
    });

    await check('a job with code_mode: parsed, and Claude Code gets the MCP config and mcp__ov_code', async () => {
        const job = parseArgs(JSON.stringify({ repo: 'https://github.com/example/app', prompt: 'Rename greet to hello everywhere', code_mode: true }), {});
        assert.strictEqual(job.codeMode, true);
        assert.strictEqual(parseArgs(JSON.stringify({ repo: 'https://github.com/example/app', prompt: 'x' }), {}).codeMode, undefined, 'off unless asked');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-cfg-'));
        fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { codes: { command: 'node', args: ['x'] } } }));
        const cm = codeMode.mcpOptions({ file: path.join(dir, 'mcp-code.json'), root: dir, permission: 'files', existing: path.join(dir, 'mcp.json') });
        const cfg = JSON.parse(fs.readFileSync(cm.mcpConfig, 'utf8'));
        assert.deepStrictEqual(Object.keys(cfg.mcpServers).sort(), ['codes', 'ov_code'], 'the conductor\'s Codes tools stay');
        assert.deepStrictEqual(cfg.mcpServers.ov_code.args.slice(1), ['code-mode', '--root', dir, '--permission', 'files']);
        assert.strictEqual(cm.tool, 'mcp__ov_code');
        assert.strictEqual(fs.statSync(cm.mcpConfig).mode & 0o777, 0o600);
    });

    await check('Claude Code in code mode: the hint in the system prompt, its own tools off when strict, execute shown up front', async () => {
        const proc = require('../harness/process');
        const seen = [];
        const real = proc.spawnAgent;
        proc.spawnAgent = (o) => { seen.push(o); return { runId: 'x', [Symbol.asyncIterator]: async function* () {} }; };
        try {
            delete require.cache[require.resolve('../harness/adapters/cli')];
            const cli = require('../harness/adapters/cli');
            const claude = cli.claudeCode;
            assert.ok(claude && claude.start, 'the Claude Code adapter');
            const hint = codeMode.hintFor({ strict: true, permission: 'edit' });
            claude.start({ prompt: 'p', permission: 'edit', cwd: '/tmp', options: { mcpConfig: '/tmp/m.json', allowedTools: ['mcp__ov_code'], codeMode: { strict: true, hint } } }, { env: { PATH: '/bin' } });
            const a = seen[0].args;
            assert.strictEqual(a[a.indexOf('--append-system-prompt') + 1], hint);
            assert.match(hint, /own Read, Edit, Write, Grep, Glob and Bash are off/);
            const denied = a[a.indexOf('--disallowedTools') + 1];
            for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']) assert.ok(denied.split(' ').includes(tool), tool);
            assert.ok(denied.includes('Bash(git push:*)'), 'the deny list stays');
            assert.deepStrictEqual([seen[0].env.ENABLE_TOOL_SEARCH, seen[0].env.PATH], ['false', '/bin']);
            claude.start({ prompt: 'p', permission: 'edit', cwd: '/tmp', options: { codeMode: { strict: false, hint: codeMode.hintFor({ strict: false, permission: 'read' }) } } }, {});
            const b = seen[1].args;
            assert.ok(!b[b.indexOf('--disallowedTools') + 1].split(' ').includes('Edit'), 'beside its own tools, not instead');
            claude.start({ prompt: 'p', permission: 'edit', cwd: '/tmp', options: {} }, { env: { PATH: '/bin' } });
            assert.ok(!seen[2].args.includes('--append-system-prompt') && seen[2].env.ENABLE_TOOL_SEARCH === undefined, 'no code mode: unchanged');
        } finally { proc.spawnAgent = real; delete require.cache[require.resolve('../harness/adapters/cli')]; }
    });

    if (failed) { console.log(`code-mode: ${failed} failed`); process.exitCode = 1; } else console.log('code-mode: all checks passed');
})();
