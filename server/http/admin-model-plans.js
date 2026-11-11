'use strict';

const express = require('express');
const { asyncRouter } = require('./router');
const { esc } = require('../render/html');

function createAdminModelPlans(ctx) {
    const r = asyncRouter();
    const owner = (req) => req.viewer?.kind === 'user' && req.viewer.role === 'owner';
    const deny = (req, res) => res.status(req.viewer ? 403 : 401).type('text/plain').send('Owner access required.\n');
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(ctx.config.baseUrl).origin; } catch { return false; }
    };
    const table = (rows) => `<table><thead><tr><th>Preset or model</th><th>Tasks done</th><th>Checks first time</th><th>Cost</th><th>Time</th></tr></thead><tbody>${rows.map((row) => `<tr><th>${esc(row.key)}</th><td>${row.done}/${row.tasks}</td><td>${row.checks_first_time}/${row.checks_seen}</td><td>$${row.cost_usd.toFixed(2)}</td><td>${Math.round(row.duration_ms / 60000)} min</td></tr>`).join('') || '<tr><td colspan="5">No planned tasks in the last seven days.</td></tr>'}</tbody></table>`;
    r.get('/admin/model-plans', async (req, res) => {
        if (!owner(req)) return deny(req, res);
        const summary = await ctx.modelPlans.outcomes();
        const notice = req.query.tuned ? `<p role="status">${esc(req.query.tuned)} preset defaults updated.</p>` : '';
        const body = `<main><h1>Model plan outcomes</h1><p>Last seven days. Presets change only when you use the button below.</p>${notice}<h2>Presets</h2>${table(summary.presets)}<h2>Models</h2>${table(summary.models)}<h2>Suggested tuning</h2>${summary.suggestions.length ? `<ul>${summary.suggestions.map((item) => `<li>${esc(item.preset)} builder effort: ${esc(item.before)} → ${esc(item.after)} (${esc(item.reason)})</li>`).join('')}</ul><form method="post" action="/admin/model-plans/tune"><button class="ovk-btn ovk-btn--primary">Apply these preset changes</button></form>` : '<p>No change suggested from the current sample.</p>'}</main>`;
        return ctx.chatShell(req, res, { title: 'Model plan outcomes', body, css: ['css/c4.css'], here: '/admin/model-plans' });
    });
    r.post('/admin/model-plans/tune', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
        if (!owner(req)) return deny(req, res);
        if (!sameOrigin(req)) return res.status(403).type('text/plain').send('Cross-site form posts are refused.\n');
        const changed = await ctx.modelPlans.tune(req.viewer.subject);
        return res.redirect(303, `/admin/model-plans?tuned=${changed.length}`);
    });
    return r;
}

module.exports = { createAdminModelPlans };
