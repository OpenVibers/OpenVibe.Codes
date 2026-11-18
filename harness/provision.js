'use strict';
/**
 * Provisioning: a harness installs itself, each actor has a home of its own, and a login comes from Locker or Exchange
 * (2026-11-16; the owner: "shouldn't it handle installing claude code on its own per each user's individual sandbox or
 * multi machine setup or multi actors per machine … with Link", "interconnected with locker for logins", "and with
 * openvibe.exchange and openvibe.computer … make it way better").
 *
 * Where things live (never global, never root):
 *   <home>                    OPENVIBE_CODES_HOME, or ~/.openvibe-codes
 *   <home>/tools              the harnesses this runner installed (npm -g --prefix, uv tool); tools/bin goes first on PATH
 *   <home>/profiles/<actor>   one actor's own homes for every harness (CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_*), so two
 *                             actors or two people on one machine never share a login, a history or a setting
 *   <home>/profiles/<actor>/locker-keys.json   the actor's Locker keys (0600); its public half is what a person shares
 *                             a login with in Locker
 *
 * Logins, per harness, from one of:
 *   own       the harness's own sign-in in the actor's home (`claude` then /login, `codex login`, …)
 *   locker    a Locker login item sealed to the actor's key: fetched with OPENVIBE_LOCKER_TOKEN, opened here, and put in
 *             the agent's environment for one run only; never written to disk
 *   exchange  OpenVibe.Exchange as the gateway: one Exchange key (OPENVIBE_EXCHANGE_KEY) for Claude Code, Codex and
 *             OpenCode alike, through Exchange's OpenAI- and Anthropic-compatible endpoints
 *
 *   recipes / recipeOf(id)                         how each harness installs
 *   home(env) / withTools(env) / profileEnv(env, actor)
 *   install(id, env, { spawn }) / ensure(adapter, env, opts)
 *   lockerKeys(env, actor) / lockerLogin(id, env, { fetch, item }) / exchangeLogin(id, env)
 *   doctor(adapters, env)                          every harness: installed, signed in, ready, and the one command that fixes it
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EXCHANGE = 'https://api.openvibe.exchange';
const LOCKER = 'https://openvibe.locker';

// How each harness installs: every coding agent this runner knows, from one table. The CLI harnesses install the vendor's
// own package into tools/ (the version can be pinned per harness with OPENVIBE_CODES_PIN_<ID>, e.g.
// OPENVIBE_CODES_PIN_CLAUDE_CODE=2.1.325). The ACP agents (harness/acp-agents.json: Gemini CLI, Qwen Code, Kimi, Grok,
// Copilot, Cline, Kilo, Auggie, Qoder, CodeBuddy, Droid …) already launch with npx at their pinned versions; installing
// one fetches that exact package ahead, so its first run starts at once.
const recipes = {
    'claude-code': { via: 'npm', pkg: '@anthropic-ai/claude-code', bin: 'claude' },
    'claude-other': { via: 'npm', pkg: '@anthropic-ai/claude-code', bin: 'claude' },
    codex: { via: 'npm', pkg: '@openai/codex', bin: 'codex' },
    opencode: { via: 'npm', pkg: 'opencode-ai', bin: 'opencode' },
    'command-code': { via: 'npm', pkg: 'command-code', bin: 'cmd' },
    'minimax-code': { via: 'npm', pkg: '@minimax-ai/code', bin: 'mcode' },
    aider: { via: 'uv', pkg: 'aider-chat', bin: 'aider' },
    // Muse Code ships as Meta's own launcher script, with no package to install: by hand, until it has one.
};
try {
    for (const a of require('./acp-agents.json').agents) {
        const npx = a.npx || (a.distribution && a.distribution.npx);
        if (npx && npx.package && !recipes[a.id]) recipes[a.id] = { via: 'npx', pkg: npx.package, acp: true };
    }
} catch { /* the ACP list is optional here */ }
const recipeOf = (id) => recipes[id] || null;
const envKey = (id) => String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_');

const ACTOR = /^[a-z0-9][a-z0-9_.-]{0,62}$/i;

function home(env = process.env) {
    return env.OPENVIBE_CODES_HOME || path.join(env.HOME || os.homedir(), '.openvibe-codes');
}
const toolsDir = (env) => path.join(home(env), 'tools');

/** The env with this runner's installed harnesses first on PATH. */
function withTools(env = process.env) {
    const bin = path.join(toolsDir(env), 'bin');
    const parts = String(env.PATH || '').split(path.delimiter).filter(Boolean);
    return parts[0] === bin ? { ...env } : { ...env, PATH: [bin, ...parts.filter((p) => p !== bin)].join(path.delimiter) };
}

/** One actor's own homes: each harness keeps its login, history and settings apart from every other actor's. */
function profileEnv(env = process.env, actor) {
    if (!actor) return { ...env };
    if (!ACTOR.test(String(actor))) throw Object.assign(new Error('an actor name is letters, digits, dot, dash or underscore (up to 63)'), { code: 'bad_profile' });
    const dir = path.join(home(env), 'profiles', String(actor));
    const sub = (name) => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true, mode: 0o700 }); return p; };
    return {
        ...env,
        // The runner's own folder stays where it was (its installed agents are shared); the actor gets a HOME of its own,
        // so a CLI that keeps its login under ~ (Command Code, MiniMax …) is the actor's too.
        OPENVIBE_CODES_HOME: home(env),
        HOME: sub('home'),
        OPENVIBE_CODES_PROFILE: String(actor),
        OPENVIBE_CODES_PROFILE_DIR: dir,
        CLAUDE_CONFIG_DIR: sub('claude'),
        CODEX_HOME: sub('codex'),
        XDG_CONFIG_HOME: sub('config'),
        XDG_DATA_HOME: sub('share'),
        XDG_STATE_HOME: sub('state'),
        XDG_CACHE_HOME: sub('cache'),
    };
}

/** Installs a harness into this runner's tools. Returns { ok, version?, error? }. */
function install(id, env = process.env, { spawn = spawnSync, log = () => {} } = {}) {
    const r = recipeOf(id);
    if (!r) return { ok: false, error: `${id} has no install recipe: install it by hand` };
    const tools = toolsDir(env);
    fs.mkdirSync(tools, { recursive: true });
    const pin = env[`OPENVIBE_CODES_PIN_${envKey(id)}`];
    let res;
    if (r.via === 'npm') {
        const npm = env.OPENVIBE_CODES_NPM || 'npm';
        log(`installing ${r.pkg}${pin ? `@${pin}` : ''} into ${tools}`);
        res = spawn(npm, ['install', '-g', '--prefix', tools, '--no-fund', '--no-audit', '--loglevel=error', pin ? `${r.pkg}@${pin}` : r.pkg], { env, encoding: 'utf8', timeout: 300_000 });
    } else if (r.via === 'npx') {
        // An ACP agent: fetch its pinned package into npm's cache, where npx finds it on the first run.
        const npm = env.OPENVIBE_CODES_NPM || 'npm';
        log(`fetching ${r.pkg} ahead`);
        res = spawn(npm, ['cache', 'add', r.pkg, '--no-fund', '--no-audit', '--loglevel=error'], { env, encoding: 'utf8', timeout: 300_000 });
        if (res && !res.error && res.status === 0) return { ok: true, where: `npx ${r.pkg}`, version: r.pkg.split('@').pop() };
    } else if (r.via === 'uv') {
        const uv = env.OPENVIBE_CODES_UV || 'uv';
        log(`installing ${r.pkg}${pin ? `==${pin}` : ''} with uv into ${tools}`);
        res = spawn(uv, ['tool', 'install', pin ? `${r.pkg}==${pin}` : r.pkg], { env: { ...env, UV_TOOL_DIR: path.join(tools, 'uv'), UV_TOOL_BIN_DIR: path.join(tools, 'bin') }, encoding: 'utf8', timeout: 300_000 });
    }
    if (!res || res.error || res.status !== 0) {
        const why = res && res.error ? res.error.message : String((res && (res.stderr || res.stdout)) || '').trim().split('\n').slice(-2).join(' ');
        return { ok: false, error: `could not install ${r.pkg}: ${why || 'it failed'}` };
    }
    const bin = path.join(tools, 'bin', r.bin);
    if (!fs.existsSync(bin)) return { ok: false, error: `${r.pkg} installed, but ${bin} is not there` };
    const v = spawn(bin, ['--version'], { env: withTools(env), encoding: 'utf8', timeout: 20_000 });
    return { ok: true, where: bin, version: v && v.status === 0 ? String(v.stdout).trim().split('\n')[0] : undefined };
}

/** Installs the harness a run needs when it is missing and installing is allowed (OPENVIBE_CODES_AUTOINSTALL, default on). */
function ensure(adapter, env, opts = {}) {
    if (!adapter || adapter.kind !== 'cli' || !recipeOf(adapter.id)) return { ok: true, skipped: true };
    const where = onPath(adapter.bin, env);
    if (where) return { ok: true, where };
    if (env.OPENVIBE_CODES_AUTOINSTALL === '0') return { ok: false, error: `\`${adapter.bin}\` is not on PATH and installing is off (OPENVIBE_CODES_AUTOINSTALL=0): openvibe-codes install ${adapter.id}` };
    return install(adapter.id, env, opts);
}

function onPath(bin, env) {
    for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
        try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return path.join(dir, bin); } catch { /* the next one */ }
    }
    return null;
}

// ── Locker: the actor's keys, and a login sealed to them ──

/** The actor's Locker keys: created once (private half 0600 in its profile); returns the public half to share with. */
async function lockerKeys(env, actor) {
    const locker = require('openvibe-sdk/locker');
    const dir = profileEnv(env, actor || env.OPENVIBE_CODES_PROFILE || 'default').OPENVIBE_CODES_PROFILE_DIR;
    const file = path.join(dir, 'locker-keys.json');
    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { stored = null; }
    if (!stored) {
        const person = await locker.generatePersonKeys();
        stored = { private: await locker.exportPrivateKeys(person), public: await locker.exportPersonKeys(person) };
        fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    }
    return { file, public: stored.public, person: await locker.importPersonKeys({ ...stored.private, ecdh: stored.private.ecdh, signing: stored.private.signing }) };
}

// What a login's value becomes in the agent's environment.
const LOGIN_ENV = {
    'claude-code': (v) => (/^sk-ant-oat/.test(v) ? { CLAUDE_CODE_OAUTH_TOKEN: v } : { ANTHROPIC_API_KEY: v }),
    'claude-other': (v) => ({ ANTHROPIC_AUTH_TOKEN: v }),
    codex: (v) => ({ OPENAI_API_KEY: v }),
    opencode: (v) => ({ OPENAI_API_KEY: v }),
    aider: (v) => (/^sk-ant-/.test(v) ? { ANTHROPIC_API_KEY: v } : { OPENAI_API_KEY: v }),
};

/**
 * The actor's login for one harness from Locker, as env for one run: the item (OPENVIBE_CODES_LOGIN_<ID>=locker:<item
 * id>, or `item`) is fetched with OPENVIBE_LOCKER_TOKEN and opened with the actor's own key. Never written to disk.
 */
async function lockerLogin(id, env, { fetch: fetchImpl = globalThis.fetch, item = null } = {}) {
    const ref = String(item || env[`OPENVIBE_CODES_LOGIN_${envKey(id)}`] || '').replace(/^locker:/, '');
    if (!ref) return null;
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(ref)) throw Object.assign(new Error('a Locker item id is letters, digits, dash or underscore'), { code: 'bad_item' });
    if (!env.OPENVIBE_LOCKER_TOKEN) throw Object.assign(new Error('set OPENVIBE_LOCKER_TOKEN (the actor\'s Locker token) to read its logins'), { code: 'no_locker_token' });
    const base = String(env.OPENVIBE_LOCKER_URL || LOCKER).replace(/\/+$/, '');
    const res = await fetchImpl(`${base}/api/v1/logins/${encodeURIComponent(ref)}/content`, { headers: { Authorization: `Bearer ${env.OPENVIBE_LOCKER_TOKEN}`, Accept: 'application/octet-stream' } });
    if (!res.ok) throw Object.assign(new Error(`Locker did not give the login (${res.status}): share it with this actor's key (openvibe-codes setup prints it)`), { code: 'locker_refused' });
    const envelope = new Uint8Array(await res.arrayBuffer());
    const keys = await lockerKeys(env, env.OPENVIBE_CODES_PROFILE);
    const bytes = await require('openvibe-sdk/locker').open(envelope, { person: keys.person });
    const text = Buffer.from(bytes).toString('utf8').trim();
    let value = text;
    try { const j = JSON.parse(text); value = String(j.token || j.key || j.value || j.password || '').trim(); } catch { /* a bare value */ }
    if (!value) throw Object.assign(new Error('the Locker login is empty'), { code: 'locker_empty' });
    const map = LOGIN_ENV[id];
    return map ? map(value) : null;
}

/** Exchange as every harness's gateway: one Exchange key, its OpenAI- and Anthropic-compatible endpoints. */
function exchangeLogin(id, env) {
    const key = env.OPENVIBE_EXCHANGE_KEY;
    if (!key) return null;
    const base = String(env.OPENVIBE_EXCHANGE_URL || EXCHANGE).replace(/\/+$/, '');
    if (id === 'claude-other' || id === 'claude-code') return { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: key };
    if (id === 'codex' || id === 'opencode' || id === 'aider') return { OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_KEY: key };
    return null;
}

/** Every harness here: installed, its login, ready, and the one command that fixes what is missing. */
function doctor(adapters, env, { logins = [] } = {}) {
    const signed = new Map(logins.map((l) => [l.id, l]));
    return Object.values(adapters).filter((a) => a && a.kind === 'cli').map((a) => {
        const where = onPath(a.bin, env);
        const r = recipeOf(a.id);
        const login = signed.get(a.id);
        const viaLocker = !!env[`OPENVIBE_CODES_LOGIN_${envKey(a.id)}`];
        const viaExchange = !!exchangeLogin(a.id, env);
        const signedIn = !!(login && login.signed_in) || viaLocker || viaExchange;
        const fix = !where ? (r ? `openvibe-codes install ${a.id}` : `install ${a.name} by hand`)
            : !signedIn ? `${a.bin} (then sign in), or a Locker login: openvibe-codes setup --login locker${a.id === 'claude-code' || a.id === 'codex' ? ', or OPENVIBE_EXCHANGE_KEY for Exchange' : ''}` : null;
        return { id: a.id, name: a.name, installed: !!where, where, login: viaLocker ? 'locker' : viaExchange ? 'exchange' : signedIn ? 'own' : null, ready: !!where && signedIn, fix };
    });
}

// Each agent's own sign-in, run inside the actor's homes (`openvibe-codes login <agent> --profile <actor>`).
const LOGIN_ARGS = { 'claude-code': ['auth', 'login'], codex: ['login'], opencode: ['auth', 'login'], 'command-code': ['login'] };

module.exports = { LOGIN_ARGS, recipes, recipeOf, home, withTools, profileEnv, install, ensure, lockerKeys, lockerLogin, exchangeLogin, doctor, LOGIN_ENV };
