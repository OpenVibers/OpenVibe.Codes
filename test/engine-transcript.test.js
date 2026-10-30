'use strict';
// The transcript normaliser, ported from the portal's test-transcript.js (the cache: retention, eviction, replay,
// append, truncation and deletion) and extended with the event shape every harness ends up in.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { check, done } = require('./helpers/boot');
const transcript = require('../engine/transcript');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-transcript-'));
const source = fs.readFileSync(path.join(__dirname, '..', 'engine', 'transcript.js'), 'utf8');

/** The module again, with a smaller cache, so the eviction can be seen. */
function parser(budget) {
    const context = { require, module: { exports: {} }, Buffer };
    vm.runInNewContext(source.replace('32 * 1024 * 1024', String(budget)), context);
    return context.module.exports;
}

function log(name, text) {
    const file = path.join(folder, name);
    fs.writeFileSync(file, JSON.stringify({ type: 'result', result: text }) + '\n');
    return file;
}

(async () => {
    try {
        await check('the cache keeps, evicts, replays, appends, truncates and forgets', () => {
            const small = parser(4096);
            const first = log('first', 'first answer');
            const firstState = small.parse(first);
            assert.equal(small.parse(first), firstState);
            const second = log('second', 'second answer');
            const secondState = small.parse(second);
            assert.equal(small.parse(first), firstState);
            small.parse(log('third', 'third answer'));
            assert.equal(small.parse(first), firstState);
            const reloaded = small.parse(second);
            assert.notEqual(reloaded, secondState);
            assert.equal(reloaded.events[0].text, 'second answer');
            const oversized = log('large', 'large answer '.repeat(1000));
            const largeState = small.parse(oversized);
            assert.notEqual(small.parse(oversized), largeState);
            assert.equal(small.parse(oversized).events[0].text, largeState.events[0].text);
            fs.appendFileSync(first, JSON.stringify({ type: 'result', result: 'appended' }) + '\n');
            assert.equal(small.parse(first).events.at(-1).text, 'appended');
            fs.writeFileSync(first, JSON.stringify({ type: 'result', result: 'new' }) + '\n');
            assert.equal(small.parse(first).events.length, 1);
            assert.equal(small.parse(first).events[0].text, 'new');
            fs.unlinkSync(first);
            assert.equal(small.parse(first).events.length, 0);
            const many = parser(1024 * 1024);
            const oldest = log('oldest', 'oldest');
            const original = many.parse(oldest);
            for (let index = 0; index < 60; index++) many.parse(log(`entry-${index}`, String(index)));
            assert.notEqual(many.parse(oldest), original);
        });

        await check('Claude Code stream-json becomes the one shape', () => {
            const state = transcript.parseText([
                JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5-5', cwd: '/repo' }),
                JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'On it.' }] } }),
                JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
                JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
                JSON.stringify({ type: 'result', result: 'Done.', session_id: 'sess-1', total_cost_usd: 0.12 }),
            ].join('\n'));
            assert.equal(state.session, 'sess-1');
            assert.equal(state.model, 'claude-sonnet-5-5');
            assert.equal(state.cost, 0.12);
            const kinds = state.events.map((e) => e.t);
            assert.deepEqual(kinds, ['meta', 'text', 'tool', 'final']);
            const tool = state.events.find((e) => e.t === 'tool');
            assert.equal(tool.name, 'Bash');
            assert.equal(tool.kind, 'shell');
            assert.match(tool.input.text, /npm test/, 'the input is kept as text');
            assert.equal(tool.pending, false, 'the result arrived');
            assert.equal(tool.output.text, 'ok');
            assert.equal(state.events.at(-1).text, 'Done.');
        });

        await check('a Codex and Command Code feed (the same shape) becomes the one shape', () => {
            const state = transcript.parseText([
                JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } }),
                JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'shell', input: { command: '/bin/bash -lc "ls -la"' } }] } }),
            ].join('\n'));
            const tool = state.events.find((e) => e.t === 'tool');
            assert.equal(tool.name, 'shell');
            assert.equal(tool.summary, 'ls -la', 'the wrapped command is unwrapped');
        });

        await check('DeepSeek\'s dsh --json becomes the one shape', () => {
            const state = transcript.parseText([
                JSON.stringify({ type: 'session', sessionId: 'dsh-1', cwd: '/repo' }),
                JSON.stringify({ type: 'thinking', text: 'hmm' }),
                JSON.stringify({ type: 'tool_call', callId: 'd1', tool: 'read_file', input: { path: '/repo/a.js' } }),
                JSON.stringify({ type: 'tool_result', callId: 'd1', result: 'contents', status: 'completed' }),
                JSON.stringify({ type: 'text', text: 'Read it.' }),
            ].join('\n'));
            assert.equal(state.session, 'dsh-1');
            assert.deepEqual(state.events.map((e) => e.t), ['meta', 'thinking', 'tool', 'text']);
            const tool = state.events.find((e) => e.t === 'tool');
            assert.equal(tool.name, 'read_file');
            assert.equal(tool.kind, 'read');
            assert.equal(tool.output.text, 'contents');
        });

        await check('MiniMax Code\'s stream-json becomes the one shape', () => {
            const state = transcript.parseText([
                JSON.stringify({ schemaVersion: 1, type: 'item.started', sessionId: 'mm-1', item: { id: 'm1', type: 'agent_message' } }),
                JSON.stringify({ schemaVersion: 1, type: 'item.completed', item: { id: 'm1', type: 'agent_message', content: 'Hello.' } }),
                JSON.stringify({ schemaVersion: 1, type: 'item.started', item: { id: 't1', type: 'tool_call', toolCall: { id: 'tc1', name: 'Bash', input: { command: 'npm test' } } } }),
                JSON.stringify({ schemaVersion: 1, type: 'item.completed', item: { id: 't1', type: 'tool_call', toolCall: { id: 'tc1', name: 'Bash', output: 'ok' } } }),
                JSON.stringify({ schemaVersion: 1, type: 'exec.completed', result: { answer: 'All good.', status: 'succeeded' } }),
            ].join('\n'));
            assert.equal(state.session, 'mm-1');
            assert.deepEqual(state.events.map((e) => e.t), ['text', 'tool', 'final']);
            const tool = state.events.find((e) => e.t === 'tool');
            assert.equal(tool.name, 'Bash');
            assert.equal(tool.output.text, 'ok');
            assert.equal(state.events.at(-1).text, 'All good.');
        });

        await check('every event says when it happened', () => {
            const state = transcript.parseText(JSON.stringify({ type: 'result', result: 'Done.', timestampMs: 1712345678900 }));
            assert.equal(state.events[0].at, '2024-04-05T19:34:38.900Z');
            assert.equal(transcript.atOf(null), null);
            assert.equal(transcript.atOf(1712345678900), '2024-04-05T19:34:38.900Z');
        });

        await check('the schema of the shape is published and describes an event', () => {
            const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'engine', 'transcript.schema.json'), 'utf8'));
            assert.equal(schema.$id, 'https://openvibe.codes/schemas/engine/transcript@1');
            const event = schema.$defs.event;
            for (const field of ['t', 'text', 'name', 'input', 'output', 'at']) {
                assert.ok(event.properties[field], `the schema describes ${field}`);
            }
            assert.deepEqual(event.properties.t.enum, ['user', 'text', 'thinking', 'tool', 'error', 'final', 'meta']);
        });
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }
    done();
})();
