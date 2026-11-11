'use strict';

const { PRESETS, EFFORTS, validatePlan } = require('./model-plan');

const parse = (value) => {
    if (value && typeof value === 'object') return value;
    if (typeof value === 'string') { try { return JSON.parse(value); } catch { return null; } }
    return null;
};

/** The first tests/lint result for each configured check, from the machine's own event log. */
function firstChecks(result) {
    const lines = parse(result)?.log;
    if (!Array.isArray(lines)) return null;
    const first = new Map();
    for (const line of lines) {
        if (line?.t !== 'step' || !['tests', 'lint'].includes(line.phase) || first.has(line.phase)) continue;
        first.set(line.phase, /passed$/.test(String(line.text || '')));
    }
    return first.size ? [...first.values()].every(Boolean) : null;
}

function weeklySummary(rows) {
    const presets = new Map();
    const models = new Map();
    const make = (key) => ({ key, tasks: 0, done: 0, checks_first_time: 0, checks_seen: 0, cost_usd: 0, duration_ms: 0 });
    for (const row of rows || []) {
        const name = row.preset && PRESETS[row.preset] ? row.preset : 'Custom';
        if (!presets.has(name)) presets.set(name, make(name));
        const summary = presets.get(name);
        summary.tasks++;
        if (row.state === 'succeeded' && parse(row.result)?.ok === true) summary.done++;
        const checks = firstChecks(row.result);
        if (checks !== null) { summary.checks_seen++; if (checks) summary.checks_first_time++; }
        const roles = parse(row.role_runs);
        if (!Array.isArray(roles)) continue;
        const seen = new Set();
        for (const role of roles) {
            const model = String(role.model || 'unknown');
            const cost = Math.max(0, Number(role.cost_usd) || 0);
            const duration = Math.max(0, Number(role.duration_ms) || 0);
            summary.cost_usd += cost;
            summary.duration_ms += duration;
            if (!models.has(model)) models.set(model, make(model));
            const aggregate = models.get(model);
            if (!seen.has(model)) { aggregate.tasks++; seen.add(model); if (row.state === 'succeeded' && parse(row.result)?.ok === true) aggregate.done++; if (checks !== null) { aggregate.checks_seen++; if (checks) aggregate.checks_first_time++; } }
            aggregate.cost_usd += cost;
            aggregate.duration_ms += duration;
        }
    }
    const sort = (a, b) => b.tasks - a.tasks || a.key.localeCompare(b.key);
    return { presets: [...presets.values()].sort(sort), models: [...models.values()].sort(sort) };
}

/** A proposal only: the caller must get an owner action before storing it. */
function tuningSuggestions(summary, current) {
    const suggestions = [];
    for (const row of summary.presets || []) {
        if (!PRESETS[row.key] || row.tasks < 5 || row.checks_seen < 5 || row.checks_first_time / row.checks_seen >= 0.8) continue;
        const plan = validatePlan(current[row.key]);
        const builder = plan.roles.find((role) => role.role === 'builder');
        const index = EFFORTS.indexOf(builder.effort);
        if (index < 0 || index >= EFFORTS.length - 1) continue;
        const before = builder.effort;
        builder.effort = EFFORTS[index + 1];
        suggestions.push({ preset: row.key, before, after: builder.effort, reason: `${row.checks_first_time}/${row.checks_seen} checks passed first time over ${row.tasks} tasks`, plan });
    }
    return suggestions;
}

module.exports = { firstChecks, weeklySummary, tuningSuggestions };
