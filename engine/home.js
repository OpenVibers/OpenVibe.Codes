'use strict';

/**
 * Agent homes (plan §AD.22, openvibe.home@1): what a person's agents need on a machine, described once and made real
 * there by Codes itself, in their persistent sandbox (Link's `/sandbox`) or their own home folder, so nobody logs in to
 * set a machine up.
 *
 * The owner, 2026-11-17: "Instead of sshing into the local OV node yourself you should make it so link can do all this
 * kinda shit and run agents and sandboxed". The cloud agents prepare a workspace the same way (Copilot's
 * copilot-setup-steps, Codex and Claude-on-the-web setup scripts), but fresh for every task; a home is kept and only
 * what changed is redone.
 *
 *   {
 *     "format": "openvibe.home@1",
 *     "workspace": "work",                                   the folder the repositories go in (under the home)
 *     "tools": { "go": "1.27.1", "node": "24.19.0", "rust": "1.96.0" },   installed by mise, user-local, pinned
 *     "agents": ["claude-code", "codex"],                    the agent CLIs (Codes' own installer)
 *     "repos": ["OpenVibers/OpenVibe.Live", "https://github.com/OpenVibers/OpenVibe.Codes"],
 *     "git": { "name": "OpenVibers", "email": "Contact@OpenVibe.Network" }
 *   }
 *
 *   readSpec(raw)                                → the spec, checked (throws in words)
 *   apply(spec, { root, env, say, run, fetchImpl, installAgent }) → { ok, tools, agents, repos, git, root }
 *
 * Every step is idempotent: a tool already at its version, a repository already cloned (it is fetched), an agent
 * already installed are left as they are. A step that fails is reported and the others go on, so one bad repository
 * never leaves a machine half set up.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const FORMAT = 'openvibe.home@1';
const TOOL = /^[a-z][a-z0-9-]{0,30}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,40}$/;
const AGENT = /^[a-z][a-z0-9-]{1,40}$/;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_REPOS = 300;

const fail = (message) => Object.assign(new Error(message), { status: 422, code: 'home.invalid' });

/** A repository as an https URL and the folder name it is cloned into. */
function repoOf(value) {
    const v = String(value || '').trim();
    // A refusal names the address without any user or password in it: the words go back to a page and a log.
    const shown = v.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/i, '$1').slice(0, 80);
    if (SLUG.test(v)) return { url: `https://github.com/${v}.git`, name: v.split('/')[1] };
    let u;
    try { u = new URL(v); } catch { throw fail(`not a repository: ${shown}`); }
    if (u.protocol !== 'https:' || u.username || u.password) throw fail(`a repository is an https address without credentials: ${shown}`);
    const name = path.basename(u.pathname).replace(/\.git$/, '');
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw fail(`not a repository: ${shown}`);
    return { url: u.toString(), name };
}

function readSpec(raw) {
    let spec = raw;
    if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
        try { spec = JSON.parse(String(raw)); } catch { throw fail('the home spec is not JSON'); }
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw fail('the home spec is an object');
    if (spec.format !== FORMAT) throw fail(`the home spec's format is ${FORMAT}`);
    const workspace = spec.workspace == null ? 'work' : String(spec.workspace);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(workspace) || workspace === '.' || workspace === '..') throw fail('workspace is one folder name');
    const tools = {};
    for (const [name, version] of Object.entries(spec.tools || {})) {
        if (!TOOL.test(name) || !VERSION.test(String(version))) throw fail(`a tool is name: version (${String(name).slice(0, 30)})`);
        tools[name] = String(version);
    }
    const agents = (spec.agents || []).map(String);
    if (!agents.every((a) => AGENT.test(a))) throw fail('agents are agent ids, like claude-code');
    const repos = (spec.repos || []).map(repoOf);
    if (repos.length > MAX_REPOS) throw fail(`at most ${MAX_REPOS} repositories`);
    if (new Set(repos.map((r) => r.name)).size !== repos.length) throw fail('two repositories would share one folder');
    let git = null;
    if (spec.git) {
        const name = String(spec.git.name || '').trim();
        const email = String(spec.git.email || '').trim();
        if (!name || name.length > 100 || /[\n\r]/.test(name) || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 200) throw fail('git is { name, email }');
        git = { name, email };
    }
    return { format: FORMAT, workspace, tools, agents, repos, git };
}

/** Runs a program without a shell → { ok, out }. */
function runProgram(cmd, args, { env, cwd, timeout = 30 * 60 * 1000 } = {}) {
    const r = spawnSync(cmd, args, { env, cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
    return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-2000) };
}

const ARCH = { x64: 'x64', arm64: 'arm64' };

/** mise, user-local in the home: the release binary for this machine, its SHA-256 checked against the release's list. */
async function ensureMise(root, { fetchImpl, say, platform = process.platform, arch = process.arch }) {
    const bin = path.join(root, '.local', 'bin', 'mise');
    if (fs.existsSync(bin)) return bin;
    if (platform !== 'linux' || !ARCH[arch]) throw new Error(`mise is fetched here for Linux x64 and arm64 (this is ${platform} ${arch})`);
    say('Installing mise (tool versions, user-local)');
    const rel = await (await fetchImpl('https://api.github.com/repos/jdx/mise/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openvibe-codes' }, signal: AbortSignal.timeout(30_000) })).json();
    const tag = String(rel && rel.tag_name || '');
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('the mise release could not be read');
    const name = `mise-${tag}-linux-${ARCH[arch]}`;
    const asset = (rel.assets || []).find((a) => a.name === name);
    const sums = (rel.assets || []).find((a) => a.name === 'SHASUMS256.txt');
    if (!asset || !sums) throw new Error(`the mise release ${tag} has no ${name}`);
    const bytes = Buffer.from(await (await fetchImpl(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) })).arrayBuffer());
    const list = await (await fetchImpl(sums.browser_download_url, { signal: AbortSignal.timeout(30_000) })).text();
    const want = (list.split('\n').find((l) => l.trim().endsWith(` ${name}`) || l.trim().endsWith(`./${name}`)) || '').split(/\s+/)[0];
    const got = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!want || want !== got) throw new Error('the mise download does not match its checksum: refused');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, bytes, { mode: 0o755 });
    return bin;
}

async function apply(spec, { root, env = process.env, say = () => {}, run = runProgram, fetchImpl = globalThis.fetch, installAgent = null, gitAuth = () => ({}) } = {}) {
    const s = readSpec(spec);
    if (!root || !path.isAbsolute(root)) throw new Error('the home is an absolute folder');
    const out = { ok: true, root, tools: {}, agents: {}, repos: { cloned: [], fetched: [], failed: [] }, git: null };
    const miseEnv = {
        ...env,
        MISE_DATA_DIR: path.join(root, '.local', 'share', 'mise'),
        MISE_CONFIG_DIR: path.join(root, '.config', 'mise'),
        MISE_CACHE_DIR: path.join(root, '.cache', 'mise'),
        MISE_YES: '1',
    };

    // 1. Tools, pinned, through mise: the global config is the home's own, so every shell and agent there sees them.
    if (Object.keys(s.tools).length) {
        try {
            const mise = await ensureMise(root, { fetchImpl, say });
            for (const [name, version] of Object.entries(s.tools)) {
                say(`${name} ${version}`);
                const r = run(mise, ['use', '--global', `${name}@${version}`], { env: miseEnv });
                out.tools[name] = r.ok ? version : `failed: ${r.out.split('\n').slice(-1)[0]}`;
                if (!r.ok) out.ok = false;
            }
        } catch (e) {
            out.ok = false;
            for (const name of Object.keys(s.tools)) out.tools[name] = `failed: ${e.message}`;
        }
    }

    // 2. The agent CLIs, by Codes' own installer (into the runner's folder, never global).
    for (const id of s.agents) {
        if (!installAgent) { out.agents[id] = 'skipped: no installer here'; continue; }
        try {
            const r = await installAgent(id);
            out.agents[id] = r && r.ok ? 'ready' : `failed: ${(r && r.error) || 'not installed'}`;
            if (!(r && r.ok)) out.ok = false;
        } catch (e) { out.agents[id] = `failed: ${e.message}`; out.ok = false; }
    }

    // 3. Git's identity, in the home's own config.
    if (s.git) {
        const file = path.join(env.HOME || root, '.gitconfig');
        const a = run('git', ['config', '--file', file, 'user.name', s.git.name], { env });
        const b = run('git', ['config', '--file', file, 'user.email', s.git.email], { env });
        out.git = a.ok && b.ok ? s.git : null;
        if (!out.git) out.ok = false;
    }

    // 4. The repositories: a partial clone (the history now, file contents when used), or a fetch when it is there.
    const work = path.join(root, s.workspace);
    fs.mkdirSync(work, { recursive: true });
    for (const repo of s.repos) {
        const dir = path.join(work, repo.name);
        const auth = gitAuth(repo.url) || {};
        const genv = { ...env, GIT_TERMINAL_PROMPT: '0', ...(auth.env || {}) };
        if (fs.existsSync(path.join(dir, '.git'))) {
            const r = run('git', ['-C', dir, 'fetch', '--quiet', 'origin'], { env: genv, timeout: 10 * 60 * 1000 });
            (r.ok ? out.repos.fetched : out.repos.failed).push(r.ok ? repo.name : { name: repo.name, why: r.out.split('\n').slice(-1)[0] });
        } else {
            say(`Cloning ${repo.name}`);
            const r = run('git', ['clone', '--quiet', '--filter=blob:none', repo.url, dir], { env: genv, timeout: 30 * 60 * 1000 });
            (r.ok ? out.repos.cloned : out.repos.failed).push(r.ok ? repo.name : { name: repo.name, why: r.out.split('\n').slice(-1)[0] });
        }
    }
    if (out.repos.failed.length) out.ok = false;

    // What this home is now, beside it: what a page shows, and what the next apply compares with.
    fs.writeFileSync(path.join(root, '.openvibe-home.json'), JSON.stringify({ spec: s, applied_at: new Date().toISOString(), result: out }, null, 2), { mode: 0o600 });
    say(out.ok ? 'Your agent home is ready' : 'Your agent home is set up, with the failures listed');
    return out;
}

module.exports = { FORMAT, readSpec, apply, repoOf, ensureMise };
