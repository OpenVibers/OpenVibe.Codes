'use strict';

/**
 * A coding agent for any model behind an OpenAI-compatible chat API: DeepSeek, OpenAI, or a model you host (llama.cpp,
 * Ollama, vLLM, LM Studio). The model gets a small set of tools that work inside the working directory, and the loop
 * runs until it answers without calling one (or reaches its turn limit):
 *
 *   list_dir, read_file, grep           every permission level
 *   write_file, edit_file               edit and full
 *   run_command                         full only (bash -lc in the working directory, two minutes, output clipped;
 *                                       push, reset, recursive rm and .env paths refused before anything spawns)
 *   advise                              OpenVibe.AI only, when the run asked for an advisor (at most 3 asks)
 *
 * Every path is resolved inside the working directory: `..` out of it, an absolute path elsewhere, `.git/` writes and
 * `.env` files are refused. One read answers at most 40 KB. The conversation is kept in the session store so `resume`
 * continues it.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createExchangeClient } = require('openvibe-sdk/exchange');
const ev = require('../events');

const SYSTEM = `You are a careful coding agent working in a repository on the user's machine. Use the tools to look before
you change anything: list and read the files involved, make the smallest change that does what was asked, and keep the
code's own style. When you are done, answer with a short summary of what you changed and anything left to do. Never
invent a file's contents: read it first.`;

const TOOL_DEFS = {
    list_dir: { level: 'read', description: 'List the entries of a directory (relative to the working directory).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] } },
    read_file: { level: 'read', description: 'Read a text file. Optional 1-based line offset and line limit.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] } },
    grep: { level: 'read', description: 'Search files for a regular expression; returns path:line: text matches.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
    write_file: { level: 'edit', description: 'Create or replace a file with the given content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    edit_file: { level: 'edit', description: 'Replace one exact, unique occurrence of old_string with new_string in a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
    run_command: { level: 'full', description: 'Run a shell command in the working directory (two-minute limit).', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
};
const LEVELS = { read: 1, edit: 2, full: 3 };
const SHOWN_AS = { list_dir: 'LS', read_file: 'Read', grep: 'Grep', write_file: 'Write', edit_file: 'Edit', run_command: 'Bash', advise: 'Advise' };
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.cache']);

/** What one read_file answer may hold: 40 KB, enforced here, not in the prompt. */
const MAX_READ = 40_000;

/**
 * The shell a job may not run (the portal's deny list, enforced where the command would spawn).
 *
 * Every `;`, `&&`, `||`, `|` and `&` segment is checked from its first word (leading `sudo`/`command` skipped),
 * so chaining a refusal after a harmless command does not dodge it; the same shapes are then matched anywhere in
 * the whole command, so `bash -c "git push"` and `timeout 5 git push` do not dodge it either. A refusal names
 * its rule, in the tool's answer, before anything spawns.
 *
 * @param {string} command the shell the model asked for
 * @returns {string|null} why it is refused, or null when it may run
 */
function refusedCommand(command) {
    const text = String(command == null ? '' : command);
    const segments = text.split(/\s*(?:&&|\|\||[;|&\n])\s*/);
    const head = (seg) => String(seg).replace(/^(?:sudo|command)\s+/i, '').trimStart();
    const push = /^git\s+push\b/;
    const reset = /^git\s+reset\b/;
    const recRm = /^rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s|$)/;
    const dotenv = /(?:^|[\s"'=([{\/-])(?:\S*\/)?\.env(?:\.[^\s"'/]*)?(?=[\s"'/)\]}]|$)/;
    const whole = [
        [/\bgit\s+push\b/, 'git push is refused: publishing is the person\'s step'],
        [/\bgit\s+reset\b/, 'git reset is refused: it throws work away'],
        [/\brm\b[^;|&\n]*?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s|$)/, 'a recursive rm is refused'],
        [dotenv, '.env files are not read or written'],
    ];
    for (const seg of segments) {
        const h = head(seg);
        if (push.test(h)) return 'git push is refused: publishing is the person\'s step';
        if (reset.test(h)) return 'git reset is refused: it throws work away';
        if (recRm.test(h)) return 'a recursive rm is refused';
        if (dotenv.test(seg)) return '.env files are not read or written';
    }
    for (const [re, why] of whole) if (re.test(text)) return why;
    return null;
}

/**
 * Ask the run's advisor (a stronger model on OpenVibe.AI) for guidance mid-run. Offered only when the run
 * asked for an advisor and only on the OpenVibe.AI adapter: the other API paths have no advice endpoint.
 */
const ADVISE = { level: 'read', description: 'Ask the stronger advisor model for guidance with the transcript so far (at most 3 asks per run). Say what you are stuck on or about to do.', parameters: { type: 'object', properties: { question: { type: 'string' } }, required: [] } };
/** The loop's own advice budget: AI caps uses per run, and every turn is its own run, so this is the real one. */
const MAX_ADVICE = 3;
/** What one advice call may carry of the transcript: 50 messages, 60 KB, inside AI's 200/300 KB. */
const ADVICE_MAX_MESSAGES = 50;
const ADVICE_MAX_CHARS = 60_000;

/**
 * The transcript an advice call sends: text only, roles AI accepts, the newest window inside the budget with
 * the system message and the task (the first user turn) always first. Tool calls become `called: …` lines —
 * the advisor sees what ran, not the calls' shapes.
 */
function adviceTranscript(messages, { maxMessages = ADVICE_MAX_MESSAGES, maxChars = ADVICE_MAX_CHARS } = {}) {
    const flat = [];
    for (const m of messages || []) {
        if (!m || typeof m !== 'object') continue;
        if (m.role === 'system') {
            const c = String(m.content == null ? '' : m.content).trim();
            if (c) flat.push({ role: 'system', content: c.slice(0, 20000) });
            continue;
        }
        if (m.role === 'tool') {
            const c = String(m.content == null ? '' : m.content).trim();
            if (c) flat.push({ role: 'tool', content: c.slice(0, 20000) });
            continue;
        }
        if (m.role === 'assistant') {
            const parts = [];
            const c = String(m.content || '').trim();
            if (c) parts.push(c.slice(0, 20000));
            const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
            if (calls.length) {
                parts.push(`called: ${calls.map((t) => {
                    const fn = (t && t.function) || {};
                    const a = String(fn.arguments || '');
                    return `${SHOWN_AS[fn.name] || fn.name || 'tool'}(${a.length > 300 ? `${a.slice(0, 300)}…` : a})`;
                }).join(', ')}`);
            }
            if (parts.length) flat.push({ role: 'assistant', content: parts.join('\n\n').slice(0, 20000) });
            continue;
        }
        if (m.role === 'user') {
            const c = String(m.content == null ? '' : m.content).trim();
            if (c) flat.push({ role: 'user', content: c.slice(0, 20000) });
        }
    }
    const system = flat.filter((m) => m.role === 'system');
    const rest = flat.filter((m) => m.role !== 'system');
    const firstUser = rest.find((m) => m.role === 'user');
    const head = [...system];
    if (firstUser) head.push(firstUser);
    const room = Math.max(0, maxChars - head.reduce((n, m) => n + m.content.length, 0));
    const tail = [];
    let chars = 0;
    for (let i = rest.length - 1; i >= 0 && tail.length < Math.max(0, maxMessages - head.length) && chars < room; i--) {
        if (rest[i] === firstUser) continue;
        chars += rest[i].content.length;
        tail.unshift(rest[i]);
    }
    const out = [...head, ...tail].slice(0, Math.max(1, maxMessages));
    return out.length ? out : [{ role: 'user', content: 'the executor asked for advice but has no transcript yet' }];
}

/** The API root the advice route hangs off: the chat base without its trailing /v1. */
function adviceRoot(base) { return String(base || '').replace(/\/v1$/, ''); }

/**
 * The real path of abs, with any part that does not exist yet kept as written; null when a component is
 * not a directory. Every existing component is realpath'd, so a symlink cannot hide where the path goes.
 */
function realPath(abs) {
    let p = path.resolve(abs);
    const tail = [];
    for (;;) {
        try { return path.join(fs.realpathSync(p), ...tail); }
        catch (err) {
            if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return null;
            const parent = path.dirname(p);
            if (parent === p) return null;
            tail.unshift(path.basename(p));
            p = parent;
        }
    }
}

/** A path inside the working directory, or an Error that says why not. */
function inside(cwd, p, { write = false } = {}) {
    const root = fs.realpathSync(cwd);
    const abs = path.resolve(root, String(p || '.'));
    if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return new Error(`${p} is outside the working directory`);
    // Resolve symlinks before trusting the textual check: `link/.env` or `link` → a path outside the
    // working directory would otherwise read and write through the link.
    const real = realPath(abs);
    if (real === null || (real !== root && !real.startsWith(`${root}${path.sep}`))) return new Error(`${p} is outside the working directory`);
    const rel = path.relative(root, real);
    if (/(^|[\\/])\.env(\.|$)/.test(rel)) return new Error('.env files are not read or written');
    if (write && /(^|[\\/])\.git([\\/]|$)/.test(rel)) return new Error('.git is not written');
    return real;
}

function runTool(name, args, cwd) {
    const a = args || {};
    if (name === 'list_dir') {
        const dir = inside(cwd, a.path);
        if (dir instanceof Error) return [dir.message, true];
        const items = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 300).map((d) => `${d.name}${d.isDirectory() ? '/' : ''}`);
        return [items.join('\n') || '(empty)', false];
    }
    if (name === 'read_file') {
        const f = inside(cwd, a.path);
        if (f instanceof Error) return [f.message, true];
        const text = fs.readFileSync(f, 'utf8');
        const lines = text.split('\n');
        const from = Math.max(1, Number(a.offset) || 1);
        const to = Math.min(lines.length, from - 1 + Math.max(1, Number(a.limit) || 2000));
        const body = lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join('\n');
        return [body.length > MAX_READ ? `${body.slice(0, MAX_READ)}\n… (cut: read with offset/limit)` : body, false];
    }
    if (name === 'grep') {
        const base = inside(cwd, a.path);
        if (base instanceof Error) return [base.message, true];
        let re;
        try { re = new RegExp(String(a.pattern)); } catch (err) { return [`bad pattern: ${err.message}`, true]; }
        const hits = [];
        const walk = (p) => {
            if (hits.length >= 200) return;
            const st = fs.lstatSync(p);
            if (st.isSymbolicLink()) return;    // a link can point anywhere: never followed
            if (st.isDirectory()) { for (const n of fs.readdirSync(p)) if (!SKIP_DIRS.has(n) && !/^\.env/.test(n)) walk(path.join(p, n)); return; }
            if (st.size > 1_000_000) return;
            const text = fs.readFileSync(p, 'utf8');
            if (text.includes('\u0000')) return;
            text.split('\n').forEach((l, i) => { if (hits.length < 200 && re.test(l)) hits.push(`${path.relative(cwd, p)}:${i + 1}: ${l.slice(0, 300)}`); });
        };
        walk(base);
        return [hits.join('\n') || 'no matches', false];
    }
    if (name === 'write_file') {
        const f = inside(cwd, a.path, { write: true });
        if (f instanceof Error) return [f.message, true];
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, String(a.content == null ? '' : a.content));
        return [`wrote ${path.relative(cwd, f)}`, false];
    }
    if (name === 'edit_file') {
        const f = inside(cwd, a.path, { write: true });
        if (f instanceof Error) return [f.message, true];
        const text = fs.readFileSync(f, 'utf8');
        const old = String(a.old_string || '');
        const count = old ? text.split(old).length - 1 : 0;
        if (count !== 1) return [count ? `old_string occurs ${count} times: add context so it is unique` : 'old_string not found: read the file first', true];
        fs.writeFileSync(f, text.replace(old, String(a.new_string == null ? '' : a.new_string)));
        return [`edited ${path.relative(cwd, f)}`, false];
    }
    return [`unknown tool ${name}`, true];
}

/**
 * One advice call against the latest turn's run: the bounded transcript and the model's question go to
 * POST /api/v1/runs/:id/advice, and the stronger model's guidance (at most 100 words) comes back. AI records
 * the use on the run's receipt with its cost; this loop's own count is the per-task budget.
 *
 * @returns {Promise<[string, boolean, boolean]>} the answer, whether it failed, and whether to stop asking
 */
async function askAdvice({ doFetch, base, env, bearer, runId, transcript, question, model }) {
    let res;
    try {
        res = await doFetch(`${adviceRoot(base)}/api/v1/runs/${encodeURIComponent(runId)}/advice`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extraHeaders(env) },
            body: JSON.stringify({ transcript, ...(question ? { question } : {}), ...(model ? { model } : {}) }),
        });
    } catch (err) {
        return [`the advisor could not be reached: ${err.message}`, true, false];
    }
    const body = await res.json().catch(() => null);
    if (res.status === 201 && body && typeof body.advice === 'string' && body.advice.trim()) return [body.advice.trim(), false, false];
    const code = String((body && ((body.error && body.error.code) || body.code)) || '');
    const detail = String((body && ((body.error && (body.error.message || body.error.detail)) || body.detail)) || '').slice(0, 300);
    if (res.status === 409 || code === 'advisor.exhausted') return ['the advisor has no calls left on this run: work with what it said', true, true];
    if (res.status === 403 || code === 'advisor.not_enabled') return ['this run did not ask for an advisor', true, true];
    return [`the advisor answered HTTP ${res.status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`, true, false];
}

/** run_command, asynchronously (the only tool that waits on something else); onChunk(text) hears its output as it comes. */
function runCommand(command, cwd, signal, onChunk) {
    return new Promise((resolve) => {
        const child = spawn('bash', ['-lc', String(command)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const add = (d) => { out = (out + d.toString()).slice(-16_000); if (onChunk) { try { onChunk(d.toString()); } catch { /* a listener never stops the command */ } } };
        child.stdout.on('data', add); child.stderr.on('data', add);
        const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
        const abort = () => child.kill('SIGKILL');
        if (signal) signal.addEventListener('abort', abort, { once: true });
        child.on('close', (code) => { clearTimeout(timer); resolve([`${out.trim()}${code ? `\n(exit ${code})` : ''}` || '(no output)', code !== 0]); });
        child.on('error', (err) => { clearTimeout(timer); resolve([err.message, true]); });
    });
}

/** What a step shows of its input: an edit its change and a new file its start (clipped, secrets scrubbed), so a
 *  reader sees the diff; everything else as the agent gave it. */
function shownInput(name, args) {
    const cut = (s, n) => ev.clip(ev.scrub(s == null ? '' : s), n);
    if (name === 'edit_file') return { file_path: args.path, old_string: cut(args.old_string, 4000), new_string: cut(args.new_string, 4000) };
    if (name === 'write_file') return { file_path: args.path, content: cut(args.content, 4000) };
    if (name === 'run_command') return { command: cut(args.command, 2000) };
    return args;
}

/**
 * The extra headers a job's environment asks for (Codes C3): OPENVIBE_CODES_HEADERS is a JSON object of header names
 * and values (the credential header that says whose key the request uses). Only header names and short values are
 * read, and a name that is not a header is refused, so nothing else can ride this way.
 */
function extraHeaders(env) {
    const raw = String((env && env.OPENVIBE_CODES_HEADERS) || '').trim();
    if (!raw || raw.length > 2000) return {};
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return {}; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [name, value] of Object.entries(parsed)) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) continue;
        if (typeof value !== 'string' || !value || value.length > 300) continue;
        out[name] = value;
    }
    return out;
}

/**
 * One turn through OpenVibe.Exchange's compatible API, using the SDK's Exchange client: the same Chat Completions body
 * and tool loop as the direct path, with the Exchange's key, timeout and receipt. `key` is the person's or the
 * service's Exchange key; `token(env, fetch)` names one minted for the request instead (a Network token).
 */
async function exchangeTurn(spec, { env, doFetch, payload, signal }) {
    const key = spec.exchange.token ? await spec.exchange.token(env, doFetch) : spec.exchange.key;
    if (!key) throw Object.assign(new Error('no Exchange key is connected'), { code: 'exchange.no_key' });
    const client = createExchangeClient({
        developerKey: String(key),
        baseUrl: String(spec.exchange.baseUrl || 'https://api.openvibe.exchange').replace(/\/+$/, ''),
        fetchImpl: doFetch,
        timeoutMs: 120_000,
    });
    return await client.chat(payload, { signal });
}

/**
 * The API's refusal in the person's words. An exact id AI refused keeps its own code (ai.model_not_found,
 * ai.model_unavailable): the reason a chosen model did not run is shown as that, never as a different model's answer.
 */
function refusalOf(name, status, body, model) {
    const err = body && typeof body.error === 'object' && body.error ? body.error : null;
    const code = String((err && err.code) || (body && body.code) || '') || null;
    const detail = String((err && (err.message || err.detail)) || (body && (body.detail || body.title)) || (typeof (body && body.error) === 'string' ? body.error : '') || '').slice(0, 300);
    if (code === 'ai.model_not_found' || code === 'ai.model_unavailable') {
        return `${name} refused the model ${model}: HTTP ${status} ${code}${detail ? `: ${detail}` : ''}`;
    }
    return `${name} answered HTTP ${status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`;
}

/**
 * apiAgent({ id, name, baseUrl, keyEnv, model, priceIn, priceOut, token, exchange, available }) → an adapter.
 * exchange: { baseUrl, key } or { baseUrl, token(env, fetch) } → every turn goes through OpenVibe.Exchange's
 * compatible API with the SDK's Exchange client, instead of the direct fetch. available(env) answers the catalog's
 * "can this run here, and why not" for an adapter whose credentials are resolved by the caller.
 * extra(env) → fields added to every request body (OpenVibe.AI's x_openvibe.provider: the project's own provider).
 * token(env, fetch) → a bearer, asked before every request (OpenVibe.AI takes a five-minute Network token, refreshed by
 * the function); without it the key is keyEnv's value. When the API reports each answer's cost (OpenVibe.AI's
 * x_openvibe.cost_usd), the run's cost is the sum of those, not a price list.
 * ctx (from harness/index.js): { env, fetch, sessions } — sessions keeps the conversation for resume.
 */
function apiAgent(spec) {
    const adapter = {
        id: spec.id, name: spec.name, kind: 'api', baseUrl: spec.exchange ? spec.exchange.baseUrl : spec.baseUrl, keyEnv: spec.keyEnv || null, defaultModel: spec.model,
        ...(spec.available ? { available: spec.available } : {}),
        start(t, ctx = {}) {
            const env = ctx.env || process.env;
            const doFetch = ctx.fetch || globalThis.fetch;
            const base = String(t.baseUrl || spec.baseUrl || (spec.exchange && spec.exchange.baseUrl) || '').replace(/\/+$/, '');
            const key = spec.keyEnv ? env[spec.keyEnv] : (t.apiKey || '');
            const model = t.model || spec.model;
            const level = LEVELS[t.permission] || 1;
            // Tools in a fixed name order, and the system message above never carries the task: the request prefix a
            // provider caches (system + tools) is byte-identical from one task to the next, and only the prompt differs.
            // advise joins the list only when the run asked for an advisor (off unless asked) and this adapter is
            // OpenVibe.AI's: the other API paths have no advice endpoint. It stays for every turn, asked out or not,
            // so the prefix stays stable; past its budget it answers a refusal instead of calling.
            const defs = spec.advisorEndpoint === true && t.advisor ? { ...TOOL_DEFS, advise: ADVISE } : TOOL_DEFS;
            const tools = Object.entries(defs).filter(([, d]) => LEVELS[d.level] <= level)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, d]) => ({ type: 'function', function: { name, description: d.description, parameters: d.parameters } }));
            const sessionId = t.resume || `api_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
            const startedAt = Date.now();
            const maxTurns = Math.max(1, Number(t.maxTurns) || 40);
            let cancelled = false;
            const controller = new AbortController();
            if (t.signal) t.signal.addEventListener('abort', () => { cancelled = true; controller.abort(); }, { once: true });

            const iterator = (async function* run() {
                const prior = t.resume && ctx.sessions ? ctx.sessions.load(sessionId) : null;
                const messages = prior && Array.isArray(prior.messages) ? prior.messages : [{ role: 'system', content: SYSTEM }];
                messages.push({ role: 'user', content: t.prompt });
                yield ev.init(sessionId, spec.id, model);
                const u = { input: 0, output: 0, cacheRead: 0 };
                const reported = { usd: 0, any: false };
                let lastText = '';
                let turns = 0;
                let failure = null;
                // The model AI says ran, and its route disclosure (x_openvibe), recorded on the run's result.
                let resolvedModel = null;
                let disclosure = null;
                // The latest turn's AI run, advise asks against; the advice spent on this task; and the Exchange's
                // receipt for the answer (x_openvibe.receipt_id), carried on the result for the check and the page.
                let adviceRunId = null;
                let receiptId = null;
                let adviceUsed = 0;
                try {
                    while (turns < maxTurns && !cancelled) {
                        turns++;
                        const payload = { ...(spec.extra ? spec.extra(env) : {}), model, messages, tools, tool_choice: 'auto',
                            // Codes L31/AI AL3: the reasoning level the caller asked for, and the option to ask
                            // the AI router's advisor for guidance. AI ignores both when its own request does not
                            // support them; a harness that has no setting never sees them.
                            ...(t.effort ? { effort: t.effort } : {}), ...(t.advisor ? { advisor: t.advisor } : {}) };
                        let body;
                        let res = null;
                        if (spec.exchange) {
                            // The default path: the Exchange's compatible API through the SDK's Exchange client (the
                            // person's or the service's Exchange key), with the same tool loop as before.
                            try {
                                body = await exchangeTurn(spec, { env, doFetch, payload, signal: controller.signal });
                            } catch (err) {
                                failure = err.status
                                    ? `${spec.name} was refused by the Exchange (HTTP ${err.status}${err.code ? `, ${err.code}` : ''}): ${err.message}`
                                    : `${spec.name} could not reach the Exchange: ${err.message}`;
                                yield ev.error(failure);
                                break;
                            }
                        } else {
                            const bearer = spec.token ? await spec.token(env, doFetch) : key;
                            res = await doFetch(`${base}/chat/completions`, {
                                method: 'POST',
                                headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extraHeaders(env) },
                                body: JSON.stringify(payload),
                                signal: controller.signal,
                            });
                            body = await res.json().catch(() => null);
                        }
                        const x = body && body.x_openvibe && typeof body.x_openvibe === 'object' ? body.x_openvibe : null;
                        if (x) {
                            if (x.resolved_model) resolvedModel = String(x.resolved_model);
                            if (x.run_id) adviceRunId = String(x.run_id);
                            if (x.receipt_id) receiptId = String(x.receipt_id);
                            disclosure = { ...(disclosure || {}), ...x };
                        }
                        if (!adviceRunId && body && typeof body.id === 'string' && body.id.startsWith('chatcmpl-')) adviceRunId = body.id.slice('chatcmpl-'.length);
                        if ((res && !res.ok) || !body || !Array.isArray(body.choices) || !body.choices[0]) {
                            // An exact id AI refused (ai.model_not_found / ai.model_unavailable) is its own answer:
                            // it is reported as it is, and this loop never asks for a different model instead.
                            failure = spec.exchange
                                ? `${spec.name} answered without a completion${body && body.error ? `: ${String((body.error && (body.error.message || body.error)) || body.error).slice(0, 300)}` : ''}`
                                : refusalOf(spec.name, res.status, body, model);
                            yield ev.error(failure);
                            break;
                        }
                        const usage = body.usage || {};
                        if (x && Number.isFinite(+x.cost_usd)) { reported.usd += +x.cost_usd; reported.any = true; }
                        u.input += +usage.prompt_tokens || 0; u.output += +usage.completion_tokens || 0;
                        u.cacheRead += +(usage.prompt_cache_hit_tokens || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)) || 0;
                        const msg = body.choices[0].message || {};
                        messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
                        if (String(msg.content || '').trim()) { lastText = msg.content; yield ev.text(msg.content, resolvedModel || model); }
                        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
                        if (!calls.length) break;
                        for (const call of calls) {
                            const name = call.function && call.function.name;
                            let args = {};
                            try { args = JSON.parse((call.function && call.function.arguments) || '{}'); } catch { /* answered as an error below */ }
                            yield ev.toolUse(call.id, SHOWN_AS[name] || name, shownInput(name, args), resolvedModel || model);
                            let out;
                            const def = defs[name];
                            if (!def) out = [`unknown tool ${name}`, true];
                            else if (LEVELS[def.level] > level) out = [`${name} needs the ${def.level} permission level`, true];
                            else if (name === 'advise') {
                                // Capped at 3 asks, against the latest turn's run: the transcript goes bounded,
                                // the guidance feeds this loop, and AI puts each use on the run's receipt.
                                if (adviceUsed >= MAX_ADVICE) out = ['the advisor has been asked 3 times on this run: work with what it said', true];
                                else if (!adviceRunId) out = ['the advisor has no run to ask against yet: carry on, and ask again after the next answer', true];
                                else {
                                    const question = typeof args.question === 'string' ? args.question.trim().slice(0, 4000) : '';
                                    const advisorModel = t.advisor && typeof t.advisor === 'object' && typeof t.advisor.model === 'string' ? t.advisor.model : null;
                                    try {
                                        const b = spec.token ? await spec.token(env, doFetch) : key;
                                        const [text, failed, exhausted] = await askAdvice({ doFetch, base, env, bearer: b, runId: adviceRunId, transcript: adviceTranscript(messages), question, model: advisorModel });
                                        if (failed) { if (exhausted) adviceUsed = MAX_ADVICE; out = [text, true]; }
                                        else { adviceUsed++; out = [`${text}\n\n(advice ${adviceUsed} of ${MAX_ADVICE})`, false]; }
                                    } catch (err) {
                                        out = [`the advisor could not be reached: ${err.message}`, true];
                                    }
                                }
                            }
                            else if (name === 'run_command') {
                                // The hard rules run before the shell does: a refusal is the tool's answer, and
                                // nothing spawns.
                                const refused = refusedCommand(args.command);
                                if (refused) out = [refused, true];
                                else {
                                // The command's output reaches the stream as it comes (batched every 150 ms), so a
                                // reader sees a long test run move instead of waiting for its end.
                                const chunks = []; let wake = null; let finished = null;
                                const nudge = () => { if (wake) { const w = wake; wake = null; w(); } };
                                runCommand(args.command, t.cwd, controller.signal, (d) => { chunks.push(d); nudge(); }).then((r) => { finished = r; nudge(); });
                                while (!finished) {
                                    await new Promise((r) => { wake = r; if (finished || chunks.length) nudge(); });
                                    if (!finished) await new Promise((r) => setTimeout(r, 150));
                                    if (chunks.length) yield ev.toolProgress(call.id, chunks.splice(0).join(''));
                                }
                                if (chunks.length) yield ev.toolProgress(call.id, chunks.splice(0).join(''));
                                out = finished;
                                }
                            }
                            else { try { out = runTool(name, args, t.cwd); } catch (err) { out = [err.message, true]; } }
                            yield ev.toolResult(call.id, out[0], out[1]);
                            messages.push({ role: 'tool', tool_call_id: call.id, content: String(out[0]).slice(0, 16_000) });
                        }
                    }
                    if (!failure && !cancelled && turns >= maxTurns && !lastText) failure = `${spec.name} reached its turn limit (${maxTurns}) without an answer`;
                } catch (err) {
                    failure = cancelled ? `${spec.name} was stopped` : `${spec.name} could not be reached: ${err.message}`;
                    yield ev.error(failure);
                }
                if (ctx.sessions) ctx.sessions.save(sessionId, { agent: spec.id, model: resolvedModel || model, messages: messages.slice(-200) });
                const cost = reported.any ? reported.usd : (u.input * (spec.priceIn || 0) + u.output * (spec.priceOut || 0)) / 1000;
                yield ev.result({ ok: !failure && !cancelled, text: failure || lastText, sessionId, model: resolvedModel || model, startedAt, turns, costUsd: cost,
                    ...(resolvedModel ? { resolved_model: resolvedModel } : {}),
                    ...(receiptId ? { receipt_id: receiptId } : {}),
                    ...(disclosure ? { disclosure } : {}),
                    usage: ev.usage({ input: u.input - u.cacheRead, output: u.output, cacheRead: u.cacheRead }) });
            }());
            iterator.cancel = () => { cancelled = true; controller.abort(); };
            return iterator;
        },
    };
    return adapter;
}

module.exports = { apiAgent, exchangeTurn, refusalOf, extraHeaders, runTool, inside, refusedCommand, adviceTranscript, TOOL_DEFS, SYSTEM };
