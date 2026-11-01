'use strict';

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const ada = t.network.addUser('c4-ada');
    try {
        await check('all C4 pages render readable server content without JavaScript', async () => {
            for (const [path, label] of [['/', 'What should an agent do?'], ['/tasks', 'Tasks'], ['/agents', 'Agents'], ['/machines', 'Machines'], ['/usage', 'Usage'], ['/settings', 'Settings']]) {
                const r = await t.get(path);
                assert.strictEqual(r.status, 200, `${path} status`);
                assert.ok(r.text.includes(label), `${path} content`);
                assert.ok(r.text.includes('ov-workspace'), `${path} reserves the Frame app bar's height`);
            }
            const task = await t.get('/tasks/tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV');
            assert.strictEqual(task.status, 200);
            assert.ok(task.text.includes('Sign in to see your work'));
        });

        await check('a visitor gets the front door, never empty panels (owner, 10-31)', async () => {
            const home = await t.get('/');
            assert.strictEqual(home.status, 200);
            const h = home.text;
            assert.ok(h.includes('Every coding agent.') && h.includes('One place.'), 'the hero');
            assert.ok(h.includes('class="c4-demo"') && h.includes('Codex took over: Claude Code hit its plan limit'), 'a conversation that shows a hand-over');
            assert.ok(h.includes('id="how"') && h.includes('Pick who works on it'), 'how it works');
            assert.ok(h.includes('Your plans, your keys, your machine') && h.includes('A conductor for the big jobs'));
            assert.ok(h.includes('action="/start"') && h.includes('id="c4-prompt"'), 'the composer is the start');
            assert.ok(!h.includes('<h2>Running</h2>') && !h.includes('<h2>Recent tasks</h2>') && !h.includes('No tasks yet'), 'no empty panels for a visitor');
            assert.match(require('fs').readFileSync(require('path').join(__dirname, '..', 'server/http/c4.js'), 'utf8'), /if \(!signedIn\) return page\(req, res, null, wrap\(visitorHome\(\)\)/, 'the route sends a visitor to the front door');
        });

        await check('task details are owner scoped and management pages honor sign-in', async () => {
            const settings = await t.get('/settings', { as: ada });
            assert.strictEqual(settings.status, 200);
            assert.ok(settings.text.includes('Safety'));
            assert.ok(settings.text.includes('Save settings'));
            assert.ok(!settings.text.includes('Sign in to see your work'));
            const hidden = await t.get('/tasks/tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV', { as: ada });
            assert.strictEqual(hidden.status, 404);
        });

        await check('a signed-in person&rsquo;s home and tasks are the chat app (plan L31)', async () => {
            const home = await t.get('/', { as: ada });
            assert.ok(!home.text.includes('Built for the way you work'));
            assert.ok(!home.text.includes('Recently shipped on'));
            assert.ok(home.text.includes('What should we build') && home.text.includes('owner/name or any Git URL') && home.text.includes('name="mode"'), 'the greeting, the three ways to start and the repository');
            assert.ok(home.text.includes('action="/chat"') && home.text.includes('data-ch-composer'), 'one composer that starts the conversation');
            const id = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV';
            await t.ctx.store.db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, state, result, error, created_at, updated_at)
                VALUES ($1,$2,'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW','https://github.com/OpenVibers/OpenVibe.Codes','main','Fix the full brief and keep the workspace readable on a phone','codex','failed','{"cost":0.42}'::jsonb,'The machine stopped.',$3,$3)`, [id, ada.subject, Date.now()]);
            const task = await t.get(`/tasks/${id}`, { as: ada });
            assert.strictEqual(task.status, 200);
            assert.ok(task.text.includes('class="ch-bubble">Fix the full brief and keep the workspace readable on a phone'), 'the brief is the first message');
            assert.ok(task.text.includes("Didn&#39;t finish") || task.text.includes('Didn\'t finish'), 'the state is said in words');
            assert.ok(task.text.includes('Same agent (Codex)'), 'the composer carries on with the same agent, or another one');
            assert.ok(task.text.includes(`action="/tasks/${id}/continue"`), 'the next message is the next turn');
            assert.ok(task.text.includes('>OpenVibers/OpenVibe.Codes</a>'), 'the repository by its name');
            assert.ok(!task.text.includes('>https://github.com/'), 'never a bare URL');
            assert.ok(!task.text.includes('data-ch-stream'), 'a finished task does not stream');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
