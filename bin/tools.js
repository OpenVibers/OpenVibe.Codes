'use strict';

/**
 * `openvibe-codes tools`: OpenVibe Tools from the terminal (plan 2026-11-13 §AD.12 (f); the owner, 11-15: tools "from gui
 * to cmd"). The same tools as the pages, the API, the agents and the MCP server (https://openvibe.tools/mcp, which this
 * talks to): the 180+ in the catalogue, the public ones people made, and your own.
 *
 *   openvibe-codes tools find "<need>"                  tools for a need, with what each takes
 *   openvibe-codes tools run <tool> [key=value …]       run one (--input '{"…"}' for any JSON input)
 *   openvibe-codes tools mine                           the tools you made
 *   openvibe-codes tools make "<what it should do>"     a model drafts a tool from your words and makes it (yours,
 *                       [--model <id>] [--public|--unlisted]   private unless you say); runs are paid by whoever runs it
 *   openvibe-codes tools bring <val address>            a Val Town val as your own code tool (Val Town closes
 *   openvibe-codes tools bring --pipedream <file.js>    2027-01-10), or a Pipedream code step (closes 2027-03-31)
 *   openvibe-codes tools automate <tool> --every day --at 09:00 [key=value …]   any tool on a schedule (UTC), as you
 *   openvibe-codes tools automate <tool> --link [key=value …]                   or from a private link (a webhook)
 *   openvibe-codes tools automations                    every schedule and link you have, on any tool
 *
 * Signed out, the catalogue and the public tools work. OPENVIBE_TOOLS_TOKEN (a sign-in for openvibe.tools; else
 * OPENVIBE_TOKEN) adds your own tools and making one. OPENVIBE_TOOLS_URL points elsewhere (default
 * https://openvibe.tools). --json prints the answer as JSON.
 */

const BASE = () => String(process.env.OPENVIBE_TOOLS_URL || 'https://openvibe.tools').replace(/\/+$/, '');
const TOKEN = () => process.env.OPENVIBE_TOOLS_TOKEN || process.env.OPENVIBE_TOKEN || '';

const HELP = `openvibe-codes tools — OpenVibe Tools from the terminal

  openvibe-codes tools find "<need>"                 tools for a need, with what each takes
  openvibe-codes tools run <tool> [key=value …]      run one (--input '{"…"}' for any JSON input)
  openvibe-codes tools mine                          the tools you made
  openvibe-codes tools make "<what it should do>"    a model drafts a tool from your words and makes it
      --code                JavaScript that computes the answer (math, formats, conversions), not a model
      --model <id>          the model it runs on (default auto: the cheapest that does the job)
      --public | --unlisted  who can use it (default: only you)
  openvibe-codes tools bring <val address>           a Val Town val as your own code tool (its imported vals too)
  openvibe-codes tools bring --pipedream <file.js>   a Pipedream Node.js code step (- reads it from stdin)
      --name <name>         a name for a Pipedream step (default: the file's)
  openvibe-codes tools automate <tool> [key=value …] any tool on its own, as you: a catalogue tool or one you made
      --every hour|day      a schedule (default day), --at HH:MM in UTC (default 09:00), --quiet: not told each run
      --link                a private link instead: GET or POST it (a webhook, a form, a shortcut) and the tool runs
  openvibe-codes tools automations                   every schedule and link you have, with the next and last run
  --json                    the answer as JSON

Signed out, the catalogue and the public tools work. OPENVIBE_TOOLS_TOKEN (else OPENVIBE_TOKEN) adds your own tools
and making one. Every tool is also an MCP tool: https://openvibe.tools/mcp`;

class ToolsError extends Error { constructor(message, code = 'tools.failed') { super(message); this.code = code; } }

async function http(path, { method = 'GET', body, auth = false, fetchImpl = globalThis.fetch } = {}) {
    const token = TOKEN();
    if (auth && !token) throw new ToolsError('Sign in first: set OPENVIBE_TOOLS_TOKEN (or OPENVIBE_TOKEN)', 'tools.session_required');
    const res = await fetchImpl(BASE() + path, {
        method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120_000),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) throw new ToolsError(String((data && (data.detail || data.title || data.error)) || `openvibe.tools answered ${res.status}`).slice(0, 300), (data && data.code) || 'tools.failed');
    return data;
}

let rpcId = 0;
/** One MCP tools/call on openvibe.tools/mcp → { ok, text }. */
async function mcpCall(name, args, opts = {}) {
    const d = await http('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }, ...opts });
    if (d && d.error) throw new ToolsError(d.error.message || 'the tools server refused', 'tools.rpc');
    const r = (d && d.result) || {};
    return { ok: !r.isError, text: ((r.content || [])[0] || {}).text || '' };
}

/** key=value pairs → an input object (numbers, true/false and JSON values read as such); --input JSON wins. */
function inputOf(rest, inputJson) {
    if (inputJson) {
        try { const v = JSON.parse(inputJson); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* below */ }
        throw new ToolsError('--input is a JSON object, like \'{"target":"example.com"}\'', 'tools.input');
    }
    const out = {};
    for (const pair of rest) {
        const i = pair.indexOf('=');
        if (i < 1) throw new ToolsError(`"${pair}" is not key=value`, 'tools.input');
        const k = pair.slice(0, i), raw = pair.slice(i + 1);
        let v = raw;
        if (/^-?\d+(\.\d+)?$/.test(raw)) v = Number(raw);
        else if (raw === 'true' || raw === 'false') v = raw === 'true';
        else if (/^[[{]/.test(raw)) { try { v = JSON.parse(raw); } catch { v = raw; } }
        out[k] = v;
    }
    return out;
}

function flags(argv) {
    const o = { json: false, rest: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') o.json = true;
        else if (a === '--public') o.visibility = 'public';
        else if (a === '--unlisted') o.visibility = 'unlisted';
        else if (a === '--code') o.code = true;
        else if (a === '--link') o.link = true;
        else if (a === '--quiet') o.quiet = true;
        else if (a === '--model' || a === '--input' || a === '--pipedream' || a === '--name' || a === '--every' || a === '--at') o[a.slice(2)] = argv[++i];
        else if (a === '--help' || a === '-h') o.help = true;
        else o.rest.push(a);
    }
    return o;
}

const slugOf = (name) => {
    let s = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34);
    if (!/^[a-z]/.test(s)) s = `tool-${s}`.slice(0, 34);
    return `${s.replace(/-+$/, '') || 'my-tool'}-${Math.random().toString(36).slice(2, 6)}`;
};

/** The make form's fields (a draft) → the API's tool body: the same rules as openvibe.tools/make. */
function bodyOf(d, { model = 'auto', visibility = 'private' } = {}) {
    const key = (label, taken) => {
        let k = String(label || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
        if (!/^[a-z]/.test(k)) k = `f_${k}`;
        let out = k, n = 2;
        while (taken[out]) out = `${k}_${n++}`;
        taken[out] = true;
        return out;
    };
    const t1 = {}, props = {}, required = [];
    for (const i of d.inputs || []) { const k = key(i.label, t1); props[k] = i.kind === 'number' ? { type: 'number', title: i.label } : { type: 'string', title: i.label, maxLength: i.kind === 'short' ? 500 : 20000 }; required.push(k); }
    let output = { kind: 'text' };
    if (d.answer === 'fields') {
        const t2 = {}, op = {}, oreq = [];
        for (const f of d.fields || []) { const k = key(f.label, t2); op[k] = { type: 'string', title: f.label }; oreq.push(k); }
        output = { kind: 'json', schema: { type: 'object', required: oreq, properties: op } };
    }
    return { slug: slugOf(d.name), name: d.name, summary: d.summary, kind: 'prompt', input: { type: 'object', required, properties: props }, output, prompt: { instructions: d.instructions, model }, visibility };
}

async function tools(argv, { out = (s) => process.stdout.write(`${s}\n`), json: asJson = false, fetchImpl } = {}) {
    const [sub, ...args] = argv;
    const o = flags(args);
    const json = asJson || o.json;
    const opts = fetchImpl ? { fetchImpl } : {};
    if (!sub || sub === '--help' || sub === '-h' || o.help) { out(HELP); return 0; }
    try {
        if (sub === 'find') {
            const need = o.rest.join(' ').trim();
            if (!need) throw new ToolsError('Say what you need: openvibe-codes tools find "merge pdf"', 'tools.input');
            const r = await mcpCall('find_tools', { need, limit: 10 }, opts);
            const found = JSON.parse(r.text || '[]');
            if (json) { out(JSON.stringify(found)); return 0; }
            if (!Array.isArray(found) || !found.length) { out(found && found.none ? found.none : 'Nothing fits.'); return 0; }
            for (const t of found) {
                const takes = Object.keys((t.input && t.input.properties) || {});
                out(`${t.tool}${t.made ? (t.yours ? '  (yours)' : '  (made by someone)') : ''}\n    ${t.summary || t.name}${takes.length ? `\n    takes: ${takes.join(', ')}` : ''}`);
            }
            return 0;
        }
        if (sub === 'run') {
            const [tool, ...pairs] = o.rest;
            if (!tool) throw new ToolsError('Name the tool: openvibe-codes tools run dns target=example.com', 'tools.input');
            const r = await mcpCall('run_tool', { tool, input: inputOf(pairs, o.input) }, opts);
            if (json) { out(JSON.stringify({ ok: r.ok, result: (() => { try { return JSON.parse(r.text); } catch { return r.text; } })() })); return r.ok ? 0 : 1; }
            out(r.ok ? (() => { try { return JSON.stringify(JSON.parse(r.text), null, 2); } catch { return r.text; } })() : `failed: ${r.text}`);
            return r.ok ? 0 : 1;
        }
        if (sub === 'mine') {
            const d = await http('/api/v1/made-tools?mine=1', { auth: true, ...opts });
            const list = (d && d.tools) || [];
            if (json) { out(JSON.stringify(list)); return 0; }
            if (!list.length) { out('You have made no tools yet: openvibe-codes tools make "what it should do"'); return 0; }
            for (const t of list) out(`${t.id}  ${t.name}  (${t.visibility}, v${t.version}, ${t.runs || 0} runs)\n    ${t.summary}`);
            return 0;
        }
        if (sub === 'make') {
            const description = o.rest.join(' ').trim();
            if (description.length < 8) throw new ToolsError('Say in a sentence or two what the tool should do', 'tools.input');
            const drafted = await http('/api/v1/made-tools/draft', { method: 'POST', body: { description, kind: o.code ? 'code' : 'prompt' }, auth: true, ...opts });
            // Tools answers the tool as POST takes it (body, since 11-15); an older Tools only the form's fields.
            const visibility = o.visibility || 'private';
            let body;
            if (drafted.body) {
                body = { ...drafted.body, visibility };
                if (body.prompt && o.model) body.prompt = { ...body.prompt, model: o.model };
            } else {
                if (o.code) throw new ToolsError('This Tools cannot draft code tools yet: make it at openvibe.tools/make', 'tools.input');
                body = bodyOf(drafted.draft, { model: o.model || 'auto', visibility });
            }
            const made = await http('/api/v1/made-tools', { method: 'POST', body, auth: true, ...opts });
            if (json) { out(JSON.stringify(made)); return 0; }
            const takes = Object.keys((made.input && made.input.properties) || {});
            out(`Made ${made.name} (${made.id}, ${made.visibility})\n    ${made.summary}\n    takes: ${takes.join(', ')}\n    try it: openvibe-codes tools run ${made.id} ${takes.map((k) => `${k}=…`).join(' ')}\n    change it: ${BASE()}/make#${made.id}`);
            return 0;
        }
        if (sub === 'bring') {
            // A val (its address) or a Pipedream step (its file): converted by Tools (/import/val, /import/pipedream),
            // then made as yours, private unless you say; a name you already use gets a short suffix.
            let path;
            let body;
            if (o.pipedream) {
                const code = require('fs').readFileSync(o.pipedream === '-' ? 0 : o.pipedream, 'utf8');
                path = '/api/v1/made-tools/import/pipedream';
                body = { code, name: o.name || (o.pipedream === '-' ? 'pipedream-step' : require('path').basename(o.pipedream).replace(/\.[a-z]+$/i, '')) };
            } else {
                const ref = (o.rest[0] || '').trim();
                if (!ref) throw new ToolsError('Give the val\'s address: openvibe-codes tools bring https://www.val.town/v/you/name', 'tools.input');
                path = '/api/v1/made-tools/import/val';
                body = { url: ref };
            }
            const brought = await http(path, { method: 'POST', body, auth: true, ...opts });
            let tool = { ...brought.body, visibility: o.visibility || 'private' };
            let made = null;
            let tries = 0;
            while (!made) {
                try {
                    made = await http('/api/v1/made-tools', { method: 'POST', body: tool, auth: true, ...opts });
                } catch (err) {
                    if (tries >= 2 || !/already have/i.test(err.message)) throw err;
                    tries += 1;
                    tool = { ...tool, slug: slugOf(tool.name) };
                }
            }
            const notes = brought.notes || [];
            if (json) { out(JSON.stringify({ made, notes })); return 0; }
            const takes = Object.keys((made.input && made.input.properties) || {});
            out(`Brought ${made.name} (${made.id}, ${made.visibility})\n    ${made.summary}\n    takes: ${takes.join(', ') || 'nothing'}${notes.map((n) => `\n    note: ${n}`).join('')}\n    try it: openvibe-codes tools run ${made.id} ${takes.map((k) => `${k}=…`).join(' ')}\n    change it: ${BASE()}/make#${made.id}`);
            return 0;
        }
        if (sub === 'automate') {
            // Any tool on its own (one tool system, 11-15): POST /api/v1/tools/:id/triggers, as you.
            const [tool, ...pairs] = o.rest;
            if (!tool) throw new ToolsError('Name the tool: openvibe-codes tools automate dns --every day --at 09:00 target=example.com', 'tools.input');
            if (o.every && !['hour', 'day'].includes(o.every)) throw new ToolsError('--every is hour or day', 'tools.input');
            if (o.at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(o.at)) throw new ToolsError('--at is a time, HH:MM (UTC)', 'tools.input');
            const input = inputOf(pairs, o.input);
            const body = o.link ? { kind: 'link', input } : { kind: 'schedule', every: o.every || 'day', at: o.at || '09:00', input, ...(o.quiet ? { notify: false } : {}) };
            const t = await http(`/api/v1/tools/${encodeURIComponent(tool)}/triggers`, { method: 'POST', body, auth: true, ...opts });
            if (json) { out(JSON.stringify(t)); return 0; }
            if (t.url) out(`${tool}: a private link, shown once; keep it\n    ${t.url}\n    curl -X POST '${t.url}' -H 'Content-Type: application/json' -d '{…}'`);
            else out(`${tool}: ${t.says}${t.next_run_at ? `, next ${t.next_run_at.slice(0, 16).replace('T', ' ')} UTC` : ''}${t.notify ? ', and you are told what it answered' : ''}`);
            return 0;
        }
        if (sub === 'automations') {
            const d = await http('/api/v1/me/triggers', { auth: true, ...opts });
            const list = (d && d.triggers) || [];
            if (json) { out(JSON.stringify(list)); return 0; }
            if (!list.length) { out('No automations yet: openvibe-codes tools automate <tool> --every day --at 09:00'); return 0; }
            for (const t of list) {
                const last = t.last_run_at ? `${t.last_state === 'succeeded' ? 'ran' : 'failed'} ${t.last_run_at.slice(0, 16).replace('T', ' ')}` : 'not run yet';
                out(`${t.tool_name || t.tool}  ${t.says}${t.enabled ? '' : '  (paused)'}\n    ${last}${t.enabled && t.next_run_at ? ` · next ${t.next_run_at.slice(0, 16).replace('T', ' ')} UTC` : ''} · ${t.runs || 0} runs · ${t.page || ''}`);
            }
            return 0;
        }
        throw new ToolsError(`No tools command "${sub}". ${HELP.split('\n')[0]}`, 'tools.usage');
    } catch (err) {
        if (json) out(JSON.stringify({ ok: false, error: { code: err.code || 'tools.failed', message: err.message } }));
        else out(`openvibe-codes tools: ${err.message}`);
        return 1;
    }
}

module.exports = { tools, inputOf, bodyOf, HELP };
