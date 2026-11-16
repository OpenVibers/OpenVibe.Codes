'use strict';
// A sign-in on a machine (Codes runner 0.10.0, Link v0.72.0; the owner, 11-16: the agents' sign-ins done in the page, and
// installed "when the user goes to use openvibe.computer or openvibe.link … their sandbox"): a Link job of mode 'login'
// runs the agent's own sign-in in the person's sandbox, hands it what the person types after the job's args (the code
// its sign-in page shows), and says in its result whether it is signed in now. A coding job's first line is its args,
// whatever stays open after it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'openvibe-codes.js');

function runJob(args, typed, env, { close = false } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [BIN, 'job'], { env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
        let out = '';
        let result = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.stdio[3].on('data', (d) => { result += d; });
        child.stdin.write(`${JSON.stringify(args)}\n`);
        // The code arrives later, as the page sends it: the stdin stays open meanwhile (an interactive job).
        setTimeout(() => { child.stdin.write(typed); if (close) child.stdin.end(); }, 300);
        child.on('close', (code) => resolve({ code, out, result }));
    });
}

(async () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-login-'));
    // A stand-in Claude Code: asks for the code, writes a credential file where Claude Code keeps it (CLAUDE_CONFIG_DIR).
    const fake = path.join(box, 'bin');
    fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, 'claude'), `#!/bin/sh
case "$1" in --version) echo "2.1.325 (Claude Code)"; exit 0;; esac
echo "If the browser didn't open, visit: https://claude.example/oauth/authorize?code=true"
printf "Paste code here if prompted > "
read code
[ "$code" = "the-code-123" ] || { echo "Invalid code."; exit 1; }
mkdir -p "$CLAUDE_CONFIG_DIR"
printf '{"claudeAiOauth":{"accessToken":"sk-ant-oat-test","refreshToken":"r"}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
echo "Login successful."
`, { mode: 0o755 });
    const sandbox = path.join(box, 'sandbox');
    fs.mkdirSync(sandbox);
    const env = { ...process.env, PATH: `${fake}:${process.env.PATH}`, OPENVIBE_SANDBOX: sandbox, OPENVIBE_CODES_AUTOINSTALL: '0', HOME: path.join(box, 'jobhome') };
    delete env.CLAUDE_CONFIG_DIR;

    const ok = await runJob({ mode: 'login', agent: 'claude-code' }, 'the-code-123\n', env);
    assert.strictEqual(ok.code, 0, ok.out);
    assert.match(ok.out, /claude\.example\/oauth\/authorize/, 'the sign-in link reaches the page (job_stdout)');
    const doc = JSON.parse(ok.result);
    assert.deepStrictEqual([doc.mode, doc.agent, doc.ok, doc.signed_in], ['login', 'claude-code', true, true], ok.result);
    // In the person's sandbox, as the actor `me`: their next job finds it.
    const cred = path.join(sandbox, 'codes', 'profiles', 'me', 'claude', '.credentials.json');
    assert.ok(fs.existsSync(cred), `the sign-in is kept in the sandbox: ${cred}`);

    const wrong = await runJob({ mode: 'login', agent: 'claude-code' }, 'not-it\n', { ...env, OPENVIBE_SANDBOX: path.join(box, 'other') });
    fs.mkdirSync(path.join(box, 'other'), { recursive: true });
    const w = JSON.parse(wrong.result || '{}');
    assert.strictEqual(w.ok, false, wrong.out);
    assert.match(wrong.out, /did not sign in/);

    // An agent that never gives up waiting (Claude Code after a wrong code, on ov-node-01): the page's input closing
    // gives it a moment, then the job ends with a result, never killed silently at Link's limit.
    const stuck = path.join(box, 'stuck');
    fs.mkdirSync(stuck);
    fs.writeFileSync(path.join(stuck, 'claude'), `#!/bin/sh
case "$1" in --version) echo "2.1.325 (Claude Code)"; exit 0;; esac
echo "If the browser didn't open, visit: https://claude.example/oauth/authorize?code=true"
exec tail -f /dev/null
`, { mode: 0o755 });
    const stuckEnv = { ...env, PATH: `${stuck}:${process.env.PATH}`, OPENVIBE_SANDBOX: path.join(box, 'stuck-box'), OPENVIBE_CODES_LOGIN_GRACE_MS: '200' };
    fs.mkdirSync(stuckEnv.OPENVIBE_SANDBOX);
    const t0 = Date.now();
    const closed = await runJob({ mode: 'login', agent: 'claude-code' }, 'wrong\n', stuckEnv, { close: true });
    const c = JSON.parse(closed.result || '{}');
    assert.deepStrictEqual([c.ok, c.signed_in], [false, false], `input closed: a result (${closed.out})`);
    assert.ok(Date.now() - t0 < 8000, 'ended soon after the input closed');
    // Input left open: the job's own deadline ends it, with a result.
    const late = await runJob({ mode: 'login', agent: 'claude-code' }, 'wrong\n', { ...stuckEnv, OPENVIBE_CODES_LOGIN_GRACE_MS: '60000', OPENVIBE_CODES_LOGIN_DEADLINE_MS: '700' });
    const l = JSON.parse(late.result || '{}');
    assert.strictEqual(l.ok, false, `deadline: a result (${late.out})`);
    assert.match(late.out, /did not sign in/);

    const unknown = await runJob({ mode: 'login', agent: 'no-such-agent' }, '\n', env);
    assert.strictEqual(JSON.parse(unknown.result).error, 'unknown_agent');
    console.log('login-job: a sign-in on a machine takes the typed code and is kept in the person\'s sandbox');
})().catch((e) => { console.error(e); process.exit(1); });
