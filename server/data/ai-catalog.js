'use strict';

/**
 * OpenVibe.AI's model catalog, as Codes reads it (AI Exchange P4, GET /v1/models with ai.model@1 entries).
 *
 * The catalog is only used while CODES_AI_CATALOG is on and OpenVibe.AI's own AI_MODEL_CATALOG answers more than the
 * legacy single `openvibe` model. A failure, a flag off, or the legacy answer returns null: the pickers then keep the
 * one OpenVibe.AI entry they have always had.
 *
 *   parseCatalog(body)        GET /v1/models → { aliases, models, entries } or null
 *   catalogChoices(catalog)   the entries a picker offers: the dynamic aliases first, then the exact ids
 *   usdPerMillion(nano)       integer nano-USD per million tokens → dollars, exactly, never a float
 *
 * Every fact here comes from the response. A price is the retail output rate in integer nano-USD strings (D1); an
 * availability is AI's own word. An alias has no single price (the router picks the model per request), so its entry
 * says that rather than inventing a number.
 */

const NANO = 1_000_000_000n;
/** An exact id: <org>/<model>[:<quant>]@<revision> (D3). */
const EXACT_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?@[A-Za-z0-9._-]+$/;
/** The dynamic policy aliases, in the order a picker offers them; legacy `openvibe` last. */
const ALIASES = ['openvibe/auto', 'openvibe/economy', 'openvibe/balanced', 'openvibe/fast', 'openvibe/private', 'openvibe'];
const AVAILABILITY = {
    available: { state: 'ok', badge: 'Available' },
    limited: { state: 'warn', badge: 'Limited' },
    degraded: { state: 'warn', badge: 'Degraded' },
    deprecated: { state: 'warn', badge: 'Deprecated' },
    unavailable: { state: 'bad', badge: 'Unavailable' },
    planned: { state: 'off', badge: 'Planned' },
    pending_agreement: { state: 'off', badge: 'Pending agreement' },
    byok_only: { state: 'warn', badge: 'With your own key' },
};

/**
 * Integer nano-USD per million tokens as dollars per million tokens, exactly: "1500000000" → "1.50",
 * "123456789" → "0.123456789". Trailing zeros are dropped, but a money amount keeps at least two decimals.
 * Null when the value is not a non-negative integer.
 */
function usdPerMillion(nano) {
    const s = String(nano == null ? '' : nano).trim();
    if (!/^\d{1,19}$/.test(s)) return null;
    const n = BigInt(s);
    const whole = n / NANO;
    let frac = (n % NANO).toString().padStart(9, '0').replace(/0+$/, '');
    if (frac && frac.length < 2) frac = frac.padEnd(2, '0');
    return frac ? `${whole}.${frac}` : `${whole}.00`;
}

/** The availability of a catalog entry as a picker's state, badge and words. */
function availabilityOf(entry) {
    const value = String((entry && entry.availability) || 'available');
    return AVAILABILITY[value] || { state: 'off', badge: value };
}

/** The retail output rate of one entry in integer nano-USD per million tokens, from either catalog shape. */
function outputNano(entry) {
    const flat = entry && entry.retail_rate && entry.retail_rate.output_nano_usd_per_m;
    if (flat != null) return flat;
    const nested = entry && entry.retail && entry.retail.nano_usd_per_m && entry.retail.nano_usd_per_m.output;
    return nested == null ? null : nested;
}

/** The retail price of one entry, as data-desc's words: the output rate per million tokens. */
function priceDesc(entry) {
    const usd = usdPerMillion(outputNano(entry));
    return usd == null ? null : `$${usd} per million output tokens`;
}

/** One alias as a picker entry: always dynamic, never a price of its own. */
function aliasEntry(alias) {
    const name = String(alias.name || alias.id).trim() || alias.id;
    const policy = alias.policy ? String(alias.policy) : null;
    const avail = availabilityOf(alias);
    return {
        id: String(alias.id),
        dynamic: true,
        name: `${name} (dynamic)`,
        description: alias.description || null,
        policy,
        state: avail.state,
        badge: 'Dynamic',
        efforts: Array.isArray(alias.efforts) ? alias.efforts.filter((effort) => ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) : null,
        desc: `Dynamic: ${alias.description || 'the router picks the model for each request'} Its price is what the chosen model's retail rate says.`,
    };
}

/** One exact model as a picker entry: its id, its availability and its output price. */
function modelEntry(model) {
    const avail = availabilityOf(model);
    const price = priceDesc(model);
    return {
        id: String(model.id),
        dynamic: false,
        // The exact id is what a person offers and what is sent: show it, with AI's display name beside it.
        name: String(model.id),
        display_name: model.display_name || model.name || null,
        family: model.family || null,
        revision: model.revision || null,
        quant: model.quant || null,
        availability: model.availability || null,
        state: avail.state,
        badge: avail.badge,
        output_nano_usd_per_m: outputNano(model) == null ? null : String(outputNano(model)),
        efforts: Array.isArray(model.efforts) ? model.efforts.filter((effort) => ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) : null,
        desc: price || 'No published price',
    };
}

/**
 * GET /v1/models as the parts a picker needs. Null when the answer is not a catalog: a failure, no entries, or the
 * legacy single `openvibe` model (AI_MODEL_CATALOG off), which is today's one entry and stays today's.
 */
function parseCatalog(body) {
    const data = body && Array.isArray(body.data) ? body.data : null;
    if (!data || !data.length) return null;
    if (data.length === 1 && data[0] && data[0].id === 'openvibe') return null;
    const aliases = [];
    const models = [];
    for (const entry of data) {
        if (!entry || typeof entry !== 'object') continue;
        const id = String(entry.id || '').trim();
        if (!id) continue;
        if (entry.dynamic === true || ALIASES.includes(id)) aliases.push(aliasEntry({ ...entry, id }));
        else if (EXACT_ID.test(id)) models.push(modelEntry({ ...entry, id }));
        // A row without an exact id is listed by AI but cannot be asked for by id: it is not offered here.
    }
    if (!aliases.length && !models.length) return null;
    const order = (a, b) => {
        const ai = ALIASES.indexOf(a.id);
        const bi = ALIASES.indexOf(b.id);
        return (ai < 0 ? ALIASES.length : ai) - (bi < 0 ? ALIASES.length : bi);
    };
    aliases.sort(order);
    return {
        aliases: aliases.map((a) => a.id),
        models: models.map((m) => m.id),
        entries: [...aliases, ...models],   // the picker's order: every alias before every exact id
    };
}

/** The catalog's entries (aliases first) for a picker; [] when there is no catalog. */
function catalogChoices(catalog) {
    return catalog && Array.isArray(catalog.entries) ? catalog.entries : [];
}

module.exports = { NANO, EXACT_ID, ALIASES, AVAILABILITY, parseCatalog, catalogChoices, usdPerMillion, outputNano, priceDesc, availabilityOf };
