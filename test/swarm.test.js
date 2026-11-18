'use strict';
/**
 * The swarm (harness/swarm.js) on a real git repository, with a stand-in model behind the openai-compatible harness
 * that answers by role: the lead's plan, each worker's ticket, the resolver. Two tickets run at once in their own
 * worktrees and merge into one branch; a conflict goes to the resolver; the person's branch and working tree are never
 * touched; a dirty working tree is refused; the planner's answer is read forgivingly and cut to the limit.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { createHarness } = require('../harness');
const { createStore } = require('../harness/sessions');
const { createSwarm, parsePlan } = require('../harness/swarm');
const { check, done } = require('./helpers/boot');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const collect = async (it) => { const out = []; for await (const e of it) out.push(e); return out; };

/** A model that answers by the prompt it is given: the plan, a ticket's write, or the resolver's fix. */
async function roleModel() {
    let plan = [];
    let writes = {};
    let resolved = '';
    const seen = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', async () => {
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 60));   // long enough for two workers to overlap
            const b = JSON.parse(body);
            const first = b.messages.find((m) => m.role === 'user').content;
            const answered = b.messages[b.messages.length - 1].role === 'tool';
            let msg;
            if (/You are the lead/.test(first)) { seen.push('lead'); msg = { content: `Here is the plan:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }; }
            else if (/conflict markers/.test(first)) {
                seen.push('resolver');
                msg = answered ? { content: 'Resolved.' } : { tool_calls: [{ id: 'r1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'shared.txt', content: resolved }) } }] };
            } else {
                const t = /Your ticket \((t\d+)\)/.exec(first)[1];
                seen.push(t);
                const w = writes[t];
                msg = answered ? { content: `${t} done.` } : { tool_calls: [{ id: `${t}c`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify(w) } }] };
            }
            inFlight--;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
        url: `http://127.0.0.1:${server.address().port}/v1`, seen, maxInFlight: () => maxInFlight,
        set: (p, w, r = '') => { plan = p; writes = w; resolved = r; seen.length = 0; maxInFlight = 0; },
        close: () => new Promise((r) => server.close(r)),
    };
}

(async () => {
    const model = await roleModel();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-swarm-'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Tester');
    git(repo, 'config', 'user.email', 'tester@example.test');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const head = git(repo, 'rev-parse', 'HEAD');
    const env = { PATH: path.dirname(process.execPath), HOME: dir, OPENVIBE_CODES_HOME: path.join(dir, 'home'), OPENVIBE_CODES_BASE_URL: model.url, OPENVIBE_CODES_MODEL: 'tiny', OPENVIBE_CODES_API_KEY: 'k', OPENVIBE_CODES_RG: 'off' };
    const harness = createHarness({ env, store: createStore({ env }) });
    const swarm = createSwarm({ harness });
    const result = (events) => events.find((e) => e.type === 'result');

    await check('two tickets run at once in their own worktrees and merge into one branch; yours is untouched', async () => {
        model.set([{ title: 'Add a', brief: 'Create a.txt saying A.', files: ['a.txt'] }, { title: 'Add b', brief: 'Create b.txt saying B.', files: ['b.txt'] }],
            { t1: { path: 'a.txt', content: 'A\n' }, t2: { path: 'b.txt', content: 'B\n' } });
        const events = await collect(swarm.run({ goal: 'add a.txt and b.txt', cwd: repo, agents: ['openai-compatible'], concurrency: 2 }));
        const r = result(events);
        assert.strictEqual(r.is_error, false, r.result);
        const b = r.swarm;
        assert.deepStrictEqual(b.tickets.map((t) => [t.id, t.status, t.agent, t.changed]), [['t1', 'done', 'openai-compatible', ['a.txt']], ['t2', 'done', 'openai-compatible', ['b.txt']]]);
        assert.strictEqual(b.merged_branch, `ovswarm/${b.id}/merged`);
        assert.strictEqual(git(repo, 'show', `${b.merged_branch}:a.txt`), 'A');
        assert.strictEqual(git(repo, 'show', `${b.merged_branch}:b.txt`), 'B');
        assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head, 'HEAD did not move');
        assert.strictEqual(git(repo, 'status', '--porcelain'), '', 'the working tree is clean');
        assert.ok(!fs.existsSync(path.join(repo, 'a.txt')));
        assert.strictEqual(git(repo, 'worktree', 'list').split('\n').length, 1, 'every worktree removed');
        assert.ok(model.maxInFlight() >= 2, `the workers overlapped (${model.maxInFlight()} at once)`);
        assert.deepStrictEqual(model.seen.filter((s) => s !== 'lead').sort(), ['t1', 't1', 't2', 't2']);
        const saved = JSON.parse(fs.readFileSync(path.join(env.OPENVIBE_CODES_HOME, 'swarms', b.id, 'board.json'), 'utf8'));
        assert.strictEqual(saved.status, 'done');
        assert.ok(events.some((e) => e.subtype === 'swarm' && e.phase === 'board' && e.tickets.length === 2));
        assert.ok(events.some((e) => e._ticket === 't1' && e.type === 'assistant'), 'the workers\' own events are tagged');
    });

    await check('a merge conflict goes to the resolver, and the merged branch keeps both sides', async () => {
        model.set([{ title: 'One', brief: 'Write one in shared.txt.', files: ['shared.txt'] }, { title: 'Two', brief: 'Write two in shared.txt.', files: ['shared.txt'] }],
            { t1: { path: 'shared.txt', content: 'one\n' }, t2: { path: 'shared.txt', content: 'two\n' } }, 'one\ntwo\n');
        const events = await collect(swarm.run({ goal: 'shared edits', cwd: repo, agents: ['openai-compatible'] }));
        const r = result(events);
        assert.strictEqual(r.is_error, false, r.result);
        assert.ok(model.seen.includes('resolver'));
        assert.strictEqual(git(repo, 'show', `${r.swarm.merged_branch}:shared.txt`), 'one\ntwo');
        assert.deepStrictEqual(r.swarm.tickets[1].resolved, ['shared.txt']);
        assert.ok(events.some((e) => e.phase === 'conflict' && e.files.includes('shared.txt')));
        assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head);
    });

    await check('a dirty working tree is refused before anything runs', async () => {
        fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
        model.set([], {});
        const r = result(await collect(swarm.run({ goal: 'anything', cwd: repo })));
        assert.strictEqual(r.is_error, true);
        assert.match(r.result, /uncommitted changes/);
        assert.deepStrictEqual(model.seen, [], 'no agent ran');
        git(repo, 'checkout', '--', 'README.md');
        assert.throws(() => swarm.run({ goal: 'x', cwd: repo, permission: 'read' }), /edit or full/);
    });

    await check('the plan is read forgivingly and cut to the limit', async () => {
        assert.deepStrictEqual(parsePlan('```json\n[{"title":"A","brief":"do a","files":["a.js","../x","/etc/passwd"]}]\n```').map((t) => [t.id, t.files]), [['t1', ['a.js']]]);
        assert.strictEqual(parsePlan('Sure! [{"title":"A","brief":"b"},{"title":"B","brief":"c"}] done').length, 2);
        assert.strictEqual(parsePlan('{"tickets":[{"title":"A","brief":"b"}]}').length, 1);
        assert.deepStrictEqual(parsePlan('no plan here'), []);
        assert.strictEqual(parsePlan(JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, brief: 'x' }))), 3).length, 3);
        assert.deepStrictEqual(parsePlan('[{"title":"no brief"}]'), []);
    });

    await model.close();
    fs.rmSync(dir, { recursive: true, force: true });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
