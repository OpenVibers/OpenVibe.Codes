'use strict';
/**
 * Every model each coding agent runs (2026-11-15, the owner: "a lot of harnesses [run] different models … Claude Code
 * obviously has a bunch … there's like tons"): from AI's model directory, by maker, in each CLI's own id form; newest
 * first; the pickers on pages get a short list, the API the whole one; the owner's default model applies when an agent
 * is picked with no model.
 */
const assert = require('assert');
const models = require('../server/data/models');
const { createModelDirectory, versionOf } = require('../server/data/model-directory');
const { createHarnesses } = require('../server/domain/harnesses');

const or = (model, extra = {}) => ({ id: `openrouter/${model}`, provider: 'openrouter', model, type: 'chat', supports: { tools: true }, context_window: 200000, ...extra });
const DIRECTORY = { models: [
    or('anthropic/claude-opus-5.5'), or('anthropic/claude-haiku-4.5'), or('anthropic/claude-opus-5.5:batch'),
    or('openai/gpt-5.6-luna'), or('openai/gpt-3.5-turbo-0613'), or('openai/gpt-oss-120b'), or('openai/gpt-6.1-sol'),
    or('google/gemini-3.8-flash'), or('google/gemini-4-argon'), or('openai/text-only', { supports: { tools: false } }),
    or('moonshotai/kimi-k3.1-pro'), or('minimax/minimax-m3.1-flash'), or('z-ai/glm-5.3'), or('openai/old', { retired_at: '2026-01-01' }),
    { id: 'meta/muse-spark-1.3', provider: 'meta', model: 'muse-spark-1.3', type: 'chat', supports: { tools: true } },
] };

(async () => {
    const dir = createModelDirectory({ config: { ai: { internalUrl: 'http://ai.test' } }, fetchImpl: async () => ({ ok: true, json: async () => DIRECTORY }), log: { warn() {} } });
    await dir.load();
    assert.ok(dir.loaded());
    models.useDirectory(dir);
    const base = createHarnesses();
    const harnesses = { ...base, defaultModel: (id) => (id === 'codex' ? 'gpt-5.6-luna' : null) };
    const of = (agent) => models.list(harnesses).find((a) => a.agent === agent).models.map((m) => m.id);

    // The versions: sizes, dates and snapshots are not versions.
    assert.deepStrictEqual(['gpt-5.6-luna', 'gpt-oss-120b', 'gpt-3.5-turbo-0613', 'qwen-2.5-72b-instruct'].map(versionOf), [5.6, 0, 3.5, 2.5]);
    // Claude Code: its own aliases, then every Anthropic model, as Anthropic ids (dashes), no batch variant.
    assert.deepStrictEqual(of('claude-code'), ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-haiku-4-5']);
    // Codex: OpenAI's, newest first, nothing that cannot call tools, nothing retired.
    assert.deepStrictEqual(of('codex'), ['gpt-6.1-sol', 'gpt-5.6-luna', 'gpt-3.5-turbo-0613', 'gpt-oss-120b']);
    assert.deepStrictEqual(of('gemini-cli'), ['gemini-4-argon', 'gemini-3.8-flash']);
    assert.deepStrictEqual(of('minimax-code'), ['MiniMax-M3.1-Flash'], 'in MiniMax Code\'s own form');
    assert.ok(of('muse').includes('muse-spark-1.3'));
    // OpenCode runs any model, as an OpenRouter path; Kilo as maker/model.
    assert.ok(of('opencode').includes('openrouter/anthropic/claude-opus-5.5') && of('opencode').includes('openrouter/moonshotai/kimi-k3.1-pro'));
    assert.ok(of('kilo').includes('z-ai/glm-5.3'));
    // An agent whose id form is not known here keeps its own default.
    assert.deepStrictEqual(of('droid'), ['']);
    // A page's picker gets a short list per agent; parse accepts any model of the full list.
    const picker = models.choices(harnesses).filter((c) => c.agent === 'opencode');
    assert.ok(picker.length <= 24 && picker.length > 0, `a short list on a page (${picker.length})`);
    assert.deepStrictEqual(models.parse('opencode|openrouter/z-ai/glm-5.3', harnesses), { agent: 'opencode', model: 'openrouter/z-ai/glm-5.3' });
    // The owner's default model, when the agent is picked with no model.
    assert.deepStrictEqual(models.parse('codex|', harnesses), { agent: 'codex', model: 'gpt-5.6-luna' });
    assert.deepStrictEqual(models.parse('gemini-cli|', harnesses), { agent: 'gemini-cli', model: null }, 'no default: the CLI picks');
    console.log('every-model-per-agent: by maker, each CLI\'s id form, newest first, short on pages, the owner\'s default applied');
})().catch((e) => { console.error(e); process.exit(1); });
