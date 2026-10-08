'use strict';
/**
 * Stand-in coding agents for the harness tests: a temporary bin directory with `claude`, `codex`, `opencode` and `cmd`
 * scripts that print what the real CLIs print (recorded shapes) and an isolated OPENVIBE_CODES_HOME. Each script reads
 * FAKE_<NAME> from its environment:
 *
 *   ok        a short run: a tool call, its result, a final answer that quotes the prompt it was given
 *   fail      the agent's own error, then exit 1 (no result line from the CLI)
 *   crash     exit 3 with a line on stderr that carries a key (it must come back redacted)
 *   hang      prints its start, then sleeps (a stall)
 *
 *   const f = fakeAgents({ claude: 'ok', codex: 'fail' });   f.env → PATH and OPENVIBE_CODES_HOME; f.cleanup()
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = {
    claude: `
const prompt = process.argv[process.argv.indexOf('-p') + 1];
const mode = process.env.FAKE_CLAUDE || 'ok';
const out = (o) => console.log(JSON.stringify(o));
if (mode === 'hang') { out({ type: 'system', subtype: 'init', session_id: 'cl-hang', model: 'fake-claude' }); setInterval(() => {}, 1000); return; }
if (mode === 'crash') { process.stderr.write('boom: api_key=sk-test0123456789abcdefghij\\n'); process.exit(3); }
out({ type: 'system', subtype: 'init', session_id: 'cl-1', model: 'fake-claude' });
out({ type: 'assistant', message: { model: 'fake-claude', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'const a = 1;', is_error: false }] } });
if (mode === 'fail') { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'claude could not finish', session_id: 'cl-1' }); process.exit(1); }
out({ type: 'assistant', message: { model: 'fake-claude', content: [{ type: 'text', text: 'claude did: ' + prompt }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'claude did: ' + prompt, session_id: 'cl-1', duration_ms: 5, num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
`,
    codex: `
const prompt = process.argv[process.argv.length - 1];
const mode = process.env.FAKE_CODEX || 'ok';
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'thread.started', thread_id: 'cx-1' });
out({ type: 'turn.started' });
if (mode === 'fail') { out({ type: 'error', message: 'You have hit your usage limit.' }); out({ type: 'turn.failed', error: { message: 'You have hit your usage limit.' } }); process.exit(1); }
out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', aggregated_output: 'a.js', exit_code: 0, status: 'completed' } });
out({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }], status: 'completed' } });
out({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'codex did: ' + prompt } });
out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } });
`,
    opencode: `
const prompt = process.argv[process.argv.length - 1];
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'step_start', sessionID: 'oc-1', part: {} });
out({ type: 'tool_use', sessionID: 'oc-1', part: { id: 'p1', tool: 'read', state: { status: 'completed', input: { path: 'a.js' }, output: 'const a = 1;' } } });
out({ type: 'text', sessionID: 'oc-1', part: { messageID: 'm1', text: 'opencode did: ' + prompt } });
out({ type: 'step_finish', sessionID: 'oc-1', part: { tokens: { input: 20, output: 3, reasoning: 1, cache: { read: 5, write: 0 } }, cost: 0.002 } });
`,
    cmd: `
const arg = process.argv.find((a) => a.startsWith('--print=')) || '';
const prompt = arg.slice(8);
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'event', event: { type: 'run_start', sessionId: 'cc-1' } });
out({ type: 'event', event: { type: 'model_request_start', model: 'fake-cmd' } });
out({ type: 'event', event: { type: 'message_end', content: [{ type: 'tool_use', id: 'u1', name: 'edit_file', input: { path: 'a.js' } }] } });
out({ type: 'event', event: { type: 'tool_completed', toolCallId: 'u1', result: [{ text: 'edited' }] } });
out({ type: 'event', event: { type: 'message_end', content: [{ type: 'text', text: 'cmd did: ' + prompt }] } });
out({ type: 'result', subtype: 'success', finalText: 'cmd did: ' + prompt, sessionId: 'cc-1', usage: { inputTokens: 9, outputTokens: 4 } });
`,
};

function fakeAgents(modes = {}, { include = Object.keys(SCRIPTS) } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-fake-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    for (const name of include) {
        const f = path.join(bin, name);
        fs.writeFileSync(f, `#!${process.execPath}\n'use strict';\n(function () {${SCRIPTS[name]}})();\n`, { mode: 0o755 });
    }
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'a.js'), 'const a = 1;\n');
    const env = {
        PATH: bin, OPENVIBE_CODES_HOME: path.join(dir, 'home'),
        FAKE_CLAUDE: modes.claude || 'ok', FAKE_CODEX: modes.codex || 'ok',
    };
    return { dir, bin, work, env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { fakeAgents };
