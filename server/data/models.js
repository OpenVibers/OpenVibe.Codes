'use strict';

/**
 * The models a person can pick for a turn (Codes L31 CH5), in words a beginner understands. One entry per agent: the
 * models whose names stay put (Claude Code's own aliases follow each new release; DeepSeek's two names are its API's),
 * and otherwise the agent's own default, which its CLI keeps current. The composer offers them as one control, "who
 * works on it": an agent and its model together. The value is "agent|model" (model empty for the agent's default).
 *
 * OpenVibe.AI is the one agent whose models come from AI itself (AI Exchange P9): while CODES_AI_CATALOG is on and
 * GET /v1/models answers a real catalog, its choices are the dynamic aliases (openvibe/auto, …) first, then the exact
 * ids (<org>/<model>[:<quant>]@<revision>), each with its retail output price and availability. The id is sent
 * unchanged as `model`; nothing here rewrites an exact id or substitutes another model.
 *
 *   list(harnesses)          → [{ agent, name, models: [{ id, name, note }], efforts }] for the agents Codes knows
 *   choices(harnesses, catalog?) → [{ value, label, agent, model, group, state, badge, desc }] for a picker, Auto first
 *   parse(value, harnesses, { aiCatalog }) → { agent, model } or null when it names nothing Codes offers
 */
const { EFFORT_LEVELS } = require('../../engine/adapters/base');

const OPENVIBE_AI = 'openvibe-ai';

const MODELS = {
    'claude-code': [
        { id: 'opus', name: 'Opus', note: 'the strongest: hard changes, design, long work' },
        { id: 'sonnet', name: 'Sonnet', note: 'fast and capable: most tasks' },
        { id: 'haiku', name: 'Haiku', note: 'the quickest: small fixes and questions' },
    ],
    deepseek: [
        { id: 'deepseek-chat', name: 'Chat', note: 'quick and very cheap' },
        { id: 'deepseek-reasoner', name: 'Reasoner', note: 'thinks first: harder problems' },
    ],
    muse: [
        { id: 'muse-spark-1.3', name: 'Spark 1.3', note: 'default: agentic coding work at scale' },
        { id: 'muse-wonder-full', name: 'Wonder Full', note: 'complex engineering and long-horizon work' },
        { id: 'muse-ember-1.0', name: 'Ember', note: 'efficient high-volume repeated work' },
    ],
};
const DEFAULT = { id: '', name: 'its default', note: 'the model the agent picks for itself' };

/**
 * Every model an agent can run (2026-11-15, the owner: "a lot of harnesses [run] different models … Claude Code
 * obviously has a bunch … there's like tons"), from AI's model directory (data/model-directory.js), by maker, in the
 * form each CLI takes: Claude Code an Anthropic id (claude-opus-5-5), Codex an OpenAI id, OpenCode and Aider an
 * OpenRouter path (openrouter/<maker>/<model>), Kilo and Cline <maker>/<model>. An agent whose id form is not known
 * here keeps its own default (the CLI keeps it current).
 */
const ANY = ['anthropic', 'openai', 'google', 'deepseek', 'qwen', 'moonshotai', 'z-ai', 'x-ai', 'minimax', 'mistralai', 'meta-llama'];
const dashed = (m) => m.replace(/(\d)\.(\d)/g, '$1-$2');
const RUNS = {
    'claude-code': { makers: ['anthropic'], id: dashed },
    'claude-acp': { makers: ['anthropic'], id: dashed },
    codex: { makers: ['openai'] },
    'codex-acp': { makers: ['openai'] },
    'gemini-cli': { makers: ['google'] },
    'qwen-code': { makers: ['qwen'] },
    'kimi-code': { makers: ['moonshotai'] },
    'grok-build': { makers: ['x-ai'] },
    'glm-acp': { makers: ['z-ai'] },
    'minimax-code': { makers: ['minimax'], id: (m) => m.replace(/^minimax-m/i, 'MiniMax-M').replace(/-([a-z])/g, (_, c) => `-${c.toUpperCase()}`) },
    muse: { makers: ['meta'], keep: (m) => /^muse-/.test(m.model) },
    'copilot-cli': { makers: ['anthropic', 'openai', 'google'] },
    opencode: { makers: ANY, id: (m, maker) => `openrouter/${maker}/${m}` },
    aider: { makers: ANY, id: (m, maker) => `openrouter/${maker}/${m}` },
    kilo: { makers: ANY, id: (m, maker) => `${maker}/${m}` },
    cline: { makers: ANY, id: (m, maker) => `${maker}/${m}` },
};
let directory = null;
/** The model directory the lists are made from (server/app.js sets it at start). */
function useDirectory(d) { directory = d || null; }
const priceNote = (p) => {
    if (!p) return '';
    const inp = Number(p.input_per_mtok ?? p.input ?? p.prompt), out = Number(p.output_per_mtok ?? p.output ?? p.completion);
    return Number.isFinite(inp) && Number.isFinite(out) ? `$${+inp.toFixed(2)} in · $${+out.toFixed(2)} out per 1M` : '';
};
/** An agent's models from the directory, newest first; [] when it has no list here or the directory has not answered. */
function fromDirectory(agentId, { cap = 0 } = {}) {
    const run = RUNS[agentId];
    const makers = directory && typeof directory.byMaker === 'function' ? directory.byMaker() : null;
    if (!run || !makers || !makers.size) return [];
    const per = cap && run.makers.length > 1 ? Math.max(2, Math.ceil(cap / run.makers.length)) : 0;
    const out = [];
    for (const maker of run.makers) {
        let rows = (makers.get(maker) || []).filter((m) => !run.keep || run.keep(m));
        if (per) rows = rows.slice(0, per);
        for (const m of rows) {
            const id = run.id ? run.id(m.model, maker) : m.model;
            const words = [m.context ? `${Math.round(m.context / 1000)}K context` : '', priceNote(m.price), m.vision ? 'sees pictures' : ''].filter(Boolean).join(' · ');
            out.push({ id, name: run.makers.length > 1 ? `${m.name}` : m.name, note: words || m.model, maker });
        }
    }
    return cap ? out.slice(0, cap) : out;
}

function list(harnesses, { cap = 0 } = {}) {
    return (harnesses?.list?.() || []).map((a) => {
        const own = MODELS[a.id] || [];
        const known = new Set(own.map((m) => m.id));
        const more = fromDirectory(a.id, { cap }).filter((m) => !known.has(m.id) && known.add(m.id));
        const models = own.length || more.length ? [...own, ...more] : [DEFAULT];
        return { agent: a.id, name: a.name, models, efforts: EFFORT_LEVELS[a.id] || [] };
    });
}

function choices(harnesses, catalog = null) {
    const out = [{ value: '', label: 'Auto: Codes picks', agent: null, model: null, group: null }];
    const rows = Array.isArray(catalog) ? catalog : (catalog && Array.isArray(catalog.entries) ? catalog.entries : null);
    const aiModels = rows && rows.length ? rows : null;
    for (const a of list(harnesses, { cap: 24 })) {
        if (a.agent === OPENVIBE_AI && aiModels) {
            // AI's own order: every dynamic alias first, then every exact id. The id travels as the option's model.
            for (const m of aiModels) {
                out.push({
                    value: `${a.agent}|${m.id}`, label: `${a.name} · ${m.name}`, note: m.desc || null,
                    agent: a.agent, model: m.id, group: a.name,
                    detail: m.desc || null, state: m.state || null, badge: m.badge || null,
                    dynamic: m.dynamic === true,
                });
            }
            continue;
        }
        for (const m of a.models) {
            out.push({ value: `${a.agent}|${m.id}`, label: m.id ? `${a.name} · ${m.name}` : a.name, note: m.note, agent: a.agent, model: m.id || null, group: a.name });
        }
    }
    return out;
}

function parse(value, harnesses, { aiCatalog = false } = {}) {
    const v = String(value || '');
    if (!v) return { agent: null, model: null };
    const [agent, model = ''] = v.split('|');
    const known = list(harnesses).find((a) => a.agent === agent);
    if (!known) return null;
    // OpenVibe.AI is the authority on its own ids: an alias or an exact id is sent exactly as chosen, and AI answers
    // ai.model_not_found / ai.model_unavailable when it cannot run it. Codes never rewrites it into another model.
    if (agent === OPENVIBE_AI && aiCatalog) return { agent, model: model || null };
    if (model && !known.models.some((m) => m.id === model)) return null;
    // The agent with no model named: the owner's default for it (codes.harnesses defaults), when it is one it runs.
    if (!model && harnesses && typeof harnesses.defaultModel === 'function') {
        const d = harnesses.defaultModel(agent);
        if (d && known.models.some((m) => m.id === d)) return { agent, model: d };
    }
    return { agent, model: model || null };
}

module.exports = { useDirectory, fromDirectory, RUNS, MODELS, OPENVIBE_AI, list, choices, parse };
