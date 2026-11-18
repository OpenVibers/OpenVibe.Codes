'use strict';

/**
 * Code mode for a coding agent that runs headless (2026-11-18; plan §AD.28 item 5). Claude Code's own Code Mode works
 * only in an interactive terminal ("doesn't work with -p, the Agent SDK … or cloud sessions"), and every Codes run is
 * headless. So Codes brings its own, as an MCP server the run starts beside the agent:
 *
 *   search  { query }   the repository's tools that match, each as a typed signature
 *   execute { code }    a JavaScript script in openvibe-sdk/code-mode's sandbox (its own process under Node's permission
 *                       model: no files, network or processes of its own), whose only way out is
 *                       `await tools.<name>(input)`: read, write, edit, glob, grep, ls and sh, here, in the job's folder.
 *                       Only what it returns and its console lines come back, so ten reads and a grep cost one turn
 *                       and only the part that matters enters the agent's context.
 *
 * Every tool works only inside ROOT (the job's folder), never on a .env file, and within the job's PERMISSION, the
 * same rules as the agent's own tools:
 *   read    read, glob, grep, ls                       (Claude Code's plan mode; a conductor that asks the owner)
 *   files   and write, edit                             (a conductor at "project": files without the owner, no commands)
 *   edit    and sh, with the portal's deny list         (no git push/commit/reset/clean/stash, sudo, rm -rf, .env)
 *   full    and sh, only git push denied                (publishing is always the person's step)
 *
 *   createRepoTools({ root, permission }) → { defs, call(name, input) }
 *   serveStdio({ root, permission, input, output }) → the MCP server over newline-delimited JSON-RPC
 *   ready() → null when this Node can run the sandbox, else why not (Node 22.13+: the permission model)
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PERMISSIONS = ['read', 'files', 'edit', 'full'];
const LIMITS = { ms: 10 * 60_000, calls: 300, resultBytes: 32 * 1024, memMb: 256 };
const MAX_READ = 400 * 1024;
const MAX_OUT = 200 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const DENIED_SH = [
    [/\bgit\s+push\b/, 'git push (publishing is the person\'s step)'],
    [/\bgit\s+(commit|reset|clean|stash)\b/, 'git commit, reset, clean or stash'],
    [/(^|[;&|\s(])sudo\b/, 'sudo'],
    [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r)\b/, 'rm -rf'],
    [/(^|[\s'"=/<])\.env(\.[\w.-]+)?(\s|$|['"])/, 'a .env file'],
];

function ready() {
    const [maj, min] = String(process.versions.node).split('.').map(Number);
    if (maj > 22 || (maj === 22 && min >= 13)) return null;
    return `code mode needs Node.js 22.13 or newer for its sandbox (this machine has ${process.versions.node})`;
}

const toolError = (message) => Object.assign(new Error(message), { toolError: true });

function createRepoTools({ root, permission = 'edit' } = {}) {
    const base = fs.realpathSync(path.resolve(root || process.cwd()));
    const perm = PERMISSIONS.includes(permission) ? permission : 'read';
    const may = { write: perm !== 'read', sh: perm === 'edit' || perm === 'full' };

    /** A path inside the folder (relative or absolute), refusing anything outside it and every .env file. */
    function inside(p, { create = false } = {}) {
        const raw = String(p == null || p === '' ? '.' : p);
        if (/\0/.test(raw)) throw toolError('a path has no NUL byte');
        const abs = path.resolve(base, raw);
        let real = abs;
        try { real = fs.realpathSync(abs); } catch {
            if (!create) throw toolError(`no such file or folder: ${raw}`);
            let parent = path.dirname(abs);
            while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
            real = path.join(fs.realpathSync(parent), path.relative(parent, abs));
        }
        if (real !== base && !real.startsWith(base + path.sep)) throw toolError(`${raw} is outside this job's folder`);
        if (/^\.env(\..*)?$/.test(path.basename(real))) throw toolError('.env files are never read or written here');
        return real;
    }
    const rel = (abs) => path.relative(base, abs) || '.';

    function walk(dir, out, limit) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (out.length >= limit) return;
            if (SKIP_DIRS.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full, out, limit);
            else if (e.isFile()) out.push(full);
        }
    }
    const globRe = (pattern) => new RegExp('^' + String(pattern).split('/').map((seg) => (seg === '**' ? '(?:.*/)?' : seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '/')).join('').replace(/\(\?:\.\*\/\)\?\/?$/, '.*').replace(/\/$/, '') + '$');

    let rg = null;
    const hasRg = () => (rg === null ? (rg = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0) : rg);

    const tools = {
        read({ path: p, from = 1, to = null } = {}) {
            const abs = inside(p);
            const st = fs.statSync(abs);
            if (st.isDirectory()) throw toolError(`${p} is a folder: use ls`);
            if (st.size > 20 * 1024 * 1024) throw toolError(`${p} is ${Math.round(st.size / 1048576)} MB: read part of it with grep`);
            const lines = fs.readFileSync(abs, 'utf8').split('\n');
            const a = Math.max(1, Number(from) || 1);
            const b = Math.min(lines.length, to == null ? lines.length : Math.max(a, Number(to) || a));
            let text = lines.slice(a - 1, b).join('\n');
            const cut = Buffer.byteLength(text) > MAX_READ;
            if (cut) text = Buffer.from(text).subarray(0, MAX_READ).toString('utf8');
            return { path: rel(abs), from: a, to: b, lines: lines.length, text, ...(cut ? { cut: true } : {}) };
        },
        write({ path: p, text = '' } = {}) {
            if (!may.write) throw toolError('this job may only read (its permission is read)');
            const abs = inside(p, { create: true });
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, String(text));
            return { path: rel(abs), bytes: Buffer.byteLength(String(text)) };
        },
        edit({ path: p, old, new: next, all = false } = {}) {
            if (!may.write) throw toolError('this job may only read (its permission is read)');
            if (typeof old !== 'string' || !old) throw toolError('edit needs the exact text to replace (old)');
            if (typeof next !== 'string') throw toolError('edit needs the new text (new)');
            const abs = inside(p);
            const was = fs.readFileSync(abs, 'utf8');
            const n = was.split(old).length - 1;
            if (!n) throw toolError(`the text to replace is not in ${p}`);
            if (n > 1 && !all) throw toolError(`the text to replace is in ${p} ${n} times: give more of it, or all: true`);
            fs.writeFileSync(abs, all ? was.split(old).join(next) : was.replace(old, () => next));
            return { path: rel(abs), replaced: all ? n : 1 };
        },
        ls({ path: p = '.' } = {}) {
            const abs = inside(p);
            return fs.readdirSync(abs, { withFileTypes: true }).filter((e) => !/^\.env(\..*)?$/.test(e.name)).slice(0, 1000).map((e) => {
                const full = path.join(abs, e.name);
                let size = null;
                try { if (e.isFile()) size = fs.statSync(full).size; } catch { size = null; }
                return { name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', ...(size != null ? { size } : {}) };
            });
        },
        glob({ pattern, limit = 500 } = {}) {
            if (typeof pattern !== 'string' || !pattern) throw toolError('glob needs a pattern, like src/**/*.js');
            const re = globRe(pattern.replace(/^\.\//, ''));
            const files = [];
            walk(base, files, 200000);
            return files.map(rel).filter((f) => re.test(f) && !/(^|\/)\.env(\..*)?$/.test(f)).slice(0, Math.max(1, Math.min(5000, Number(limit) || 500)));
        },
        async grep({ pattern, path: p = '.', glob = null, ignoreCase = false, limit = 200 } = {}) {
            if (typeof pattern !== 'string' || !pattern) throw toolError('grep needs a pattern (a regular expression)');
            const where = inside(p);
            const max = Math.max(1, Math.min(2000, Number(limit) || 200));
            if (hasRg()) {
                const args = ['--json', '--max-count', '50', '--glob', '!.env*', '--glob', '!.git', '--glob', '!node_modules', ...(ignoreCase ? ['-i'] : []), ...(glob ? ['--glob', String(glob)] : []), '-e', pattern, where];
                const out = await run('rg', args, { cwd: base, timeoutMs: 60_000 });
                const matches = [];
                for (const line of out.stdout.split('\n')) {
                    if (matches.length >= max) break;
                    let j; try { j = JSON.parse(line); } catch { continue; }
                    if (j.type !== 'match') continue;
                    matches.push({ file: rel(path.resolve(base, j.data.path.text)), line: j.data.line_number, text: String(j.data.lines.text || '').replace(/\n$/, '').slice(0, 400) });
                }
                return { matches, ...(matches.length >= max ? { more: true } : {}) };
            }
            let re;
            try { re = new RegExp(pattern, ignoreCase ? 'i' : ''); } catch (e) { throw toolError(`not a regular expression: ${e.message}`); }
            const gre = glob ? globRe(String(glob).replace(/^\.\//, '')) : null;
            const files = [];
            if (fs.statSync(where).isDirectory()) walk(where, files, 50000); else files.push(where);
            const matches = [];
            for (const f of files) {
                const r = rel(f);
                if (/(^|\/)\.env(\..*)?$/.test(r) || (gre && !gre.test(r) && !gre.test(path.basename(r)))) continue;
                let text; try { if (fs.statSync(f).size > 2 * 1024 * 1024) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
                if (text.includes('\0')) continue;
                const lines = text.split('\n');
                for (let i = 0; i < lines.length && matches.length < max; i += 1) if (re.test(lines[i])) matches.push({ file: r, line: i + 1, text: lines[i].slice(0, 400) });
                if (matches.length >= max) break;
            }
            return { matches, ...(matches.length >= max ? { more: true } : {}) };
        },
        async sh({ cmd, timeoutMs = 120_000 } = {}) {
            if (!may.sh) throw toolError(perm === 'files' ? 'this job may change files but not run commands' : 'this job may only read (its permission is read)');
            const c = String(cmd || '');
            if (!c.trim()) throw toolError('sh needs a command');
            for (const [re, what] of perm === 'full' ? DENIED_SH.slice(0, 1) : DENIED_SH) if (re.test(c)) throw toolError(`not here: ${what}`);
            return run('bash', ['-lc', c], { cwd: base, timeoutMs: Math.max(1000, Math.min(15 * 60_000, Number(timeoutMs) || 120_000)) });
        },
    };

    const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
    const defs = [
        { name: 'read', description: 'Read a text file in the job\'s folder, whole or lines FROM to TO (1-based). → { path, from, to, lines, text }', inputSchema: obj({ path: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } }, ['path']) },
        { name: 'grep', description: 'Search file contents with a regular expression (ripgrep when the machine has it). → { matches: [{ file, line, text }], more? }', inputSchema: obj({ pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, ignoreCase: { type: 'boolean' }, limit: { type: 'integer' } }, ['pattern']) },
        { name: 'glob', description: 'Files whose path matches a pattern (src/**/*.js), skipping .git and node_modules. → string[]', inputSchema: obj({ pattern: { type: 'string' }, limit: { type: 'integer' } }, ['pattern']) },
        { name: 'ls', description: 'A folder\'s entries. → [{ name, type, size? }]', inputSchema: obj({ path: { type: 'string' } }) },
        ...(may.write ? [
            { name: 'edit', description: 'Replace exact text in a file: once (it must be there exactly once) or every time (all: true). → { path, replaced }', inputSchema: obj({ path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' }, all: { type: 'boolean' } }, ['path', 'old', 'new']) },
            { name: 'write', description: 'Write a whole file (its folders are made). → { path, bytes }', inputSchema: obj({ path: { type: 'string' }, text: { type: 'string' } }, ['path', 'text']) },
        ] : []),
        ...(may.sh ? [{ name: 'sh', description: 'Run a shell command in the job\'s folder (bash -lc), for tests, builds and git status/diff/log. → { code, stdout, stderr }', inputSchema: obj({ cmd: { type: 'string' }, timeoutMs: { type: 'integer' } }, ['cmd']) }] : []),
    ];

    async function call(name, input) {
        const fn = tools[name];
        if (!fn || !defs.some((d) => d.name === name)) return { ok: false, error: `there is no tool ${name} here` };
        try { return { ok: true, value: await fn(input && typeof input === 'object' ? input : {}) }; } catch (e) {
            return { ok: false, error: e && e.toolError ? e.message : `${name} failed: ${String((e && e.message) || e).slice(0, 300)}` };
        }
    }
    return { defs, call, root: base, permission: perm };
}

/** A process's exit code and output (each cut at 200 KB), killed after timeoutMs. */
function run(cmd, args, { cwd, timeoutMs }) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', killed = false;
        const add = (buf, chunk) => (buf.length < MAX_OUT ? buf + chunk.toString('utf8') : buf);
        child.stdout.on('data', (c) => { stdout = add(stdout, c); });
        child.stderr.on('data', (c) => { stderr = add(stderr, c); });
        const t = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
        child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout: '', stderr: String(e.message) }); });
        child.on('close', (code) => {
            clearTimeout(t);
            resolve({ code: killed ? 124 : code, stdout: stdout.slice(0, MAX_OUT), stderr: stderr.slice(0, MAX_OUT), ...(killed ? { timedOut: true } : {}) });
        });
    });
}

const INSTRUCTIONS = 'ov_code: run one JavaScript script that calls this repository\'s tools, instead of one tool call at a time. '
    + 'Use execute when the work takes several reads, searches or edits: find every caller and change each, read the ten files that matter and keep the lines you need, run the tests and pick out the failures. '
    + 'Inside the script, `await tools.read({ path })`, `tools.grep({ pattern, glob })`, `tools.glob({ pattern })`, `tools.ls({ path })`, and when the job may change things `tools.edit({ path, old, new })`, `tools.write({ path, text })`, `tools.sh({ cmd })`; calls may run in parallel (Promise.all). '
    + 'Only what the script returns (32 KB at most) and its console.log lines come back, so return just what you need. search lists the tools with their types. '
    + 'The script itself has no files, network or processes: everything goes through tools, inside this job\'s folder.';

const SEARCH = {
    name: 'search',
    description: 'The repository tools a script may call in execute, with their input types. Empty query: all of them.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 } }, additionalProperties: false },
    annotations: { title: 'Find the script tools', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const EXECUTE = {
    name: 'execute',
    description: 'Run a JavaScript script that calls `await tools.<name>(input)` (read, grep, glob, ls, edit, write, sh as the job allows) and returns a value. Several steps in one call; only the returned value and console.log lines come back.',
    inputSchema: { type: 'object', properties: { code: { type: 'string', maxLength: 50000 } }, required: ['code'], additionalProperties: false },
    annotations: { title: 'Run a script over the repository', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

function createServer({ root, permission, version = '1' } = {}) {
    const repo = createRepoTools({ root, permission });
    const cm = require('openvibe-sdk/code-mode');
    const text = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });

    async function handle(msg) {
        const { id, method, params } = msg || {};
        if (method === 'initialize') {
            return { id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ov_code', version }, instructions: INSTRUCTIONS } };
        }
        if (method === 'ping') return { id, result: {} };
        if (method === 'tools/list') return { id, result: { tools: [SEARCH, EXECUTE] } };
        if (method === 'tools/call') {
            const name = String((params && params.name) || '');
            const args = (params && params.arguments) || {};
            if (name === 'search') {
                const q = String(args.query || '').trim();
                const found = q ? cm.searchTools(repo.defs, q, 12) : repo.defs.map((d) => ({ name: d.name, signature: cm.signatureOf(d), description: d.description }));
                return { id, result: text(found.length ? found.map((f) => `${f.signature}\n  ${f.description}`).join('\n\n') : `Nothing matches "${q}". The tools: ${repo.defs.map((d) => d.name).join(', ')}.`) };
            }
            if (name === 'execute') {
                const code = String(args.code || '');
                if (!code.trim()) return { id, result: text('Send the script ({ code }).', true) };
                const out = await cm.runCode(code, { tools: repo.defs.map((d) => d.name), call: (kind, toolName, input) => (kind === 'tool' ? repo.call(toolName, input) : { ok: false, error: 'no functions here' }), limits: LIMITS });
                return { id, result: text({ ok: out.ok, ...(out.ok ? { value: out.value } : { error: out.error }), logs: (out.logs || []).slice(0, 60), calls: out.calls, ms: out.ms }, !out.ok) };
            }
            return { id, result: text(`There is no tool ${name} here: use search, then execute.`, true) };
        }
        if (id === undefined || id === null) return null;   // a notification (initialized, cancelled): no answer
        return { id, error: { code: -32601, message: `no method ${method}` } };
    }
    return { handle, repo };
}

/** The server over stdio: one JSON-RPC message a line, in and out. */
function serveStdio({ root, permission, input = process.stdin, output = process.stdout, version } = {}) {
    const server = createServer({ root, permission, version });
    let buf = '';
    const send = (o) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'not JSON' } }); continue; }
            Promise.resolve(server.handle(msg)).then((reply) => { if (reply) send(reply); }, (e) => { if (msg && msg.id != null) send({ id: msg.id, error: { code: -32603, message: String((e && e.message) || e).slice(0, 300) } }); });
        }
    });
    return server;
}

/**
 * What a job adds to its agent's options for code mode: the MCP config file (merged with one the job already has, e.g.
 * the conductor's Codes tools) and the tool on the allow list. Claude Code refuses an MCP tool that is not on
 * --allowedTools in a headless run.
 */
function mcpOptions({ file, root, permission, existing = null, bin = path.join(__dirname, '..', 'bin', 'openvibe-codes.js') }) {
    let config = { mcpServers: {} };
    if (existing) { try { config = JSON.parse(fs.readFileSync(existing, 'utf8')); } catch { config = { mcpServers: {} }; } }
    config.mcpServers = { ...(config.mcpServers || {}), ov_code: { command: process.execPath, args: [bin, 'code-mode', '--root', root, '--permission', permission] } };
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    return { mcpConfig: file, tool: 'mcp__ov_code' };
}

/**
 * The line in the agent's system prompt. MCP servers' own instructions reach the model only once it loads the tool, and
 * measured on Claude Code 2.1 (11-18): without this line it kept to its own tools; with it and its own file and shell
 * tools off (strict), a three-file rename took two execute calls in three turns.
 */
function hintFor({ strict = false, permission = 'edit' } = {}) {
    const can = { read: 'read, grep, glob and ls', files: 'read, grep, glob, ls, edit and write', edit: 'read, grep, glob, ls, edit, write and sh', full: 'read, grep, glob, ls, edit, write and sh' }[permission] || 'read, grep, glob and ls';
    return 'Code mode is on for this run. mcp__ov_code__execute runs one JavaScript script that calls `await tools.<name>(input)` '
        + `(${can}) in this folder, and only what the script returns comes back. `
        + (strict
            ? 'Your own Read, Edit, Write, Grep, Glob and Bash are off: do the work through execute, several steps in each script (search, read the parts you need, edit, run the tests, return a short result).'
            : 'When a change takes more than two reads, searches, edits or commands, do them in one execute call instead of separate tool calls.');
}

/**
 * How each harness takes code mode (runner 0.14.0; the owner, 11-18: "Give all harnesses code mode"). Measured 11-18 on
 * this workstation with the three-file rename:
 *   claude      --mcp-config + --append-system-prompt; strict turns Read/Edit/Write/Grep/Glob/Bash off (2 scripts)
 *   opencode    the project's opencode.json (v2: mcp.servers, instructions, and its own tools denied); strict holds
 *               under --auto only through the `permission` object (it then ran execute and nothing else).
 *               OPENCODE_CONFIG and OPENCODE_CONFIG_CONTENT were not read by v2.2.6.
 *   codex       -c mcp_servers.ov_code.*; beside its own tools: with shell_tool and unified_exec off it hangs, and its
 *               own code_mode/code_mode_only flags are unfinished (one script, two commands and a patch: done)
 *   mcp-json    Command Code and Muse read the project's .mcp.json; beside their own tools (the hint is in the prompt)
 *   acp         session/new's mcpServers, for every ACP agent; beside its own tools
 *   loop        Codes' own API loop (DeepSeek, OpenVibe AI): execute is one of its tools; strict offers only it
 *   own         MiniMax Code has its own (--ptc, run_code), always on
 *   null        Aider: no tools of its own to script
 */
const PLANS = Object.freeze({
    'claude-code': { via: 'claude', strict: true },
    'claude-other': { via: 'claude', strict: true },
    opencode: { via: 'opencode', strict: true },
    codex: { via: 'codex', strict: false, note: 'beside its own tools (its shell cannot be turned off)' },
    'command-code': { via: 'mcp-json', strict: false, note: 'beside its own tools' },
    muse: { via: 'mcp-json', strict: false, note: 'beside its own tools' },
    'minimax-code': { via: 'own', strict: false, note: 'MiniMax Code has its own code mode (run_code), always on' },
    aider: { via: null, strict: false, note: 'Aider has no tools of its own to script' },
});

/** The plan for a harness: the table above, then by kind (an API harness runs Codes' own loop, an ACP agent ACP). */
function planFor(agent, kind = null) {
    if (agent && PLANS[agent]) return PLANS[agent];
    if (kind === 'api') return { via: 'loop', strict: true };
    if (kind === 'acp') return { via: 'acp', strict: false, note: 'beside its own tools' };
    return { via: null, strict: false, note: 'this harness takes no MCP server' };
}

/** The server a harness starts: `openvibe-codes code-mode --root ROOT --permission P`. */
function serverSpec({ root, permission, bin = path.join(__dirname, '..', 'bin', 'openvibe-codes.js') }) {
    return { name: 'ov_code', command: process.execPath, args: [bin, 'code-mode', '--root', root, '--permission', permission] };
}

/**
 * A project file the harness reads (opencode.json, .mcp.json), with code mode's part merged in: what was there is kept,
 * a new file stays out of git (.git/info/exclude), and restore() puts the folder back as it was after the run.
 *   withProjectFile(root, name, mutate) → restore()
 */
function withProjectFile(root, name, mutate) {
    const file = path.join(root, name);
    let before = null;
    try { before = fs.readFileSync(file); } catch { before = null; }
    let json = {};
    if (before) { try { json = JSON.parse(before.toString('utf8')); } catch { json = {}; } }
    const next = mutate(json && typeof json === 'object' && !Array.isArray(json) ? json : {}) || json;
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    if (!before) {
        const exclude = path.join(root, '.git', 'info', 'exclude');
        try {
            if (fs.existsSync(path.dirname(exclude))) {
                const now = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
                if (!now.split('\n').includes(`/${name}`)) fs.appendFileSync(exclude, `${now && !now.endsWith('\n') ? '\n' : ''}/${name}\n`);
            }
        } catch { /* not a checkout: nothing to keep out */ }
    }
    let done = false;
    return () => {
        if (done) return; done = true;
        try { if (before) fs.writeFileSync(file, before); else fs.rmSync(file, { force: true }); } catch { /* the folder went away */ }
    };
}

/**
 * Code mode as a job hands it to the harness (adapterOptions.codeMode): the server, how strict, the line for the agent,
 * and the restores the adapters register (a project file each), run by cleanup() when the job ends. A harness reads it
 * its own way (PLANS); one that takes no MCP server ignores it.
 */
function descriptor({ root, permission, strict = null, bin }) {
    const server = serverSpec({ root, permission, ...(bin ? { bin } : {}) });
    const restores = [];
    return {
        server, permission, strict, restores,
        hint: (isStrict) => hintFor({ strict: !!isStrict, permission }),
        cleanup() { while (restores.length) { try { restores.pop()(); } catch { /* best effort */ } } },
    };
}

/** The hint before a prompt, for a harness with no system prompt of its own to add to. */
const withHint = (cm, prompt, strict = false) => (cm ? `${cm.hint(strict)}\n\n${prompt || ''}` : prompt);

module.exports = { createRepoTools, createServer, serveStdio, mcpOptions, hintFor, ready, planFor, serverSpec, withProjectFile, descriptor, withHint, PLANS, PERMISSIONS, LIMITS, INSTRUCTIONS };
