'use strict';
/**
 * A person's agent home (plan §AD.22, openvibe.home@1): kept here once, applied on any of their machines by a Codes job
 * of mode 'home' (bin/openvibe-codes.js homeJob → engine/home.js apply), in their sandbox there.
 *
 *   createHomes({ store })
 *     get(subject)                       → { spec, applied, updated_at } (a starting spec when they have none)
 *     save(subject, raw)                 → the checked spec, stored (throws 422 in words)
 *     applying(subject, device, jobId, { machine, name }) → notes the job that sets the home up on that machine
 *
 * The spec carries no secret: repositories are https addresses without credentials (readSpec refuses any), and the
 * credential for a private one comes with the job, from the machine's own token or the person's OpenVibe Git token.
 */
const home = require('../../engine/home');

/** What a person starts from: the agent they most likely have, nothing else assumed. */
const STARTER = Object.freeze({ format: home.FORMAT, workspace: 'work', tools: {}, agents: ['claude-code'], repos: [], git: null });

/** The stored form: repositories as they were given (owner/name or the address), so the page shows them back. */
function stored(raw) {
    const s = home.readSpec(raw);
    const given = (raw && typeof raw === 'object' ? raw.repos : JSON.parse(String(raw)).repos) || [];
    return { format: s.format, workspace: s.workspace, tools: s.tools, agents: s.agents, repos: given.map((r) => String(r).trim()), git: s.git };
}

function createHomes({ store }) {
    const db = store.db;
    async function get(subject) {
        const row = await db.maybe('SELECT spec, applied, updated_at FROM codes_homes WHERE subject = $1', [subject]);
        if (!row) return { spec: { ...STARTER }, applied: {}, updated_at: null, saved: false };
        return { spec: row.spec, applied: row.applied || {}, updated_at: row.updated_at, saved: true };
    }

    async function save(subject, raw) {
        const spec = stored(raw);
        await db.exec(`INSERT INTO codes_homes (subject, spec) VALUES ($1, $2::jsonb)
            ON CONFLICT (subject) DO UPDATE SET spec = EXCLUDED.spec, updated_at = now()`, [subject, JSON.stringify(spec)]);
        return spec;
    }

    async function applying(subject, device, jobId, { machine = null, name = null } = {}) {
        const entry = JSON.stringify({ [device]: { job: jobId, at: new Date().toISOString(), machine, name } });
        await db.exec('UPDATE codes_homes SET applied = applied || $2::jsonb WHERE subject = $1', [subject, entry]);
    }

    return { get, save, applying };
}

module.exports = { createHomes, STARTER };
