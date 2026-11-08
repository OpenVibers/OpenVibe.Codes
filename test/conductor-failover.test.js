'use strict';

/**
 * The conductor's failover (owner 2026-11-03): before each turn the conductor's own agent and the fallbacks the person
 * chose are read against their machine's usage windows, and the turn runs on the first with room under the switch
 * point. What this checks:
 *   - the choice itself (conductor-failover.js): room, near, full, signed out, a window that already freed, no reading;
 *   - the settings: fallbacks and the switch point are checked and kept;
 *   - a conductor whose Claude Code is at 93% of its week runs its turn on Codex, comes back when the week frees, and
 *     each agent resumes its own session; the agent taking over is told what happened while it was away;
 *   - a machine whose runner is too old to switch is said so on the turn;
 *   - the harness takes a conductor turn on Codex or OpenCode, with the Codes MCP server in a 0700 launcher.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');
const failover = require('../server/domain/conductor-failover');
const job = require('../harness/job');

const NODE = 'nod_01J8Z3Q4R5S6T7V8W9X0Y1Z2F1';
const DEVICE = 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2F1';
const HOUR = 3600_000;

(async () => {
    const now = Date.now();
    const later = new Date(now + 50 * HOUR).toISOString();
    const chain = [{ agent: 'claude-code', model: 'opus' }, { agent: 'codex', model: 'gpt-5.5' }, { agent: 'opencode', model: null }];
    const row = (pct, extra = {}) => ({ installed: true, signed_in: true, windows: pct == null ? [] : [{ name: 'week', pct, resets_at: later }], ...extra });

    await check('the choice: the first agent under the switch point takes the turn', async () => {
        let c = failover.choose({ chain, fleet: { 'claude-code': row(40), codex: row(10) }, now });
        assert.deepStrictEqual(c.pick, { agent: 'claude-code', model: 'opus' });
        assert.strictEqual(c.switched, false);
        assert.strictEqual(c.note, null);

        c = failover.choose({ chain, fleet: { 'claude-code': row(93), codex: row(20) }, now });
        assert.deepStrictEqual(c.pick, { agent: 'codex', model: 'gpt-5.5' }, 'near its limit, the next agent with room takes it');
        assert.strictEqual(c.switched, true);
        assert.match(c.note, /Claude Code is at 93% of its week \(resets in 2 d|resets \w{3} \d\d:\d\d UTC\)/);
        assert.match(c.note, /this turn runs on Codex \(gpt-5\.5\)/);

        c = failover.choose({ chain, fleet: { 'claude-code': row(93), codex: row(20) }, switchPct: 95, now });
        assert.strictEqual(c.pick.agent, 'claude-code', 'the person\'s switch point decides when it moves');

        c = failover.choose({ chain, fleet: { 'claude-code': row(100), codex: row(91), opencode: row(96) }, now });
        assert.strictEqual(c.pick.agent, 'codex', 'with nothing under the point, a near agent before a full one');

        c = failover.choose({ chain, fleet: { 'claude-code': row(92), codex: row(99), opencode: row(null, { signed_in: false }) }, now });
        assert.strictEqual(c.pick.agent, 'claude-code', 'a near primary beats full and signed-out fallbacks');

        c = failover.choose({ chain, fleet: { 'claude-code': row(100), codex: row(99), opencode: row(97) }, now });
        assert.strictEqual(c.pick.agent, 'claude-code', 'all at their limit: the primary tries, and its own answer says the limit');
        assert.match(c.note, /^Every agent in your chain is at its limit/);

        c = failover.choose({ chain: chain.slice(0, 1), fleet: { 'claude-code': row(100) }, now });
        assert.match(c.note, /no fallback is set/);

        c = failover.choose({ chain, fleet: { 'claude-code': row(null, { signed_in: false }), codex: row(5) }, now });
        assert.strictEqual(c.pick.agent, 'codex', 'a signed-out primary hands over');

        const freed = { installed: true, signed_in: true, windows: [{ name: 'week', pct: 100, resets_at: new Date(now - HOUR).toISOString() }] };
        c = failover.choose({ chain, fleet: { 'claude-code': freed, codex: row(5) }, now });
        assert.strictEqual(c.pick.agent, 'claude-code', 'a window whose reset has passed is free again');

        c = failover.choose({ chain, fleet: null, now });
        assert.strictEqual(c.pick.agent, 'claude-code', 'no reading at all: the primary, as before any machine reported');
        c = failover.choose({ chain, fleet: { 'claude-code': row(97) }, now });
        assert.strictEqual(c.pick.agent, 'codex', 'an unreported fallback is still tried before a full primary');
        assert.strictEqual(c.usage[1].state, 'unknown');
    });

    await check('the settings: fallbacks and the switch point are checked', async () => {
        assert.deepStrictEqual(failover.cleanFallbacks([{ agent: 'codex', model: 'gpt-5.5' }, { agent: 'opencode', model: '' }, '']),
            [{ agent: 'codex', model: 'gpt-5.5' }, { agent: 'opencode', model: null }]);
        assert.throws(() => failover.cleanFallbacks([{ agent: 'aider' }]), /fall back to/);
        assert.throws(() => failover.cleanFallbacks([{ agent: 'codex', model: 'gpt 5; rm -rf' }]), /model name/);
        assert.throws(() => failover.cleanFallbacks([{ agent: 'codex', model: 'a' }, { agent: 'codex', model: 'b' }, { agent: 'opencode' }, { agent: 'claude-code', model: 'sonnet' }]), /at most 3/);
        assert.strictEqual(failover.cleanSwitchPct('85'), 85);
        assert.throws(() => failover.cleanSwitchPct(99), /50 to 95/);
        assert.strictEqual(failover.resetsLabel(new Date(now + 30 * 60_000).toISOString(), now), 'resets in 30 min');
    });

    // ── The conductor, end to end on the in-process services ──
    const calls = [];
    const jobs = new Map();
    let counter = 0;
    const run = {
        enabled: true,
        async submit(o) {
            counter++;
            const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2F${String(counter).padStart(2, '0')}`;
            jobs.set(id, { id, state: 'queued', args: o.args });
            calls.push(o);
            return { id, state: 'queued' };
        },
        async read(jobId) { return jobs.get(jobId) || { id: jobId, state: 'running' }; },
        async cancel(jobId) { const j = jobs.get(jobId); if (j) j.state = 'cancelled'; return j; },
        async streamUrl() { throw new Error('no stream in this test'); },
    };
    const t = await boot({ run });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    t.network.addNode(ada.subject, { principal: NODE, node_id: 'node_ada', name: 'ada-laptop', status: 'active', last_seen_at: new Date().toISOString() });
    const machine = t.bot.addMachine({ id: DEVICE, node_id: NODE, name: 'ada-laptop', online: true });
    const report = (claudePct, codexPct) => {
        machine.fleet = [
            { agent: 'claude-code', installed: true, signed_in: true, windows: [{ name: '5h', pct: 10, resets_at: new Date(Date.now() + 2 * HOUR).toISOString() }, { name: 'week', pct: claudePct, resets_at: later }] },
            { agent: 'codex', installed: true, signed_in: true, windows: [{ name: 'week', pct: codexPct, resets_at: later }] },
        ];
        machine.fleet_at = new Date().toISOString();
    };
    const refresh = async () => t.ctx.fleet.refresh(ada.subject, t.network.userToken(ada));
    const post = (p, body) => t.get(p, { as: ada, json: body });
    const rowOf = async (id) => await db.one('SELECT * FROM run_tasks WHERE id = $1', [id]);
    const messagesOf = async (id) => await db.many('SELECT * FROM codes_conductor_messages WHERE task_id = $1 ORDER BY n ASC', [id]);
    const endTurn = async (id, { agent, session, summary = 'Done that.' }) => {
        const r = await rowOf(id);
        const doc = { id: r.job_id, state: 'succeeded', result: { ok: true, summary, log: [{ t: 'agent', agent, session }] } };
        const updated = await t.ctx.tasks.applyEvent(r, { state: 'succeeded', job: doc, error: null });
        return await t.ctx.tasks.afterEnd(updated.id);
    };

    let taskId = null;
    try {
        await check('Claude Code at 93% of its week: the first turn runs on the fallback', async () => {
            await t.ctx.userSettings.save(ada.subject, { conductor_fallbacks: [{ agent: 'codex', model: 'gpt-5.5' }] });
            report(93, 20);
            await refresh();
            const res = await post('/api/v1/conductor', { folder: '/home/ada/work', machine: NODE, model: 'opus', safety: 'ask' });
            assert.strictEqual(res.status, 201, res.text);
            taskId = res.json().task.id;
            const submit = calls.at(-1);
            assert.strictEqual(submit.args.agent, 'codex');
            assert.strictEqual(submit.args.model, 'gpt-5.5');
            assert.strictEqual(submit.args.resume, undefined);
            assert.doesNotMatch(submit.args.prompt, /taking over/, 'the first turn needs no catch-up: it is the brief');
            const [first] = await messagesOf(taskId);
            assert.strictEqual(first.agent, 'codex');
            assert.match(first.switch_note, /Claude Code is at 93% of its week/);
            const view = res.json();
            assert.strictEqual(view.messages[0].agent, 'codex');
            assert.strictEqual(view.usage.chain.length, 2);
            assert.strictEqual(view.usage.chain[0].state, 'near');
            assert.strictEqual(view.usage.chain[1].state, 'ok');
        });

        await check('the week frees: the next turn is Claude Code again, told what Codex did', async () => {
            await endTurn(taskId, { agent: 'codex', session: 'thr_codex_1', summary: 'Split the plan into three tasks.' });
            assert.strictEqual((await messagesOf(taskId))[0].session, 'thr_codex_1', 'Codex\'s session is kept on its turn');
            report(12, 20);
            await refresh();
            const res = await post(`/api/v1/conductor/${taskId}/messages`, { text: 'carry on with the second task' });
            assert.strictEqual(res.status, 201, res.text);
            const submit = calls.at(-1);
            assert.strictEqual(submit.args.agent, 'claude-code');
            assert.strictEqual(submit.args.model, 'opus');
            assert.strictEqual(submit.args.resume, undefined, 'Claude Code has no session of its own yet in this conversation');
            assert.match(submit.args.prompt, /You are taking over this conversation/);
            assert.match(submit.args.prompt, /carrying on from Codex/);
            assert.match(submit.args.prompt, /carry on with the second task$/);
            assert.ok(submit.args.prompt.length <= 16000, 'a turn stays inside a job\'s prompt size');
            const m = (await messagesOf(taskId))[1];
            assert.strictEqual(m.prompt, 'carry on with the second task', 'the person\'s own words are what the row keeps');
            assert.strictEqual(m.agent, 'claude-code');
            assert.strictEqual(m.switch_note, null);
        });

        await check('near again: Codex resumes its own session and hears turn 2', async () => {
            await endTurn(taskId, { agent: 'claude-code', session: 'sess_claude_2', summary: 'Started the second task on OpenCode.' });
            report(95, 30);
            await refresh();
            await post(`/api/v1/conductor/${taskId}/messages`, { text: 'and the third' });
            const submit = calls.at(-1);
            assert.strictEqual(submit.args.agent, 'codex');
            assert.strictEqual(submit.args.resume, 'thr_codex_1', 'each agent resumes its own session');
            assert.match(submit.args.prompt, /since you last took part/);
            assert.match(submit.args.prompt, /Turn 2 — Claude Code/);
            assert.match(submit.args.prompt, /Started the second task on OpenCode\./);
            assert.doesNotMatch(submit.args.prompt, /hand-over brief this conversation started with/, 'Codex already read the brief');
        });

        await check('a runner too old to switch ran Claude Code: the turn says so, and the session stays with Claude Code', async () => {
            await endTurn(taskId, { agent: 'claude-code', session: 'sess_claude_2' });
            const m = (await messagesOf(taskId))[2];
            assert.strictEqual(m.agent, 'claude-code');
            assert.match(m.switch_note, /Update OpenVibe Link/);
            report(10, 30);
            await refresh();
            await post(`/api/v1/conductor/${taskId}/messages`, { text: 'status?' });
            assert.strictEqual(calls.at(-1).args.resume, 'sess_claude_2');
        });

        await check('the pages say it: the conductor\'s usage card and the Settings section', async () => {
            const page = await t.get(`/tasks/${taskId}`, { as: ada });
            assert.strictEqual(page.status, 200);
            assert.match(page.text, /<h3>Usage<\/h3>/, 'the side panel says the usage');
            assert.match(page.text, /fallback 1 · 30% of week/);
            assert.match(page.text, /class="ovt-divider"><span>.*Claude Code is at 93% of its week/, 'the switch is a line in the thread');
            const settings = await t.get('/settings', { as: ada });
            assert.match(settings.text, /id="conductor"/);
            assert.match(settings.text, /<option value="codex" selected data-state="ok" data-badge="30% used"[^>]*>Codex<\/option>/, 'the fallback picker says what each agent is ready for');
            assert.match(settings.text, /name="fallback_model_1" value="gpt-5\.5"/);
        });
    } finally {
        await t.close();
    }

    await check('the harness: a conductor turn on Codex or OpenCode, with the Codes tools in a launcher', async () => {
        const base = { kind: 'conductor', folder: '/home/ada/work', prompt: 'go', task_id: 'tsk_01J8Z3Q4R5S6T7V8W9X0Y1Z2F1', mcp: true, codes_url: 'https://codes.test' };
        assert.strictEqual(job.parseArgs(JSON.stringify({ ...base, agent: 'codex', safety: 'ask' }), {}).agent, 'codex');
        assert.strictEqual(job.parseArgs(JSON.stringify({ ...base, agent: 'codex', safety: 'ask' }), {}).permission, 'edit');
        assert.strictEqual(job.parseArgs(JSON.stringify({ ...base, agent: 'opencode', safety: 'full' }), {}).permission, 'full');
        assert.strictEqual(job.parseArgs(JSON.stringify({ ...base, agent: 'claude-code', safety: 'full' }), {}).permission, 'edit', 'Claude Code keeps its own permission modes');
        assert.strictEqual(job.parseArgs(JSON.stringify({ ...base, agent: 'aider' }), {}).agent, 'aider', 'every harness may lead');
        assert.strictEqual(job.parseArgs(JSON.stringify({ ...base, agent: 'not-a-harness' }), {}).agent, 'claude-code');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-codes-failover-'));
        try {
            const parsed = job.parseArgs(JSON.stringify({ ...base, agent: 'codex' }), {});
            const server = job.conductorMcpLauncher(path.join(dir, 'codes-mcp.sh'), parsed, { OPENVIBE_TOKEN: "tok'en" });
            assert.strictEqual(server.command, '/bin/sh');
            const st = fs.statSync(server.args[0]);
            assert.strictEqual(st.mode & 0o077, 0, 'only the job may read the launcher');
            const text = fs.readFileSync(server.args[0], 'utf8');
            assert.match(text, /export OPENVIBE_TOKEN='tok'\\''en'/, 'the token is quoted for the shell');
            assert.match(text, /export OPENVIBE_CONDUCTOR_TASK='tsk_/);
            assert.match(text, /exec '.+' '.+openvibe-codes\.js' mcp/);
            const oc = JSON.parse(fs.readFileSync(job.opencodeConfig(path.join(dir, 'opencode.json'), server), 'utf8'));
            assert.deepStrictEqual(oc.mcp.codes, { type: 'local', command: ['/bin/sh', server.args[0]], enabled: true });
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
