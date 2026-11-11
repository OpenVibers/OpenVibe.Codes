'use strict';

/**
 * A fresh verifier per confirmed record, with a refute prompt.
 *
 * The reviewer raises findings; a verifier tries to knock each confirmed one down. Every verification is one
 * standalone request with no conversation history — a fresh agent, never the reviewer's session resumed — pointed
 * at a single record and told to refute it: reproduce the claim against the diff, and say with exact lines where
 * the claim fails. A finding the verifier cannot knock down stands; a refuted one is dropped (ledger) or rejected
 * (finding@1), never silently kept.
 *
 * A "confirmed record" is either a finding@1 record with verdict `confirmed` (validated by engine/finding.js) or a
 * review-ledger record that carries a severity — the review only attaches a severity to a claim it stands behind.
 * Records without a severity are informational and are not verified.
 *
 * Cost is bounded like the review rounds: at most MAX_VERIFY verifier calls per review, worst first. Findings past
 * the cap keep standing and are counted as not verified, out loud.
 *
 *   isConfirmed(record)       whether this record is a confirmed claim worth verifying
 *   refutePrompt({ finding, patch }) the prompt one verifier gets
 *   readRefutal(text)         { stands, reason, counter } from JSON or from the words
 *   verifyFinding({ … })       one fresh verifier on one record
 *   verifyConfirmed({ … })     every confirmed record through a fresh verifier
 */

const { familyOf } = require('./review');
const { validate } = require('./finding');

const MAX_VERIFY = 3;

const modelName = (m) => (typeof m === 'string' ? m : (m && m.model) || null);

/**
 * The models a verifier may be, in order: models of another family than the reviewer's first (a second opinion on
 * the second opinion), else every model but the reviewer's own, else whatever is there. Rotating through the pool
 * gives each record its own fresh verifier while the pool lasts.
 */
function verifierModels({ models = [], reviewer = null, reviewerFamily = null } = {}) {
    const list = (Array.isArray(models) ? models : []).map(modelName).filter(Boolean);
    if (!list.length) return [];
    const otherFamily = reviewerFamily
        ? list.filter((m) => { const f = familyOf(m); return f && f !== reviewerFamily; })
        : [];
    if (otherFamily.length) return otherFamily;
    const notReviewer = reviewer ? list.filter((m) => m !== reviewer) : [];
    return notReviewer.length ? notReviewer : list;
}

/** Whether this record is a confirmed claim: finding@1 `confirmed`, or a ledger record with a severity. */
function isConfirmed(record) {
    if (!record || typeof record !== 'object') return false;
    if (record.verdict === 'confirmed') return validate(record).valid;
    if (record.verdict === 'needs_validation' || record.verdict === 'rejected') return false;
    return typeof record.severity === 'string' && record.severity.trim().length > 0;
}

/** The one finding, in words a verifier that never saw the review can use. */
function findingBrief(finding = {}) {
    const lines = [];
    if (finding.title) lines.push(`Title: ${String(finding.title).slice(0, 300)}`);
    const where = finding.file || (finding.trace && finding.trace[0] && finding.trace[0].file) || '';
    const line = finding.line || (finding.trace && finding.trace[0] && finding.trace[0].line) || null;
    if (where) lines.push(`Location: ${where}${line ? ':' + line : ''}`);
    const text = finding.text || finding.description || '';
    if (text) lines.push(`Claim: ${String(text).slice(0, 2000)}`);
    if (finding.severity) lines.push(`Severity claimed: ${typeof finding.severity === 'object' ? JSON.stringify(finding.severity) : finding.severity}`);
    if (Array.isArray(finding.evidence) && finding.evidence.length) {
        lines.push('Evidence the reviewer cited:');
        for (const ev of finding.evidence.slice(0, 5)) {
            lines.push(`- [${ev.kind || 'unspecified'}] ${String(ev.summary || '').slice(0, 500)}${ev.command ? ` (command: ${String(ev.command).slice(0, 300)})` : ''}`);
        }
    }
    if (finding.claimed_root_cause) lines.push(`Claimed root cause: ${String(finding.claimed_root_cause).slice(0, 1000)}`);
    return lines.join('\n');
}

/**
 * The prompt one verifier gets: the single finding, the diff, and the instruction to refute. The answer is JSON
 * with `stands` false only when the verifier shows the claim failing; anything unclear leaves the finding standing.
 */
function refutePrompt({ finding = {}, patch = '' } = {}) {
    return [
        'You are an independent verifier. You never saw the review below; verify one finding against the diff.',
        'Try to refute it: reproduce the claim in the code, and quote the exact lines that show it failing. A claim',
        'you cannot reproduce, or whose evidence does not reach it, does not stand.',
        'Answer only with JSON:',
        '{"stands":true|false,"reason":"one sentence: why it stands, or the exact lines that refute it","counter":"the lines or command output that decide it, empty when it stands"}',
        'Set "stands" false only when you can show the claim failing. When the answer is unclear, the finding stands.',
        '',
        'The finding under verification:',
        findingBrief(finding),
        '',
        'The diff:\n' + String(patch || '').slice(0, 60000),
    ].filter(Boolean).join('\n');
}

/** The verifier's answer: refuted only on an explicit false, standing on anything else. */
function readRefutal(text) {
    const raw = String(text || '').trim();
    if (!raw) return { stands: true, reason: 'the verifier said nothing', counter: '' };
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try {
            const doc = JSON.parse(raw.slice(start, end + 1));
            if (doc && doc.stands === false) {
                return {
                    stands: false,
                    reason: String(doc.reason || doc.counter || 'the verifier refuted the claim').slice(0, 2000),
                    counter: String(doc.counter || '').slice(0, 2000),
                };
            }
            if (doc && (doc.stands === true || typeof doc.reason === 'string')) {
                return { stands: true, reason: String(doc.reason || 'the verifier could not refute it').slice(0, 2000), counter: String(doc.counter || '').slice(0, 2000) };
            }
        } catch { /* not JSON: read the words */ }
    }
    if (/\brefuted?\b|\bdoes not (stand|hold)\b|\bnot (a |an )?(real|valid) (finding|issue|bug)\b|\bthe claim fails\b/i.test(raw)) {
        return { stands: false, reason: raw.slice(0, 2000), counter: '' };
    }
    return { stands: true, reason: raw.slice(0, 2000), counter: '' };
}

/** One OpenVibe.AI answer to one prompt: a fresh call with no history, the token passed in and never logged. */
async function completeOnce({ baseUrl, token, model, prompt, fetchImpl = globalThis.fetch }) {
    const root = String(baseUrl || 'https://ai.openvibe.services/v1').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    let res = await fetchImpl(`${root}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    let doc = res ? await res.json().catch(() => null) : null;
    const codeOf = (body) => (body && body.error && typeof body.error === 'object' ? body.error.code : null) || (body && body.code) || null;
    if (res && res.status === 404 && !/^ai\.model_/.test(String(codeOf(doc) || ''))) {
        res = await fetchImpl(`${root}/messages`, {
            method: 'POST', headers, body: JSON.stringify({ model, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
        });
        doc = await res.json().catch(() => null);
    }
    if (!res || !res.ok) {
        const err = (doc && doc.error && typeof doc.error === 'object') ? doc.error : null;
        const detail = String((err && (err.message || err.detail)) || '').slice(0, 200);
        throw new Error(`the verifier could not be reached (HTTP ${res && res.status})${detail ? `: ${detail}` : ''}`);
    }
    const text = doc && doc.choices && doc.choices[0] && doc.choices[0].message && doc.choices[0].message.content
        ? doc.choices[0].message.content
        : (doc && doc.content && Array.isArray(doc.content) ? doc.content.map((c) => c && c.text).filter(Boolean).join(' ') : '');
    return String(text || '');
}

/**
 * One fresh verifier on one confirmed record: a standalone call, no history shared with the review or with any
 * other record's verification.
 */
async function verifyFinding({ baseUrl, token, model, family = null, finding = {}, patch = '', fetchImpl = globalThis.fetch } = {}) {
    if (!token) throw new Error('verification needs the task\'s token');
    if (!model) throw new Error('verification needs a model');
    const id = finding.finding_id || finding.fingerprint || null;
    const text = await completeOnce({ baseUrl, token, model, prompt: refutePrompt({ finding, patch }), fetchImpl });
    const refutal = readRefutal(text);
    return {
        finding_id: id,
        stands: refutal.stands,
        reason: refutal.reason,
        ...(refutal.counter ? { counter: refutal.counter } : {}),
        model,
        ...(family || familyOf(model) ? { family: family || familyOf(model) } : {}),
    };
}

/** A finding@1 record after its verifier answered: a standing one is unchanged, a refuted one is rejected. */
function applyRefutalFinding(record, verification) {
    if (verification.stands) return { ...record };
    const { severity, confidence, ...rest } = record;
    return { ...rest, verdict: 'rejected', reason: `verification refuted this (${verification.model}): ${verification.reason}`.slice(0, 2000) };
}

/**
 * Every confirmed record through its own fresh verifier, worst first, at most MAX_VERIFY calls.
 *
 * @returns {{ findings: object[], verifications: object[], line: string|null }}
 */
async function verifyConfirmed({ baseUrl, token, models = [], reviewer = null, reviewerFamily = null, findings = [], patch = '', fetchImpl = globalThis.fetch } = {}) {
    const list = Array.isArray(findings) ? findings : [];
    const pool = verifierModels({ models, reviewer, reviewerFamily });
    const confirmedIdx = [];
    for (let i = 0; i < list.length; i++) if (isConfirmed(list[i])) confirmedIdx.push(i);
    if (!confirmedIdx.length) return { findings: list, verifications: [], line: null };
    if (!token || !pool.length) return { findings: list, verifications: [], line: null };
    const verifications = [];
    const byIndex = new Map();
    const take = confirmedIdx.slice(0, MAX_VERIFY);
    for (let n = 0; n < take.length; n++) {
        const i = take[n];
        const model = pool[n % pool.length];
        try {
            const v = await verifyFinding({ baseUrl, token, model, finding: list[i], patch, fetchImpl });
            verifications.push(v);
            byIndex.set(i, v);
        } catch (e) {
            // A verifier that cannot be reached leaves the finding standing, out loud.
            const v = { finding_id: (list[i] && (list[i].finding_id || list[i].fingerprint)) || null, stands: true, reason: `the verifier could not be reached: ${(e && e.message) || e}`, model };
            verifications.push(v);
            byIndex.set(i, v);
        }
    }
    const kept = list.map((record, i) => {
        const v = byIndex.get(i);
        if (!v) return record;
        if (!v.stands && record.verdict === 'confirmed') return applyRefutalFinding(record, v);
        if (!v.stands) return null;
        // A standing ledger record carries its verification; a standing finding@1 record is already complete.
        if (record.verdict === undefined) return { ...record, verification: { stands: true, reason: v.reason, model: v.model } };
        return { ...record };
    }).filter(Boolean);
    const stood = verifications.filter((v) => v.stands).length;
    const down = verifications.filter((v) => !v.stands).length;
    const skipped = confirmedIdx.length - take.length;
    const line = `Verified: ${stood} stand, ${down} refuted${skipped ? `, ${skipped} not verified` : ''}`;
    return { findings: kept, verifications, line };
}

module.exports = {
    MAX_VERIFY,
    verifierModels, isConfirmed, refutePrompt, readRefutal, verifyFinding, verifyConfirmed,
};
