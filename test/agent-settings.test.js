'use strict';
/**
 * Settings → Coding agents (2026-11-18; the owner: "make harness more easily configurable"): each agent's code mode,
 * model, reasoning and standing instructions (server/domain/harness-prefs.js, /settings/agents, harness_prefs in the
 * settings API).
 * - Cleaning: a bad code mode, model or an overlong instruction is refused; an empty entry clears it; an unknown agent
 *   is refused; a patch replaces only the agents it names.
 * - A job: the agent's code mode wins over the person's switch; a task's own model and reasoning win; the instructions
 *   follow the brief once.
 * - The page lists the agents in groups with how code mode reaches each; a save is stored and read back; the API takes
 *   the same map; a started task carries the agent's settings to Run.
 *   node test/agent-settings.test.js
 */
const assert = require('assert');
const prefs = require('../server/domain/harness-prefs');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    await check('cleaning and merging: bad values refused, empty clears, a patch touches only its agents', async () => {
        assert.deepStrictEqual(prefs.cleanOne({ code_mode: 'strict', model: 'opus', effort: 'high', instructions: '  run the tests  ' }), { code_mode: 'strict', model: 'opus', effort: 'high', instructions: 'run the tests' });
        assert.strictEqual(prefs.cleanOne({ code_mode: '', model: '', effort: '', instructions: '' }), null);
        assert.throws(() => prefs.cleanOne({ code_mode: 'always' }), /strict, beside, off/);
        assert.throws(() => prefs.cleanOne({ model: 'rm -rf /' }), /model is a model id/);
        assert.throws(() => prefs.cleanOne({ instructions: 'x'.repeat(2001) }), /at most 2000/);
        const stored = { codex: { model: 'gpt-5' }, opencode: { code_mode: 'beside' } };
        const next = prefs.merge(stored, { codex: { effort: 'high' }, opencode: null }, (id) => ['codex', 'opencode'].includes(id));
        assert.deepStrictEqual(next, { codex: { effort: 'high' } }, 'the named entries replaced, a null one cleared');
        assert.throws(() => prefs.merge({}, { nope: { model: 'x' } }, () => false), /not a coding agent here/);
    });

    await check('a job: the agent\'s code mode, else the switch; the task\'s own model wins; instructions once', async () => {
        const settings = { code_mode: true, harness_prefs: { codex: { code_mode: 'beside', model: 'gpt-5', effort: 'high', instructions: 'Keep diffs small.' }, opencode: { code_mode: 'off' } } };
        const a = prefs.applyPrefs({ agent: 'codex', prompt: 'Fix the bug.' }, settings, { name: 'Codex' });
        assert.deepStrictEqual([a.code_mode, a.model, a.effort], ['beside', 'gpt-5', 'high']);
        assert.match(a.prompt, /^Fix the bug\.\n\n---\nStanding instructions for Codex \(set by the person on openvibe\.codes\):\nKeep diffs small\.$/);
        assert.strictEqual(prefs.applyPrefs(a, settings).prompt, a.prompt, 'never twice');
        assert.deepStrictEqual([prefs.applyPrefs({ agent: 'codex', prompt: 'x', model: 'o4' }, settings).model], ['o4'], 'the task\'s own model wins');
        assert.strictEqual(prefs.applyPrefs({ agent: 'opencode', prompt: 'x' }, settings).code_mode, undefined, 'off for this agent');
        assert.strictEqual(prefs.applyPrefs({ agent: 'claude-code', prompt: 'x' }, settings).code_mode, true, 'no entry: the switch');
        assert.strictEqual(prefs.applyPrefs({ agent: null, prompt: 'x' }, { code_mode: false }).code_mode, undefined);
    });

    const t = await boot();
    try {
        const ada = t.network.addUser('agentcfg-ada');
        await check('the page: the agents in groups, each saying how code mode reaches it; a save is read back', async () => {
            const page = await t.get('/settings/agents', { as: ada });
            assert.strictEqual(page.status, 200, page.text.slice(0, 200));
            for (const words of ['On your computers', 'Agent Client Protocol agents', 'API models', 'Claude Code', 'Codex', 'OpenCode']) assert.ok(page.text.includes(words), words);
            assert.ok(page.text.includes('Codex stops working with its shell off'), 'Codex: beside only');
            assert.ok(page.text.includes('Has its own code mode (run_code)'), 'MiniMax Code: its own');
            assert.ok(page.text.includes('name="p_codex_code_mode"') && !/name="p_codex_code_mode">[\s\S]{0,400}value="strict"/.test(page.text), 'Codex offers no strict');
            const saved = await t.get('/settings/agents', { as: ada, method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, form: {
                p_codex_code_mode: 'beside', p_codex_model: 'gpt-5', p_codex_effort: '', p_codex_instructions: 'Keep diffs small.',
                p_opencode_code_mode: '', p_opencode_model: '', p_opencode_instructions: '' } });
            assert.strictEqual(saved.status, 303, saved.text.slice(0, 200));
            assert.match(saved.headers.get('location'), /ok=Agents%20saved/);
            const s = await t.ctx.userSettings.get(ada.subject);
            assert.deepStrictEqual(s.harness_prefs, { codex: { code_mode: 'beside', model: 'gpt-5', instructions: 'Keep diffs small.' } });
            const again = await t.get('/settings/agents', { as: ada });
            assert.ok(again.text.includes('value="gpt-5"') && again.text.includes('Keep diffs small.'));
            const bad = await t.get('/settings/agents', { as: ada, method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, form: { p_codex_model: 'not a model!' } });
            assert.match(bad.headers.get('location'), /error=model%20is%20a%20model%20id/);
            assert.strictEqual((await t.get('/settings/agents', { as: ada, method: 'POST', headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, form: { p_codex_model: 'x' } })).status, 403);
            const main = await t.get('/settings', { as: ada });
            assert.ok(main.text.includes('href="/settings/agents"') && main.text.includes('Code mode for every coding agent'));
        });
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await t.close();
    }
    done();
})();
