'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../harness/adapters/cli');
const { apiAgent } = require('../harness/adapters/api');
const { compact } = require('../harness/job');
const { initial, createMapper } = require('../server/agent-ui/mapper');
const { clean } = require('../server/agent-ui/codes');
const { check, done } = require('./helpers/boot');
(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agui-adapters-'));
    fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;');
    try {
        for (const [fixture, adapter, title] of [['claude', cli.claudeCode, 'Read server/auth/handoff.js'], ['codex', cli.codex, 'Ran ls'], ['opencode', cli.opencode, 'Read a.js'], ['muse', cli.muse, 'Ran ls']]) {
            await check(`${fixture}: recorded feed through its real adapter and job parser to AG-UI`, async () => {
                const bin = path.join(dir, fixture);
                fs.writeFileSync(bin, '#!' + process.execPath + '\nprocess.stdout.write(require("fs").readFileSync(' + JSON.stringify(path.join(__dirname, 'fixtures/agent-ui', fixture + '.jsonl')) + '));\n', { mode: 0o700 });
                const state = initial('run-' + fixture, 'codes', '2026-11-11T00:00:00Z');
                const m = createMapper(state, { clean });
                let seq = 0;
                for await (const e of adapter.start.call({ ...adapter, bin }, { cwd: dir, prompt: 'test', permission: 'read', timeoutMs: 5000 }, {})) {
                    for (const line of [].concat(compact(e) || [])) await m.push(line, ++seq);
                }
                await m.push({ t: 'end', ok: true }, ++seq);
                assert.equal(state.steps[0].title, title);
                assert.equal(state.steps[0].status, 'done');
                assert(m.events.some((e) => e.event.type === 'TOOL_CALL_RESULT'));
                assert.equal(m.events.at(-1).event.type, 'RUN_FINISHED');
            });
        }
        await check('DeepSeek: recorded Exchange completion invokes tools and maps their results', async () => {
            const script = require('./fixtures/agent-ui/deepseek.json').slice();
            const adapter = apiAgent({ id: 'deepseek', name: 'DeepSeek', model: 'deepseek-chat', exchange: { key: 'test-only-key' } });
            const state = initial('run-deepseek', 'codes', '2026-11-11T00:00:00Z');
            const m = createMapper(state, { clean });
            let seq = 0;
            const fetch = async (url) => {
                assert.equal(String(url), 'https://api.openvibe.exchange/v1/chat/completions');
                return new Response(JSON.stringify({ choices: [{ message: script.shift() }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
            };
            for await (const e of adapter.start({ cwd: dir, prompt: 'test', permission: 'read', maxTurns: 3 }, { env: {}, fetch })) {
                for (const line of [].concat(compact(e) || [])) await m.push(line, ++seq);
            }
            assert.equal(state.steps[0].title, 'Read a.js');
            assert(m.events.some((e) => e.event.type === 'TOOL_CALL_RESULT' && e.event.content.includes('const a = 1')));
        });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
