'use strict';

/**
 * Codes C9b: approvals, end to end. The conductor's Claude Code session runs with `--permission-mode default` and a
 * permission prompt tool; when a risky call comes up, the approve MCP tool (bin/mcp.js, a real child process) asks Codes,
 * Codes writes the approval and tells the person, and the answer goes back to the tool as allow or deny.
 *
 * Checked here: the MCP server's tools, an approval asked and allowed, one asked and denied, the notification, a stop
 * that answers everything still waiting, and — with a stand-in `claude` on PATH — the flags and the MCP config a
 * conductor's turn is started with.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { boot, check, done } = require('./helpers/boot');

const BIN = path.join(__dirname, '..', 'bin', 'openvibe-codes.js');
const MCP = path.join(__dirname, '..', 'bin', 'mcp.js');
const NODE = 'nod_01J8Z3Q4R5S6T7V8W9X0Y1Z2N2';

/** A child MCP server that answers one JSON-RPC message at a time. */
function mcpChild(env) {
    const child = spawn(process.execPath, [MCP], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const waiting = new Map();
    let next = 1;
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            if (!line.trim()) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            const done = waiting.get(msg.id);
            if (done) { waiting.delete(msg.id); done(msg); }
        }
    });
    const send = (method, params) => new Promise((resolve, reject) => {
        const id = next++;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`no answer to ${method} in 40 s`)); }, 40_000);
        waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    return {
        send,
        async call(name, args) {
            const msg = await send('tools/call', { name, arguments: args });
            return msg.result && msg.result.content && msg.result.content[0] ? JSON.parse(msg.result.content[0].text) : null;
        },
        close() { try { child.stdin.end(); } catch { /* it is gone */ } try { child.kill(); } catch { /* it is gone */ } },
    };
}

(async () => {
    const calls = [];
    let counter = 0;
    const run = {
        enabled: true,
        async submit(o) {
            counter++;
            const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2M${String(counter).padStart(2, '0')}`;
            calls.push(['submit', o]);
            return { id, state: 'queued' };
        },
        async read(jobId) { return { id: jobId, state: 'running' }; },
        async cancel() { return { state: 'cancelled' }; },
        async streamUrl() { throw new Error('no stream in this test'); },
    };
    const notices = [];
    const notify = { enabled: true, async push(n) { notices.push(n); return { sent: true }; } };
    const t = await boot({ run, notify });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    t.network.addNode(ada.subject, { principal: NODE, node_id: 'node_ada', name: 'ada-laptop', status: 'active', last_seen_at: new Date().toISOString() });

    const created = await t.get('/api/v1/conductor', { as: ada, json: { folder: '/home/ada/openvibe', machine: NODE, safety: 'ask' } });
    assert.strictEqual(created.status, 201, created.text);
    const taskId = created.json().task.id;
    const token = t.network.userToken(ada);
    const env = { OPENVIBE_TOKEN: token, OPENVIBE_CODES_URL: t.base, OPENVIBE_CONDUCTOR_TASK: taskId, APPROVAL_TIMEOUT_MS: '30000' };

    /** The approval row the MCP just asked for (it is written before the child starts waiting). */
    const awaiting = async () => {
        for (let i = 0; i < 100; i++) {
            const row = await db.maybe('SELECT * FROM codes_approvals WHERE task_id = $1 AND decision IS NULL ORDER BY created_at DESC LIMIT 1', [taskId]);
            if (row) return row;
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('the MCP never asked for an approval');
    };

    const mcp = mcpChild(env);
    try {
        await check('the MCP server lists the conductor\'s tools, including approve', async () => {
            await mcp.send('initialize', { protocolVersion: '2024-11-05' });
            const list = await mcp.send('tools/list', {});
            const names = (list.result.tools || []).map((x) => x.name);
            for (const name of ['codes_task_start', 'codes_task_list', 'codes_task_show', 'codes_task_continue', 'codes_task_stop', 'codes_fleet', 'codes_ship_status', 'codes_approve']) {
                assert.ok(names.includes(name), `${name} is listed`);
            }
        });

        await check('a risky call is asked, the person allows it on their phone, and the tool gets its answer', async () => {
            const answer = mcp.call('codes_approve', { tool_name: 'Bash', input: { command: 'rm -rf build' } });
            const row = await awaiting();
            assert.strictEqual(row.tool, 'Bash');
            assert.strictEqual(row.summary, 'rm -rf build', 'the person reads the command');
            assert.ok(notices.some((n) => n.type === 'APPROVAL_NEEDED' && /rm -rf build/.test(n.message)), 'the person is told');
            const inbox = await t.get('/api/v1/approvals', { as: ada });
            assert.strictEqual(inbox.status, 200, inbox.text);
            assert.ok(inbox.json().approvals.some((a) => a.id === row.id), 'it is in the inbox');
            const decided = await t.get(`/api/v1/approvals/${row.id}`, { as: ada, json: { decision: 'allow' } });
            assert.strictEqual(decided.status, 200, decided.text);
            const out = await answer;
            assert.strictEqual(out.behavior, 'allow');
            assert.strictEqual(out.message, 'the owner said yes');
            const stored = await db.maybe('SELECT * FROM codes_approvals WHERE id = $1', [row.id]);
            assert.strictEqual(stored.decision, 'allow');
            assert.ok(stored.decided_at, 'when it was decided');
        });

        await check('a denied call is denied, with the person\'s own reason', async () => {
            const answer = mcp.call('codes_approve', { tool_name: 'Write', input: { file_path: '/etc/hosts' }, summary: 'write /etc/hosts' });
            const row = await awaiting();
            assert.strictEqual(row.summary, 'write /etc/hosts');
            await t.get(`/api/v1/approvals/${row.id}`, { as: ada, json: { decision: 'deny', message: 'not that file' } });
            const out = await answer;
            assert.strictEqual(out.behavior, 'deny');
            assert.strictEqual(out.message, 'not that file');
        });

        await check('stopping the conductor answers what is still waiting', async () => {
            const answer = mcp.call('codes_approve', { tool_name: 'Bash', input: { command: 'make deploy' } });
            const row = await awaiting();
            const stopped = await t.get(`/api/v1/conductor/${taskId}/stop`, { as: ada, json: {} });
            assert.strictEqual(stopped.status, 200, stopped.text);
            const out = await answer;
            assert.strictEqual(out.behavior, 'deny');
            const stored = await db.maybe('SELECT * FROM codes_approvals WHERE id = $1', [row.id]);
            assert.strictEqual(stored.decision, 'deny');
            assert.match(stored.message, /stopped/);
        });

        await check('a conductor turn starts Claude Code with the Codes tools and the ask mode (a stand-in claude)', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-conductor-'));
            const bin = path.join(dir, 'bin');
            const folder = path.join(dir, 'project');
            fs.mkdirSync(bin);
            fs.mkdirSync(folder);
            const seen = path.join(dir, 'seen.json');
            // What the real CLI prints (the recorded shapes), plus what it was started with: the flags and the config.
            fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
const at = argv.indexOf('--mcp-config');
const mcp = at >= 0 ? JSON.parse(fs.readFileSync(argv[at + 1], 'utf8')) : null;
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv, mcp }));
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: 'cl-conductor', model: 'opus' });
out({ type: 'assistant', message: { model: 'opus', content: [{ type: 'text', text: 'Carrying the plan on.' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Carrying the plan on.', session_id: 'cl-conductor', duration_ms: 5, num_turns: 1, total_cost_usd: 0.02, usage: { input_tokens: 30, output_tokens: 9 } });
`, { mode: 0o755 });
            const job = spawnSync(process.execPath, [BIN, 'job'], {
                cwd: folder,
                input: JSON.stringify({ kind: 'conductor', folder, prompt: 'carry on', task_id: taskId, mcp: true, codes_url: t.base, safety: 'ask', model: 'opus' }),
                env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, OPENVIBE_CODES_HOME: path.join(dir, 'home'), ...env },
                encoding: 'utf8', timeout: 60_000,
            });
            const doc = job.stdout.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
                .find((l) => l && l.t === 'result_doc');
            assert.ok(doc, job.stdout + job.stderr);
            assert.strictEqual(doc.result.kind, 'conductor');
            assert.strictEqual(doc.result.ok, true, JSON.stringify(doc.result));
            assert.strictEqual(doc.result.summary, 'Carrying the plan on.');
            assert.deepStrictEqual(doc.result.files, [], 'the owner\'s folder is not patched');
            const argv = JSON.parse(fs.readFileSync(seen, 'utf8')).argv;
            assert.strictEqual(argv[argv.indexOf('--permission-mode') + 1], 'default', 'ask is Claude Code\'s default mode');
            assert.ok(argv.includes('--mcp-config'), argv.join(' '));
            assert.strictEqual(argv[argv.indexOf('--allowedTools') + 1], 'mcp__codes');
            assert.strictEqual(argv[argv.indexOf('--permission-prompt-tool') + 1], 'mcp__codes__approve');
            const config = JSON.parse(fs.readFileSync(seen, 'utf8')).mcp;
            const codes = config.mcpServers.codes;
            assert.ok(codes.args[0].endsWith(path.join('bin', 'openvibe-codes.js')), codes.args[0]);
            assert.strictEqual(codes.args[1], 'mcp');
            assert.strictEqual(codes.env.OPENVIBE_CONDUCTOR_TASK, taskId);
            assert.strictEqual(codes.env.OPENVIBE_CODES_URL, t.base);
            fs.rmSync(dir, { recursive: true, force: true });
        });
    } finally {
        mcp.close();
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
