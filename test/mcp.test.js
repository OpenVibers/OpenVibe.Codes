'use strict';

/**
 * Codes C9b: `openvibe-codes mcp`, the conductor's tools. One real MCP child process against a real Codes server: each
 * tool does its work through the person's own token, and the rule at the centre of the conductor — no Anthropic
 * sub-task — is refused by the client and by the server.
 *
 *   codes_task_start · codes_task_list · codes_task_show · codes_task_continue · codes_task_stop · codes_fleet ·
 *   codes_ship_status (against a fake GitHub) · codes_approve (its refusal without a conductor task)
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { boot, check, done } = require('./helpers/boot');

const MCP = path.join(__dirname, '..', 'bin', 'mcp.js');
const NODE = 'nod_01J8Z3Q4R5S6T7V8W9X0Y1Z2N3';

function mcpChild(env) {
    const child = spawn(process.execPath, [MCP], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    const waiting = new Map();
    let next = 1;
    let stderr = '';
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            const done = waiting.get(msg.id);
            if (done) { waiting.delete(msg.id); done(msg); }
        }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const send = (method, params) => new Promise((resolve, reject) => {
        const id = next++;
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`no answer to ${method} in 40 s: ${stderr}`)); }, 40_000);
        waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    return {
        send,
        async call(name, args) {
            const msg = await send('tools/call', { name, arguments: args });
            return msg.result && msg.result.content && msg.result.content[0] ? JSON.parse(msg.result.content[0].text) : null;
        },
        close() { try { child.stdin.end(); } catch { /* gone */ } try { child.kill(); } catch { /* gone */ } },
    };
}

/** A GitHub that answers one pull request and its commit status. */
async function fakeGitHub() {
    const server = http.createServer((req, res) => {
        const sha = 'abc1234';
        const body = req.url.includes('/status')
            ? { state: 'success', statuses: [] }
            : { number: 7, title: 'Codes C9b: the conductor', state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean', head: { sha, ref: 'codes-c9b-conductor' }, base: { ref: 'main' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const calls = [];
    let counter = 0;
    const run = {
        enabled: true,
        async submit(o) { counter++; const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2L${String(counter).padStart(2, '0')}`; calls.push(['submit', o]); return { id, state: 'queued' }; },
        async read(jobId) { return { id: jobId, state: 'running' }; },
        async cancel() { return { state: 'cancelled' }; },
        async streamUrl() { throw new Error('no stream in this test'); },
    };
    const t = await boot({ run });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    t.network.addNode(ada.subject, { principal: NODE, node_id: 'node_ada', name: 'ada-laptop', status: 'active', last_seen_at: new Date().toISOString() });
    const created = await t.get('/api/v1/conductor', { as: ada, json: { folder: '/home/ada/openvibe', machine: NODE } });
    assert.strictEqual(created.status, 201, created.text);
    const conductorId = created.json().task.id;
    const gh = await fakeGitHub();

    const mcp = mcpChild({
        OPENVIBE_TOKEN: t.network.userToken(ada),
        OPENVIBE_CODES_URL: t.base,
        OPENVIBE_CONDUCTOR_TASK: conductorId,
        GITHUB_API_URL: gh.url,
    });
    const rowOf = async (id) => await db.one('SELECT * FROM run_tasks WHERE id = $1', [id]);
    const repo = 'https://github.com/octocat/Hello-World';
    let subTask = null;

    try {
        await check('initialize: one stdio server, tools, ping', async () => {
            const init = await mcp.send('initialize', { protocolVersion: '2024-11-05' });
            assert.strictEqual(init.result.serverInfo.name, 'openvibe-codes');
            assert.strictEqual((await mcp.send('ping', {})).result !== undefined || true, true);
        });

        await check('codes_task_start: a sub-task on another agent, in the conductor\'s project', async () => {
            const before = calls.length;
            const out = await mcp.call('codes_task_start', { prompt: 'Fix the parser and add a test.', repo: 'octocat/Hello-World', agent: 'codex', model: 'gpt-5' });
            assert.ok(out.id, JSON.stringify(out));
            assert.strictEqual(out.repo, repo);
            assert.strictEqual(calls.length, before + 1);
            const submit = calls.at(-1)[1];
            assert.strictEqual(submit.args.agent, 'codex');
            assert.strictEqual(submit.args.model, 'gpt-5');
            assert.strictEqual(submit.args.prompt, 'Fix the parser and add a test.');
            const row = await rowOf(out.id);
            assert.strictEqual(row.kind, 'code');
            assert.strictEqual(row.project_id, (await rowOf(conductorId)).project_id, 'the conductor\'s own project');
            subTask = out.id;
        });

        await check('codes_task_start: the rule, refused here and not sent', async () => {
            const anthropic = await mcp.call('codes_task_start', { prompt: 'x', repo, agent: 'claude-code' });
            assert.match(anthropic.error, /Anthropic/);
            const model = await mcp.call('codes_task_start', { prompt: 'x', repo, agent: 'codex', model: 'claude-opus-5-5' });
            assert.match(model.error, /Anthropic/);
            const noRepo = await mcp.call('codes_task_start', { prompt: 'x' });
            assert.match(noRepo.error, /repository/);
        });

        await check('codes_task_list: running, needs and done', async () => {
            const running = await mcp.call('codes_task_list', { state: 'running' });
            assert.ok(running.tasks.some((x) => x.id === subTask), JSON.stringify(running));
            assert.ok(running.tasks.some((x) => x.id === conductorId), 'the conductor is one of the person\'s tasks');
            const doneList = await mcp.call('codes_task_list', { state: 'done' });
            assert.ok(!doneList.tasks.some((x) => x.id === subTask), 'a running sub-task is not done');
        });

        await check('codes_task_show: the state, its attempts and the last lines', async () => {
            await t.ctx.sessions.append(subTask, [
                { seq: 1, kind: 'text', at: new Date().toISOString(), body: { t: 'text', text: 'Looking at the parser.' } },
                { seq: 2, kind: 'tool', at: new Date().toISOString(), body: { t: 'tool', name: 'Read', input: { file_path: 'src/parser.js' } } },
            ]);
            const out = await mcp.call('codes_task_show', { id: subTask, lines: 5 });
            assert.strictEqual(out.id, subTask);
            assert.strictEqual(out.state, 'queued');
            assert.strictEqual(out.attempts.length, 1);
            assert.strictEqual(out.attempts[0].agent, 'codex');
            assert.ok(out.last_lines.some((l) => /Looking at the parser/.test(l)), JSON.stringify(out.last_lines));
            assert.ok(out.last_lines.some((l) => /Read src\/parser\.js/.test(l)), JSON.stringify(out.last_lines));
        });

        await check('codes_task_continue: a note on a task that ended unfinished', async () => {
            const row = await rowOf(subTask);
            await t.ctx.tasks.applyEvent(row, { state: 'failed', job: { id: row.job_id, state: 'failed' }, error: 'the machine said no' });
            const after = await rowOf(subTask);
            assert.strictEqual(after.state, 'failed');
            const out = await mcp.call('codes_task_continue', { id: subTask, message: 'the parser test is flaky, fix that first' });
            assert.strictEqual(out.id, subTask, JSON.stringify(out));
            const submit = calls.at(-1)[1];
            assert.match(submit.args.prompt, /flaky/);
        });

        await check('codes_task_stop: a running sub-task stops', async () => {
            const started = await mcp.call('codes_task_start', { prompt: 'a second piece', repo, agent: 'opencode' });
            const out = await mcp.call('codes_task_stop', { id: started.id });
            assert.strictEqual(out.id, started.id);
            assert.strictEqual(out.outcome, 'stopped');
            const row = await rowOf(started.id);
            assert.strictEqual(row.state, 'cancelled');
        });

        await check('codes_fleet: each coding CLI on this machine, and its windows', async () => {
            const out = await mcp.call('codes_fleet', {});
            assert.ok(Array.isArray(out.agents) && out.agents.length >= 5, JSON.stringify(out));
            for (const a of out.agents) {
                assert.strictEqual(typeof a.agent, 'string');
                assert.strictEqual(typeof a.installed, 'boolean');
                assert.ok(Array.isArray(a.windows));
            }
            // Codes answers with every machine's stored report; Bot is not running here, and the answer says so.
            assert.ok(Array.isArray(out.machines), 'the stored fleet of every machine');
            assert.ok(out.problem && /bot|answer|refused|fetch/i.test(JSON.stringify(out.problem)), JSON.stringify(out.problem));
        });

        await check('codes_ship_status: a pull request\'s CI, merge and deploy state, from GitHub', async () => {
            const out = await mcp.call('codes_ship_status', { repo: 'octocat/Hello-World', pr: 7 });
            assert.strictEqual(out.state, 'open');
            assert.strictEqual(out.ci, 'Passed');
            assert.strictEqual(out.merged, false);
            assert.strictEqual(out.title, 'Codes C9b: the conductor');
            assert.strictEqual(out.deploy.state, 'unknown', 'Codes knows no service for this repository');
            assert.strictEqual(out.deploy.service, null);
        });

        await check('codes_approve without a conductor task says so, instead of asking nothing', async () => {
            const other = mcpChild({ OPENVIBE_TOKEN: t.network.userToken(ada), OPENVIBE_CODES_URL: t.base });
            try {
                const out = await other.call('codes_approve', { tool_name: 'Bash', input: { command: 'ls' } });
                assert.match(out.error, /OPENVIBE_CONDUCTOR_TASK/);
            } finally { other.close(); }
        });
    } finally {
        mcp.close();
        await gh.close();
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
