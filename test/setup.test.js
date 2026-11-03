'use strict';

/**
 * The guided setup (owner 2026-11-03): /setup's five steps, each read live; the pickers that say what each agent is
 * ready for; the choices it saves; the home's line to it while it is unfinished.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { readiness, optionAttrs } = require('../server/domain/readiness');

const NODE = 'nod_01J8Z3Q4R5S6T7V8W9X0Y1Z2S1';
const DEVICE = 'dev_01J8Z3Q4R5S6T7V8W9X0Y1Z2S1';

(async () => {
    await check('readiness: a state, a badge, a line and where to fix it', async () => {
        const r = readiness([
            { agent: 'claude-code', state: 'ok', used: 41, machines: [{ name: 'ada-laptop', room: true }] },
            { agent: 'codex', state: 'absent', used: 0, machines: [] },
            { agent: 'opencode', state: 'login', used: 0, machines: [] },
            { agent: 'minimax-code', state: 'low', used: 88, machines: [] },
        ]);
        assert.deepStrictEqual(r.get('claude-code'), { state: 'ok', badge: '41% used', desc: 'Signed in on ada-laptop', ready: true });
        assert.strictEqual(r.get('codex').href, '/setup#agent-codex');
        assert.strictEqual(r.get('opencode').hrefLabel, 'Sign in');
        assert.strictEqual(r.get('minimax-code').state, 'warn');
        assert.strictEqual(optionAttrs({ state: 'ok', badge: 'a "b"', desc: '<x>' }), ' data-state="ok" data-badge="a &quot;b&quot;" data-desc="&lt;x&gt;"');
    });

    const t = await boot({});
    const ada = t.network.addUser('ada');
    try {
        await check('a new person: every step to do, the machine first, and the home says so', async () => {
            const res = await t.get('/setup', { as: ada });
            assert.strictEqual(res.status, 200, res.text);
            for (const id of ['machine', 'agents', 'keys', 'accounts', 'choices']) assert.match(res.text, new RegExp(`id="step-${id}"`));
            assert.match(res.text, /0 of 5 done/);
            assert.match(res.text, /class="c4-card c4-setup-step is-next" id="step-machine"/, 'the machine is next');
            assert.match(res.text, /curl -fsSL https:\/\/openvibe\.bot\/install \| sh -s -- --worker/);
            assert.match(res.text, /npm install -g @openai\/codex/, 'an agent that is not there says how to install it');
            assert.match(res.text, /href="\/css\/setup\.css|css\/setup\.css/, 'the page brings its own stylesheet');
            assert.match(res.text, /<code tabindex="0">curl -fsSL[^<]*<\/code><button type="button" class="c4-setup-copy" data-c4-copy>Copy<\/button>/, 'a command has its Copy button');
            // A phone never gets a page wider than its screen (2026-11-03: the installer's one long line widened the
            // whole grid to 595 px at 390): the page's columns may shrink, and a command wraps.
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'setup.css'), 'utf8');
            for (const rule of ['.c4-setup{display:grid;grid-template-columns:minmax(0,1fr)', '.c4-setup-head{display:grid;grid-template-columns:minmax(0,1fr)', '.c4-setup-body{margin:14px 0 0 54px;display:grid;grid-template-columns:minmax(0,1fr)']) assert.ok(css.includes(rule), rule);
            assert.match(css, /\.c4-setup-cmd code\{[^}]*white-space:pre-wrap;overflow-wrap:anywhere/);
            const home = await t.get('/', { as: ada });
            assert.match(home.text, /class="ch-setup-nudge" href="\/setup"/);
            assert.match(home.text, /0 of 3 done · next: Your machine/);
        });

        await check('a paired machine with Claude Code signed in: two steps done, the pickers know', async () => {
            t.network.addNode(ada.subject, { principal: NODE, node_id: 'node_ada', name: 'ada-laptop', status: 'active', last_seen_at: new Date().toISOString() });
            t.bot.addMachine({ id: DEVICE, node_id: NODE, name: 'ada-laptop', online: true, fleet_at: new Date().toISOString(), fleet: [
                { agent: 'claude-code', installed: true, signed_in: true, windows: [{ name: 'week', pct: 41, resets_at: new Date(Date.now() + 86400000).toISOString() }] },
                { agent: 'opencode', installed: true, signed_in: false, windows: [] },
            ] });
            const res = await t.get('/setup', { as: ada });
            assert.match(res.text, /class="c4-card c4-setup-step is-done" id="step-machine"/);
            assert.match(res.text, /class="c4-card c4-setup-step is-done" id="step-agents"/);
            assert.match(res.text, /class="c4-card c4-setup-step is-next" id="step-choices"/, 'the choices are next');
            assert.match(res.text, /opencode auth login/, 'a signed-out agent says how to sign in');
            assert.match(res.text, /<option value="claude-code"[^>]*data-state="ok" data-badge="41% used"/, 'the default agent picker says what is ready');
            assert.match(res.text, /<option value="opencode"[^>]*data-state="bad" data-badge="Sign in"[^>]*data-href="\/setup#agent-opencode"/);
            const home = await t.get('/', { as: ada });
            assert.match(home.text, /2 of 3 done · next: Your choices/);
            assert.match(home.text, /<option value="claude-code\|[^"]*"[^>]*data-state="ok"/, 'the composer\'s agent picker knows too');
            assert.match(home.text, /data-ch-who data-ov-select="bare"/, 'the composer\'s chips use the bare select');
        });

        await check('saving the choices finishes the setup', async () => {
            const res = await t.get('/setup/choices', { as: ada, form: { default_agent: 'claude-code', default_machine: NODE, fallback_agent_1: 'codex', fallback_model_1: 'gpt-5.5', fallback_agent_2: '', fallback_model_2: '', fallback_agent_3: '', fallback_model_3: '', conductor_switch_pct: '85', safety: 'project' } });
            assert.strictEqual(res.status, 303, res.text);
            assert.match(res.headers.get('location'), /^\/setup\?ok=/);
            const s = await t.ctx.userSettings.get(ada.subject);
            assert.strictEqual(s.default_agent, 'claude-code');
            assert.deepStrictEqual(s.conductor_fallbacks, [{ agent: 'codex', model: 'gpt-5.5' }]);
            assert.strictEqual(s.conductor_switch_pct, 85);
            assert.strictEqual(s.safety, 'project');
            const page = await t.get('/setup', { as: ada });
            assert.match(page.text, /You are set/);
            assert.match(page.text, /class="c4-card c4-setup-step is-done" id="step-choices"/);
            const home = await t.get('/', { as: ada });
            assert.doesNotMatch(home.text, /ch-setup-nudge/, 'a finished setup leaves the home alone');
        });

        await check('signed out: the page asks to sign in', async () => {
            const res = await t.get('/setup');
            assert.strictEqual(res.status, 200);
            assert.match(res.text, /Set up Codes/);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
