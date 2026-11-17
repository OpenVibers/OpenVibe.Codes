'use strict';

/**
 * Agent homes (plan §AD.22, openvibe.home@1): a spec is checked, then made real in a person's home without anyone
 * logging in to the machine. mise comes from its release with its checksum checked (a wrong one is refused); tools are
 * pinned through it; agent CLIs by Codes' installer; git's identity in the home's own config; repositories cloned
 * partially, or fetched when they are there. A failing step is reported and the others still run.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const home = require('../engine/home');
const { check, done } = require('./helpers/boot');

const SPEC = {
    format: 'openvibe.home@1',
    tools: { go: '1.27.1', node: '24.19.0' },
    agents: ['claude-code'],
    repos: ['OpenVibers/OpenVibe.Live', 'https://github.com/OpenVibers/OpenVibe.Codes'],
    git: { name: 'OpenVibers', email: 'Contact@OpenVibe.Network' },
};

function fakeRelease(bytes, { goodSum = true } = {}) {
    const name = `mise-v2026.11.1-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
    const sum = crypto.createHash('sha256').update(goodSum ? bytes : Buffer.from('other')).digest('hex');
    return async (url) => {
        if (url.includes('/releases/latest')) {
            return { json: async () => ({ tag_name: 'v2026.11.1', assets: [{ name, browser_download_url: 'https://dl/mise' }, { name: 'SHASUMS256.txt', browser_download_url: 'https://dl/sums' }] }) };
        }
        if (url === 'https://dl/mise') return { arrayBuffer: async () => bytes };
        if (url === 'https://dl/sums') return { text: async () => `${sum}  ./${name}\n` };
        throw new Error(`unexpected ${url}`);
    };
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    try {
        await check('a spec is checked: format, tools, agents, repositories (https, no credentials) and git', async () => {
            const s = home.readSpec(JSON.stringify(SPEC));
            assert.deepStrictEqual(s.repos.map((r) => [r.url, r.name]), [['https://github.com/OpenVibers/OpenVibe.Live.git', 'OpenVibe.Live'], ['https://github.com/OpenVibers/OpenVibe.Codes', 'OpenVibe.Codes']]);
            assert.strictEqual(s.workspace, 'work');
            assert.throws(() => home.readSpec({ ...SPEC, format: 'x' }), /openvibe.home@1/);
            assert.throws(() => home.readSpec({ ...SPEC, repos: ['https://user:secret@github.com/a/b'] }), /without credentials/);
            assert.throws(() => home.readSpec({ ...SPEC, repos: ['http://github.com/a/b'] }), /https/);
            assert.throws(() => home.readSpec({ ...SPEC, tools: { 'go; rm': '1' } }), /a tool is name: version/);
            assert.throws(() => home.readSpec({ ...SPEC, workspace: '../etc' }), /one folder name/);
            assert.throws(() => home.readSpec({ ...SPEC, repos: ['a/x', 'b/x'] }), /share one folder/);
        });

        if (process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch)) {
            await check('applied: mise checked and installed, tools pinned, the agent installed, git set, repositories cloned', async () => {
                const ran = [];
                const run = (cmd, args, o) => {
                    ran.push([path.basename(cmd), ...args]);
                    if (args[0] === 'clone') fs.mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true });
                    return { ok: true, out: '' };
                };
                const installed = [];
                const said = [];
                const out = await home.apply(SPEC, {
                    root, env: { HOME: root, PATH: '/usr/bin' }, run, fetchImpl: fakeRelease(Buffer.from('#!/bin/sh\n')), say: (t) => said.push(t),
                    installAgent: async (id) => { installed.push(id); return { ok: true }; },
                    gitAuth: () => ({ env: { GIT_CONFIG_COUNT: '1' } }),
                });
                assert.strictEqual(out.ok, true, JSON.stringify(out));
                assert.ok(fs.existsSync(path.join(root, '.local', 'bin', 'mise')), 'mise in the home');
                assert.deepStrictEqual(ran.filter((r) => r[0] === 'mise'), [['mise', 'use', '--global', 'go@1.27.1'], ['mise', 'use', '--global', 'node@24.19.0']]);
                assert.deepStrictEqual(installed, ['claude-code']);
                assert.deepStrictEqual(out.tools, { go: '1.27.1', node: '24.19.0' });
                assert.deepStrictEqual(out.repos.cloned, ['OpenVibe.Live', 'OpenVibe.Codes']);
                assert.ok(ran.some((r) => r[0] === 'git' && r.includes('user.email') && r.includes('Contact@OpenVibe.Network')));
                assert.ok(ran.filter((r) => r[1] === 'clone').every((r) => r.includes('--filter=blob:none')), 'partial clones');
                assert.ok(fs.existsSync(path.join(root, '.openvibe-home.json')), 'what the home is now, beside it');
                assert.ok(said.includes('Your agent home is ready'));

                // Again: nothing reinstalled, the repositories fetched.
                ran.length = 0;
                const again = await home.apply(SPEC, { root, env: { HOME: root }, run, fetchImpl: async () => { throw new Error('no download the second time'); }, installAgent: async () => ({ ok: true }) });
                assert.deepStrictEqual(again.repos.fetched, ['OpenVibe.Live', 'OpenVibe.Codes']);
                assert.ok(!ran.some((r) => r[1] === 'clone'));
            });

            await check("a download that does not match its checksum is refused, and the other steps still run", async () => {
                const other = fs.mkdtempSync(path.join(os.tmpdir(), 'home-bad-'));
                try {
                    const run = (cmd, args) => {
                        if (args[0] === 'clone' && args.includes('https://github.com/OpenVibers/OpenVibe.Codes')) return { ok: false, out: 'fatal: repository not found' };
                        if (args[0] === 'clone') fs.mkdirSync(path.join(args[args.length - 1], '.git'), { recursive: true });
                        return { ok: true, out: '' };
                    };
                    const out = await home.apply(SPEC, { root: other, env: { HOME: other }, run, fetchImpl: fakeRelease(Buffer.from('bin'), { goodSum: false }), installAgent: async () => ({ ok: true }) });
                    assert.strictEqual(out.ok, false);
                    assert.ok(/checksum/.test(out.tools.go), out.tools.go);
                    assert.ok(!fs.existsSync(path.join(other, '.local', 'bin', 'mise')), 'nothing unchecked is kept');
                    assert.deepStrictEqual(out.repos.cloned, ['OpenVibe.Live']);
                    assert.deepStrictEqual(out.repos.failed, [{ name: 'OpenVibe.Codes', why: 'fatal: repository not found' }]);
                } finally { fs.rmSync(other, { recursive: true, force: true }); }
            });
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        done();
    }
})();
