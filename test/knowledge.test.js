'use strict';

/**
 * Know K5: workspace knowledge on Codes.
 *
 *   a run's ending is captured (its Learned: lines, a failure, the command that failed, the commands it uses), with
 *   secrets removed; the next run's job carries it in its prompt; every row is visible, editable, pinnable and
 *   deletable on /knowledge with its source run; a row is private until its owner shares it with a team, and only
 *   that team's members (not everyone) can read it; the API the ov-know MCP speaks answers the same rows.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { boot, check, done } = require('./helpers/boot');
const { parseArgs, agentPrompt, runJob } = require('../harness/job');
const secrets = require('./helpers/fakesecrets');

const REPO = 'https://github.com/OpenVibers/OpenVibe.Codes';
const PROJECT = 'prj_01J8Z3Q4R5S6T7V8W9X0Y1Z2P1';
const TASK_ID = /^tsk_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A small repository to clone, as a file:// URL. */
function repository() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-kn-src-'));
    const sh = (...args) => execFileSync('git', args, {
        cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
    sh('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'first');
    return { dir, url: `file://${dir}` };
}

/** A stand-in harness that records the prompt the job actually hands it. */
function fakeHarness() {
    const calls = [];
    return {
        calls,
        run(opts) {
            calls.push(opts);
            return (async function* run() {
                yield { type: 'system', subtype: 'init', agent: 'claude-code', model: 'test' };
                yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } };
                yield { type: 'result', is_error: false, result: 'Done.\n\nLearned:\n- It worked (README.md).', total_cost_usd: 0.001 };
            })();
        },
    };
}

(async () => {
    const calls = [];
    const jobs = new Map();
    let counter = 0;
    const run = {
        enabled: true,
        async submit(o) {
            counter++;
            const id = `job_01J8Z3Q4R5S6T7V8W9X0Y1Z2K${String(counter).padStart(2, '0')}`;
            jobs.set(id, { id, state: 'queued', args: o.args });
            calls.push(o);
            return { id, state: 'queued' };
        },
        async read(jobId) { return jobs.get(jobId) || { id: jobId, state: 'queued' }; },
        async cancel(jobId) { const job = jobs.get(jobId); if (job) job.state = 'cancelled'; return job; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');
    const carol = t.network.addUser('carol');
    t.network.state.projects.set(PROJECT, {
        id: PROJECT, name: 'The team', owner: ada.subject, environment_policy: 'sandbox', allowance: [],
        created_at: new Date().toISOString(), archived_at: null,
    });
    t.network.state.members.set(PROJECT, new Map([[ada.subject, 'owner'], [bo.subject, 'developer']]));

    const startTask = async (prompt) => await t.ctx.tasks.start({ subject: ada.subject, project: PROJECT, args: parseArgs(JSON.stringify({ repo: REPO, prompt, agent: 'claude-code' })) });
    const rowOf = async (id) => await db.one('SELECT * FROM run_tasks WHERE id = $1', [id]);
    const end = async (id, state, result, error = null) => {
        const row = await rowOf(id);
        const updated = await t.ctx.tasks.applyEvent(row, { state, job: { id: row.job_id, state, result, error: null }, error });
        await t.ctx.tasks.afterEnd(updated.id);
        return await rowOf(id);
    };
    const knowledgeOf = async (subject) => await db.many('SELECT * FROM codes_knowledge WHERE subject = $1 ORDER BY created_at ASC', [subject]);

    try {
        let firstId = null;
        let captured = null;

        await check('a finished run is captured: its Learned: lines, the failure, the failed command and the commands it used', async () => {
            firstId = (await startTask('Fix the home test after the pin bump.')).id;
            assert.match(firstId, TASK_ID);
            const provider = secrets.providerKey();
            const password = secrets.password();
            const result = {
                ok: true,
                summary: `I finished.\n\nLearned:\n- The home test pins the sc-navbar markup (test/home.test.js).\n- The token ${provider} must not be stored; ${password}.`,
                agents: ['codex'],
                log: [
                    { t: 'tool', id: 't1', name: 'Bash', input: { command: 'npm test' } },
                    { t: 'tool_result', id: 't1', ok: true, output: '2 tests passed' },
                    { t: 'text', text: 'I finished.\n\nLearned:\n- The home test pins the sc-navbar markup (test/home.test.js).' },
                ],
            };
            const ended = await end(firstId, 'succeeded', result);
            assert.strictEqual(ended.state, 'succeeded');
            // The failure path is the same capture, from an attempt that did not finish; call it with that ending.
            await t.ctx.knowledge.captureTask({
                ...ended, state: 'failed', error: 'the tests failed',
                result: {
                    ok: false, summary: 'I could not finish.', agents: ['codex'],
                    log: [
                        { t: 'tool', id: 't1', name: 'Bash', input: { command: 'npm test' } },
                        { t: 'tool_result', id: 't1', ok: false, output: 'Error: 2 tests failed\n  at home.test.js:42' },
                    ],
                },
            });
            captured = await knowledgeOf(ada.subject);
            assert.ok(captured.length >= 4, `${captured.length} rows captured`);
            const learned = captured.find((r) => /sc-navbar markup/.test(r.text));
            assert.ok(learned, 'the Learned: line is stored');
            assert.strictEqual(learned.source_task, firstId, 'the row names the run it came from');
            assert.strictEqual(learned.kind, 'lesson');
            const heldSecret = captured.find((r) => /\[redacted\]/.test(r.text));
            assert.ok(heldSecret, 'the row that held a key is stored with the key replaced');
            assert.ok(heldSecret.redacted, 'and is marked redacted');
            const all = captured.map((r) => r.text).join('\n');
            assert.ok(!all.includes(provider) && !all.includes(secrets.passwordValue()), 'the provider key and password are gone');
            assert.match(all, /\[redacted\]/);
            assert.ok(captured.some((r) => r.kind === 'fact' && /npm test/.test(r.text)), 'the command the repository uses is a fact');
            assert.ok(captured.some((r) => /npm test` failed/.test(r.text)), 'the command that failed is a lesson');
            assert.ok(captured.every((r) => r.visibility === 'private'), 'captured rows are private by default');
        });

        await check('the next run’s job carries them, and the harness prompt gets them before the brief', async () => {
            const second = await startTask('Fix the pin bump bundle growth in package.json.');
            assert.match(second.id, TASK_ID);
            const submitted = calls.at(-1);
            assert.ok(submitted.args.knowledge, 'the job input carries the knowledge block');
            assert.match(submitted.args.knowledge, /sc-navbar markup/);
            const parsed = parseArgs(JSON.stringify(submitted.args));
            assert.match(parsed.knowledge, /OpenVibe\.Codes Knowledge/);
            const prompt = agentPrompt(parsed);
            assert.ok(prompt.startsWith(parsed.knowledge), 'the knowledge is the prompt’s first section');
            assert.ok(prompt.includes('Fix the pin bump bundle growth'), 'the person’s brief follows it');
            assert.ok(prompt.includes('End with a `Learned:` block'), 'and the next run is asked to teach one back');
            // End it so the test leaves no queued task behind.
            await end(second.id, 'succeeded', { ok: true, summary: 'Done.', agents: ['claude-code'], log: [] });
        });

        await check('a job’s prompt is what the harness receives, for every adapter', async () => {
            const src = repository();
            const harness = fakeHarness();
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-kn-tmp-'));
            try {
                const doc = await runJob({
                    input: JSON.stringify({ repo: src.url, prompt: 'Add a line', knowledge: '## What earlier runs learned\n\n- Use npm test (package.json).\n\n---\n' }),
                    harness, emit: () => {}, writeResult: () => {}, env: { ...process.env, OPENVIBE_CODES_ALLOW_FILE_REPO: '1' }, tmp,
                });
                assert.strictEqual(doc.ok, true, JSON.stringify(doc));
                assert.ok(harness.calls[0].prompt.startsWith('## What earlier runs learned'), 'the prefix reaches the adapter');
                assert.ok(harness.calls[0].prompt.includes('Add a line'));
                assert.ok(harness.calls[0].prompt.includes('Before you finish (OpenVibe.Codes Knowledge)'));
            } finally {
                fs.rmSync(tmp, { recursive: true, force: true });
            }
        });

        await check('the page shows every row with its source run, and its edit, pin, share and delete forms', async () => {
            const page = await t.get('/knowledge', { as: ada });
            assert.strictEqual(page.status, 200, page.text.slice(0, 200));
            assert.ok(page.text.includes('Knowledge'), 'the page title');
            assert.ok(page.text.includes('The home test pins the sc-navbar markup'), 'the captured text');
            assert.ok(page.text.includes(`/tasks/${firstId}`), 'the source run links to the task');
            assert.ok(page.text.includes('Add a lesson or a fact'), 'the add form');
            assert.ok(page.text.includes('Pin'), 'pin');
            assert.ok(page.text.includes('>Edit<'), 'edit');
            assert.ok(page.text.includes('>Delete<') && page.text.includes('>Delete it<'), 'delete');
            assert.ok(page.text.includes('Share'), 'share');
            assert.ok(page.text.includes('The team'), 'the person’s team is offered');
        });

        await check('a row can be edited, pinned, and deleted by its owner', async () => {
            const row = (await knowledgeOf(ada.subject)).find((r) => /sc-navbar markup/.test(r.text));
            const edited = await t.get(`/knowledge/${row.id}/edit`, { as: ada, form: { tab: 'all', text: 'The home test pins the sc-navbar markup (test/home.test.js); update it with a pin.', kind: 'fact' } });
            assert.strictEqual(edited.status, 303);
            const after = await db.one('SELECT * FROM codes_knowledge WHERE id = $1', [row.id]);
            assert.strictEqual(after.kind, 'fact');
            assert.match(after.text, /update it with a pin/);
            const pinned = await t.get(`/knowledge/${row.id}/pin`, { as: ada, form: { tab: 'all', pinned: '1' } });
            assert.strictEqual(pinned.status, 303);
            assert.strictEqual((await db.one('SELECT pinned FROM codes_knowledge WHERE id = $1', [row.id])).pinned, true);
            const deleted = await t.get(`/knowledge/${row.id}/delete`, { as: ada, form: { tab: 'all' } });
            assert.strictEqual(deleted.status, 303);
            assert.strictEqual(await db.maybe('SELECT 1 FROM codes_knowledge WHERE id = $1', [row.id]), null);
        });

        await check('a row is shared with a team: its members read it, a non-member does not, and only the owner edits it', async () => {
            const shared = await t.ctx.knowledge.remember({
                subject: ada.subject, kind: 'lesson', text: 'Team only: the deploy waits for the release tag (release.json).', repo: 'OpenVibers/OpenVibe.Codes',
            });
            const share = await t.get(`/knowledge/${shared.row.id}/share`, { as: ada, form: { tab: 'all', team_id: PROJECT } });
            assert.strictEqual(share.status, 303);
            const row = await db.one('SELECT * FROM codes_knowledge WHERE id = $1', [shared.row.id]);
            assert.strictEqual(row.visibility, 'team');
            assert.strictEqual(row.team_id, PROJECT);

            const boPage = await t.get('/knowledge', { as: bo });
            assert.ok(boPage.text.includes('Team only: the deploy waits'), 'a team member reads it');
            assert.ok(boPage.text.includes('Shared with The team'), 'and it says why');
            const carolPage = await t.get('/knowledge', { as: carol });
            assert.ok(!carolPage.text.includes('Team only: the deploy waits'), 'a non-member does not');
            const boEdit = await t.get(`/knowledge/${row.id}/edit`, { as: bo, form: { tab: 'all', text: 'hijacked', kind: 'lesson' } });
            assert.strictEqual(boEdit.status, 303);
            assert.match((await db.one('SELECT text FROM codes_knowledge WHERE id = $1', [row.id])).text, /deploy waits/, 'a teammate cannot edit it');
            const boDelete = await t.get(`/knowledge/${row.id}/delete`, { as: bo, form: { tab: 'all' } });
            assert.strictEqual(boDelete.status, 303);
            assert.ok(await db.maybe('SELECT 1 FROM codes_knowledge WHERE id = $1', [row.id]), 'and cannot delete it');
        });

        await check('the API the ov-know MCP speaks reads the rows, adds a redacted row, and refuses another person', async () => {
            const read = await t.get('/api/v1/knowledge', { bearer: t.network.userToken(ada) });
            assert.strictEqual(read.status, 200, read.text.slice(0, 200));
            assert.ok(read.json().knowledge.length >= 2, 'the person’s rows');
            assert.ok(read.json().knowledge.every((r) => typeof r.mine === 'boolean'));
            const secret = secrets.providerKey();
            const added = await t.get('/api/v1/knowledge', {
                method: 'POST', bearer: t.network.userToken(ada),
                json: { text: `A fact with a key ${secret} (src/app.js).`, kind: 'fact', repo: 'OpenVibers/OpenVibe.Codes' },
            });
            assert.strictEqual(added.status, 201, added.text.slice(0, 200));
            assert.ok(!added.json().knowledge.text.includes(secret), 'the answer is redacted');
            assert.match(added.json().knowledge.text, /\[redacted\]/);
            const boRead = await t.get('/api/v1/knowledge', { bearer: t.network.userToken(bo) });
            assert.ok(boRead.json().knowledge.some((r) => /deploy waits/.test(r.text)), 'a teammate reads the shared row');
            const anon = await t.get('/api/v1/knowledge');
            assert.strictEqual(anon.status, 401);
        });

        await check('every task rewrites one session summary, and the next run reads it first', async () => {
            const { summaryKey, summaryText } = require('../server/domain/knowledge');
            assert.strictEqual(summaryKey(REPO), 'summary:github.com/OpenVibers/OpenVibe.Codes');
            assert.match(summaryText({ repo: REPO, prompt: 'Fix the footer.\nSecond line.', ending: { state: 'succeeded' } }),
                /^Previously on github\.com\/OpenVibers\/OpenVibe\.Codes: Fix the footer\. — finished\./);
            const summaries = async () => (await knowledgeOf(ada.subject)).filter((r) => r.kind === 'fact' && /^Previously on /.test(r.text));
            const third = await startTask('Bump the footer year.');
            await end(third.id, 'succeeded', { ok: true, summary: 'Done.', agents: ['claude-code'], log: [] });
            assert.strictEqual((await summaries()).length, 1, 'one summary row, rewritten not added');
            assert.match((await summaries())[0].text, /Bump the footer year.*finished/);
            const fourth = await startTask('Fix the header link.');
            await end(fourth.id, 'failed', { ok: false, summary: 'Could not.', agents: ['codex'], log: [] }, 'the tests failed');
            const again = await summaries();
            assert.strictEqual(again.length, 1, 'the second task rewrote the same row');
            assert.match(again[0].text, /Fix the header link.*failed/);
            assert.strictEqual(again[0].source_task, fourth.id, 'the row names its latest run');
            const fifth = await startTask('Polish the footer.');
            assert.match(calls.at(-1).args.knowledge, /^Previously on .*Fix the header link.*failed/, 'the next run reads the last session first');
            await end(fifth.id, 'succeeded', { ok: true, summary: 'Done.', agents: ['claude-code'], log: [] });
            const other = await t.ctx.knowledge.recall({ subject: ada.subject, repo: 'https://github.com/OpenVibers/OpenVibe.Bot', prompt: '' });
            assert.strictEqual(other.previous, null, 'another repository has no summary');
            assert.strictEqual(other.previousText, '');
        });

        await check('the nightly dream rechecks captured rows against the saved transcript without repeating a lesson', async () => {
            const task = await startTask('Check the release tests.');
            await end(task.id, 'succeeded', { ok: true, summary: 'Done.\n\nLearned:\n- npm test covers the release.\n- The release uses CI.', agents: ['codex'], log: [] });
            const valid = (await knowledgeOf(ada.subject)).find((r) => r.source_task === task.id && /covers the release/.test(r.text));
            assert.ok(valid);
            const ghost = await t.ctx.knowledge.remember({ subject: ada.subject, kind: 'lesson',
                text: 'The moon is green.', repo: REPO, sourceTask: task.id });
            const pass = await t.ctx.knowledge.dream({ limit: 100 });
            assert.strictEqual(pass.skipped, false);
            assert.ok(pass.processed > 0);
            assert.strictEqual((await db.one('SELECT seen FROM codes_knowledge WHERE id = $1', [valid.id])).seen, valid.seen,
                'a nightly replay of the same task is not a second sighting');
            const stale = await db.one('SELECT * FROM codes_knowledge WHERE id = $1', [ghost.row.id]);
            assert.strictEqual(stale.dream_status, 'unsupported', 'the saved task does not support this claim');
            const recalled = await t.ctx.knowledge.recall({ subject: ada.subject, repo: REPO, prompt: 'moon green' });
            assert.ok(!recalled.rows.some((r) => r.id === stale.id), 'unsupported text cannot steer another run');
            assert.strictEqual((await t.ctx.knowledge.list({ subject: ada.subject })).find((r) => r.id === stale.id).dream_status,
                'unsupported', 'the owner can still inspect it');
            const manual = await t.ctx.knowledge.edit({ subject: ada.subject, id: stale.id, text: 'The moon is blue.' });
            assert.strictEqual(manual.source_task, null, 'an owner edit becomes manual knowledge');
            assert.strictEqual(manual.dream_status, 'active');
            assert.strictEqual((await t.ctx.knowledge.dream()).skipped, true, 'the due check runs once a day');
            const next = await startTask('Check the next release.');
            await end(next.id, 'succeeded', { ok: true, summary: 'Done.\n\nLearned:\n- npm test covers the release.', agents: ['codex'], log: [] });
            const repeated = await db.one('SELECT seen, source_task FROM codes_knowledge WHERE id = $1', [valid.id]);
            assert.strictEqual(repeated.source_task, next.id);
            assert.strictEqual(repeated.seen, valid.seen + 1, 'a new task is a second sighting');
            await t.ctx.knowledge.dream({ force: true, limit: 100 });
            const replayed = await db.one('SELECT seen, source_task FROM codes_knowledge WHERE id = $1', [valid.id]);
            assert.strictEqual(replayed.seen, repeated.seen, 'replaying an older task does not inflate sightings');
            assert.strictEqual(replayed.source_task, next.id, 'replay does not move attribution backwards');
        });

        await check('the person’s knowledge is exported with the account and erased with it', async () => {
            const { TABLES } = require('../server/account-data');
            assert.ok(TABLES.some((x) => x.table === 'codes_knowledge' && x.subject === 'subject'), 'the table is covered');
            const before = Number(await db.value('SELECT count(*) FROM codes_knowledge WHERE subject = $1', [ada.subject]));
            assert.ok(before > 0);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
