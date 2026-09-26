'use strict';

/**
 * The full project archive (roadmap WS-N task 9): one zip with everything the project holds on the
 * platform, for its owner or an admin. Built when asked, sent once, never stored.
 *
 *   manifest.json                what each part holds: counts, limits reached, file sizes and hashes
 *   README.txt                   the same in words, and how to fetch the objects before the URLs expire
 *   project.json                 the metadata document (project-export.js): Network's project, members,
 *                                apps, credentials by id and hint, grants, quotas and audit; Codes'
 *                                releases, trust tiers and playground runs. This is the configuration.
 *   modules/<release_id>.json    each release's manifest (codes.app-manifest@1 or mods.mod-manifest@1)
 *                                exactly as validated: the project's app and mod modules
 *   media/<env>/namespaces.json  Media's namespaces for the project: policy, quotas, usage
 *   media/<env>/objects.jsonl    every object Media holds for the project (soft-deleted ones too),
 *                                with `download`: its public URL, or a signed URL valid urlTtlS
 *   events/<env>.jsonl           the project's app events (app.<project_key>.*) Events still keeps,
 *                                one { seq, event } per line
 *
 * Objects are listed with download URLs rather than copied into the zip: a project may hold a GiB
 * or more, and Codes stays out of the byte path. Media signs private and sandbox URLs for at most
 * an hour; public production objects keep their permanent URL.
 *
 * Authorization: for each audience (openvibe.media, openvibe.events) and environment, Network mints
 * a 5-minute read-only export token for the signed-in person (`mintToken`, with their own Network
 * token; Network allows only the owner and admins). A long export asks again a minute before one
 * expires. No app secret is involved, and no token is written to the archive or the logs.
 *
 * Failure: a service that fails (an error, a refusal, no answer) fails the whole export with an
 * ArchiveError naming the service, the part and the environment; a partial archive is never sent as
 * if it were complete. A size limit is not a failure: the part says `complete: false`, how many it
 * holds and where it stopped, and manifest.json's top-level `complete` is false.
 */
const crypto = require('crypto');
const { createClient, isOpenVibeError } = require('openvibe-sdk/core');
const { zip } = require('./zip');

const FORMAT = 'openvibe.codes.project-archive';
const FORMAT_VERSION = 1;
const ENVS = ['production', 'sandbox'];
const OBJECT_PAGE = 200;          // Media's largest list page
const EVENT_PAGE = 1000;          // Events' largest pull page
const MAX_EVENT_PAGES = 10000;    // a guard; each pull scans up to 5,000 rows of the project's topic
const REMINT_BEFORE_MS = 60 * 1000;
const DOWNLOAD_CONCURRENCY = 8;
const SERVICES = { media: 'OpenVibe.Media', events: 'OpenVibe.Events' };

const NOT_INCLUDED = Object.freeze([
    { what: 'Tools job results', why: 'OpenVibe.Tools keeps them in its own Media tenant (tools.app.<project_id>), readable only by Tools; fetch each result from the Tools job API with the app\'s own token.' },
    { what: 'Events webhook subscriptions', why: 'they belong to each app (listing them needs events.app.subscribe) and carry signing secrets; list them with the app\'s own token.' },
    { what: 'Network user modules', why: 'they are per person, not per project; each member exports their own from OpenVibe.Network (GET /api/modules).' },
    { what: 'Client secrets and tokens', why: 'never exported: Network lists credentials by id and last four characters only.' },
]);

/** A service that failed during the export. `problem` is what the portal shows. */
class ArchiveError extends Error {
    constructor({ service, part, env, status, code, detail, requestId }) {
        const name = SERVICES[service] || service;
        const answered = status ? `answered ${status}${code ? ` (${code})` : ''}` : `did not answer${code ? ` (${code})` : ''}`;
        super(`${name} ${answered} for ${part} (${env})`);
        this.problem = {
            status: 502, code: 'codes.export_failed', requestId: requestId || null,
            detail: `${name} ${answered} while exporting ${part} (${env})${detail ? `: ${detail}` : ''}. Nothing was exported: an archive is never sent with a part missing.`,
        };
    }
}

const projectKey = (projectId) => `p${String(projectId).replace(/^prj_/, '').toLowerCase()}`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

/** Run `fn` over `items`, `n` at a time; the first failure rejects (the rest are not started). */
async function pool(items, n, fn) {
    let next = 0;
    let failed = null;
    const worker = async () => {
        while (!failed && next < items.length) {
            const item = items[next++];
            try { await fn(item); } catch (err) { failed = failed || err; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    if (failed) throw failed;
}

function createArchiver({ config, fetchImpl, log = console }) {
    const opts = config.export;
    const client = createClient({
        network: config.networkInternalUrl, autoDiscover: false, retries: 1, timeoutMs: 15000, deadlineMs: 30000,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        onWarning: (m) => log.warn('[Codes] sdk:', m),
    });

    /** A token source for one audience and environment: minted on first use and again before it expires. */
    function tokenSource(mintToken, audience, env) {
        let current = null;
        return async () => {
            if (!current || Date.parse(current.expires_at) - Date.now() < REMINT_BEFORE_MS) current = await mintToken(audience, env);
            return current.access_token;
        };
    }

    /**
     * GET one JSON document from Media or Events; any failure there becomes an ArchiveError. The
     * token comes first and outside: Network refusing it is Network's answer, not the service's.
     */
    async function get(service, part, env, token, path, query) {
        const baseUrl = service === 'media' ? opts.mediaUrl : opts.eventsUrl;
        const bearer = await token();
        try {
            return (await client.json({ baseUrl, path, query, token: bearer })) || {};
        } catch (err) {
            if (err instanceof ArchiveError || !isOpenVibeError(err)) throw err;
            const unreachable = !err.status || String(err.code || '').startsWith('sdk.');
            throw new ArchiveError({
                service, part, env, status: unreachable ? null : err.status, code: err.code,
                detail: unreachable ? '' : String(err.detail || err.title || '').slice(0, 300), requestId: err.requestId,
            });
        }
    }

    async function mediaPart(project, env, token) {
        const base = `/api/v2/${encodeURIComponent(project.id)}`;
        const ns = await get('media', 'namespaces', env, token, `${base}/namespaces`);
        const objects = [];
        let cursor = null;
        for (;;) {
            const page = await get('media', 'objects', env, token, `${base}/objects`, { limit: OBJECT_PAGE, include_deleted: 1, ...(cursor ? { cursor } : {}) });
            objects.push(...(page.objects || []));
            cursor = page.next_cursor || null;
            if (!cursor || objects.length >= opts.maxObjects) break;
        }
        const complete = !cursor && objects.length <= opts.maxObjects;
        objects.length = Math.min(objects.length, opts.maxObjects);

        const counts = { public: 0, signed: 0, none: 0 };
        const toSign = [];
        for (const o of objects) {
            if (o.lifecycle_status === 'ready' && o.public_url) { o.download = { url: o.public_url, expires_at: null, public: true }; counts.public++; }
            else if (o.lifecycle_status === 'ready') toSign.push(o);
            else { o.download = null; counts.none++; }
        }
        await pool(toSign, DOWNLOAD_CONCURRENCY, async (o) => {
            const d = await get('media', 'download URLs', env, token, `${base}/objects/${encodeURIComponent(o.id)}/download`, { format: 'json', ttl: opts.urlTtlS });
            o.download = { url: d.url, expires_at: d.expires_at || null, public: Boolean(d.public) };
            if (d.public) counts.public++; else counts.signed++;
        });
        const expiries = objects.map((o) => o.download && o.download.expires_at).filter(Boolean).sort();
        return {
            namespaces: ns.namespaces || [],
            objects,
            summary: {
                count: objects.length, complete, limit: opts.maxObjects,
                ...(complete ? {} : { next_cursor: objects.length ? objects[objects.length - 1].id : null, note: `stopped at ${opts.maxObjects} objects (CODES_EXPORT_MAX_OBJECTS); list the rest from Media with ?cursor=next_cursor` }),
                bytes: objects.reduce((n, o) => n + (Number(o.size_bytes) || 0), 0),
                downloads: counts, urls_expire_at: expiries[0] || null,
            },
        };
    }

    async function eventsPart(project, env, token) {
        const topic = `app.${projectKey(project.id)}.*`;
        const events = [];
        let after = 0;
        let end = null;
        let gap = null;
        let pages = 0;
        let stopped = false;
        for (;;) {
            const page = await get('events', 'events', env, token, '/api/v1/events', { topic, after_seq: after, limit: EVENT_PAGE });
            if (end === null) end = Number(page.latest_seq) || 0;
            if (page.gap && !gap) gap = page.gap;
            events.push(...(page.events || []));
            const next = Number(page.next_after_seq);
            if (events.length > opts.maxEvents) { stopped = true; break; }
            if (!(next > after) || next >= end) break;
            if (++pages >= MAX_EVENT_PAGES) { stopped = true; break; }
            after = next;
        }
        events.length = Math.min(events.length, opts.maxEvents);
        return {
            events,
            summary: {
                count: events.length, complete: !stopped, limit: opts.maxEvents, topic,
                first_seq: events.length ? events[0].seq : null, last_seq: events.length ? events[events.length - 1].seq : null,
                ...(stopped ? { next_after_seq: events.length ? events[events.length - 1].seq : after, note: `stopped at ${opts.maxEvents} events (CODES_EXPORT_MAX_EVENTS); pull the rest from Events with after_seq=next_after_seq` } : {}),
                retention: `Events keeps app events for a limited time (production 30 days, sandbox 7 by default); older ones are gone${gap ? ` (the oldest kept is seq ${gap.to_seq + 1})` : ''}.`,
            },
        };
    }

    /**
     * project: Network's project view; metadata: the project.json document (buildExport);
     * mintToken(audience, env) → { access_token, expires_at } (throws Network's problem as is).
     * Returns { buffer, filename, summary }.
     */
    async function build({ project, metadata, mintToken, meta }) {
        const media = {};
        const events = {};
        for (const env of ENVS) {
            media[env] = await mediaPart(project, env, tokenSource(mintToken, 'openvibe.media', env));
            events[env] = await eventsPart(project, env, tokenSource(mintToken, 'openvibe.events', env));
        }

        const releases = (metadata.codes && metadata.codes.releases) || [];
        const modules = releases.filter((r) => r.manifest && r.manifest.body).map((r) => ({
            path: `modules/${r.id}.json`, body: r.manifest.body,
            entry: { path: `modules/${r.id}.json`, release_id: r.id, app_id: r.app_id, kind: r.kind, name: r.name, version: r.version, status: r.status, environment: r.environment, schema: r.kind === 'mod' ? 'mods.mod-manifest@1' : 'codes.app-manifest@1' },
        }));

        const files = [
            { name: 'project.json', data: json(metadata) },
            ...modules.map((m) => ({ name: m.path, data: json(m.body) })),
        ];
        for (const env of ENVS) {
            files.push({ name: `media/${env}/namespaces.json`, data: json({ project_id: project.id, env, namespaces: media[env].namespaces }) });
            files.push({ name: `media/${env}/objects.jsonl`, data: jsonl(media[env].objects) });
            files.push({ name: `events/${env}.jsonl`, data: jsonl(events[env].events) });
        }
        for (const f of files) f.data = Buffer.from(f.data, 'utf8');

        const complete = ENVS.every((env) => media[env].summary.complete && events[env].summary.complete) && !(metadata.audit && metadata.audit.complete === false);
        const manifest = {
            format: FORMAT, format_version: FORMAT_VERSION,
            exported_at: meta.now, exported_by: meta.subject,
            project: { id: project.id, name: project.name, archived_at: project.archived_at || null },
            complete,
            parts: {
                metadata: { path: 'project.json', format: metadata.format, format_version: metadata.format_version, holds: 'project, members, apps, credentials (id and last four only), grants, quotas, audit; releases, trust tiers, playground runs' },
                modules: { path: 'modules/', count: modules.length, files: modules.map((m) => m.entry) },
                media: Object.fromEntries(ENVS.map((env) => [env, {
                    namespaces: { path: `media/${env}/namespaces.json`, count: media[env].namespaces.length },
                    objects: { path: `media/${env}/objects.jsonl`, ...media[env].summary },
                }])),
                events: Object.fromEntries(ENVS.map((env) => [env, { path: `events/${env}.jsonl`, ...events[env].summary }])),
            },
            not_included: NOT_INCLUDED,
            files: files.map((f) => ({ path: f.name, bytes: f.data.length, sha256: sha256(f.data) })),
        };
        const entries = [{ name: 'manifest.json', data: json(manifest) }, { name: 'README.txt', data: readme(manifest) }, ...files];
        const buffer = zip(entries, { date: new Date(meta.now) });
        return {
            buffer,
            filename: `openvibe-project-${project.id}-${meta.now.slice(0, 10)}.zip`,
            summary: {
                complete,
                objects: ENVS.reduce((n, env) => n + media[env].objects.length, 0),
                events: ENVS.reduce((n, env) => n + events[env].events.length, 0),
                modules: modules.length, bytes: buffer.length,
            },
        };
    }

    return { build };
}

function readme(m) {
    const env = (e) => {
        const o = m.parts.media[e].objects;
        const ev = m.parts.events[e];
        return `  ${e}:\n`
            + `    media/${e}/objects.jsonl    ${o.count} objects${o.complete ? '' : ` (NOT COMPLETE: ${o.note})`}; ${o.downloads.public} public, ${o.downloads.signed} signed, ${o.downloads.none} without bytes to fetch (not ready or deleted)\n`
            + `    media/${e}/namespaces.json  ${m.parts.media[e].namespaces.count} namespaces (policy, quotas, usage)\n`
            + `    events/${e}.jsonl           ${ev.count} events${ev.complete ? '' : ` (NOT COMPLETE: ${ev.note})`}\n`;
    };
    const expiry = ['production', 'sandbox'].map((e) => m.parts.media[e].objects.urls_expire_at).filter(Boolean).sort()[0];
    return `OpenVibe project archive: ${m.project.name} (${m.project.id})
Exported ${m.exported_at} by ${m.exported_by}. Format ${m.format} v${m.format_version}.
${m.complete ? 'Complete: every part below holds everything the services returned.' : 'NOT COMPLETE: a size limit was reached; manifest.json says which part and where it stopped.'}

project.json      the project as OpenVibe.Network holds it (members, apps, credentials by id and
                  last four characters, grants, quotas, audit) and OpenVibe.Codes' releases, trust
                  tiers and playground runs. This is the project's configuration.
modules/          ${m.parts.modules.count} release manifest(s), exactly as validated (app and mod modules).
${env('production')}${env('sandbox')}
Objects are listed, not copied: each line of objects.jsonl has "download": a public URL, or a
signed URL that ${expiry ? `expires at ${expiry}` : 'expires within the hour'}. Fetch them before then, for example:

  node -e "const fs=require('fs'),p=require('path');(async()=>{for(const l of fs.readFileSync(process.argv[1],'utf8').split('\\n').filter(Boolean)){const o=JSON.parse(l);if(!o.download)continue;const r=await fetch(o.download.url);if(!r.ok){console.error(o.id,r.status);continue;}fs.mkdirSync('objects',{recursive:true});fs.writeFileSync(p.join('objects',o.id),Buffer.from(await r.arrayBuffer()));}})()" media/production/objects.jsonl

Download the archive again for fresh URLs. Not included:
${m.not_included.map((x) => `  - ${x.what}: ${x.why}`).join('\n')}

manifest.json lists every file with its size and SHA-256.
`;
}

module.exports = { createArchiver, ArchiveError, FORMAT, FORMAT_VERSION, NOT_INCLUDED, projectKey };
