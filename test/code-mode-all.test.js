'use strict';
/**
 * Code mode for every harness (runner 0.14.0; the owner, 11-18: "Give all harnesses code mode"), each its own way
 * (harness/code-mode.js PLANS):
 * - the plans: Claude Code and OpenCode strict, Codex / Command Code / Muse / ACP beside their own tools, Codes' own API
 *   loop strict, MiniMax Code its own, Aider none;
 * - a project file (opencode.json, .mcp.json) is merged into what is there, kept out of git, and put back after the run;
 * - Codex: the server as config overrides, the hint before the prompt; OpenCode: one project opencode.json (v2) with
 *   the server, its own tools denied by policy, the hint as instructions; Command Code and Muse: the project .mcp.json;
 *   Claude Code on another provider: the same flags as Claude Code's;
 * - ACP: session/new carries the server; Codes' API loop: strict offers only execute, and a script edits the repository.
 *   node test/code-mode-all.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const codeMode = require('../harness/code-mode');

let failed = 0;
const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n${e && e.stack}`); } };
const collect = async (run) => { const out = []; for await (const e of run) out.push(e); return out; };
const repo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmall-'));
    fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const greet = (n) => `hi ${n}`;\nmodule.exports = { greet };\n');
    return dir;
};

/** Each CLI adapter's start, with the process stubbed: what it would run, and the files it left. */
function startOf(adapterName, t) {
    const proc = require('../harness/process');
    const real = proc.spawnAgent;
    const seen = [];
    proc.spawnAgent = (o) => { seen.push(o); return { runId: 'x', [Symbol.asyncIterator]: async function* () {} }; };
    try {
        delete require.cache[require.resolve('../harness/adapters/cli')];
        require('../harness/adapters/cli')[adapterName].start(t, { env: { PATH: '/bin' } });
        return seen[0];
    } finally { proc.spawnAgent = real; delete require.cache[require.resolve('../harness/adapters/cli')]; }
}

(async () => {
    const why = codeMode.ready();
    if (why) { console.log(`code-mode-all: skipped here (${why})`); return; }

    await check('the plans: every harness has one, strict where it can be', async () => {
        const plan = (a, k) => codeMode.planFor(a, k);
        assert.deepStrictEqual([plan('claude-code').via, plan('claude-code').strict], ['claude', true]);
        assert.deepStrictEqual([plan('claude-other').via, plan('opencode').via, plan('opencode').strict], ['claude', 'opencode', true]);
        assert.deepStrictEqual([plan('codex').via, plan('codex').strict], ['codex', false]);
        assert.deepStrictEqual([plan('command-code').via, plan('muse').via], ['mcp-json', 'mcp-json']);
        assert.strictEqual(plan('minimax-code').via, 'own');
        assert.strictEqual(plan('aider').via, null);
        assert.deepStrictEqual([plan('deepseek', 'api').via, plan('deepseek', 'api').strict], ['loop', true]);
        assert.deepStrictEqual([plan('gemini', 'acp').via, plan('gemini', 'acp').strict], ['acp', false]);
    });

    await check('a project file: merged into what is there, kept out of git, put back after the run', async () => {
        const dir = repo();
        const restoreNew = codeMode.withProjectFile(dir, '.mcp.json', (c) => ({ ...c, mcpServers: { ov_code: { command: 'node' } } }));
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.ov_code, { command: 'node' });
        assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.mcp\.json$/m, 'out of git');
        restoreNew();
        assert.ok(!fs.existsSync(path.join(dir, '.mcp.json')), 'a new file goes away');
        const theirs = '{ "mcpServers": { "theirs": { "command": "x" } }, "other": 1 }';
        fs.writeFileSync(path.join(dir, 'opencode.json'), theirs);
        const restore = codeMode.withProjectFile(dir, 'opencode.json', (c) => { c.mcp = { servers: { ov_code: { type: 'local', command: ['node'] } } }; return c; });
        const merged = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
        assert.deepStrictEqual([merged.other, !!merged.mcpServers.theirs, !!merged.mcp.servers.ov_code], [1, true, true], 'theirs kept');
        restore();
        assert.strictEqual(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'), theirs, 'theirs back, byte for byte');
    });

    await check('Codex: the server as config overrides, the hint before the prompt', async () => {
        const dir = repo();
        const cm = codeMode.descriptor({ root: dir, permission: 'edit', strict: false });
        const o = startOf('codex', { prompt: 'rename greet', cwd: dir, permission: 'edit', options: { codeMode: cm } });
        assert.ok(o.args.includes(`mcp_servers.ov_code.command=${JSON.stringify(process.execPath)}`), o.args.join(' '));
        assert.ok(o.args.some((a) => a.startsWith('mcp_servers.ov_code.args=') && a.includes('code-mode')));
        const prompt = o.args[o.args.length - 1];
        assert.match(prompt, /^Code mode is on for this run\./);
        assert.match(prompt, /rename greet$/);
    });

    await check('OpenCode: one project opencode.json (v2), its own tools denied by policy, the hint as instructions; put back', async () => {
        const dir = repo();
        const cm = codeMode.descriptor({ root: dir, permission: 'edit', strict: true });
        startOf('opencode', { prompt: 'rename greet', cwd: dir, permission: 'edit', options: { codeMode: cm } });
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
        assert.deepStrictEqual(cfg.mcp.servers.ov_code.command.slice(1, 3), [cfg.mcp.servers.ov_code.command[1], 'code-mode']);
        for (const tool of ['read', 'edit', 'write', 'glob', 'grep', 'shell', 'bash']) assert.ok(cfg.policies.some((p) => p.action === 'tool.use' && p.resource === tool && p.effect === 'deny'), tool);
        assert.match(fs.readFileSync(cfg.instructions[0], 'utf8'), /Your own Read, Edit, Write, Grep, Glob and Bash are off/);
        assert.deepStrictEqual(cfg.permission, { read: 'deny', edit: 'deny', glob: 'deny', grep: 'deny', list: 'deny', bash: 'deny' }, 'the object form, which --auto respects');
        cm.cleanup();
        assert.ok(!fs.existsSync(path.join(dir, 'opencode.json')), 'put back');
        // The conductor's Codes tools on OpenCode take the same road (v2 ignores OPENCODE_CONFIG).
        const restores = [];
        startOf('opencode', { prompt: 'x', cwd: dir, permission: 'edit', options: { mcpServers: [{ name: 'codes', command: 'node', args: ['mcp'] }], restores } });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8')).mcp.servers.codes, { type: 'local', command: ['node', 'mcp'] });
        assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8')).policies, 'no code mode: its own tools stay');
        restores.forEach((r) => r());
        assert.ok(!fs.existsSync(path.join(dir, 'opencode.json')));
    });

    await check('Command Code and Muse: the project .mcp.json; the hint before the prompt', async () => {
        const dir = repo();
        const cm = codeMode.descriptor({ root: dir, permission: 'edit', strict: false });
        const c = startOf('commandCode', { prompt: 'rename greet', cwd: dir, permission: 'edit', options: { codeMode: cm } });
        assert.ok(c.args[0].startsWith('--print=Code mode is on for this run.'), c.args[0].slice(0, 80));
        assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers), ['ov_code']);
        cm.cleanup();
        assert.ok(!fs.existsSync(path.join(dir, '.mcp.json')));
        const cm2 = codeMode.descriptor({ root: dir, permission: 'read', strict: false });
        const m = startOf('muse', { prompt: 'look around', cwd: dir, permission: 'read', options: { codeMode: cm2 } });
        assert.match(String(m.stdin), /^Code mode is on for this run\.[\s\S]*look around$/);
        assert.ok(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.ov_code.args.includes('read'));
        cm2.cleanup();
    });

    await check('Claude Code on another provider: the same flags as Claude Code\'s', async () => {
        const dir = repo();
        const o = startOf('claudeOther', { prompt: 'p', cwd: dir, permission: 'edit', options: { mcpConfig: '/tmp/m.json', allowedTools: ['mcp__ov_code'], codeMode: { strict: true, claudeHint: 'HINT', server: { name: 'ov_code' } } } });
        const a = o.args;
        assert.strictEqual(a[a.indexOf('--mcp-config') + 1], '/tmp/m.json');
        assert.strictEqual(a[a.indexOf('--append-system-prompt') + 1], 'HINT');
        assert.ok(a[a.indexOf('--disallowedTools') + 1].split(' ').includes('Edit'), 'strict');
        assert.strictEqual(o.env.ENABLE_TOOL_SEARCH, 'false');
    });

    await check('ACP: session/new carries the server, and the hint leads the prompt', async () => {
        const dir = repo();
        const log = path.join(dir, 'acp.log');
        const { acpAgent } = require('../harness/adapters/acp');
        const agent = acpAgent({ id: 'mock-acp', name: 'Mock ACP', cmd: process.execPath, args: [path.join(__dirname, 'fixtures', 'acp-mock-agent.js')], env: { MOCK_ACP_LOG: log } });
        const cm = codeMode.descriptor({ root: dir, permission: 'edit', strict: false });
        await collect(agent.start({ prompt: 'do it', cwd: dir, permission: 'edit', options: { codeMode: cm } }, { env: {} }));
        const msgs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const created = msgs.find((m) => m.method === 'session/new');
        assert.deepStrictEqual(created.params.mcpServers.map((s) => [s.name, s.args.includes('code-mode')]), [['ov_code', true]]);
        const prompted = msgs.find((m) => m.method === 'session/prompt');
        assert.match(prompted.params.prompt[0].text, /^Code mode is on for this run\.[\s\S]*do it$/);
    });

    await check('Codes\' own API loop: strict offers only execute, and one script edits the repository', async () => {
        const dir = repo();
        const requests = [];
        const script = [{ calls: [{ name: 'execute', arguments: { code: "const r = await tools.edit({ path: 'src/a.js', old: 'hi ', new: 'hello ' }); return r;" } }] }];
        const server = http.createServer((req, res) => {
            let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
                requests.push(JSON.parse(b || '{}'));
                const step = script.shift();
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step ? '' : 'done', ...(step ? { tool_calls: step.calls.map((c, i) => ({ id: `c${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
            });
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        try {
            const { createHarness } = require('../harness');
            const { createStore } = require('../harness/sessions');
            const env = { PATH: '/nonexistent', OPENVIBE_CODES_HOME: path.join(dir, '.home'), OPENVIBE_CODES_BASE_URL: `http://127.0.0.1:${server.address().port}`, OPENVIBE_CODES_MODEL: 'tiny', OPENVIBE_CODES_API_KEY: 'k', OPENVIBE_CODES_RETRY_MS: '0' };
            const h = createHarness({ env, store: createStore({ env }) });
            const cm = codeMode.descriptor({ root: dir, permission: 'edit', strict: true });
            await collect(h.run({ prompt: 'say hello', agent: 'openai-compatible', cwd: dir, permission: 'edit', handoff: false, adapterOptions: { codeMode: cm } }));
            assert.deepStrictEqual(requests[0].tools.map((x) => x.function.name), ['execute'], 'strict: only execute');
            assert.match(requests[0].tools[0].function.description, /read, grep, glob, ls, edit, write/);
            assert.match(fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8'), /hello \$\{n\}/, 'the script edited the file');
            const toolMsg = requests[1].messages.find((m) => m.role === 'tool');
            assert.match(toolMsg.content, /"ok":true/);
        } finally { server.close(); }
    });

    if (failed) { console.log(`code-mode-all: ${failed} failed`); process.exitCode = 1; } else console.log('code-mode-all: all checks passed');
})();
