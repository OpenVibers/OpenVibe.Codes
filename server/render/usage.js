'use strict';

/**
 * A project's usage page (roadmap WS-N task 4): what OpenVibe.Network answers for
 * GET /api/v1/projects/:project/usage (network.project-usage-result@1), next to the limits each
 * enforcing service publishes. Server-rendered and complete without JavaScript: the filters are a GET
 * form, headroom is a <meter>, every number is text.
 */
const { html, raw, table, code, time, problemBox } = require('./html');
const { amount } = require('../domain/limits');

const DAYS = [7, 30, 90];
const ENVS = ['all', 'production', 'sandbox'];
const SERVICE_NAMES = { tools: 'OpenVibe Tools', events: 'OpenVibe Events', media: 'OpenVibe Media', host: 'OpenVibe Host', ai: 'OpenVibe AI' };

const num = (v) => html`<span class="num">${Number(v).toLocaleString('en-US')}</span>`;
const cap = (id) => html`<a href="/docs/capabilities/${id}"><code>${id}</code></a>`;
const rate = (errors, quantity) => (quantity > 0 ? `${+((errors / quantity) * 100).toFixed(1)}%` : '—');
const per = (window) => (window === 'total' ? 'in total' : `a ${window}`);

/** ?days=&env= as the page offers them (anything else falls back to 30 days, every environment). */
function usageQuery(query = {}) {
    const days = DAYS.includes(Number(query.days)) ? Number(query.days) : 30;
    const env = ENVS.includes(String(query.env)) ? String(query.env) : 'all';
    return { days, env };
}

function filters(projectId, { days, env }) {
    return html`<form method="get" action="/projects/${projectId}/usage" class="inline-form" aria-label="Usage range">
<label>Last <select name="days">${DAYS.map((d) => html`<option value="${d}"${d === days ? raw(' selected') : ''}>${d} days</option>`)}</select></label>
<label>Environment <select name="env">${ENVS.map((e) => html`<option value="${e}"${e === env ? raw(' selected') : ''}>${e === 'all' ? 'both' : e}</option>`)}</select></label>
<button type="submit">Show</button></form>`;
}

function quotaRows(quotas) {
    return quotas.map((q) => {
        const used = q.used == null
            ? html`— <span class="muted small">${q.note || ''}</span>`
            : html`${num(q.used)} ${q.unit}${q.window_start ? html` <span class="muted small">since ${time(q.window_start)}</span>` : ''}${q.note ? html` <span class="muted small">(${q.note})</span>` : ''}`;
        const headroom = q.used == null ? '—' : html`<meter class="headroom" min="0" max="${Math.max(q.limit, 1)}" value="${Math.min(q.used, Math.max(q.limit, 1))}" low="${Math.floor(q.limit * 0.8)}" high="${Math.floor(q.limit * 0.95)}" optimum="0">${rate(q.used, q.limit)}</meter> ${num(q.remaining)} left${q.limit > 0 ? html` <span class="muted small">(${rate(q.used, q.limit)} used)</span>` : ''}`;
        return [cap(q.capability), html`${num(q.limit)} ${q.unit} ${per(q.window)}`, used, headroom,
            html`recorded limit — enforced by <code>${q.enforced_by || 'the owning service'}</code>`];
    });
}

/** The limits of the services this project used, for the capabilities it used. */
function serviceLimits(u, limitAnswers, env) {
    const used = new Set(u.totals.map((t) => t.capability));
    const services = [...new Set(u.totals.map((t) => t.service))].sort();
    if (!services.length) return '';
    const cols = env === 'all' ? ['sandbox', 'production'] : [env];
    return html`<h2 id="limits">Service limits</h2>
<p class="muted small">The defaults each service enforces for every project, as it reports them now (<a href="/docs/limits">all limits</a>). A rate limit is enforced as it happens; these hourly numbers cannot show a single busy minute.</p>
${services.map((svc) => {
        const a = limitAnswers.find((x) => x.src.service === svc);
        const name = SERVICE_NAMES[svc] || svc;
        if (!a) return html`<h3>${name}</h3><p class="muted small">${name} does not publish its limits yet.</p>`;
        if (a.problem) return html`<h3>${name}</h3>${problemBox(a.problem, { title: `${name}'s limits could not be read` })}`;
        const rows = a.body.limits.filter((l) => l.capability && used.has(l.capability));
        return html`<h3>${name}</h3>${table(['Limit', 'Capability', ...cols.map((c) => c[0].toUpperCase() + c.slice(1)), 'Past it'],
            rows.map((l) => [l.label, cap(l.capability), ...cols.map((c) => amount(l[c], l.unit)), l.exceeded ? code(l.exceeded) : '—']),
            { empty: `${name} publishes no limit for the capabilities used here.` })}`;
    })}`;
}

/**
 * @param {object} o
 * @param {object} o.project     Network's project view
 * @param {object} o.usage       network.project-usage-result@1
 * @param {Array}  o.limits      [{ src, body } | { src, problem }] from the limits reader
 * @param {{ days: number, env: string }} o.query
 */
function usageBody({ project, usage: u, limits: limitAnswers, query }) {
    const byService = [...u.totals].sort((a, b) => a.service.localeCompare(b.service) || a.capability.localeCompare(b.capability));
    return html`<h1>Usage <small>${project.name}</small></h1>
<p class="muted">${u.freshness}${u.last_recorded_at ? html` Last rollup received ${time(u.last_recorded_at)}.` : ''} Showing ${u.range.from} to ${u.range.to} (UTC).</p>
${filters(project.id, query)}

<h2 id="summary">Summary</h2>
${byService.length ? html`<ul class="cards">${byService.map((t) => html`<li><strong>${num(t.quantity)} ${t.unit}</strong>
<span>${cap(t.capability)} · ${t.env}</span>
<span>${t.errors ? html`${num(t.errors)} errors (${rate(t.errors, t.quantity)})` : 'no errors'}</span></li>`)}</ul>`
        : html`<p class="muted">No usage in these days. Usage is counted for apps of this project, per environment, by the service that does the work.</p>`}

<h2 id="quotas">Quotas</h2>
${table(['Capability', 'Limit', 'Used this window', 'Headroom', 'Enforcement'], quotaRows(u.quotas),
        { empty: 'No quotas are recorded for this project (staff set them). The service limits below apply to every project.' })}

${serviceLimits(u, limitAnswers, query.env)}

<h2 id="daily">By day</h2>
${table(['Day (UTC)', 'Service', 'Capability', 'Detail', 'Environment', 'Used', 'Errors'], u.daily.map((d) => [
        d.day, d.service, cap(d.capability), d.dimension ? code(d.dimension) : '—', d.env, html`${num(d.quantity)} ${d.unit}`, d.errors ? num(d.errors) : '0',
    ]), { empty: 'No usage in these days.' })}

<h2 id="errors">Errors</h2>
<p>${num(u.errors.total)} ${u.errors.total === 1 ? 'error' : 'errors'} in these days.</p>
${table(['Code', 'Service', 'Capability', 'Count'], u.errors.by_code.map((e) => [code(e.code), e.service, cap(e.capability), num(e.count)]), { empty: 'No errors.' })}
<h3 id="recent">Recent failures</h3>
<p class="muted small">The last failures the services sampled, newest first. A trace id is the <code>traceparent</code> trace of the request that failed (for a job, the request that submitted it; for a webhook, the event delivered): look it up in your own logs. A job or event id can be read with your app's token.</p>
${table(['When', 'Environment', 'Capability', 'Code', 'Status', 'Trace id', 'Job or event'], u.errors.recent.map((e) => [
        time(e.at), e.env, cap(e.capability), code(e.code), e.status == null ? '—' : String(e.status), e.trace_id ? code(e.trace_id) : '—', e.ref ? code(e.ref) : '—',
    ]), { empty: 'No failures sampled in these days.' })}

<p class="muted small">Counts come from the services that own each capability (OpenVibe Tools and OpenVibe Events today) as hourly rollups through OpenVibe Events; OpenVibe.Network adds them up per day. They say how much and what failed, never who did it.</p>`;
}

module.exports = { usageBody, usageQuery, DAYS, ENVS };
