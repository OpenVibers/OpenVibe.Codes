'use strict';

// Codes' turns in the network's conversation kit (openvibe-shared/thread): a turn is what the person said and what
// the agent answered, the answer is Markdown (headings, lists, tables, code with its language and a Copy button,
// links marked nofollow), each tool call is a row with its name, its one line and how it ended, and a long output
// folds behind a fold that says how much is in it. Nothing an agent writes ever becomes HTML.

const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const md = require('../public/js/md.js');

(async () => {
    const t = await boot();
    const ada = t.network.addUser('kit-ada');
    const db = t.ctx.store.db;
    const now = Date.now();
    const P = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const MINE = 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FD1';
    const ANSWER = [
        '# What changed',
        '',
        'The rail scrolls sideways now. See [the notes](https://example.com/notes).',
        '',
        '- one line',
        '- another',
        '',
        '```js',
        'const rail = document.querySelector(".ovt-rail");',
        '```',
        '',
        '| file | lines |',
        '| --- | --- |',
        '| public/css/chat.css | 12 |',
        '',
        'And a script tag: <script>alert("no")</script>',
    ].join('\n');
    const OUTPUT = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    try {
        await db.exec(`INSERT INTO run_tasks (id, subject, project_id, repo, ref, prompt, agent, state, result, created_at, updated_at)
            VALUES ($1, $2, $3, 'https://github.com/OpenVibers/OpenVibe.Live', 'main', 'Make the rail scroll sideways', 'claude-code', 'succeeded', '{}'::jsonb, $4, $4)`,
        [MINE, ada.subject, P, now - 60_000]);
        await db.exec(`INSERT INTO codes_attempts (id, task_id, n, agent, model, state, why, kind, created_at)
            VALUES ('att_01ARZ3NDEKTSV4RRFFQ69G5FE1', $1, 1, 'claude-code', 'opus', 'done', 'The rail scrolls sideways', 'first', now() - interval '50 minutes')`, [MINE]);
        await db.exec(`INSERT INTO codes_session_lines (task_id, seq, at, kind, body, attempt_n) VALUES
            ($1, 1, now() - interval '49 minutes', 'tool', $2::jsonb, 1),
            ($1, 2, now() - interval '48 minutes', 'tool_result', $3::jsonb, 1),
            ($1, 3, now() - interval '47 minutes', 'done', $4::jsonb, 1)`,
        [MINE,
            JSON.stringify({ t: 'tool', id: 'call-1', name: 'Edit', what: 'public/css/chat.css' }),
            JSON.stringify({ t: 'tool_result', id: 'call-1', ok: true, output: OUTPUT }),
            JSON.stringify({ t: 'done', ok: true, text: ANSWER })]);

        const page = await t.get(`/tasks/${MINE}`, { as: ada });
        assert.strictEqual(page.status, 200);

        await check('the answer is Markdown: headings, lists, a table, code with its language and Copy, safe links', async () => {
            const text = page.text;
            assert.ok(text.includes('<div class="ovt-answer" data-ovt-answer>'), 'the answer is the kit\'s own');
            assert.ok(text.includes('<h2>What changed</h2>'), 'a heading');
            assert.ok(text.includes('<ul><li>one line</li><li>another</li></ul>'), 'a list');
            assert.ok(text.includes('<table><thead><tr><th>file</th><th>lines</th></tr></thead>'), 'a table');
            assert.ok(text.includes('<code data-lang="js" class="language-js">'), 'the code block says its language');
            assert.ok(text.includes('data-ovt-code-copy'), 'the code block has a Copy button');
            assert.ok(text.includes('data-ovt-copy'), 'and the answer has one too');
            assert.ok(text.includes('<a href="https://example.com/notes" rel="nofollow ugc noopener" target="_blank">the notes</a>'), 'a link says what it is');
        });

        await check('a tool call is a row: its name, the one line it was given, and how it ended', async () => {
            const text = page.text;
            assert.ok(text.includes('<li class="ovt-w-tool is-ok">'), 'the row is the kit\'s, and it worked');
            assert.ok(text.includes('<b>Edit</b>'), 'the name');
            assert.ok(text.includes('<span class="ovt-w-in">public/css/chat.css</span>'), 'the one line it was given');
            assert.ok(text.includes('<span class="ovt-w-st">'), 'and the mark that says how it ended');
        });

        await check('a long output folds, and the fold says how much is in it', async () => {
            const text = page.text;
            assert.ok(text.includes('Output (12 lines)'), 'the count is on the fold');
            assert.ok(text.includes('<details>') && text.includes('<pre class="ovt-w-out">'), 'the output is folded away');
        });

        await check('the renderer itself escapes first and marks up afterwards', async () => {
            const html = md.markdown('# Title\n\nA [link](https://example.com) and <script>x</script>');
            assert.ok(html.includes('<h2>Title</h2>'), 'a heading');
            assert.ok(html.includes('rel="nofollow ugc noopener"'), 'a link says what it is');
            assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'), 'and a script tag stays words');
            assert.ok(!html.includes('<script>'), 'never a script');
        });

        await check('a script tag in the agent\'s words is words, not a script', async () => {
            const text = page.text;
            assert.ok(text.includes('&lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt;'), 'it is escaped');
            assert.ok(!text.includes('<script>alert'), 'and never a script');
        });

        await check('the turn is drawn by the server: the page says it all without a script', async () => {
            const text = page.text;
            assert.ok(text.includes('<li class="ovt-turn"') && text.includes('class="ovt-bubble">Make the rail scroll sideways'), 'the turn and the brief are in the page');
            assert.ok(text.includes('<details class="ovt-work">') || text.includes('<details class="ovt-work"'), 'the work folds under the answer');
            assert.ok(text.includes('data-ovt-answer'), 'the answer is there to be read');
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
