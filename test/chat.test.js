'use strict';

// Codes as a chat app (plan L31 CH1): a signed-in person's / and /tasks/:id are one app. The rail holds their own
// conversations only; the thread shows the brief, each agent's turn with its steps, a hand-over as a divider and a
// carry-on as their next message; a new chat starts a task from the composer; the step kinds name what an agent did.
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { stepKind } = require('../server/http/chat');

(async () => {
    const t = await boot();
    const ada = t.network.addUser('chat-ada');
    const bo = t.network.addUser('chat-bo');
    const db = t.ctx.store.db;
    const now = Date.now();
    const P = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const MINE = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FB1', THEIRS = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FB2';
    try {
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, state, result, created_at, updated_at) VALUES
            ($1, $2, $5, 'https://github.com/OpenVibers/OpenVibe.Live', 'main', 'Fit the home page to a 360 px phone', 'claude-code', 'succeeded', '{"files":[{"path":"public/css/home.css","added":3,"removed":1}]}'::jsonb, $6, $6),
            ($3, $4, $5, 'https://github.com/OpenVibers/OpenVibe.Meme', 'main', 'Someone else entirely', 'codex', 'succeeded', '{}'::jsonb, $6, $6)`,
            [MINE, ada.subject, THEIRS, bo.subject, P, now - 60_000]);
        await db.exec(`INSERT INTO codes_attempts (id, task_id, n, agent, model, state, reason, why, kind, created_at) VALUES
            ('att_01ARZ3NDEKTSV4RRFFQ69G5FC1', $1, 1, 'codex', 'gpt-5.5', 'failed', 'limit', 'the router picked Codex', 'first', now() - interval '50 minutes'),
            ('att_01ARZ3NDEKTSV4RRFFQ69G5FC2', $1, 2, 'claude-code', 'opus', 'done', null, 'Codex hit its limit', 'switch', now() - interval '40 minutes'),
            ('att_01ARZ3NDEKTSV4RRFFQ69G5FC3', $1, 3, 'claude-code', 'opus', 'done', null, 'carried on by the owner: Keep the titles on one line.', 'manual', now() - interval '30 minutes')`, [MINE]);
        await db.exec(`INSERT INTO codes_session_lines (task_id, seq, at, kind, body, attempt_n) VALUES
            ($1, 1, now() - interval '49 minutes', 'tool', '{"t":"tool","name":"Read","what":"public/css/home.css"}', 1),
            ($1, 2, now() - interval '39 minutes', 'tool', '{"t":"tool","name":"Edit","what":"public/css/home.css"}', 2),
            ($1, 3, now() - interval '38 minutes', 'done', '{"t":"done","ok":true,"text":"The clips rail now **scrolls sideways**."}', 2),
            ($1, 4, now() - interval '29 minutes', 'done', '{"t":"done","ok":true,"text":"Titles stay on one line."}', 3)`, [MINE]);

        await check('the rail holds the person&rsquo;s own conversations, and only theirs', async () => {
            const page = await t.get('/', { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Fit the home page to a 360 px phone'), 'their conversation is in the rail');
            assert.ok(!page.text.includes('Someone else entirely'), 'another person&rsquo;s is not');
            assert.ok(page.text.includes('<p class="ch-group">Today</p>'), 'grouped by when it last moved');
            const theirs = await t.get(`/tasks/${THEIRS}`, { as: ada });
            assert.notStrictEqual(theirs.status, 200, 'another person&rsquo;s conversation does not open');
        });

        await check('the thread: the brief, each agent&rsquo;s turn, a hand-over and the next message', async () => {
            const page = await t.get(`/tasks/${MINE}`, { as: ada });
            assert.strictEqual(page.status, 200);
            const text = page.text;
            const brief = text.indexOf('class="ch-bubble">Fit the home page');
            const handover = text.indexOf('Claude Code took over');
            const answer = text.indexOf('<strong>scrolls sideways</strong>');
            const next = text.indexOf('class="ch-bubble">Keep the titles on one line.');
            const last = text.indexOf('Titles stay on one line.');
            assert.ok(brief > -1 && handover > brief && answer > handover && next > answer && last > next, 'in the order it happened');
            assert.ok(text.includes('data-kind="read"') && text.includes('data-kind="edit"'), 'each step carries its kind');
            assert.ok(text.includes('1 file changed') && text.includes('<span class="ch-add">+3</span>'), 'how it ended: the files');
            assert.ok(text.includes(`action="/tasks/${MINE}/continue"`), 'the composer carries it on');
            assert.ok(text.includes('aria-current="page"'), 'the rail marks the open conversation');
        });

        await check('a new chat starts a task from the composer, and an empty one is refused in words', async () => {
            const empty = await t.get('/chat', { as: ada, form: { text: '  ', repo: 'https://github.com/OpenVibers/OpenVibe.Live' } });
            assert.strictEqual(empty.status, 303);
            assert.match(empty.headers.get('location'), /^\/\?error=Write%20what%20you%20want%20done%20first/);
            const made = await t.get('/chat', { as: ada, form: { text: 'Make the footer quieter', repo: 'https://github.com/OpenVibers/OpenVibe.Live', agent: '' } });
            assert.strictEqual(made.status, 303, made.text.slice(0, 200));
            const at = made.headers.get('location');
            assert.match(at, /^\/tasks\/tsk_[0-9A-Z]{26}$/, `opens the new conversation (${at})`);
            const row = await db.maybe('SELECT prompt, subject FROM run_tasks WHERE id = $1', [at.split('/').pop()]);
            assert.ok(row && row.prompt === 'Make the footer quieter' && row.subject === ada.subject, 'the brief is the person&rsquo;s own task');
        });

        await check('a visitor who is not signed in gets the product&rsquo;s home, not the app', async () => {
            const page = await t.get('/');
            assert.strictEqual(page.status, 200);
            assert.ok(!page.text.includes('data-chat'), 'no chat app');
        });

        await check('the step kinds name what an agent did, whatever the agent calls its tools', async () => {
            const kinds = { Read: 'read', read_file: 'read', Glob: 'read', Grep: 'find', Edit: 'edit', apply_patch: 'edit', Write: 'edit', Bash: 'run', shell: 'run', WebFetch: 'web', WebSearch: 'web', Task: 'sub', mcp__codes__fleet: 'tool' };
            for (const [name, kind] of Object.entries(kinds)) assert.strictEqual(stepKind(name), kind, name);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
