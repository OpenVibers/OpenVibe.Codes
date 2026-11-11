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

function list(harnesses) {
    return (harnesses?.list?.() || []).map((a) => ({
        agent: a.id, name: a.name,
        models: MODELS[a.id] ? MODELS[a.id] : [DEFAULT],
        efforts: EFFORT_LEVELS[a.id] || [],
    }));
}

function choices(harnesses, catalog = null) {
    const out = [{ value: '', label: 'Auto: Codes picks', agent: null, model: null, group: null }];
    const rows = Array.isArray(catalog) ? catalog : (catalog && Array.isArray(catalog.entries) ? catalog.entries : null);
    const aiModels = rows && rows.length ? rows : null;
    for (const a of list(harnesses)) {
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
    return { agent, model: model || null };
}

module.exports = { MODELS, OPENVIBE_AI, list, choices, parse };
