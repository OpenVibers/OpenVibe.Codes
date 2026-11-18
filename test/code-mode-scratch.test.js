'use strict';
/**
 * Code mode without a repository (plan §AD.28 item 3; the owner, 11-18: Codes "should take it"). The Frame starts a
 * Code-mode turn with { mode: 'make', text, scratch: true }; when the words name no repository, Codes makes a private
 * repository on OpenVibe Git in the person's name (named from the words, the next free name when one is taken) and
 * starts the task there. Without scratch, or without OpenVibe Git, the answer is the old handover to OpenVibe AI.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const run = {
        enabled: true, jobs: 0,
        async submit() { this.jobs += 1; return { id: `job_01J8Z3Q4R5S6T7V8W9X0Y1Z3J${this.jobs}`, state: 'queued' }; },
        async read(jobId) { return { id: jobId, state: 'queued', result: null, error: null }; },
        async cancel(jobId) { return { id: jobId, state: 'cancelled' }; },
        async streamUrl() { throw new Error('not used'); },
    };
    const made = [];
    const taken = new Set(['ada/bakery-site-today-hours']);
    let gitOn = true;
    const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
    const forge = {
        get enabled() { return gitOn; },
        publicUrl: 'https://git.openvibe.codes', host: 'git.openvibe.codes',
        async repo() { return null; },
        async repos() { return []; },
        async mintToken() { return null; },
        jobEnv() { return null; },
        async createRepo(actor, { name, description, isPrivate }) {
            const full = `${actor.username}/${name}`;
            if (taken.has(full)) throw fail(409, 'git.name_taken', `You already have a repository called ${name}`);
            taken.add(full);
            made.push({ subject: actor.subject, username: actor.username, name, description, isPrivate });
            return { full_name: full, html_url: `https://git.openvibe.codes/${full}`, clone_url: `https://git.openvibe.codes/${full}.git`, private: isPrivate };
        },
    };
    const t = await boot({ run, forge });
    const ada = t.network.addUser('ada');
    const api = (body, { as = ada, bearer = null } = {}) => t.get('/api/v1/tasks', {
        ...(bearer ? {} : { as }), method: 'POST', json: body, headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    const row = async (id) => t.ctx.store.db.maybe('SELECT mode, repo FROM run_tasks WHERE id = $1', [id]);

    try {
        // A first task gives ada a project, as her first visit to Codes would.
        const first = await api({ text: 'Add a test for the date parser.', mode: 'repo', repo: 'https://github.com/octocat/Hello-World' });
        assert.strictEqual(first.status, 201, first.text);

        await check('Code mode with no repository: a private repository in her name, named from her words, and the task on it', async () => {
            const r = await api({ text: 'A bakery site with today’s hours', mode: 'make', scratch: true });
            assert.strictEqual(r.status, 201, r.text);
            assert.match(String(r.json().id), /^tsk_/);
            // "bakery-site-today-hours" was taken: the next free name.
            assert.deepStrictEqual(r.json().repository, { full_name: 'ada/bakery-site-today-hours-2', html_url: 'https://git.openvibe.codes/ada/bakery-site-today-hours-2', private: true });
            const m = made.at(-1);
            assert.deepStrictEqual([m.subject, m.username, m.isPrivate], [ada.subject, 'ada', true]);
            assert.match(m.description, /^A bakery site/);
            const task = await row(r.json().id);
            assert.strictEqual(task.mode, 'repo');
            assert.strictEqual(task.repo, 'https://git.openvibe.codes/ada/bakery-site-today-hours-2.git');
        });

        await check('her own bearer token works the same (the Frame calls as the person)', async () => {
            const r = await api({ text: 'Make a pomodoro timer page', mode: 'make', scratch: 'true' }, { bearer: t.network.userToken(ada) });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().repository.full_name, 'ada/pomodoro-timer-page');
        });

        await check('words that name one of her repositories work there, with no new repository', async () => {
            const before = made.length;
            const r = await api({ text: 'Now fix the README typo in hello-world', mode: 'make', scratch: true });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json().repository, undefined);
            assert.strictEqual(made.length, before);
            assert.match(String((await row(r.json().id)).repo), /octocat\/Hello-World/i);
        });

        await check('without scratch, something new is still the handover to OpenVibe AI (the site’s own button)', async () => {
            const before = made.length;
            const r = await api({ text: 'A bakery site with opening hours', mode: 'make' });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().id, null);
            assert.ok(String(r.json().url).startsWith('https://openvibe.space'), r.json().url);
            assert.strictEqual(made.length, before, 'no repository made');
        });

        await check('OpenVibe Git closed: the handover, saying why', async () => {
            gitOn = false;
            const r = await api({ text: 'A recipe box app', mode: 'make', scratch: true });
            gitOn = true;
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json().id, null);
            assert.strictEqual(r.json().scratch.code, 'repo.git_off');
        });

        await check('words with nothing to name it by: scratch-<date>', async () => {
            const r = await api({ text: 'make it for me please', mode: 'make', scratch: true });
            assert.strictEqual(r.status, 201, r.text);
            assert.match(r.json().repository.full_name, /^ada\/scratch-\d{8}$/);
        });
    } finally {
        await t.close?.();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
