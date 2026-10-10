'use strict';

/**
 * A coding agent for any model behind an OpenAI-compatible chat API: DeepSeek, OpenAI, or a model you host (llama.cpp,
 * Ollama, vLLM, LM Studio). The model gets a small set of tools that work inside the working directory, and the loop
 * runs until it answers without calling one (or reaches its turn limit):
 *
 *   list_dir, read_file, grep           every permission level
 *   write_file, edit_file               edit and full
 *   run_command                         full only (bash -lc in the working directory, two minutes, output clipped)
 *
 * Every path is resolved inside the working directory: `..` out of it, an absolute path elsewhere, `.git/` writes and
 * `.env` files are refused. The conversation is kept in the session store so `resume` continues it.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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
const SHOWN_AS = { list_dir: 'LS', read_file: 'Read', grep: 'Grep', write_file: 'Write', edit_file: 'Edit', run_command: 'Bash' };
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.cache']);

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
        return [body.length > 64_000 ? `${body.slice(0, 64_000)}\n… (cut: read with offset/limit)` : body, false];
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

/** run_command, asynchronously (the only tool that waits on something else). */
function runCommand(command, cwd, signal) {
    return new Promise((resolve) => {
        const child = spawn('bash', ['-lc', String(command)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const add = (d) => { out = (out + d.toString()).slice(-16_000); };
        child.stdout.on('data', add); child.stderr.on('data', add);
        const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
        const abort = () => child.kill('SIGKILL');
        if (signal) signal.addEventListener('abort', abort, { once: true });
        child.on('close', (code) => { clearTimeout(timer); resolve([`${out.trim()}${code ? `\n(exit ${code})` : ''}` || '(no output)', code !== 0]); });
        child.on('error', (err) => { clearTimeout(timer); resolve([err.message, true]); });
    });
}

/**
 * apiAgent({ id, name, baseUrl, keyEnv, model, priceIn, priceOut }) → an adapter.
 * ctx (from harness/index.js): { env, fetch, sessions } — sessions keeps the conversation for resume.
 */
function apiAgent(spec) {
    const adapter = {
        id: spec.id, name: spec.name, kind: 'api', baseUrl: spec.baseUrl, keyEnv: spec.keyEnv || null, defaultModel: spec.model,
        start(t, ctx = {}) {
            const env = ctx.env || process.env;
            const doFetch = ctx.fetch || globalThis.fetch;
            const base = String(t.baseUrl || spec.baseUrl).replace(/\/+$/, '');
            const key = spec.keyEnv ? env[spec.keyEnv] : (t.apiKey || '');
            const model = t.model || spec.model;
            const level = LEVELS[t.permission] || 1;
            const tools = Object.entries(TOOL_DEFS).filter(([, d]) => LEVELS[d.level] <= level)
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
                let lastText = '';
                let turns = 0;
                let failure = null;
                try {
                    while (turns < maxTurns && !cancelled) {
                        turns++;
                        const res = await doFetch(`${base}/chat/completions`, {
                            method: 'POST',
                            headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
                            body: JSON.stringify({ model, messages, tools, tool_choice: 'auto' }),
                            signal: controller.signal,
                        });
                        const body = await res.json().catch(() => null);
                        if (!res.ok || !body || !Array.isArray(body.choices) || !body.choices[0]) {
                            failure = `${spec.name} answered HTTP ${res.status}${body && body.error ? `: ${String(body.error.message || body.error).slice(0, 300)}` : ''}`;
                            yield ev.error(failure);
                            break;
                        }
                        const usage = body.usage || {};
                        u.input += +usage.prompt_tokens || 0; u.output += +usage.completion_tokens || 0;
                        u.cacheRead += +(usage.prompt_cache_hit_tokens || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)) || 0;
                        const msg = body.choices[0].message || {};
                        messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
                        if (String(msg.content || '').trim()) { lastText = msg.content; yield ev.text(msg.content, model); }
                        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
                        if (!calls.length) break;
                        for (const call of calls) {
                            const name = call.function && call.function.name;
                            let args = {};
                            try { args = JSON.parse((call.function && call.function.arguments) || '{}'); } catch { /* answered as an error below */ }
                            yield ev.toolUse(call.id, SHOWN_AS[name] || name, name === 'edit_file' || name === 'write_file' ? { file_path: args.path } : args, model);
                            let out;
                            const def = TOOL_DEFS[name];
                            if (!def) out = [`unknown tool ${name}`, true];
                            else if (LEVELS[def.level] > level) out = [`${name} needs the ${def.level} permission level`, true];
                            else if (name === 'run_command') out = await runCommand(args.command, t.cwd, controller.signal);
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
                if (ctx.sessions) ctx.sessions.save(sessionId, { agent: spec.id, model, messages: messages.slice(-200) });
                const cost = (u.input * (spec.priceIn || 0) + u.output * (spec.priceOut || 0)) / 1000;
                yield ev.result({ ok: !failure && !cancelled, text: failure || lastText, sessionId, model, startedAt, turns, costUsd: cost,
                    usage: ev.usage({ input: u.input - u.cacheRead, output: u.output, cacheRead: u.cacheRead }) });
            }());
            iterator.cancel = () => { cancelled = true; controller.abort(); };
            return iterator;
        },
    };
    return adapter;
}

module.exports = { apiAgent, runTool, inside, TOOL_DEFS, SYSTEM };
