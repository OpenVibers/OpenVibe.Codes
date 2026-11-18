'use strict';
/**
 * Provisioning (harness/provision.js, 2026-11-16; the owner: "shouldn't it handle installing claude code on its own per
 * each user's individual sandbox or multi machine setup or multi actors per machine", "interconnected with locker for
 * logins", "and with openvibe.exchange"): every coding agent has an install recipe; an agent installs into the runner's
 * own folder, never globally; each actor has homes of its own; a login comes from Locker (sealed to the actor's own key,
 * opened for one run) or from Exchange as the gateway; doctor names what is missing and the command that fixes it.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const provision = require('../harness/provision');
const { adaptersFor } = require('../harness');
const locker = require('openvibe-sdk/locker');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovc-prov-'));
// A stand-in npm: `install -g --prefix <dir> <pkg>` writes <dir>/bin/claude (prints its version); `cache add` succeeds.
function fakeNpm(dir) {
    const npm = path.join(dir, 'fake-npm');
    fs.writeFileSync(npm, `#!/bin/sh
if [ "$1" = "cache" ]; then exit 0; fi
prefix=""; while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && { prefix="$2"; shift; }; shift; done
mkdir -p "$prefix/bin"
printf '#!/bin/sh\\necho "9.9.9 (Claude Code)"\\n' > "$prefix/bin/claude"; chmod +x "$prefix/bin/claude"
`, { mode: 0o755 });
    return npm;
}

(async () => {
    await check('every coding agent has a recipe: the CLI harnesses and the pinned ACP agents', () => {
        const ids = Object.keys(provision.recipes);
        for (const id of ['claude-code', 'codex', 'opencode', 'command-code', 'minimax-code', 'aider', 'gemini-cli', 'qwen-code', 'copilot-cli', 'cline']) {
            assert.ok(ids.includes(id), `${id} installs`);
        }
        assert.ok(ids.length >= 20, `${ids.length} agents`);
        assert.equal(provision.recipeOf('gemini-cli').via, 'npx', 'an ACP agent is fetched at its pinned version');
    });

    await check('an actor has homes of its own; the runner\'s tools stay shared and go first on PATH', () => {
        const root = tmp();
        const env = provision.withTools(provision.profileEnv({ OPENVIBE_CODES_HOME: root, HOME: '/home/someone', PATH: '/usr/bin' }, 'alice'));
        assert.equal(env.OPENVIBE_CODES_HOME, root);
        for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
            assert.ok(env[k].startsWith(path.join(root, 'profiles', 'alice')), `${k} is alice's`);
            assert.ok(fs.statSync(env[k]).isDirectory());
        }
        assert.equal(env.PATH.split(path.delimiter)[0], path.join(root, 'tools', 'bin'));
        const bob = provision.profileEnv({ OPENVIBE_CODES_HOME: root, HOME: '/home/someone' }, 'bob');
        assert.notEqual(bob.CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR, 'two actors never share a login');
        assert.throws(() => provision.profileEnv({ OPENVIBE_CODES_HOME: root }, '../etc'), /actor name/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    await check('an agent installs into the runner\'s own folder, and a run installs it when missing (unless it is off)', () => {
        const root = tmp();
        const env = provision.withTools({ OPENVIBE_CODES_HOME: root, HOME: root, PATH: '/usr/bin:/bin', OPENVIBE_CODES_NPM: fakeNpm(root) });
        const adapter = adaptersFor(env)['claude-code'];
        const off = provision.ensure(adapter, { ...env, OPENVIBE_CODES_AUTOINSTALL: '0' });
        assert.equal(off.ok, false);
        assert.match(off.error, /openvibe-codes install claude-code/);
        const r = provision.ensure(adapter, env);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.where, path.join(root, 'tools', 'bin', 'claude'));
        assert.equal(r.version, '9.9.9 (Claude Code)');
        assert.equal(provision.ensure(adapter, env).where, r.where, 'already there: nothing to install');
        assert.equal(provision.install('gemini-cli', env).ok, true, 'an ACP agent is fetched ahead');
        assert.match(provision.install('no-such-agent', env).error, /no install recipe/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    await check('a Locker login: sealed to the actor\'s own key, opened here for one run, never written', async () => {
        const root = tmp();
        const env = provision.profileEnv({ OPENVIBE_CODES_HOME: root, HOME: root }, 'alice');
        const keys = await provision.lockerKeys(env, 'alice');
        assert.equal((fs.statSync(keys.file).mode & 0o777).toString(8), '600', 'the private half is the actor\'s alone');
        const sealed = await locker.seal(JSON.stringify({ token: 'sk-ant-oat-TEST-ONLY' }), { lock: 'people', keys: [{ subject: 'actor:alice', publicKey: keys.public.ecdh }] });
        const seen = [];
        const fetch = async (url, init) => { seen.push([url, init.headers.Authorization]); return { ok: true, status: 200, arrayBuffer: async () => sealed.bytes.buffer.slice(sealed.bytes.byteOffset, sealed.bytes.byteOffset + sealed.bytes.byteLength) }; };
        const out = await provision.lockerLogin('claude-code', { ...env, OPENVIBE_LOCKER_TOKEN: 'locker-token', OPENVIBE_CODES_LOGIN_CLAUDE_CODE: 'locker:itm_abc123' }, { fetch });
        assert.deepEqual(out, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-TEST-ONLY' }, 'an OAuth token signs Claude Code in');
        assert.deepEqual(seen, [['https://openvibe.locker/api/v1/logins/itm_abc123/content', 'Bearer locker-token']]);
        const files = fs.readdirSync(env.OPENVIBE_CODES_PROFILE_DIR, { recursive: true }).map(String);
        assert.ok(!files.some((f) => fs.statSync(path.join(env.OPENVIBE_CODES_PROFILE_DIR, f)).isFile() && fs.readFileSync(path.join(env.OPENVIBE_CODES_PROFILE_DIR, f), 'utf8').includes('sk-ant-oat-TEST-ONLY')), 'the login is never on disk');
        assert.equal(await provision.lockerLogin('claude-code', env, { fetch }), null, 'no item named: no Locker login');
        await assert.rejects(provision.lockerLogin('claude-code', { ...env, OPENVIBE_CODES_LOGIN_CLAUDE_CODE: 'locker:itm_abc123' }, { fetch }), /OPENVIBE_LOCKER_TOKEN/);
        const refused = async () => ({ ok: false, status: 403 });
        await assert.rejects(provision.lockerLogin('claude-code', { ...env, OPENVIBE_LOCKER_TOKEN: 't', OPENVIBE_CODES_LOGIN_CLAUDE_CODE: 'locker:itm_abc123' }, { fetch: refused }), /share it with this actor's key/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    await check('Exchange as the gateway: one key for Claude Code, Codex and OpenCode', () => {
        const env = { OPENVIBE_EXCHANGE_KEY: 'ovx_test' };
        assert.deepEqual(provision.exchangeLogin('claude-code', env), { ANTHROPIC_BASE_URL: 'https://api.openvibe.exchange', ANTHROPIC_AUTH_TOKEN: 'ovx_test' });
        assert.deepEqual(provision.exchangeLogin('codex', env), { OPENAI_BASE_URL: 'https://api.openvibe.exchange/v1', OPENAI_API_KEY: 'ovx_test' });
        assert.equal(provision.exchangeLogin('codex', {}), null);
    });

    await check('doctor: each agent installed or not, its login, ready, and the one command that fixes it', () => {
        const root = tmp();
        const env = provision.withTools(provision.profileEnv({ OPENVIBE_CODES_HOME: root, HOME: root, PATH: '/nonexistent' }, 'alice'));
        const rows = provision.doctor(adaptersFor(env), env, { logins: [] });
        const cc = rows.find((r) => r.id === 'claude-code');
        assert.deepEqual([cc.installed, cc.ready, cc.fix], [false, false, 'openvibe-codes install claude-code']);
        const viaExchange = provision.doctor(adaptersFor(env), { ...env, OPENVIBE_EXCHANGE_KEY: 'k', PATH: path.join(root, 'tools', 'bin') }, { logins: [] });
        assert.equal(viaExchange.find((r) => r.id === 'codex').login, 'exchange');
        fs.rmSync(root, { recursive: true, force: true });
    });
    done();
})();
