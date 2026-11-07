'use strict';
/**
 * The agent's step (design 2026-11-07): Codes publishes what its task is doing as agent.step.started|updated|ended,
 * so the one timeline behind the Dock shows it. The payload is a title, an outcome and a link: never the task's
 * prompt, never a diff.
 */
const assert = require('assert');
const { agentStepOf, AGENT_TOPICS } = require('../server/events/outbox');

const ROW = {
    id: 'tsk_01JAB2C3D4E5F6G7H8J9K0MNPS',
    subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPS',
    repo: 'https://github.com/ada/site',
    state: 'running',
    prompt: 'the prompt the person typed, which never leaves here',
    created_at: 1762000000000,
    updated_at: 1762000001000,
    result: { cost_usd: 0.12 },
};

assert.strictEqual(AGENT_TOPICS.started, 'agent.step.started');
assert.strictEqual(AGENT_TOPICS.updated, 'agent.step.updated');
assert.strictEqual(AGENT_TOPICS.ended, 'agent.step.ended');

const step = agentStepOf(ROW, 'running');
assert.strictEqual(step.step_id, ROW.id);
assert.strictEqual(step.mode, 'code');
assert.strictEqual(step.product, 'codes');
assert.strictEqual(step.status, 'running');
assert.ok(step.title.includes('ada/site'), 'the title names the repository');
assert.ok(!JSON.stringify(step).includes('the prompt the person typed'), 'the prompt never leaves Codes');
assert.ok(!('prompt' in step) && !('diff' in step) && !('files' in step), 'there is no field for a prompt or a diff');
assert.strictEqual(step.cost_usd, 0.12);
assert.ok(step.link.includes(ROW.id), 'the step links to its own page');
assert.ok(step.started_at && !Number.isNaN(Date.parse(step.started_at)), 'the start is a time');

const ended = agentStepOf(Object.assign({}, ROW, { state: 'failed', error: 'the build failed' }), 'failed');
assert.strictEqual(ended.status, 'failed');
assert.strictEqual(ended.reason, 'the build failed');
assert.ok(ended.ended_at, 'an ended step says when it ended');

console.log('codes agent step: a title, an outcome and a link — never a prompt or a diff');
console.log('all passed');
