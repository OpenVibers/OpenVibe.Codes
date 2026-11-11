'use strict';

/**
 * Where the repository field looks (ask 348, the owner 2026-11-10): Codes' answer for the dropdown in front of the
 * project field.
 *
 *   GET  /api/v1/me/repos?q=&limit=   → { sections: [{ id, label, items }], create }
 *   POST /api/v1/repos { name, private } → { url, label }
 *   GET/PUT /api/v1/admin/repo-sources → the owner's sources (server/http/admin-repos.js)
 *
 * The sources are rows in repo_picker_sources (migration 0034), merged in their position order. Each one is asked
 * with its own time limit: a source that fails, times out or answers nonsense is left out of the sections and the
 * person sees no error. The three built-ins:
 *
 *   recent   the person's last tasks' repositories, from Codes' own run_tasks (any host)
 *   git      their repositories on OpenVibe Git, through Codes' service token (server/domain/forge.js)
 *   github   their linked GitHub account when OpenVibe.Network gives Codes one; otherwise only an exact owner/name,
 *            public — no general GitHub search without a link
 *
 * A custom source (kind url) is the owner's https URL template with {q}. It is fetched through openvibe-shared/egress
 * (the estate's rule for a URL someone else chose): https only, public addresses only at every hop, no credentials in
 * the URL, a small cap on the answer. It answers { items: [...] } or { sections: [{ items }] }, with the same item
 * shape as ours: { label, url, host, private, updated_at, sub }.
 */
const { assertPublicUrl, safeLookup } = require('openvibe-shared/egress');
const { githubRepo } = require('./github');

const BUILTIN = new Set(['recent', 'git', 'github']);
const KINDS = new Set(['recent', 'git', 'github', 'url']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_SOURCES = 12;
const MAX_BODY = 256 * 1024;
const DEFAULT_LIMIT = 8;
const DEFAULT_TIMEOUT = 1500;

const DEFAULT_SOURCES = [
    { id: 'recent', kind: 'recent', label: 'Used here', enabled: true, position: 1, limit_n: DEFAULT_LIMIT, timeout_ms: DEFAULT_TIMEOUT, url_template: null },
    { id: 'git', kind: 'git', label: 'OpenVibe Git', enabled: true, position: 2, limit_n: DEFAULT_LIMIT, timeout_ms: DEFAULT_TIMEOUT, url_template: null },
    { id: 'github', kind: 'github', label: 'GitHub', enabled: true, position: 3, limit_n: DEFAULT_LIMIT, timeout_ms: DEFAULT_TIMEOUT, url_template: null },
];

/** owner/name, host and clone address for a repository URL (or null when it is not one). */
function partsOf(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    if (/^git@[^:]+:/.test(s)) s = `https://${s.slice(4).replace(':', '/')}`;
    else if (!/^https?:\/\//i.test(s)) {
        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s)) return null;
        s = `https://github.com/${s.replace(/\.git$/i, '')}`;
    }
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    const bits = u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
    if (bits.length !== 2) return null;
    const owner = bits[0];
    const name = bits[1];
    if (!NAME.test(owner) || !NAME.test(name)) return null;
    const host = u.hostname.toLowerCase();
    const clone = host === 'github.com' || host === 'git.openvibe.codes'
        ? `https://${host}/${owner}/${name}.git`
        : s;
    return { owner, name, label: `${owner}/${name}`, host, url: clone, web: `https://${host}/${owner}/${name}` };
}

/** The `create` block: an OpenVibe Git repository can be made when Codes can reach Git and the person has a username. */
function createBlock(config, viewer, forge) {
    const host = (config.git && config.git.publicUrl) ? String(config.git.publicUrl).replace(/\/+$/, '') : 'https://git.openvibe.codes';
    const hostName = (() => { try { return new URL(host).host.toLowerCase(); } catch { return 'git.openvibe.codes'; } })();
    return {
        allowed: Boolean(forge && forge.enabled && viewer && NAME.test(String(viewer.username || '')) && /^usr_/.test(String(viewer.subject || ''))),
        host: hostName,
        owner: String((viewer && viewer.username) || '').slice(0, 64) || null,
    };
}

function cleanLimit(value, fallback = DEFAULT_LIMIT) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(20, Math.max(1, Math.trunc(n))) : fallback;
}

function cleanTimeout(value, fallback = DEFAULT_TIMEOUT) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(5000, Math.max(100, Math.trunc(n))) : fallback;
}

/** The item shape the dropdown reads, with the source's own id prefix so two sources cannot collide. */
function item(source, x) {
    const p = partsOf(x && (x.url || x.full_name || x.html_url || x.clone_url));
    const url = String((x && (x.url || x.clone_url || x.html_url)) || (p && p.url) || '').trim();
    if (!url) return null;
    const parts = p || partsOf(url);
    if (!parts) return null;
    const label = String((x && (x.full_name || x.label)) || parts.label).trim().slice(0, 140);
    return {
        id: `${source.id}:${parts.label.toLowerCase()}`,
        label,
        url: parts.url,
        host: parts.host,
        private: x && x.private === true,
        updated_at: (x && (x.updated_at || x.pushed_at)) || null,
        sub: (x && x.sub) ? String(x.sub).slice(0, 120) : String((x && x.description) || '').slice(0, 120) || null,
    };
}

/** Sort rows newest first, keeping only the requested query and count. */
function filterItems(list, q, limit) {
    const asked = String(q || '').trim().toLowerCase();
    const seen = new Set();
    const out = [];
    for (const it of list) {
        if (!it) continue;
        const hay = `${it.label} ${it.url}`.toLowerCase();
        if (asked && !hay.includes(asked)) continue;
        const key = String(it.url || it.label).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(it);
        if (out.length >= limit) break;
    }
    return out;
}

async function within(promise, ms) {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('source timed out'), { code: 'source_timeout' })), ms); });
    if (timer.unref) timer.unref();
    try { return await Promise.race([promise, limit]); } finally { clearTimeout(timer); }
}

function createRepoPicker({ config, store, forge = null, github = null, log = console, fetchImpl = globalThis.fetch, fetchCustom = null, now = () => Date.now() }) {
    const db = store.db;
    const publicUrl = String((config.git && config.git.publicUrl) || 'https://git.openvibe.codes').replace(/\/+$/, '');

    // ── The owner's sources ─────────────────────────────────
    async function sources() {
        const rows = await db.many('SELECT * FROM repo_picker_sources ORDER BY position ASC, id ASC');
        return (rows.length ? rows : DEFAULT_SOURCES).map((r) => ({
            id: String(r.id), kind: String(r.kind), label: String(r.label || r.id), url_template: r.url_template || null,
            enabled: r.enabled !== false, position: Number(r.position) || 0, limit_n: cleanLimit(r.limit_n), timeout_ms: cleanTimeout(r.timeout_ms),
        }));
    }

    /** The sources a person's dropdown should read: on, and of a kind this service understands. */
    async function activeSources() {
        return (await sources()).filter((s) => s.enabled && KINDS.has(s.kind));
    }

    function validateSource(raw) {
        const id = String((raw && raw.id) || '').trim();
        const kind = String((raw && raw.kind) || '').trim();
        if (!KINDS.has(kind)) throw Object.assign(new Error('A source is recent, git, github or url.'), { status: 422 });
        if (kind !== 'url' && !BUILTIN.has(kind)) throw Object.assign(new Error(`Unknown source kind ${kind}.`), { status: 422 });
        if (id && !ID.test(id)) throw Object.assign(new Error('A source id uses letters, digits, dots, dashes or underscores.'), { status: 422 });
        const label = String((raw && raw.label) || '').trim().slice(0, 60);
        if (!label) throw Object.assign(new Error('Every source has a name.'), { status: 422 });
        const template = kind === 'url' ? String((raw && raw.url_template) || '').trim().slice(0, 500) : null;
        if (kind === 'url') {
            let u;
            try { u = new URL(template.replace(/\{q\}/g, 'x')); } catch { throw Object.assign(new Error('A custom source is an https URL with {q} where the search goes.'), { status: 422 }); }
            if (u.protocol !== 'https:') throw Object.assign(new Error('A custom source URL is https.'), { status: 422 });
            if (!template.includes('{q}')) throw Object.assign(new Error('A custom source URL needs {q} where the search goes.'), { status: 422 });
        }
        return {
            id: id || `src_${String(raw && raw.label || 'source').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
            kind, label, url_template: template,
            enabled: !(raw && raw.enabled === false),
            position: Number.isFinite(Number(raw && raw.position)) ? Math.trunc(Number(raw.position)) : 100,
            limit_n: cleanLimit(raw && raw.limit_n), timeout_ms: cleanTimeout(raw && raw.timeout_ms),
        };
    }

    /** Replace the owner's list: built-ins upserted in place, custom sources added, removed custom sources deleted. */
    async function saveSources(wanted, { subject = null } = {}) {
        if (!Array.isArray(wanted)) throw Object.assign(new Error('sources is a list.'), { status: 422 });
        if (wanted.length > MAX_SOURCES) throw Object.assign(new Error(`At most ${MAX_SOURCES} sources.`), { status: 422 });
        const rows = wanted.map(validateSource);
        const seen = new Set();
        for (const row of rows) {
            if (seen.has(row.id)) throw Object.assign(new Error(`Two sources share the id ${row.id}.`), { status: 422 });
            seen.add(row.id);
        }
        for (const kind of BUILTIN) {
            if (rows.filter((x) => x.kind === kind).length > 1) throw Object.assign(new Error(`The ${kind} source is listed twice.`), { status: 422 });
        }
        if (!rows.some((x) => x.kind === 'recent')) throw Object.assign(new Error('The recent source stays: it is the person\'s own history.'), { status: 422 });
        await store.tx(async () => {
            const before = await db.many('SELECT id, kind FROM repo_picker_sources');
            const byId = new Map(before.map((r) => [String(r.id), r]));
            const keep = new Set(rows.map((r) => r.id));
            for (const row of rows) {
                const builtin = BUILTIN.has(row.kind) ? row.kind : null;
                if (builtin && byId.has(builtin)) row.id = builtin;
                if (byId.has(row.id)) {
                    await db.exec(
                        'UPDATE repo_picker_sources SET kind = $2, label = $3, url_template = $4, enabled = $5, position = $6, limit_n = $7, timeout_ms = $8, updated_at = now(), updated_by = $9 WHERE id = $1',
                        [row.id, row.kind, row.label, row.url_template, row.enabled, row.position, row.limit_n, row.timeout_ms, subject],
                    );
                } else {
                    await db.exec(
                        'INSERT INTO repo_picker_sources (id, kind, label, url_template, enabled, position, limit_n, timeout_ms, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                        [row.id, row.kind, row.label, row.url_template, row.enabled, row.position, row.limit_n, row.timeout_ms, subject],
                    );
                }
            }
            for (const row of before) {
                if (!keep.has(String(row.id)) && row.kind === 'url') await db.exec('DELETE FROM repo_picker_sources WHERE id = $1', [String(row.id)]);
            }
        });
        return sources();
    }

    // ── The sources ─────────────────────────────────────────
    async function recentSource(source, { subject, q, limit }) {
        const asked = String(q || '').trim();
        const rows = await db.many(
            `SELECT repo, max(created_at) AS at FROM run_tasks
             WHERE subject = $1 AND repo LIKE 'https://%' AND ($2 = '' OR repo ILIKE '%' || $2 || '%')
             GROUP BY repo ORDER BY at DESC LIMIT 60`,
            [subject, asked],
        );
        return filterItems(rows.map((r) => {
            const it = item(source, { url: r.repo, updated_at: new Date(Number(r.at) || Date.now()).toISOString() });
            return it;
        }), q, limit);
    }

    async function gitSource(source, { subject, username, q, limit }) {
        if (!forge || !forge.enabled || !username) return [];
        const out = await forge.repos({ subject, username }, { timeoutMs: source.timeout_ms });
        return filterItems((out || []).map((x) => item(source, {
            full_name: x.full_name, url: `${publicUrl}/${String(x.full_name).replace(/^\//, '')}.git`,
            private: x.private, updated_at: x.updated_at, description: x.description,
        })), q, limit);
    }

    async function githubSource(source, { viewer, q, limit }) {
        if (!github) return [];
        const linked = (viewer && (viewer.githubLogin || viewer.github_login)) || null;
        if (linked && /^[A-Za-z0-9-]{1,39}$/.test(String(linked))) {
            const out = await github.userRepos(String(linked), q, { limit, timeoutMs: source.timeout_ms });
            return filterItems((out || []).map((x) => item(source, x)), q, limit);
        }
        // No linked account: only an exact owner/name, public, and only when the person names it.
        const exact = exactRepo(q);
        if (!exact) return [];
        const out = await github.publicRepo(exact.owner, exact.name, { timeoutMs: source.timeout_ms });
        return out ? [item(source, out)].filter(Boolean) : [];
    }

    async function customSource(source, { q, limit }) {
        const template = String(source.url_template || '');
        if (!template.includes('{q}')) return [];
        const url = template.replace(/\{q\}/g, encodeURIComponent(String(q || '').trim().slice(0, 100)));
        const doc = fetchCustom
            ? await fetchCustom(url, source.timeout_ms)
            : await fetchThroughEgress(url, source.timeout_ms);
        const items = [];
        if (doc && Array.isArray(doc.items)) items.push(...doc.items);
        if (doc && Array.isArray(doc.sections)) for (const sec of doc.sections) if (sec && Array.isArray(sec.items)) items.push(...sec.items);
        return filterItems(items.map((x) => item(source, x)), q, limit).map((x) => ({ ...x, sub: x.sub || `${new URL(template.replace(/\{q\}/g, 'x')).host}` }));
    }

    /** Ask every enabled source at once, each under its own time limit; a failure is that source's absence. */
    async function sections({ viewer, q, limit }) {
        const list = await activeSources();
        const jobs = list.map(async (source) => {
            const ctx = { subject: viewer.subject, username: viewer.username, viewer, q, limit: Math.min(limit, source.limit_n) };
            let items = [];
            try {
                if (source.kind === 'recent') items = await within(recentSource(source, ctx), source.timeout_ms);
                else if (source.kind === 'git') items = await within(gitSource(source, ctx), source.timeout_ms);
                else if (source.kind === 'github') items = await within(githubSource(source, ctx), source.timeout_ms);
                else if (source.kind === 'url') items = await within(customSource(source, ctx), source.timeout_ms);
            } catch (e) {
                log.warn(`[Codes] repository source ${source.id} left out: ${String((e && e.message) || e).slice(0, 160)}`);
                items = [];
            }
            return items.length ? { id: source.id, label: source.label, items } : null;
        });
        const out = await Promise.all(jobs);
        return out.filter(Boolean);
    }

    return { sources, activeSources, saveSources, sections, validateSource, create: (viewer) => createBlock(config, viewer, forge) };
}

/** `owner/name` (or a GitHub URL) when the query names a repository exactly, else null. */
function exactRepo(q) {
    const raw = String(q || '').trim();
    if (!raw) return null;
    const g = githubRepo(raw);
    if (g) return { owner: g.owner, name: g.name };
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(raw.replace(/\.git$/i, ''));
    return m ? { owner: m[1], name: m[2] } : null;
}

/** A small GET through the estate's egress rule: https, public only at each hop, no credentials, a capped body. */
function fetchThroughEgress(url, timeoutMs) {
    const https = require('node:https');
    const MAX_HOPS = 2;
    const get = (target, hops) => new Promise((resolve, reject) => {
        assertPublicUrl(target, { protocols: ['https:'] }).then((u) => {
            const req = https.request(u, {
                method: 'GET', lookup: safeLookup, timeout: timeoutMs,
                headers: { Accept: 'application/json', 'User-Agent': 'openvibe-codes' },
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < MAX_HOPS) {
                    res.resume();
                    const next = new URL(res.headers.location, u).href;
                    return get(next, hops + 1).then(resolve, reject);
                }
                if (res.statusCode !== 200) { res.resume(); return reject(Object.assign(new Error(`source answered ${res.statusCode}`), { status: 502 })); }
                let size = 0;
                const chunks = [];
                res.on('data', (c) => {
                    size += c.length;
                    if (size > MAX_BODY) { req.destroy(Object.assign(new Error('source answer too large'), { code: 'source_too_large' })); return; }
                    chunks.push(c);
                });
                res.on('end', () => {
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('source answer is not JSON'), { status: 502 })); }
                });
            });
            req.on('timeout', () => req.destroy(Object.assign(new Error('source timed out'), { code: 'source_timeout' })));
            req.on('error', reject);
            req.end();
        }, reject);
    });
    return get(url, 0);
}

module.exports = { createRepoPicker, partsOf, exactRepo, fetchThroughEgress, cleanLimit, cleanTimeout, DEFAULT_SOURCES, MAX_SOURCES };
