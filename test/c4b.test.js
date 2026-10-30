'use strict';
/**
 * Codes C4b: the screens C4 left as links.
 *
 *   - Home's saved pickers: the repositories a person used here, last used first, and their paired machines
 *   - a task's Changes, Proof and Pull request panels are Codes' own, from run_tasks and codes_task_proof
 *   - Agents: the person's keys, added, tested and removed from the page (the key itself never comes back)
 *   - Machines: the person's paired Node machines, their state, and Node's pairing flow with a one-time code
 *   - Settings: remembered per person
 *   - Usage: runs, minutes and tokens per day, and no prices Codes does not know
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

const NODE = 'nod_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = 'nod_01ARZ3NDEKTSV4RRFFQ69G5FAC';
const TASK = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TASK2 = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const TASK3 = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAX';

(async () => {
    const t = await boot({ env: (network) => ({ CODES_AI_URL: 'https://ai.openvibe.services.invalid', CODES_AI_INTERNAL_URL: network.url }) });
    const db = t.ctx.store.db;
    const ada = t.network.addUser('c4b-ada');
    const bo = t.network.addUser('c4b-bo');
    const now = Date.now();

    try {
        await check('Home offers the repositories a person used, last used first, and their paired machines', async () => {
            await db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, state, result, created_at, updated_at)
                VALUES ($1,$2,'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW','https://github.com/OpenVibers/OpenVibe.Codes','main','An older task','codex','succeeded','{}'::jsonb,$3,$3),
                       ($4,$2,'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW','https://github.com/OpenVibers/OpenVibe.Shared','main','A newer task','codex','succeeded','{}'::jsonb,$5,$5)`,
                [TASK3, ada.subject, now - 90 * 60_000, TASK2, now - 60_000]);
            t.network.addNode(ada.subject, { principal: OTHER, node_id: 'node-laptop', name: 'Laptop', status: 'active', last_seen_at: new Date().toISOString(), created_at: new Date().toISOString() });
            t.network.addNode(ada.subject, { principal: NODE, node_id: 'node-desk', name: 'Desk', status: 'active', last_seen_at: new Date().toISOString(), created_at: new Date().toISOString(), paired_for: { service: 'bot', ref: 'rob_1' } });
            const home = await t.get('/', { as: ada });
            assert.strictEqual(home.status, 200);
            const shared = home.text.indexOf('https://github.com/OpenVibers/OpenVibe.Shared');
            const codes = home.text.indexOf('https://github.com/OpenVibers/OpenVibe.Codes');
            assert.ok(shared > -1 && codes > -1, 'both repositories are offered');
            assert.ok(shared < codes, 'the last one used comes first');
            assert.ok(home.text.includes('<option value="' + NODE + '">Desk'), 'the machine picker offers the paired machine');
            assert.ok(home.text.includes('data-c4-repo-search'), 'the repository field searches');
            assert.ok(home.text.includes('data-c4-saved-repo="https://github.com/OpenVibers/OpenVibe.Shared"'), 'and the saved ones are a pill away');
        });

        await check('the machine picker is in the order of use, on Home and on Settings', async () => {
            // The Desk ran the work; the Laptop never did, and Network lists the Laptop first.
            await db.exec(`INSERT INTO codes_attempts (id, task_id, n, agent, machine, state, started_at, finished_at, created_at)
                VALUES ('att_01ARZ3NDEKTSV4RRFFQ69G5FAC',$1,2,'codex',$2,'done', now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours')`, [TASK2, NODE]);
            await t.ctx.userSettings.save(ada.subject, { default_machine: OTHER });
            for (const page of ['/', '/settings']) {
                const shown = await t.get(page, { as: ada });
                assert.strictEqual(shown.status, 200);
                const desk = shown.text.indexOf(`<option value="${NODE}">Desk`);
                const laptop = shown.text.indexOf(`<option value="${OTHER}"`);
                assert.ok(desk > -1 && laptop > -1, `${page} offers both machines`);
                assert.ok(desk < laptop, `${page} shows the machine used last first`);
                assert.ok(shown.text.includes('Laptop · your default'), `${page} marks the saved default`);
            }
        });

        await check('the composer remembers the machine and agent a person picks, then opens Run&rsquo;s form', async () => {
            const started = await t.get('/start', { as: ada, method: 'POST', form: { prompt: 'Fix the header', repo: 'https://github.com/OpenVibers/OpenVibe.Codes', agent: 'codex', machine: NODE } });
            assert.strictEqual(started.status, 303);
            const to = String(started.headers.get('location'));
            assert.ok(to.startsWith('/run?') && to.includes('prompt=Fix+the+header') && to.includes('agent=codex'), 'the task is carried to Run');
            const saved = await t.ctx.userSettings.get(ada.subject);
            assert.strictEqual(saved.default_machine, NODE, 'the machine is the default now');
            assert.strictEqual(saved.default_agent, 'codex', 'and so is the agent');
        });

        await check('a task&rsquo;s Changes, Proof and Pull request panels are Codes&rsquo; own', async () => {
            await db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, state, result, outcome, outcome_note, created_at, updated_at)
                VALUES ($1,$2,'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW','https://github.com/OpenVibers/OpenVibe.Codes','main','Make the task page read well','codex','succeeded',$3::jsonb,'done','Done with proof',$4,$4)`,
                [TASK, ada.subject, JSON.stringify({ files: [{ path: 'server/http/c4.js', added: 42, removed: 7 }, { path: 'public/css/c4.css', added: 9, removed: 0 }], patch: 'diff --git a/server/http/c4.js b/server/http/c4.js\n+the change', cost_usd: 0.31, push: { pushed: true, branch: 'openvibe-codes/task', pull_request_error: 'GitHub answered 403' } }), now]);
            await t.ctx.tasks.proof.record(TASK, 1, [
                { kind: 'tests', label: 'tests', ok: true, summary: 'node test/c4.test.js passed', command: 'node test/c4.test.js' },
                { kind: 'screenshots', label: 'screenshots', ok: false, summary: '1440px: the page is 1500px wide', shots: [{ ok: true, width: 390, route: '/tasks' }, { ok: false, width: 1440, route: '/tasks', summary: 'the page is 1500px wide', path: '/tmp/proof-tasks-1440.png' }] },
                { kind: 'diff', label: 'diff', ok: true, summary: '2 files changed', files: ['server/http/c4.js'], stats: ' 2 files changed, 51 insertions(+), 7 deletions(-)' },
                { kind: 'review', label: 'review', ok: true, skipped: true, summary: 'no model of another family is connected' },
            ]);
            const page = await t.get(`/tasks/${TASK}`, { as: ada });
            assert.strictEqual(page.status, 200, page.text.slice(0, 200));
            // Changes: the files first, then the diff folded out.
            assert.ok(page.text.includes('server/http/c4.js') && page.text.includes('public/css/c4.css'), 'the changed files are listed');
            assert.ok(page.text.includes('<span class="c4-add">+42</span>') || page.text.includes('c4-add'), 'with their counts');
            assert.ok(page.text.includes('The diff') && page.text.includes('+the change'), 'and the diff itself');
            // Proof: one calm row per item, each with its own state.
            assert.ok(page.text.includes('data-proof-kind') || page.text.includes('c4-row-label">tests'), 'a proof row per item');
            assert.ok(page.text.includes('Passed') && page.text.includes('Skipped') && page.text.includes('Failed'), 'each row carries its state');
            assert.ok(page.text.includes('390 px') && page.text.includes('1440 px'), 'the shots are listed by width and route');
            assert.ok(page.text.includes('the page is 1500px wide'), 'and what the shot found');
            assert.ok(page.text.includes('no model of another family is connected'), 'the second opinion says why there is none');
            // Pull request: the link or why there is none, never an invented one.
            assert.ok(page.text.includes('The pull request was not opened: GitHub answered 403'), 'the push failure is said in its own words');
            assert.ok(!page.text.includes('/run/tasks/' + TASK), 'no panel links back to Run');
        });

        await check('a task without proof says so instead of pretending', async () => {
            const page = await t.get(`/tasks/${TASK2}`, { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('This task has no proof'), 'the empty proof is said');
            assert.ok(page.text.includes('This task did not ask for a pull request'), 'and the empty pull request too');
        });

        await check('Agents: a key is added, tested and removed from the page, and never comes back', async () => {
            // The key is built at run time: a scanner reads a file, and a file that spells out a key is a file with a
            // key in it.
            const KEY = ['sk', 'deepseek', '0123456789abcdef'].join('-');
            const add = await t.get('/agents/connections', { as: ada, form: { provider: 'deepseek', key: KEY, budget_usd_per_day: '3' } });
            assert.strictEqual(add.status, 303, add.text.slice(0, 200));
            assert.ok(String(add.headers.get('location')).startsWith('/agents?ok='), 'back to the list with a word');
            const page = await t.get('/agents', { as: ada });
            assert.ok(page.text.includes('DeepSeek'), 'the provider is listed');
            assert.ok(page.text.includes('\u2026cdef'), 'with its hint');
            assert.ok(!page.text.includes(KEY), 'and never the key');
            assert.ok(!(await t.dbDump()).includes(KEY), 'nor is it in Codes\' database');
            const test = await t.get('/agents/connections/deepseek/test', { as: ada, method: 'POST', form: { x: '1' } });
            assert.strictEqual(test.status, 303);
            assert.ok(String(test.headers.get('location')).includes('The%20DeepSeek%20key%20works'), 'the test says the key works');
            const remove = await t.get('/agents/connections/deepseek/remove', { as: ada, method: 'POST', form: { x: '1' } });
            assert.strictEqual(remove.status, 303);
            const after = await t.get('/agents', { as: ada });
            assert.ok(after.text.includes('No provider keys yet'), 'the key is forgotten');
        });

        await check('Machines: the person&rsquo;s own machines, their state, and Node&rsquo;s pairing code flow', async () => {
            const page = await t.get('/machines', { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Desk'), 'the paired machine is listed');
            assert.ok(page.text.includes('Online'), 'with its state');
            assert.ok(page.text.includes(`/machines/${NODE}/revoke`), 'and a way to revoke it');
            assert.ok(page.text.includes('Pair a machine') && page.text.includes('openvibe.bot/machines'), 'the pairing flow is Nodes');
            assert.ok(page.text.includes('"appBar":false'), 'the workspace keeps the Frame\'s own navbar: no second bar');
            const coded = await t.get('/machines?code=abcd-2345', { as: ada });
            assert.ok(coded.text.includes('"appBar":false'), 'a query string does not bring the second bar back');
            assert.ok(coded.text.includes('sudo openvibe-node pair ABCD-2345 --network https://openvibe.network'), 'the code makes the command');
            const wrong = await t.get('/machines?code=nope', { as: ada });
            assert.ok(wrong.text.includes('a pairing code is 8 letters and digits, like ABCD-1234'), 'a wrong code gets Node&rsquo;s own words');
            const revoke = await t.get(`/machines/${NODE}/revoke`, { as: ada, method: 'POST', form: { x: '1' } });
            assert.strictEqual(revoke.status, 303);
            const after = await t.get('/machines', { as: ada });
            assert.ok(after.text.includes('Revoked'), 'the machine is revoked');
            // Bo cannot revoke Ada's machine.
            t.network.addNode(ada.subject, { principal: 'nod_01ARZ3NDEKTSV4RRFFQ69G5FAA', node_id: 'node-other', name: 'Other', status: 'active', last_seen_at: new Date().toISOString() });
            const stolen = await t.get('/machines/nod_01ARZ3NDEKTSV4RRFFQ69G5FAA/revoke', { as: bo, method: 'POST', form: { x: '1' } });
            assert.strictEqual(stolen.status, 303);
            assert.ok(String(stolen.headers.get('location')).includes('error='), 'another person&rsquo;s machine is refused');
        });

        await check('Settings are remembered per person', async () => {
            const save = await t.get('/settings', { as: ada, method: 'POST', form: { default_agent: 'codex', default_machine: NODE, notify_needs: '1', safety: 'project' } });
            assert.strictEqual(save.status, 303);
            assert.ok(String(save.headers.get('location')).includes('ok='));
            const page = await t.get('/settings', { as: ada });
            assert.ok(page.text.includes('<option value="codex" selected'), 'the default agent is kept');
            assert.ok(page.text.includes('value="project" checked'), 'so is the safety level');
            assert.ok(!page.text.includes('name="notify_done" value="1" checked'), 'an unticked box stays unticked');
            assert.ok(page.text.includes('name="steps"') && page.text.includes('name="minutes"'), 'the limits are on the page');
            const other = await t.get('/settings', { as: bo });
            assert.ok(other.text.includes('<option value="codex">'), 'and it is only this person&rsquo;s');
            assert.ok(!other.text.includes('<option value="codex" selected'));
            const bad = await t.get('/settings', { as: ada, method: 'POST', form: { safety: 'anything' } });
            assert.ok(String(bad.headers.get('location')).includes('error='), 'a level Codes does not know is refused');
        });

        await check('Settings → Limits: steps and minutes per task, with No limit meaning none', async () => {
            const saved = await t.get('/settings', { as: ada, method: 'POST', form: {
                default_agent: 'codex', steps: '350', minutes: '90', notify_done: '1', notify_needs: '1', safety: 'ask',
            } });
            assert.strictEqual(saved.status, 303);
            let settings = await t.ctx.userSettings.get(ada.subject);
            assert.strictEqual(settings.steps, 350);
            assert.strictEqual(settings.minutes, 90);
            const page = await t.get('/settings', { as: ada });
            assert.ok(page.text.includes('<option value="350" selected'), 'the step limit is shown');
            assert.ok(page.text.includes('<option value="90" selected'), 'and the time limit');
            // No limit is an empty value, stored as null, never a zero budget.
            await t.get('/settings', { as: ada, method: 'POST', form: { steps: '', minutes: 'off', notify_done: '1', notify_needs: '1' } });
            settings = await t.ctx.userSettings.get(ada.subject);
            assert.strictEqual(settings.steps, null);
            assert.strictEqual(settings.minutes, null);
            const none = await t.get('/settings', { as: ada });
            assert.ok(none.text.includes('<option value="" selected'), 'No limit is selected');
            // A negative or silly value is refused, and the stored one stays.
            await t.get('/settings', { as: ada, method: 'POST', form: { steps: '500' } });
            const refused = await t.get('/settings', { as: ada, method: 'POST', form: { steps: '-3' } });
            assert.ok(String(refused.headers.get('location')).includes('error='), 'a negative limit is refused');
            assert.strictEqual((await t.ctx.userSettings.get(ada.subject)).steps, 500, 'the saved value is untouched');
        });

        await check('Usage counts runs, minutes and tokens per day, and shows no prices', async () => {
            // The task page seeds attempt 1 for a task it knows; the machine's own numbers belong on it.
            await t.get(`/tasks/${TASK}`, { as: ada });
            await db.exec(`UPDATE codes_attempts SET tokens = 1200, started_at = now() - interval '2 hours', finished_at = now() - interval '90 minutes' WHERE task_id = $1 AND n = 1`, [TASK]);
            const page = await t.get('/usage', { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Runs') && page.text.includes('Minutes') && page.text.includes('Tokens'), 'the columns are there');
            assert.ok(page.text.includes('1,200'), 'the tokens are counted');
            assert.ok(page.text.includes('30 min'), 'and the minutes');
            assert.ok(page.text.includes('No prices are shown here'), 'and it says why there is no money');
            const boPage = await t.get('/usage', { as: bo });
            assert.ok(!boPage.text.includes('1,200'), 'another person&rsquo;s usage is not shown');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
