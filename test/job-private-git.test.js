'use strict';
/**
 * Private repositories (the owner, 2026-11-01: "some people might have private Gits"): a job clones with a token the
 * machine holds (GITHUB_TOKEN, GITLAB_TOKEN, or an OPENVIBE_GIT_CREDENTIALS line https://user:token@host from the Node's
 * config), as an Authorization header for that origin only, through GIT_CONFIG_* variables — never on the command
 * line, never in the remote URL or .git/config. A failed clone of a private repository says what to do.
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const { check, done } = require('./helpers/boot');
const { gitAuthFor, cloneProblem } = require('../harness/job');

const header = (auth) => auth.env && auth.env.GIT_CONFIG_VALUE_0;
const basicOf = (auth) => Buffer.from(String(header(auth)).replace(/^Authorization: Basic /, ''), 'base64').toString();

(async () => {
    await check('a GitHub, GitLab or any-host token becomes a header for that origin only', () => {
        const env = { GITHUB_TOKEN: 'ghp_fake0123456789abcdefghij', GITLAB_TOKEN: 'glpat-fake', OPENVIBE_GIT_CREDENTIALS: 'https://ada:tok%2Fen@git.openvibe.codes\nhttps://bob:pw@code.example.org' };
        const gh = gitAuthFor('https://github.com/someone/private-thing', env);
        assert.strictEqual(gh.env.GIT_CONFIG_COUNT, '1');
        assert.strictEqual(gh.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
        assert.strictEqual(basicOf(gh), 'x-access-token:ghp_fake0123456789abcdefghij');
        assert.strictEqual(basicOf(gitAuthFor('https://gitlab.com/group/sub/project.git', env)), 'oauth2:glpat-fake');
        assert.strictEqual(basicOf(gitAuthFor('https://git.openvibe.codes/ada/site', env)), 'ada:tok/en', 'a credential line, decoded');
        assert.strictEqual(basicOf(gitAuthFor('https://code.example.org/team/app', env)), 'bob:pw');
        assert.deepStrictEqual(gitAuthFor('https://bitbucket.org/x/y', env), {}, 'no token for that host, no header');
        assert.deepStrictEqual(gitAuthFor('http://github.com/x/y', env), {}, 'never over plain http');
        assert.deepStrictEqual(gitAuthFor('https://github.com/x/y', {}), {}, 'a machine with no token sends none');
        assert.deepStrictEqual(gitAuthFor('https://evil.example/x', { OPENVIBE_GIT_CREDENTIALS: 'https://a:b@evil.example/%0d%0aX-Injected: 1' }).env ? 'header' : 'none', 'header', 'the path of a line is not part of the header');
        assert.deepStrictEqual(gitAuthFor('https://evil.example/x', { OPENVIBE_GIT_CREDENTIALS: 'https://a%0d%0aX:b@evil.example' }), {}, 'a line that would break the header is refused');
        assert.deepStrictEqual(gitAuthFor('not a url', env), {});
    });

    await check('the installed git reads the header from the environment, and nothing writes it to a config file', () => {
        const auth = gitAuthFor('https://github.com/someone/private-thing', { GITHUB_TOKEN: 'ghp_fake0123456789abcdefghij' });
        const got = execFileSync('git', ['config', '--get', 'http.https://github.com/.extraheader'], { env: { ...process.env, ...auth.env }, encoding: 'utf8' }).trim();
        assert.strictEqual(got, header(auth));
        assert.ok(!Object.values(auth.env).some((v) => v.includes('ghp_fake')), 'the raw token is in no variable: only its Basic form');
    });

    await check('a failed clone of a private repository says what to do, and other failures are left as they are', () => {
        const said = cloneProblem("fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'https://github.com/someone/private-thing');
        assert.match(said, /if the repository is private, give this machine's Codes runner a token for github\.com/);
        assert.match(said, /GITHUB_TOKEN, GITLAB_TOKEN, or an OPENVIBE_GIT_CREDENTIALS line https:\/\/you:token@github\.com/);
        assert.strictEqual(cloneProblem('fatal: unable to access: Could not resolve host', 'https://x.y/a'), 'fatal: unable to access: Could not resolve host');
    });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
