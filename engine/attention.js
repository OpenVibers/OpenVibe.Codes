'use strict';

/**
 * One structured question awaiting a person: `agent.attention@1`, raised, answered and resumed.
 *
 * A worker that cannot proceed without a person raises an attention instead of failing: one question, the evidence
 * it holds, the options it offers, and the session the answer must resume. Authorised independent work may continue
 * meanwhile; the answer resumes the same session (engine/chain.js reads the open record and says `attention`,
 * never `failed`). The person's answer arrives from the phone path; Codes records it here and hands the session
 * back. The contract shape is OpenVibe.Contracts' `agent/attention.v1.json`; the evidence, options and session ride
 * alongside it and are projected off by toContract.
 *
 *   raise({ ticket_id, question, evidence, options, session }) the open record
 *   answer(record, { answer, by })    the answered record
 *   dismiss(record, { note })         the dismissed record
 *   isOpen(record)                    an unanswered, undismissed record
 *   resumeSession(record)             the session the answer resumes, or null
 *   toContract(record)                the attention.v1 shape
 *   isValidContract(doc)              { valid, errors } for the attention.v1 shape
 *   STATES                            open, answered, dismissed
 */

const STATES = ['open', 'answered', 'dismissed'];
const MAX_TEXT = 4000;

let counter = 0;

const isText = (v, max = MAX_TEXT) => typeof v === 'string' && v.trim().length > 0 && (!max || v.length <= max);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const stamp = (v) => (v === undefined ? new Date().toISOString() : String(v));

/** The open record: one question, what backs it, what the person can pick, and the session it resumes. */
function raise({ id = null, ticket_id = null, question = null, evidence = [], options = [], session = null, created_at } = {}) {
    if (!isText(ticket_id, 200)) throw new Error('an attention needs the ticket it blocks');
    if (!isText(question)) throw new Error('an attention needs the question');
    if (evidence !== undefined && !Array.isArray(evidence)) throw new Error('attention evidence is a list');
    if (options !== undefined && !Array.isArray(options)) throw new Error('attention options is a list');
    if (session !== undefined && session !== null && !isText(session, 500)) throw new Error('an attention session is a short string');
    return {
        id: isText(id, 200) ? String(id) : `att_${Date.now().toString(36)}_${(counter++).toString(36)}`,
        ticket_id: String(ticket_id),
        question: String(question),
        evidence: (Array.isArray(evidence) ? evidence : []).filter(isObject).slice(0, 10),
        options: (Array.isArray(options) ? options : []).filter((o) => typeof o === 'string' && o.trim()).map((o) => String(o)).slice(0, 10),
        ...(session ? { session: String(session) } : {}),
        state: 'open',
        created_at: stamp(created_at),
    };
}

/** The answer, recorded on the open record. Answering anything but an open record is a mistake, said out loud. */
function answer(record, { answer: text = null, by = null, answered_at } = {}) {
    if (!isOpen(record)) throw new Error('only an open attention can be answered');
    if (!isText(text)) throw new Error('an attention answer is non-empty text');
    return {
        ...record,
        state: 'answered',
        answer: String(text),
        ...(by !== undefined && by !== null ? { answered_by: String(by) } : {}),
        answered_at: stamp(answered_at),
    };
}

/** Dismissed: the question is withdrawn, and the session is free. */
function dismiss(record, { note = null } = {}) {
    if (!isOpen(record)) throw new Error('only an open attention can be dismissed');
    return { ...record, state: 'dismissed', ...(note ? { dismiss_note: String(note).slice(0, 1000) } : {}) };
}

/** An unanswered, undismissed record. */
function isOpen(record) {
    return !!record && record.state === 'open' && isText(record.question) && isText(record.ticket_id);
}

/** The session the answer must resume: the record's own, the same session the worker waited in. */
function resumeSession(record) {
    if (!isObject(record)) return null;
    return record.session && String(record.session).trim() ? String(record.session) : null;
}

/** The contract shape: what attention.v1.json carries, nothing Codes-only. */
function toContract(record) {
    if (!isObject(record)) throw new Error('an attention record is an object');
    const doc = {
        id: String(record.id || ''),
        ticket_id: String(record.ticket_id || ''),
        question: String(record.question || ''),
        state: record.state,
        created_at: String(record.created_at || ''),
    };
    if (record.answer !== undefined) doc.answer = String(record.answer);
    return doc;
}

/** The attention.v1 shape, structurally: the required fields, the closed state list, the optional answer. */
function isValidContract(doc) {
    const errors = [];
    if (!isObject(doc)) return { valid: false, errors: ['an attention must be an object'] };
    for (const k of ['id', 'ticket_id', 'question', 'state', 'created_at']) {
        if (!isText(doc[k], k === 'question' ? MAX_TEXT : 500)) errors.push(`attention.${k} must be non-empty text`);
    }
    if (!STATES.includes(doc.state)) errors.push(`attention.state must be one of ${STATES.join(', ')}`);
    if (doc.answer !== undefined && !isText(doc.answer)) errors.push('attention.answer must be non-empty text when present');
    if (Number.isNaN(Date.parse(doc.created_at))) errors.push('attention.created_at must be a date-time');
    const allowed = ['id', 'ticket_id', 'question', 'state', 'created_at', 'answer'];
    for (const k of Object.keys(doc)) if (!allowed.includes(k)) errors.push(`attention.${k} is not an attention field`);
    return { valid: errors.length === 0, errors };
}

module.exports = {
    STATES,
    raise, answer, dismiss, isOpen, resumeSession, toContract, isValidContract,
};
