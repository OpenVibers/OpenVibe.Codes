'use strict';
/**
 * Improve OpenVibe as a guided run (server/http/pages.js): the landing page lists every OpenVibe repository and links
 * to a per-repo page; the repo page shows the contribution path and a form for signed-in users; posting it starts the
 * same Run task as /run, in one of the person's projects (creating one if necessary), and redirects to the task page.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const calls = [];
    const run = {
        enabled: true,
        async submit(o) { calls.push(['submit', o]); return { id: 'job_01J8Z3Q4R5S6T7V8W9X0Y1Z2J1', state: 'queued' }; },
        async read() { return { state: 'queued' }; },
        async cancel() { return { state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const t = await boot({ run });
    const ada = t.network.addUser('ada');
    const post = (p, as, form, headers = {}) => t.get(p, { as, form, headers, method: 'POST' });

    try {
        await check('the Improve OpenVibe landing lists repositories from the contracts manifests', async () => {
            const r = await t.get('/improve');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('Improve OpenVibe'));
            assert.ok(r.text.includes('href="/improve/OpenVibers/OpenVibe.Codes"'), r.text);
            assert.ok(r.text.includes('OpenVibe.Codes'));
        });

        await check('the landing is step 1 of 4, and one search box narrows the repositories (no JavaScript needed)', async () => {
            const all = await t.get('/improve');
            assert.ok(all.text.includes('<nav class="ovk-steps"') && all.text.includes('Step 1 of 4') && all.text.includes('aria-current="step"'), 'the steps');
            assert.ok(all.text.includes('<form class="ovk-find"') && all.text.includes('name="q"'), 'the search box');
            assert.ok(all.text.includes('Services · ') && all.text.includes('Shared libraries · '), 'both groups, counted');
            const some = await t.get('/improve?q=codes');
            assert.ok(some.text.includes('href="/improve/OpenVibers/OpenVibe.Codes"'), 'a match stays');
            assert.ok(!some.text.includes('href="/improve/OpenVibers/OpenVibe.Shared"'), 'a non-match goes');
            assert.ok(/<meta name="robots" content="noindex/.test(some.text), 'a search result is not indexed');
            const none = await t.get('/improve?q=zzzz-nothing');
            assert.ok(none.text.includes('No repository matches') && none.text.includes('href="/improve"'), 'an empty search says so and offers every repository');
        });

        await check('a repository page is step 2: describe the change; the clone command and the run explanation fold', async () => {
            const r = await t.get('/improve/OpenVibers/OpenVibe.Codes', { as: ada });
            assert.ok(r.text.includes('Step 2 of 4') && r.text.includes('href="/improve"'), 'step 2, with step 1 linking back');
            assert.ok(r.text.includes('Clone it yourself') && r.text.includes('git clone '), 'the clone command, folded');
            assert.ok(r.text.indexOf('name="prompt"') < r.text.indexOf('How the run works'), 'the form comes before the explanation');
        });

        await check('a repository page shows the guided path and asks guests to sign in', async () => {
            const r = await t.get('/improve/OpenVibers/OpenVibe.Codes');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('OpenVibe.Codes'));
            assert.ok(r.text.includes('/auth/login?next='), 'guest sign-in link');
            assert.ok(!r.text.includes('name="prompt"'), 'no task form for guests');
        });

        await check('a signed-in user sees the start form on a repository page', async () => {
            const r = await t.get('/improve/OpenVibers/OpenVibe.Codes', { as: ada });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('name="prompt"'));
            assert.ok(r.text.includes('action="/improve/start"'));
            assert.ok(r.text.includes('name="push"'));
        });

        await check('posting from another site is refused', async () => {
            const r = await post('/improve/start', ada, { repo: 'https://git.openvibe.codes/OpenVibers/OpenVibe.Codes', prompt: 'x' }, { origin: 'https://evil.example' });
            assert.strictEqual(r.status, 403);
        });

        await check('an unknown repository is 404', async () => {
            const r = await t.get('/improve/OpenVibers/NotARepo');
            assert.strictEqual(r.status, 404);
        });

        let taskId;
        await check('starting a guided run creates a project if needed and starts a Run task', async () => {
            const r = await post('/improve/start', ada, {
                repo: 'https://git.openvibe.codes/OpenVibers/OpenVibe.Codes',
                ref: 'main',
                prompt: 'Fix the typo in README',
                agent: 'claude-code',
                permission: 'edit',
                push: '1',
                pull_request: '1',
            });
            assert.strictEqual(r.status, 303, r.text);
            taskId = /\/run\/tasks\/(tsk_[0-9A-Z]{26})$/.exec(r.headers.get('location'))[1];
            const [, sent] = calls.find((c) => c[0] === 'submit');
            assert.strictEqual(sent.subject, ada.subject);
            assert.ok(sent.project, 'a project was created');
            assert.strictEqual(sent.args.repo, 'https://git.openvibe.codes/OpenVibers/OpenVibe.Codes');
            assert.strictEqual(sent.args.prompt, 'Fix the typo in README');
            assert.strictEqual(sent.args.agent, 'claude-code');
            assert.strictEqual(sent.args.permission, 'edit');
            assert.strictEqual(sent.args.push.pull_request, true);
            assert.ok(/^openvibe-codes\/improve-/.test(sent.args.push.branch), 'a new branch name is chosen');
        });

        await check('the task appears on the user API and the run page', async () => {
            const me = await t.get('/api/v1/me/tasks', { as: ada });
            assert.strictEqual(me.status, 200);
            assert.ok(me.json().tasks.some((x) => x.id === taskId), 'user API lists it');
            const page = await t.get('/run', { as: ada });
            assert.ok(page.text.includes(`/run/tasks/${taskId}`));
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
