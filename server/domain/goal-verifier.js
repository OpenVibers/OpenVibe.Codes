'use strict';

/**
 * The independent verifier (AL1): a cheap, fast model on OpenVibe.AI reads a bounded evidence window and answers
 * accept or reject with a reason.
 *
 * Codes never asks the worker's own model to grade its own work: the verifier is a separate call on a cheap rung
 * (deepseek-chat by default), made by Codes with its own Network token, not the task's. The prompt is built by
 * engine/goal.js, which cuts the evidence to 256 KB and treats it as data. A verifier that cannot answer is a
 * `failed` verdict, never an acceptance: a task without an independent verdict is not ready.
 *
 *   createGoalVerifier({ config, fetchImpl, log })
 *     verify({ goal, check, proposal, evidence, checkOutput }) → { status, reason, check_output, model }
 *
 * The service token is minted from Codes' own client credentials for OpenVibe.AI (`ai.run.create`), the same grant its
 * catalog and connection pages use. No provider key reaches Codes, and none is logged here.
 */

const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { verify } = require('../../engine/goal');

/** The cheap rung: one request, at most a short answer. The env may name another (CODES_GOALS_MODEL). */
const DEFAULT_MODEL = 'deepseek-chat';
/** Room for the answer plus a reasoning model's thinking: 300 left AI's reasoning models with no content. */
const MAX_ANSWER_TOKENS = 800;
/** A short verdict needs no long deliberation; "low" keeps the reasoning model inside the synchronous wait. */
const REASONING_EFFORT = 'low';

/** The answer's text from either dialect OpenVibe.AI speaks. */
function answerText(doc) {
    if (!doc || typeof doc !== 'object') return '';
    const choice = doc.choices && doc.choices[0];
    if (choice && choice.message && typeof choice.message.content === 'string') return choice.message.content;
    if (Array.isArray(doc.content)) return doc.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join(' ');
    if (typeof doc.result === 'string') return doc.result;
    return '';
}

function createGoalVerifier({ config = {}, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String((config.ai && (config.ai.internalUrl || config.ai.url)) || 'https://ai.openvibe.services').replace(/\/+$/, '');
    const model = String((config.goals && config.goals.model) || DEFAULT_MODEL);
    const scope = (config.ai && config.ai.scope) || 'ai.credential.manage ai.run.create';
    const tokens = config.oauth && config.oauth.clientSecret
        ? createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl || 'http://127.0.0.1:4000'}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            audience: (config.ai && config.ai.audience) || 'openvibe.ai',
            scope,
            fetch: fetchImpl,
        })
        : null;

    /** One request to AI; the OpenAI dialect first, then the Messages dialect for a provider that speaks only that. */
    async function call({ prompt, signal }) {
        if (!tokens) throw new Error('Codes has no Network client secret, so no independent verifier can run');
        const headers = { ...(await tokens.authHeaders()), 'content-type': 'application/json', accept: 'application/json' };
        const ask = async (path, body) => {
            const res = await fetchImpl(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal });
            const doc = await res.json().catch(() => null);
            return { res, doc };
        };
        let { res, doc } = await ask('/v1/chat/completions', {
            model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: MAX_ANSWER_TOKENS,
            reasoning_effort: REASONING_EFFORT,
        });
        if (res && res.status === 404) {
            ({ res, doc } = await ask('/v1/messages', {
                model, max_tokens: MAX_ANSWER_TOKENS, messages: [{ role: 'user', content: prompt }],
            }));
        }
        if (!res || !res.ok) {
            const err = doc && doc.error && typeof doc.error === 'object' ? doc.error : null;
            const code = String((err && err.code) || (doc && doc.code) || '') || null;
            throw new Error(`OpenVibe.AI refused the goal verifier (HTTP ${res && res.status}${code ? `, ${code}` : ''})`);
        }
        const text = answerText(doc);
        if (!text) throw new Error('the goal verifier returned no answer');
        return text;
    }

    /**
     * Verify one completion proposal. Never throws: a verifier that could not run is a `failed` verdict with its
     * reason, so the task can say it is waiting on a person rather than call itself ready.
     */
    async function verifyGoal({ goal, check, proposal = '', evidence = '', checkOutput = '' } = {}) {
        try {
            const verdict = await verify({
                goal, check, proposal, evidence, checkOutput,
                callVerifier: call,
                timeoutMs: Number(config.goals && config.goals.timeoutMs) || undefined,
            });
            return { ...verdict, model };
        } catch (e) {
            log.warn(`[Codes] goal verifier failed: ${String((e && e.message) || e).slice(0, 300)}`);
            return {
                status: 'failed',
                reason: `The independent verifier could not run: ${String((e && e.message) || e).slice(0, 500)}`,
                check_output: String(checkOutput || '').slice(0, 262144),
                model,
            };
        }
    }

    return { verify: verifyGoal, model };
}

module.exports = { createGoalVerifier, answerText, DEFAULT_MODEL };
