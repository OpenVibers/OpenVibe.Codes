'use strict';

/**
 * Generated documentation (roadmap §30.5: contract → generated docs → published package version).
 *
 * Built ONCE at boot from the packages this release pins — openvibe-contracts (catalog, JSON
 * schemas, fixtures, capability and service manifests, ADRs) and openvibe-sdk (its .d.ts files) —
 * so every page says exactly which versions it was generated from and nothing is hand-written that
 * could drift. Upgrading a pin and restarting regenerates everything.
 */
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const contractsRegistry = require('openvibe-contracts/lib/registry');
const { parseDts } = require('./dts');

const CONTRACTS_ROOT = path.dirname(require.resolve('openvibe-contracts/package.json'));
const SDK_ROOT = path.dirname(require.resolve('openvibe-sdk/package.json'));
const contractsPkg = require('openvibe-contracts/package.json');
const sdkPkg = require('openvibe-sdk/package.json');

/** Visibilities an app may ever be granted (Network's grantability rule, ADR-014). */
const GRANTABLE_VISIBILITIES = new Set(['public', 'partner']);

function readJsonDir(dir) {
    try {
        return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
            .map((f) => ({ name: f.replace(/\.json$/, ''), body: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
    } catch { return []; }
}

/** Absolute $id for a $ref relative to the schema that holds it. */
function resolveRef(ref, baseId) {
    try { return new URL(ref, baseId).toString(); } catch { return ref; }
}

function typeOf(s) {
    if (!s || typeof s !== 'object') return 'any';
    if (s.$ref) return 'ref';
    if (s.const !== undefined) return 'const';
    if (s.enum) return 'enum';
    if (Array.isArray(s.type)) return s.type.join(' | ');
    if (s.type) return s.type;
    if (s.oneOf || s.anyOf) return 'one of';
    return 'any';
}

function constraintsOf(s) {
    const out = [];
    if (!s || typeof s !== 'object') return out;
    if (s.enum) out.push(`one of ${s.enum.map((v) => JSON.stringify(v)).join(', ')}`);
    if (s.const !== undefined) out.push(`= ${JSON.stringify(s.const)}`);
    if (s.pattern) out.push(`pattern ${s.pattern}`);
    if (s.format) out.push(`format ${s.format}`);
    for (const k of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) if (s[k] !== undefined) out.push(`${k} ${s[k]}`);
    if (s.uniqueItems) out.push('unique items');
    if (s.default !== undefined) out.push(`default ${JSON.stringify(s.default)}`);
    if (s.additionalProperties === false && s.type === 'object') out.push('no other fields');
    return out;
}

/** Rows { path, type, required, description, constraints, ref } for a schema, nested with dotted paths. */
function fieldRows(schema, baseId, prefix = '', depth = 0) {
    const rows = [];
    if (!schema || typeof schema !== 'object' || depth > 6) return rows;
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    for (const [name, s] of Object.entries(props)) {
        const p = prefix ? `${prefix}.${name}` : name;
        const item = s && s.type === 'array' && s.items ? s.items : null;
        rows.push({
            path: p,
            type: item ? `array of ${typeOf(item)}` : typeOf(s),
            required: required.has(name),
            description: (s && s.description) || '',
            constraints: [...constraintsOf(s), ...(item ? constraintsOf(item).map((c) => `items: ${c}`) : [])],
            ref: s && s.$ref ? resolveRef(s.$ref, baseId) : (item && item.$ref ? resolveRef(item.$ref, baseId) : null),
        });
        if (s && s.type === 'object' && s.properties) rows.push(...fieldRows(s, baseId, p, depth + 1));
        if (item && item.type === 'object' && item.properties) rows.push(...fieldRows(item, baseId, `${p}[]`, depth + 1));
    }
    return rows;
}

function adrIndex() {
    const dir = path.join(CONTRACTS_ROOT, 'docs', 'adr');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /^ADR-\d+.*\.md$/.test(f)).sort(); } catch { return []; }
    return files.map((f) => {
        const markdown = fs.readFileSync(path.join(dir, f), 'utf8');
        const title = (markdown.match(/^#\s+(.+)$/m) || [null, f])[1].trim();
        const status = (markdown.match(/^\*\*Status:\*\*\s*(.+)$/m) || [null, ''])[1].trim();
        const id = (f.match(/^(ADR-\d+)/) || [null, f])[1];
        return { id, file: f, title, status, markdown };
    });
}

function sdkModules() {
    const exp = sdkPkg.exports || {};
    const out = [];
    for (const [subpath, target] of Object.entries(exp)) {
        if (!target || typeof target !== 'object' || !target.types) continue;
        const file = path.join(SDK_ROOT, target.types);
        let source = '';
        try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const name = subpath === '.' ? 'openvibe-sdk' : `openvibe-sdk/${subpath.replace(/^\.\//, '')}`;
        out.push({
            slug: subpath === '.' ? 'index' : subpath.replace(/^\.\//, '').replace(/\//g, '-'),
            name,
            typesFile: target.types.replace(/^\.\//, ''),
            browser: target.browser === null ? 'server only' : (target.browser ? 'browser build available' : 'both'),
            declarations: parseDts(source),
        });
    }
    // contracts.d.ts is re-exported by core; document it too.
    const extra = path.join(SDK_ROOT, 'types', 'contracts.d.ts');
    if (fs.existsSync(extra)) out.push({ slug: 'contracts-types', name: 'openvibe-sdk (contract types)', typesFile: 'types/contracts.d.ts', browser: 'types only', declarations: parseDts(fs.readFileSync(extra, 'utf8')) });
    return out;
}

function generate({ now = () => Date.now() } = {}) {
    const deprecations = new Map((contractsRegistry.deprecations || []).map((d) => [d.id, d]));
    const byDollarId = new Map();
    const contractList = contracts.catalog.map((entry) => {
        const schema = contracts.schema(entry.id);
        byDollarId.set(schema.$id, entry.id);
        const fixtures = {
            valid: readJsonDir(path.join(CONTRACTS_ROOT, 'fixtures', entry.id, 'valid')),
            invalid: readJsonDir(path.join(CONTRACTS_ROOT, 'fixtures', entry.id, 'invalid')),
        };
        return {
            ...entry, $id: schema.$id, title: schema.title || entry.id, description: schema.description || '', schema,
            fields: fieldRows(schema, schema.$id), fixtures, deprecation: deprecations.get(entry.id) || null,
        };
    });
    for (const c of contractList) for (const f of c.fields) f.refId = f.ref ? (byDollarId.get(f.ref) || null) : null;

    const capabilities = contracts.capabilities.manifests.map((c) => ({
        ...c, grantable: GRANTABLE_VISIBILITIES.has(c.visibility) && c.status === 'active',
    }));

    const events = new Map();
    for (const m of contracts.services.manifests) {
        for (const t of m.eventsProduced || []) {
            if (!events.has(t)) events.set(t, { type: t, producers: [], consumers: [] });
            events.get(t).producers.push(m.id);
        }
    }
    for (const m of contracts.services.manifests) {
        for (const t of m.eventsConsumed || []) {
            for (const [type, e] of events) {
                const pattern = String(t);
                const hit = pattern === type || (pattern.endsWith('*') && type.startsWith(pattern.slice(0, -1)));
                if (hit && !e.consumers.includes(m.id)) e.consumers.push(m.id);
            }
        }
    }

    return {
        generatedAt: new Date(now()).toISOString(),
        contractsVersion: contractsPkg.version,
        contractsLicense: contractsPkg.license,
        sdkVersion: sdkPkg.version,
        sdkLicense: sdkPkg.license,
        sdkContractsRange: (() => { try { return require('openvibe-sdk/core').CONTRACTS_RANGE; } catch { return null; } })(),
        contracts: contractList,
        contract: (id) => contractList.find((c) => c.id === id) || null,
        capabilities,
        capability: (id) => capabilities.find((c) => c.id === id) || null,
        services: contracts.services.manifests,
        events: [...events.values()].sort((a, b) => a.type.localeCompare(b.type)),
        eventTypes: new Set(events.keys()),
        sdk: sdkModules(),
        adrs: adrIndex(),
    };
}

module.exports = { generate, fieldRows, GRANTABLE_VISIBILITIES, CONTRACTS_ROOT, SDK_ROOT };
