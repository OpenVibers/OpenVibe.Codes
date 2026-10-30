'use strict';

/**
 * The second opinion on a change: a model of another family than the one that wrote it.
 *
 * "Another family" is the rule that makes the second opinion worth reading. A model of the same family tends to
 * repeat its own reasoning, so the family is part of the verdict: a review by the author's own family is not
 * accepted, and the collector says so instead of pretending a second look happened.
 *
 * The call goes to OpenVibe.AI, the one place that holds the person's keys (stage C3): POST /v1/chat/completions with
 * the attempt's run token, or /v1/messages for a provider that speaks that dialect. The token is passed in, never read
 * from here: this module never sees a secret and never logs one.
 *
 *   familyOf(model)                 the family a model belongs to ('anthropic', 'openai', 'deepseek', …)
 *   authorFamily({ agent, model })  the family that wrote the change
 *   pickReviewer({ models, author }) a model of another family, or null when there is none
 *   reviewWithAi({ … })             the review as { family, verdict, summary }
 *
 * The verdict is 'approved' or 'changes_requested'. The model is asked for JSON; a model that answers in prose is
 * read by its words ('approved', 'looks good' → approved; 'changes', 'needs work' → changes_requested), because a
 * review that cannot be read is not a review.
 */

/** The families this knows, by the model's own name. */
const FAMILIES = [
    { family: 'anthropic', re: /claude/i },
    { family: 'openai', re: /\bgpt-|\bo[134]\b|codex/i },
    { family: 'google', re: /gemini/i },
    { family: 'deepseek', re: /deepseek/i },
    { family: 'minimax', re: /minimax|abab/i },
    { family: 'qwen', re: /qwen/i },
    { family: 'moonshot', re: /kimi|moonshot/i },
];

/** The families Codes' own harnesses belong to, by the harness id. */
const HARNESS_FAMILY = {
    'claude-code': 'anthropic',
    codex: 'openai',
    'command-code': 'deepseek',
    opencode: 'qwen',
    deepseek: 'deepseek',
    aider: 'openai',
    'openvibe-ai': 'openai',
    'openai-compatible': 'openai',
};

/**
 * The family a model belongs to, or null when its name says nothing.
 *
 * @param {string} model the model's name
 * @returns {string|null} the family
 */
function familyOf(model) {
    const name = String(model || '').trim();
    if (!name) return null;
    for (const f of FAMILIES) if (f.re.test(name)) return f.family;
    return null;
}

/**
 * The family that wrote the change: the model's own name first, the harness second.
 *
 * @param {object} what { agent, model }
 * @returns {string|null} the family
 */
function authorFamily({ agent = null, model = null } = {}) {
    return familyOf(model) || HARNESS_FAMILY[String(agent || '')] || null;
}

/**
 * A model of another family, for the second opinion. The first one that is not the author's family wins.
 *
 * @param {object} what { models, author }
 * @returns {{ model: string, family: string }|null} the reviewer, or null when every model is the author's family
 */
function pickReviewer({ models = [], author = null } = {}) {
    const list = Array.isArray(models) ? models : [];
    for (const m of list) {
        const name = typeof m === 'string' ? m : (m && m.model) || null;
        if (!name) continue;
        const family = familyOf(name);
        if (!family || (author && family === author)) continue;
        return { model: name, family };
    }
    return null;
}

/** The prompt the reviewer gets: the change, the tests it claims to pass, and what is being asked of it. */
function reviewPrompt({ patch = '', summary = '', tests = null } = {}) {
    return [
        'You are reviewing a change to a repository. Answer only with JSON:',
        '{"verdict":"approved"|"changes_requested","summary":"one paragraph, what you checked and what you found"}.',
        'Answer "approved" when the change does what it says and holds together; "changes_requested" when it is wrong,',
        'unsafe, or leaves the work unfinished. Be concrete: name the file and the line.',
        '',
        summary ? 'What the change was asked to do:\n' + String(summary).slice(0, 4000) : '',
        tests ? 'The tests the author says pass:\n' + String(tests).slice(0, 2000) : '',
        '',
        'The diff:\n' + String(patch || '').slice(0, 120000),
    ].filter(Boolean).join('\n');
}

/** The answer as JSON, or as the words in it. */
function readVerdict(text) {
    const raw = String(text || '').trim();
    if (!raw) return { verdict: 'changes_requested', summary: 'the reviewer said nothing' };
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const doc = JSON.parse(raw.slice(start, end + 1));
            const verdict = String(doc.verdict || '').toLowerCase();
            if (/approv|looks good|lgtm/.test(verdict)) return { verdict: 'approved', summary: String(doc.summary || raw).slice(0, 4000) };
            if (/change|reject|not good/.test(verdict)) return { verdict: 'changes_requested', summary: String(doc.summary || raw).slice(0, 4000) };
            if (doc.summary) return { verdict: 'changes_requested', summary: String(doc.summary).slice(0, 4000) };
        } catch { /* not JSON: read the words */ }
    }
    if (/\bapprov|looks good|looks fine|lgtm|no changes\b/i.test(raw)) return { verdict: 'approved', summary: raw.slice(0, 4000) };
    return { verdict: 'changes_requested', summary: raw.slice(0, 4000) };
}

/**
 * The review itself: one request to OpenVibe.AI, read as a verdict.
 *
 * @param {object} what
 * @param {string} what.baseUrl OpenVibe.AI's OpenAI-compatible root
 * @param {string} what.token the task's token (never logged)
 * @param {string} what.model the reviewer's model
 * @param {string} what.family the reviewer's family
 * @param {string} [what.patch] the diff
 * @param {string} [what.summary] what the change was for
 * @param {function} [what.fetchImpl] fetch, for a test
 * @returns {Promise<{ family: string, verdict: string, summary: string }>} the verdict
 */
async function reviewWithAi({
    baseUrl = 'https://ai.openvibe.services/v1',
    token,
    model,
    family = null,
    patch = '',
    summary = '',
    tests = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    if (!token) throw new Error('the review needs the task\'s token');
    if (!model) throw new Error('the review needs a model');
    const root = String(baseUrl).replace(/\/+$/, '');
    const prompt = reviewPrompt({ patch, summary, tests });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    let res = await fetchImpl(`${root}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    if (res && res.status === 404) {
        // A provider that speaks the messages dialect instead.
        res = await fetchImpl(`${root}/messages`, {
            method: 'POST', headers, body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
        });
    }
    if (!res || !res.ok) throw new Error(`OpenVibe.AI refused the review (HTTP ${res && res.status})`);
    const body = await res.json().catch(() => null);
    const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content
        ? body.choices[0].message.content
        : (body && body.content && Array.isArray(body.content) ? body.content.map((c) => c && c.text).filter(Boolean).join(' ') : '');
    const verdict = readVerdict(text);
    return { family: family || familyOf(model), model, verdict: verdict.verdict, summary: verdict.summary };
}

module.exports = {
    FAMILIES, HARNESS_FAMILY,
    familyOf, authorFamily, pickReviewer, reviewPrompt, readVerdict, reviewWithAi,
};
