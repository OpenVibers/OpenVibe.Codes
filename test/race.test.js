'use strict';
/**
 * Race mode (server/domain/races.js, compare-arena-ecosystem.md §5): "Race this task" starts two jobs with the same
 * brief, repository and budget on two harnesses; the repository's checks become the test_suite judgement; one
 * bench.match@1 is recorded; the pull request a person merges adds an implicit judgement to the SAME id; and a Codes
 * without bench.judgement.cast runs the race and skips the match with no call and no failure.
 */
const assert = require('assert');
const { validate, ids } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { parseArgs } = require('../harness/job');
const { createMatchRecorder } = require('../server/domain/races');
const { boot, check, done } = require('./helpers/boot');

const REPO = 'https://github.com/OpenVibers/OpenVibe.Codes';
const SECRET = `fixture_${'race-events'.repeat(3)}`;

(async () => {
    const submitted = [];
    const jobResults = new Map();
    const run = {
        enabled: true,
        async submit(o) {
            const id = ids.newId('job');
            submitted.push({ id, ...o });
            return { id, state: 'queued' };
        },
        async read(id) { return jobResults.get(id) || { state: 'queued', result: null, error: null }; },
        async cancel() { return { state: 'cancelled' }; },
        async streamUrl() { throw new Error('streaming is not used by a race test'); },
    };
    const recorded = [];
    const recorder = {
        enabled: true,
        async record(match) {
            recorded.push(JSON.parse(JSON.stringify(match)));
            return { ok: true, created: recorded.length === 1, match };
        },
    };
    const t = await boot({ run, matchRecorder: recorder, random: () => 0.6, env: { CODES_TASK_USD: '2', CODES_TASK_TOKENS: '1000', CODES_EVENTS_SECRET: SECRET } });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const project = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';

    let source;
    let race;
    let sideRows;
    await check('race this task starts two jobs with one budget, the same brief and repository', async () => {
        source = await t.ctx.tasks.start({ subject: ada.subject, project, args: parseArgs(JSON.stringify({ repo: REPO, prompt: 'Fix the flaky date parser', permission: 'edit' })) });
        const before = submitted.length;
        race = await t.ctx.races.startFromTask(source, { agents: ['codex', 'opencode'] });
        const started = submitted.slice(before);
        assert.strictEqual(started.length, 2, 'two jobs started');
        assert.deepStrictEqual(started.map((x) => x.args.agent).sort(), ['codex', 'opencode']);
        assert.strictEqual(race.sides.length, 2);
        assert.strictEqual(new Set(race.sides.map((x) => x.task_id)).size, 2);
        sideRows = await db.many('SELECT * FROM run_tasks WHERE id = ANY($1) ORDER BY id', [race.sides.map((x) => x.task_id)]);
        assert.strictEqual(sideRows.length, 2);
        assert.strictEqual(new Set(sideRows.map((x) => x.prompt)).size, 1, 'the same prompt');
        assert.strictEqual(new Set(sideRows.map((x) => x.repo)).size, 1, 'the same repository');
        assert.ok(sideRows.every((x) => x.push === true && x.pull_request === true), 'both ask for a pull request');
        const budgets = await db.many('SELECT DISTINCT budget_usd, budget_tokens FROM codes_attempts WHERE task_id = ANY($1)', [race.sides.map((x) => x.task_id)]);
        assert.deepStrictEqual(budgets.map((b) => [b.budget_usd, b.budget_tokens]), [[2, 1000]], 'one budget for both sides');
    });

    await check('the repository’s check runs on both pushed branches', async () => {
        const checksBefore = submitted.filter((x) => x.args && x.args.kind === 'check').length;
        assert.strictEqual(checksBefore, 0);
        for (const [index, side] of race.sides.entries()) {
            const row = await db.one('SELECT * FROM run_tasks WHERE id = $1', [side.task_id]);
            const branch = `openvibe-codes/race-test-${side.slot}`;
            const result = {
                ok: true, summary: `Side ${side.slot} changed the parser`, files: [{ path: 'src/date.js', added: 3, removed: 1 }],
                push: { pushed: true, branch, branch_url: `https://github.com/OpenVibers/OpenVibe.Codes/tree/${branch}`, pull_request: `https://github.com/OpenVibers/OpenVibe.Codes/pull/${7 + index}` },
                cost_usd: 0.1 + index * 0.05, tokens: 100 + index, resolved_model: index ? 'glm-5.3' : 'gpt-5-mini', duration_ms: 1000 + index * 500,
                log: [{ t: 'usage', input_tokens: 60 + index, output_tokens: 40 }, { t: 'tool' }, { t: 'tool' }],
            };
            await t.ctx.tasks.applyEvent(row, { state: 'succeeded', job: { state: 'succeeded', result } });
        }
        const saved = await db.one('SELECT * FROM codes_races WHERE id = $1', [race.id]);
        assert.strictEqual(saved.state, 'checking');
        const checks = await db.many('SELECT * FROM codes_race_checks WHERE race_id = $1 ORDER BY slot', [race.id]);
        assert.deepStrictEqual(checks.map((c) => c.slot), ['a', 'b']);
        assert.ok(checks.every((c) => c.job_id && c.ref === `openvibe-codes/race-test-${c.slot}`));
        const jobs = submitted.filter((x) => x.args && x.args.kind === 'check');
        assert.strictEqual(jobs.length, 2, 'one check job per side');
        assert.deepStrictEqual(jobs.map((x) => x.args.ref).sort(), ['openvibe-codes/race-test-a', 'openvibe-codes/race-test-b']);
    });

    let match;
    await check('the match body is a bench.match@1 with both sides’ receipts and a test_suite judgement', async () => {
        const checks = await db.many('SELECT * FROM codes_race_checks WHERE race_id = $1 ORDER BY slot', [race.id]);
        // The check results arrive as run.job.succeeded deliveries, exactly as Run sends them.
        for (const row of checks) {
            const good = row.slot === 'a';
            jobResults.set(row.job_id, {
                state: 'succeeded', error: null,
                result: {
                    protocol: '1.0.0', ok: good, kind: 'check', conclusion: good ? 'success' : 'failure',
                    steps: [{ name: 'test', conclusion: 'success', ms: 1 }, { name: 'lint', conclusion: good ? 'success' : 'failure', ms: 1 }],
                    log_tail: '', ms: 5,
                },
            });
            const event = {
                event_id: ids.newId('event'), event_type: 'run.job.succeeded', version: 1, source: 'run',
                subject: { type: 'job', id: row.job_id }, visibility: 'internal',
                payload: { job_id: row.job_id, project_id: project, requester: { type: 'user', id: ada.subject }, state: 'succeeded', timings: { finished_at: new Date().toISOString() }, error: null },
            };
            const body = JSON.stringify({ event, seq: 1 });
            const delivered = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
            assert.strictEqual(delivered.status, 200, delivered.text);
        }
        assert.strictEqual(recorded.length, 1, 'one match recorded');
        match = recorded[0];
        assert.match(match.id, /^mat_[0-9A-HJKMNP-TV-Z]{26}$/);
        const valid = validate('bench.match@1', match);
        assert.ok(valid.valid, JSON.stringify(valid.errors));
        assert.deepStrictEqual([match.source, match.task.kind], ['codes', 'code']);
        assert.strictEqual(match.slots.length, 2);
        assert.ok(match.slots.every((s) => /^agent:(codex|opencode)\+[A-Za-z0-9._/:-]+#[a-f0-9]{16}$/.test(s.entrant)), JSON.stringify(match.slots.map((s) => s.entrant)));
        assert.deepStrictEqual(match.slots.map((s) => s.receipts.outcome), ['succeeded', 'succeeded']);
        assert.ok(match.slots[0].receipts.tool_calls >= 0 && match.slots[0].receipts.cost_usd > 0 && match.slots[0].receipts.wall_ms > 0);
        const tests = match.judgements.find((j) => j.judge === 'test_suite');
        assert.ok(tests, 'a test_suite judgement');
        assert.deepStrictEqual(tests.scores, { a: 1, b: 0.5 });
        assert.strictEqual(tests.winner, 'a');
        const saved = await db.one('SELECT * FROM codes_races WHERE id = $1', [race.id]);
        assert.strictEqual(saved.state, 'matched');
        assert.strictEqual(saved.match_recorded, true);
    });

    await check('the merge adds an implicit judgement to the same match id', async () => {
        const out = await t.ctx.races.handleGithubEvent({
            event_type: 'github.pr.updated', subject: { id: 'OpenVibers/OpenVibe.Codes#8' },
            payload: { action: 'closed', merged: true },
        });
        assert.strictEqual(out.outcome, 'race:merged');
        assert.strictEqual(recorded.length, 2, 'the same match is written again');
        assert.strictEqual(recorded[1].id, match.id, 'the same id');
        const implicit = recorded[1].judgements.find((j) => j.judge === 'implicit');
        assert.ok(implicit, 'an implicit judgement');
        assert.deepStrictEqual([implicit.winner, implicit.signal], ['b', 'merged']);
        assert.ok(validate('bench.match@1', recorded[1]).valid);
        const again = await t.ctx.races.handleGithubEvent({
            event_type: 'github.pr.updated', subject: { id: 'OpenVibers/OpenVibe.Codes#8' },
            payload: { action: 'closed', merged: true },
        });
        assert.strictEqual(again.outcome, 'ignored:no_race', 'a redelivery adds nothing');
        assert.strictEqual(recorded.length, 2);
    });

    await check('the run page shows both sides side by side, and the task page offers the race', async () => {
        const page = await t.get(`/run/races/${race.id}`, { as: ada });
        assert.strictEqual(page.status, 200, page.text.slice(0, 300));
        assert.ok(page.text.includes('run-race-sides') && page.text.includes('Side A') && page.text.includes('Side B'), page.text.slice(0, 500));
        assert.ok(page.text.includes(match.id), 'the match id');
        assert.ok(page.text.includes('100% of checks passed') && page.text.includes('50% of checks passed'));
        const sourcePage = await t.get(`/run/tasks/${source.id}`, { as: ada });
        assert.ok(sourcePage.text.includes('Race this task') && sourcePage.text.includes(`/run/tasks/${source.id}/race`), 'the source task offers the race');
        const sidePage = await t.get(`/run/tasks/${race.sides[0].task_id}`, { as: ada });
        assert.ok(sidePage.text.includes(`/run/races/${race.id}`) && /side [AB] of a race/.test(sidePage.text), 'a side links to both sides');
        assert.ok(!sidePage.text.includes('data-race-start'), 'a side does not offer to race itself');
        const other = t.network.addUser('bo');
        assert.strictEqual((await t.get(`/run/races/${race.id}`, { as: other })).status, 404, 'another person never sees it');
    });

    await check('no bench.judgement.cast grant: no Bench call, no failure, the race is skipped with a log line', async () => {
        let called = false;
        const absent = createMatchRecorder({
            config: { oauth: { clientId: 'codes' }, networkInternalUrl: 'http://127.0.0.1:1' },
            tokens: { authHeaders: async () => { throw new Error('invalid_scope: not granted bench.judgement.cast'); } },
            fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; },
        });
        const out = await absent.record(match);
        assert.strictEqual(called, false, 'Network’s refusal is not a Bench call');
        assert.strictEqual(out.absent, true);
        assert.match(out.reason, /bench\.judgement\.cast/);

        // The race itself is unaffected: two more jobs start, and finalizing without the grant only skips the match.
        const second = await t.ctx.races.startFromTask(source, { agents: ['codex', 'opencode'] });
        t.ctx.races.bench.record = async () => ({ ok: false, absent: true, reason: 'Codes has no bench.judgement.cast on openvibe.bench' });
        const before = (await db.one('SELECT * FROM codes_races WHERE id = $1', [second.id])).state;
        assert.strictEqual(before, 'running');
        await assert.doesNotReject(async () => { await t.ctx.races.finishRace(second.id); });
        const saved = await db.one('SELECT * FROM codes_races WHERE id = $1', [second.id]);
        assert.strictEqual(saved.state, 'skipped');
        assert.match(t.logs(), /race .*match skipped/);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exitCode = 1; });
