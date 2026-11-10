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
 *   reviewWithAi({ … })             the review as { family, verdict, summary, findings, lifecycle, lifecycle_line }
 *   readReview(text)                { verdict, summary, findings } from JSON or from the words
 *
 * The verdict is 'approved' or 'changes_requested'. The model is asked for JSON with its findings; a model that answers
 * in prose is read by its words ('approved', 'looks good' → approved; 'changes', 'needs work' → changes_requested),
 * because a review that cannot be read is not a review. Quiet by default: only issues this diff introduces, at most
 * three, no style, no speculation, and no synthetic "no issues" finding. Re-review is given the prior ledger so a
 * finding is addressed, reappeared, still open or new rather than lost in a fresh paragraph.
 */

const { MAX_FINDINGS, priorBrief, fromReview, lifecycleLine, parse: parseFindings } = require('./findings');

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

/**
 * The prompt the reviewer gets: the change, what it was for, the tests, and the prior findings on a re-review.
 * Quiet by default — the rules are the point: only what this diff introduces, at most three findings, no style, no
 * speculation, and an approval is an empty list rather than a "no issues" note.
 */
function reviewPrompt({ patch = '', summary = '', tests = null, prior = [] } = {}) {
    const before = priorBrief(prior);
    return [
        'You are reviewing a change to a repository. Answer only with JSON:',
        `{"verdict":"approved"|"changes_requested","summary":"one sentence, what you checked","findings":[{"file":"path","line":12,"text":"what is wrong and the concrete fix","severity":"low"|"medium"|"high"|"critical"}]}`,
        'Flag only issues this change introduces: a correctness bug, a security problem, a missing or broken test, or a',
        `requirement the change leaves undone. At most ${MAX_FINDINGS} findings, worst first. No style nits, no "may be`,
        'unsafe" without the path that reaches it, and no re-raising a design choice the change was asked to make. If a',
        'high-impact point is plausible but not proven, say "uncertain" in its text and keep the severity low. If nothing',
        'is wrong, "approved" with an empty findings list; never write a "no issues" finding or a comment.',
        '',
        before ? 'A previous review of an earlier revision raised the findings below. Treat them as the ledger: say in your\nsummary which are addressed, and report one again only when it still stands in this revision; then add only new\nissues this revision introduced. The ids stay stable across re-wrapping.\n' + before : '',
        summary ? 'What the change was asked to do:\n' + String(summary).slice(0, 4000) : '',
        tests ? 'The tests the author says pass:\n' + String(tests).slice(0, 2000) : '',
        '',
        'The diff:\n' + String(patch || '').slice(0, 120000),
    ].filter(Boolean).join('\n');
}

/** The answer as JSON, or as the words in it, with the findings it raised (an empty list on approval). */
function readReview(text) {
    const raw = String(text || '').trim();
    if (!raw) return { verdict: 'changes_requested', summary: 'the reviewer said nothing', findings: [] };
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const doc = JSON.parse(raw.slice(start, end + 1));
            const findings = Array.isArray(doc.findings) ? doc.findings.map((f) => ({
                file: String(f.file || '').trim(), line: Number.isInteger(f.line) ? f.line : null,
                text: String(f.text || f.description || '').trim(), severity: f.severity || null,
            })).filter((f) => f.file && f.text).slice(0, MAX_FINDINGS) : [];
            const verdict = String(doc.verdict || '').toLowerCase();
            if (/approv|looks good|lgtm/.test(verdict)) return { verdict: 'approved', summary: String(doc.summary || raw).slice(0, 4000), findings };
            if (/change|reject|not good/.test(verdict)) return { verdict: 'changes_requested', summary: String(doc.summary || raw).slice(0, 4000), findings };
            if (doc.summary) return { verdict: 'changes_requested', summary: String(doc.summary).slice(0, 4000), findings };
        } catch { /* not JSON: read the words */ }
    }
    const findings = parseFindings(raw);
    if (/\bapprov|looks good|looks fine|lgtm|no changes\b/i.test(raw)) return { verdict: 'approved', summary: raw.slice(0, 4000), findings };
    return { verdict: 'changes_requested', summary: raw.slice(0, 4000), findings };
}

/** The verdict alone (the older callers). */
function readVerdict(text) {
    const read = readReview(text);
    return { verdict: read.verdict, summary: read.summary };
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
 * @returns {Promise<{ family: string, model: string, verdict: string, summary: string, resolved_model?: string, disclosure?: object }>} the verdict
 */
async function reviewWithAi({
    baseUrl = 'https://ai.openvibe.services/v1',
    token,
    model,
    family = null,
    patch = '',
    summary = '',
    tests = null,
    prior = [],
    fetchImpl = globalThis.fetch,
} = {}) {
    if (!token) throw new Error('the review needs the task\'s token');
    if (!model) throw new Error('the review needs a model');
    const root = String(baseUrl).replace(/\/+$/, '');
    const prompt = reviewPrompt({ patch, summary, tests, prior });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    let res = await fetchImpl(`${root}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    let doc = res ? await res.json().catch(() => null) : null;
    const codeOf = (body) => (body && body.error && typeof body.error === 'object' ? body.error.code : null) || (body && body.code) || null;
    // A 404 for a model AI refused is final; only a provider that does not speak chat completions gets the other
    // dialect, and it is asked for the same model.
    if (res && res.status === 404 && !/^ai\.model_/.test(String(codeOf(doc) || ''))) {
        res = await fetchImpl(`${root}/messages`, {
            method: 'POST', headers, body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
        });
        doc = await res.json().catch(() => null);
    }
    if (!res || !res.ok) {
        const err = (doc && doc.error && typeof doc.error === 'object') ? doc.error : null;
        const code = String((err && err.code) || (doc && doc.code) || '') || null;
        const detail = String((err && (err.message || err.detail)) || (doc && (doc.detail || doc.title)) || '').slice(0, 300);
        throw new Error(`OpenVibe.AI refused the review (HTTP ${res && res.status}${code ? `, ${code}` : ''})${detail ? `: ${detail}` : ''}`);
    }
    const body = doc;
    const text = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content
        ? body.choices[0].message.content
        : (body && body.content && Array.isArray(body.content) ? body.content.map((c) => c && c.text).filter(Boolean).join(' ') : '');
    const read = readReview(text);
    // A reviewer that said nothing reviewed nothing: its prior findings are kept, never silently marked addressed.
    const ledger = String(text || '').trim() ? fromReview(text, prior) : { findings: Array.isArray(prior) ? prior : [], lifecycle: null, line: null };
    // The route disclosure (D3'): the model that actually ran, the deployment and the cost, inside x_openvibe.
    const x = body && body.x_openvibe && typeof body.x_openvibe === 'object' ? body.x_openvibe : null;
    const resolved = x && x.resolved_model ? String(x.resolved_model) : (body && body.model ? String(body.model) : model);
    return {
        family: familyOf(resolved) || family || familyOf(model) || null,
        model: resolved,
        requested_model: model,
        ...(x && x.resolved_model ? { resolved_model: String(x.resolved_model) } : {}),
        ...(x ? { disclosure: x } : {}),
        ...(x && Number.isFinite(+x.cost_usd) ? { cost_usd: +x.cost_usd } : {}),
        verdict: read.verdict,
        summary: read.summary,
        // The persisted lifecycle: ACTIVE/RESOLVED records and the addressed/reappeared/still open/new line.
        findings: ledger.findings,
        lifecycle: ledger.lifecycle,
        lifecycle_line: lifecycleLine(ledger.lifecycle),
    };
}

module.exports = {
    FAMILIES, HARNESS_FAMILY,
    familyOf, authorFamily, pickReviewer, reviewPrompt, readReview, readVerdict, reviewWithAi,
};
