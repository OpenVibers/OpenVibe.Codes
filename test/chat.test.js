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
            assert.ok(page.text.includes('<h2 class="ovk-sidebar-h">Today</h2>'), 'grouped by when it last moved');
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
            assert.match(empty.headers.get('location'), /^\/\?error=Write%20what%20you%20want%20made%20or%20changed%20first.*&repo=/, 'refused in words, and the repository is kept');
            const made = await t.get('/chat', { as: ada, form: { text: 'Make the footer quieter', repo: 'https://github.com/OpenVibers/OpenVibe.Live', agent: '' } });
            assert.strictEqual(made.status, 303, made.text.slice(0, 200));
            const at = made.headers.get('location');
            assert.match(at, /^\/tasks\/tsk_[0-9A-Z]{26}$/, `opens the new conversation (${at})`);
            const row = await db.maybe('SELECT prompt, subject FROM run_tasks WHERE id = $1', [at.split('/').pop()]);
            assert.ok(row && row.prompt === 'Make the footer quieter' && row.subject === ada.subject, 'the brief is the person&rsquo;s own task');
        });

        // The owner, 2026-11-01: pick an OpenVibe project without typing a URL, any Git, and "something new" for people
        // who have never coded, handed to openvibe.space.
        await check('a new chat offers three ways to start, each saying where it runs, and an ideas rail', async () => {
            const home = await t.get('/', { as: ada });
            const h = home.text;
            ['new', 'openvibe', 'code'].forEach((v) => assert.match(h, new RegExp(`<input type="radio" name="mode" value="${v}" form="ch-start"`), `the ${v} card belongs to the form`));
            assert.ok(h.includes('<form class="ch-composer" id="ch-start"'), 'the composer is the form the cards name');
            assert.ok(!/name="repo"[^>]*required/.test(h), 'the repository is not required: something new needs none');
            assert.match(h, /<select name="project"[^>]*>[\s\S]*?<option value="OpenVibers\/OpenVibe\.Live"[^>]*>Live · openvibe\.live<\/option>/, 'OpenVibe projects are a list');
            assert.match(h, /<option value="OpenVibers\/OpenVibe\.Shared"/, 'the shared libraries too');
            assert.match(h, /<select name="kind"[^>]*>[\s\S]*?>Website<\/option>[\s\S]*?>Game<\/option>/, 'something new is a website, a game or an app');
            assert.match(h, /class="ch-where"[\s\S]*?openvibe\.space[\s\S]*?Runs on/, 'each way says where it runs');
            assert.match(h, /<section class="ch-spark" aria-label="Ideas to start from"[^>]*data-ch-ideasets="/, 'the ideas rail, with every set for the script');
            assert.match(h, /<ul class="ch-spark-list" aria-hidden="true">[\s\S]*?tabindex="-1"/, 'the loop copy is hidden from the keyboard and assistive tech');
            assert.match(h, /data-ch-ideas-pause aria-pressed="false" aria-label="Pause the ideas"/, 'the moving rail has a pause');
            const fresh = await t.get('/?mode=new&kind=game', { as: ada });
            assert.match(fresh.text, /value="new" form="ch-start" checked/, 'the chosen way is kept');
            assert.match(fresh.text, /<option value="game" selected>Game<\/option>/);
            assert.match(fresh.text, /data-ch-idea-mode="new" data-ch-idea-kind="website"[\s\S]*?data-ch-idea-kind="game"[\s\S]*?data-ch-idea-kind="app"/, 'something new mixes the three kinds');
        });

        await check('something new goes to openvibe.space with the words in the box, and nothing is built here', async () => {
            const before = await db.maybe('SELECT count(*)::int AS n FROM run_tasks WHERE subject = $1', [ada.subject]);
            const r = await t.get('/chat', { as: ada, form: { mode: 'new', kind: 'game', text: 'Snake with a leaderboard & sound' } });
            assert.strictEqual(r.status, 303);
            const at = new URL(r.headers.get('location'));
            assert.strictEqual(at.origin, 'https://openvibe.space');
            assert.strictEqual(at.pathname, '/auth/login', 'through sign-in, which keeps the query');
            const next = new URL(at.searchParams.get('next'), 'https://openvibe.space');
            assert.strictEqual(next.pathname, '/spaces/new');
            assert.strictEqual(next.searchParams.get('prompt'), 'A browser game: Snake with a leaderboard & sound');
            assert.strictEqual(next.searchParams.get('from'), 'codes');
            const site = await t.get('/chat', { as: ada, form: { mode: 'new', kind: 'website', text: 'My bakery website with hours' } });
            const said = new URL(new URL(site.headers.get('location')).searchParams.get('next'), 'https://x').searchParams.get('prompt');
            assert.strictEqual(said, 'My bakery website with hours', 'words that already say what it is are not led');
            const long = await t.get('/chat', { as: ada, form: { mode: 'new', kind: 'app', text: 'ほ'.repeat(3000) } });
            assert.ok(long.headers.get('location').length <= 6000, 'a long description is cut until the address fits');
            const after = await db.maybe('SELECT count(*)::int AS n FROM run_tasks WHERE subject = $1', [ada.subject]);
            assert.strictEqual(after.n, before.n, 'no task was made');
        });

        await check('an OpenVibe project is picked from the list, and any Git address is read as https', async () => {
            const pick = await t.get('/chat', { as: ada, form: { mode: 'openvibe', project: 'OpenVibers/OpenVibe.Games', text: 'Add a daily challenge' } });
            assert.match(pick.headers.get('location'), /^\/tasks\/tsk_/, pick.headers.get('location'));
            const row = await db.maybe('SELECT repo FROM run_tasks WHERE id = $1', [pick.headers.get('location').split('/').pop()]);
            assert.strictEqual(row.repo, 'https://github.com/OpenVibers/OpenVibe.Games');
            const stranger = await t.get('/chat', { as: ada, form: { mode: 'openvibe', project: 'evil/repo', text: 'x y z' } });
            assert.match(stranger.headers.get('location'), /error=Pick%20one%20of%20the%20OpenVibe%20projects/);
            const ssh = await t.get('/chat', { as: ada, form: { mode: 'code', repo: 'git@gitlab.com:someone/thing.git', text: 'Fix the build' } });
            const sshRow = await db.maybe('SELECT repo FROM run_tasks WHERE id = $1', [ssh.headers.get('location').split('/').pop()]);
            assert.strictEqual(sshRow.repo, 'https://gitlab.com/someone/thing.git', 'an ssh address becomes its https twin');
            const short = await t.get('/chat', { as: ada, form: { mode: 'code', repo: 'OpenVibers/OpenVibe.Chat', text: 'Fix the build' } });
            const shortRow = await db.maybe('SELECT repo FROM run_tasks WHERE id = $1', [short.headers.get('location').split('/').pop()]);
            assert.strictEqual(shortRow.repo, 'https://github.com/OpenVibers/OpenVibe.Chat', 'owner/name is a GitHub repository');
            const secret = await t.get('/chat', { as: ada, form: { mode: 'code', repo: 'https://user:pass@example.com/a/b', text: 'Fix it' } });
            assert.match(secret.headers.get('location'), /error=That%20is%20not%20a%20Git%20address/, 'a password in the address is refused');
            assert.ok(!/user(%3A|:)pass/.test(secret.headers.get('location')), 'and it is not written back into the address');
            const none = await t.get('/chat', { as: ada, form: { mode: 'code', repo: '', text: 'Fix it' } });
            assert.match(none.headers.get('location'), /error=Pick%20a%20repository/, 'no repository is asked for in words');
        });

        await check('the effort a person picks rides on the first attempt, and the thread says it in words', async () => {
            const made = await t.get('/chat', { as: ada, form: { text: 'Think hard about the cache', repo: 'https://github.com/OpenVibers/OpenVibe.Live', effort: 'high' } });
            assert.strictEqual(made.status, 303);
            const id = made.headers.get('location').split('/').pop();
            const att = await db.maybe('SELECT effort FROM codes_attempts WHERE task_id = $1 ORDER BY n LIMIT 1', [id]);
            assert.ok(att && att.effort === 'high', `the attempt keeps it (${att && att.effort})`);
            const home = await t.get('/', { as: ada });
            assert.ok(home.text.includes('name="effort"') && home.text.includes('>Thorough</option>'), 'the composer offers it in plain words');
        });

        await check('who works on it: an agent and its model in one control, kept on the first attempt (L31 CH5)', async () => {
            const home = await t.get('/', { as: ada });
            assert.ok(home.text.includes('name="who"') && home.text.includes('value="claude-code|sonnet"') && home.text.includes('Claude Code · Sonnet'), 'the choices in words');
            const made = await t.get('/chat', { as: ada, form: { text: 'A quick fix', repo: 'https://github.com/OpenVibers/OpenVibe.Live', who: 'claude-code|sonnet' } });
            assert.strictEqual(made.status, 303);
            const id = made.headers.get('location').split('/').pop();
            const att = await db.maybe('SELECT agent, model FROM codes_attempts WHERE task_id = $1 ORDER BY n LIMIT 1', [id]);
            assert.ok(att && att.model === 'sonnet', `the model rides on the attempt (${JSON.stringify(att)})`);
            const bad = await t.get('/chat', { as: ada, form: { text: 'x', repo: 'https://github.com/OpenVibers/OpenVibe.Live', who: 'claude-code|gpt-9' } });
            assert.match(bad.headers.get('location'), /Choose%20who%20works%20on%20it/, 'a model Codes does not offer is refused in words');
            const cat = await t.get('/api/v1/harnesses/models');
            assert.strictEqual(cat.status, 200);
            const claude = cat.json().agents.find((a) => a.agent === 'claude-code');
            assert.ok(claude && claude.models.some((m) => m.id === 'opus' && /strongest/.test(m.note)) && claude.efforts.includes('max'), 'the public catalogue says what each offers');
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
