'use strict';

/**
 * The models a person can pick for a turn (Codes L31 CH5), in words a beginner understands. One entry per agent: the
 * models whose names stay put (Claude Code's own aliases follow each new release; DeepSeek's two names are its API's),
 * and otherwise the agent's own default, which its CLI keeps current. The composer offers them as one control, "who
 * works on it": an agent and its model together. The value is "agent|model" (model empty for the agent's default).
 *
 *   list(harnesses)          → [{ agent, name, models: [{ id, name, note }], efforts }] for the agents Codes knows
 *   choices(harnesses)       → [{ value, label, agent, model, group }] for a picker, Auto first
 *   parse(value, harnesses)  → { agent, model } or null when it names nothing Codes offers
 */
const { EFFORT_LEVELS } = require('../../engine/adapters/base');

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
};
const DEFAULT = { id: '', name: 'its default', note: 'the model the agent picks for itself' };

function list(harnesses) {
    return (harnesses?.list?.() || []).map((a) => ({
        agent: a.id, name: a.name,
        models: MODELS[a.id] ? MODELS[a.id] : [DEFAULT],
        efforts: EFFORT_LEVELS[a.id] || [],
    }));
}

function choices(harnesses) {
    const out = [{ value: '', label: 'Auto: Codes picks', agent: null, model: null, group: null }];
    for (const a of list(harnesses)) {
        for (const m of a.models) {
            out.push({ value: `${a.agent}|${m.id}`, label: m.id ? `${a.name} · ${m.name}` : a.name, note: m.note, agent: a.agent, model: m.id || null, group: a.name });
        }
    }
    return out;
}

function parse(value, harnesses) {
    const v = String(value || '');
    if (!v) return { agent: null, model: null };
    const [agent, model = ''] = v.split('|');
    const known = list(harnesses).find((a) => a.agent === agent);
    if (!known) return null;
    if (model && !known.models.some((m) => m.id === model)) return null;
    return { agent, model: model || null };
}

module.exports = { MODELS, list, choices, parse };
