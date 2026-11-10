'use strict';
// The agent.finding@1 shape: one review finding, the evidence bar of each verdict, and the stable id.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const finding = require('../engine/finding');

const base = (over = {}) => ({
    verdict: 'confirmed',
    fingerprint: 'server/x.js:the cache never expires',
    title: 'The cache never expires',
    description: 'The entry has no TTL.',
    trace: [{ file: 'server/x.js', line: 31, symbol: 'put' }],
    evidence: [{ kind: 'source', summary: 'The options object has no ttl.' }],
    severity: { likelihood: 'low', impact: 'high', overall_severity: 'high' },
    confidence: { level: 'high', reason: 'Read in the source.' },
    ...over,
});

const invalid = (f) => {
    const r = finding.validate(f);
    assert.equal(r.valid, false, `expected invalid: ${JSON.stringify(f.verdict)}`);
    return r.errors.join('; ');
};

(async () => {
    await check('a confirmed finding needs the split severity, a confidence and evidence', () => {
        assert.deepEqual(finding.validate(base()), { valid: true, errors: [] });
        assert.match(invalid(base({ severity: undefined })), /confirmed finding needs severity/);
        assert.match(invalid(base({ confidence: undefined })), /confirmed finding needs confidence/);
        assert.match(invalid(base({ evidence: [] })), /evidence must hold at least one record/);
        assert.match(invalid(base({ severity: { likelihood: 'low', impact: 'low', overall_severity: 'critical' } })), /cannot exceed severity\.impact/);
    });

    await check('a needs_validation lead is exact, has no severity and is never a silent pass', () => {
        const lead = {
            verdict: 'needs_validation', fingerprint: 'server/billing.js:the retry may debit twice',
            title: 'A retried debit may charge twice', description: 'The retry does not read the receipt.',
            trace: [{ file: 'server/billing.js', line: 118 }], evidence: [{ kind: 'source', summary: 'The retry calls debit().' }],
            claimed_root_cause: 'The idempotency key is not reused.', blockers: ['The provider sandbox credential is not here.'],
            validation_plan: { local: 'Post a retried payment to the sandbox and read the ledger.' },
        };
        assert.deepEqual(finding.validate(lead), { valid: true, errors: [] });
        assert.equal(finding.isLead(lead), true);
        assert.match(invalid({ ...lead, severity: { likelihood: 'low', impact: 'low', overall_severity: 'low' } }), /carries no severity/);
        assert.match(invalid({ ...lead, blockers: [] }), /at least one blocker/);
        assert.match(invalid({ ...lead, validation_plan: {} }), /local or a deployment step/);
    });

    await check('a rejected claim says why; unknown fields and unsafe paths are refused', () => {
        const rejected = {
            verdict: 'rejected', fingerprint: 'server/cache.js:the cache never expires', title: 'The cache never expires',
            description: 'The review missed the TTL.', trace: [{ file: 'server/cache.js', line: 31 }],
            evidence: [{ kind: 'source', summary: 'The TTL is passed on line 34.' }], reason: 'Line 34 sets the TTL.',
        };
        assert.deepEqual(finding.validate(rejected), { valid: true, errors: [] });
        assert.match(invalid({ ...rejected, reason: undefined }), /rejected claim needs a reason/);
        assert.match(invalid(base({ surprise: true })), /surprise is not a finding field/);
        assert.match(invalid(base({ trace: [{ file: '/etc/passwd' }] })), /repository-relative/);
        assert.match(invalid(base({ trace: [{ file: '../outside' }] })), /repository-relative/);
    });

    await check('the identity survives re-wrapping and lowercasing, not a rewording', () => {
        assert.equal(finding.findingId('./server/x.js', 'The  cache\nNEVER expires'), 'server/x.js:the cache never expires');
        assert.equal(finding.findingId('server/x.js', 'the cache never expires '), finding.findingId('server/x.js', 'The cache never expires'));
        assert.notEqual(finding.findingId('server/x.js', 'the cache expires slowly'), finding.findingId('server/x.js', 'the cache never expires'));
    });

    await check('the published transcript schema carries the same three verdicts', () => {
        const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'engine', 'transcript.schema.json'), 'utf8'));
        assert.deepEqual(schema.properties.findings.items.$ref, '#/$defs/finding');
        assert.deepEqual(schema.$defs.finding.properties.verdict.enum, ['confirmed', 'needs_validation', 'rejected']);
        assert.equal(schema.$defs.finding.properties.severity.type, 'object');
        assert.ok(schema.$defs.finding.allOf.some((r) => r.then && r.then.not), 'a lead and a rejection exclude severity');
        assert.ok(schema.$defs.finding.properties.validation_plan, 'a lead has its plan');
    });
    done();
})();
