'use strict';

/**
 * One review's finding, in the shape of `agent.finding@1` (OpenVibe.Contracts).
 *
 * The verdict is the evidence bar, not the severity. A `confirmed` finding was reproduced or re-read and carries a
 * split severity (likelihood and impact, with `overall_severity` never above `impact`) and a confidence with its
 * reason. A `needs_validation` finding is an unprovable claim turned into a lead: a claimed root cause, the exact
 * blockers, a validation plan, and no severity at all — the honest middle between noise and a silent pass. A
 * `rejected` claim says why it does not stand.
 *
 *   findingId(file, text)            the stable identity: repository-relative file + normalised text
 *   validate(finding)                { valid, errors } against agent.finding@1 (all three branches)
 *   isLead(finding)                  a needs_validation finding
 *   severityRank(level)              0 informational … 4 critical
 *   FINDING_VERDICTS, LEVELS         the closed lists
 *
 * Codes is the producer of these records (the review, the hunt), so the rules are held here as data: a re-wrapped
 * finding keeps its id, and a claim without evidence cannot become a severity.
 */

const FINDING_VERDICTS = ['confirmed', 'needs_validation', 'rejected'];
const LEVELS = ['informational', 'low', 'medium', 'high', 'critical'];
const EVIDENCE_KINDS = ['source', 'command', 'response', 'screenshot', 'log', 'test'];
const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];
const MAX_TEXT = 4000;

/**
 * The stable identity of a finding: the repository-relative file and the whitespace-normalised, lowercased words.
 * Re-wrapping the same sentence keeps the id; a genuine rewording creates a new one (which is why the prior record
 * is fed back to the reviewer too, not only the id).
 *
 * @param {string} file a repository-relative path
 * @param {string} text the finding's body
 * @returns {string} the fingerprint, `file:normalised words`
 */
function findingId(file, text) {
    const f = String(file || '').trim().replace(/^\.\//, '').replace(/^\/+/, '');
    const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return `${f}:${t}`.slice(0, 200);
}

/** The rank of a severity level, for the "overall may not exceed impact" rule. */
function severityRank(level) {
    return LEVELS.indexOf(String(level || '').toLowerCase());
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max = MAX_TEXT) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isRelative = (p) => typeof p === 'string' && p.trim().length > 0 && p.length <= 500 && !p.startsWith('/') && !p.split('/').includes('..');
const unknownKeys = (v, allowed) => Object.keys(v || {}).filter((k) => !allowed.includes(k));

/** One location: a repository-relative file, an optional line and symbol. */
function checkLocation(loc, where, errors) {
    if (!isObject(loc)) { errors.push(`${where} must be an object`); return; }
    for (const k of unknownKeys(loc, ['file', 'line', 'symbol'])) errors.push(`${where}.${k} is not a location field`);
    if (!isRelative(loc.file)) errors.push(`${where}.file must be a repository-relative path`);
    if (loc.line !== undefined && (!Number.isInteger(loc.line) || loc.line < 1)) errors.push(`${where}.line must be an integer of at least 1`);
    if (loc.symbol !== undefined && !isText(loc.symbol, 200)) errors.push(`${where}.symbol must be a short non-empty string`);
}

/** One piece of evidence: what kind, what it shows, and the command/answer/location that shows it. */
function checkEvidence(ev, where, errors) {
    if (!isObject(ev)) { errors.push(`${where} must be an object`); return; }
    for (const k of unknownKeys(ev, ['kind', 'summary', 'location', 'command', 'output'])) errors.push(`${where}.${k} is not an evidence field`);
    if (!EVIDENCE_KINDS.includes(ev.kind)) errors.push(`${where}.kind must be one of ${EVIDENCE_KINDS.join(', ')}`);
    if (!isText(ev.summary, 1000)) errors.push(`${where}.summary must be a non-empty sentence`);
    if (ev.location !== undefined) checkLocation(ev.location, `${where}.location`, errors);
    if (ev.command !== undefined && !isText(ev.command, 2000)) errors.push(`${where}.command must be a non-empty command`);
    if (ev.output !== undefined && !isText(ev.output, MAX_TEXT)) errors.push(`${where}.output must be non-empty text`);
}

/** The split severity, with the rule the schema cannot state: overall_severity never exceeds impact. */
function checkSeverity(sev, errors) {
    if (!isObject(sev)) { errors.push('severity must be an object'); return; }
    for (const k of unknownKeys(sev, ['likelihood', 'impact', 'overall_severity'])) errors.push(`severity.${k} is not a severity field`);
    for (const k of ['likelihood', 'impact', 'overall_severity']) if (!LEVELS.includes(sev[k])) errors.push(`severity.${k} must be one of ${LEVELS.join(', ')}`);
    if (LEVELS.includes(sev.impact) && LEVELS.includes(sev.overall_severity) && severityRank(sev.overall_severity) > severityRank(sev.impact)) {
        errors.push('severity.overall_severity cannot exceed severity.impact (severity cannot exceed demonstrated impact)');
    }
}

function checkConfidence(conf, errors) {
    if (!isObject(conf)) { errors.push('confidence must be an object'); return; }
    for (const k of unknownKeys(conf, ['level', 'reason'])) errors.push(`confidence.${k} is not a confidence field`);
    if (!CONFIDENCE_LEVELS.includes(conf.level)) errors.push(`confidence.level must be one of ${CONFIDENCE_LEVELS.join(', ')}`);
    if (!isText(conf.reason, 1000)) errors.push('confidence.reason must say why');
}

function checkPlan(plan, errors) {
    if (!isObject(plan)) { errors.push('validation_plan must be an object'); return; }
    for (const k of unknownKeys(plan, ['local', 'deployment'])) errors.push(`validation_plan.${k} is not a plan field`);
    if (!isText(plan.local, 2000) && !isText(plan.deployment, 2000)) errors.push('validation_plan needs a local or a deployment step');
    for (const k of ['local', 'deployment']) if (plan[k] !== undefined && !isText(plan[k], 2000)) errors.push(`validation_plan.${k} must be non-empty text`);
}

/**
 * Validate one finding against `agent.finding@1`.
 *
 * @param {object} finding the record
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(finding) {
    const errors = [];
    if (!isObject(finding)) return { valid: false, errors: ['a finding must be an object'] };
    for (const k of unknownKeys(finding, [
        'verdict', 'fingerprint', 'title', 'description', 'trace', 'evidence',
        'severity', 'confidence', 'remediation', 'claimed_root_cause', 'blockers', 'validation_plan', 'reason',
    ])) errors.push(`${k} is not a finding field`);
    if (!FINDING_VERDICTS.includes(finding.verdict)) errors.push(`verdict must be one of ${FINDING_VERDICTS.join(', ')}`);
    if (!isText(finding.fingerprint, 200)) errors.push('fingerprint must be the stable file:normalised-text id');
    if (!isText(finding.title, 200)) errors.push('title must be non-empty');
    if (!isText(finding.description)) errors.push('description must be non-empty');
    if (!Array.isArray(finding.trace) || !finding.trace.length) errors.push('trace must name at least one location');
    else if (finding.trace.length > 50) errors.push('trace holds at most 50 locations');
    else finding.trace.forEach((loc, i) => checkLocation(loc, `trace[${i}]`, errors));
    if (!Array.isArray(finding.evidence) || !finding.evidence.length) errors.push('evidence must hold at least one record');
    else if (finding.evidence.length > 50) errors.push('evidence holds at most 50 records');
    else finding.evidence.forEach((ev, i) => checkEvidence(ev, `evidence[${i}]`, errors));
    if (finding.remediation !== undefined) {
        const r = finding.remediation;
        if (!isObject(r)) errors.push('remediation must be an object');
        else {
            for (const k of unknownKeys(r, ['strategy', 'code_changes'])) errors.push(`remediation.${k} is not a remediation field`);
            if (!isText(r.strategy, 2000)) errors.push('remediation.strategy must say what to change');
        }
    }
    if (finding.verdict === 'confirmed') {
        if (finding.severity === undefined) errors.push('a confirmed finding needs severity');
        else checkSeverity(finding.severity, errors);
        if (finding.confidence === undefined) errors.push('a confirmed finding needs confidence');
        else checkConfidence(finding.confidence, errors);
    } else if (finding.verdict === 'needs_validation') {
        if (finding.severity !== undefined) errors.push('a needs_validation lead carries no severity');
        if (!isText(finding.claimed_root_cause, 2000)) errors.push('a needs_validation lead needs claimed_root_cause');
        if (!Array.isArray(finding.blockers) || !finding.blockers.length) errors.push('a needs_validation lead needs at least one blocker');
        else if (finding.blockers.length > 20) errors.push('blockers holds at most 20 entries');
        else finding.blockers.forEach((b, i) => { if (!isText(b, 500)) errors.push(`blockers[${i}] must name one exact blocker`); });
        if (finding.validation_plan === undefined) errors.push('a needs_validation lead needs a validation_plan');
        else checkPlan(finding.validation_plan, errors);
    } else if (finding.verdict === 'rejected') {
        if (finding.severity !== undefined) errors.push('a rejected claim carries no severity');
        if (!isText(finding.reason, 2000)) errors.push('a rejected claim needs a reason');
    }
    return { valid: errors.length === 0, errors };
}

/** A needs_validation finding: the honest middle state. */
function isLead(finding) {
    return !!finding && finding.verdict === 'needs_validation';
}

module.exports = {
    FINDING_VERDICTS, LEVELS, EVIDENCE_KINDS, CONFIDENCE_LEVELS,
    findingId, severityRank, validate, isLead,
};
