'use strict';

/**
 * A project's metadata as one JSON document, for the developer to keep or move elsewhere.
 *
 * Network owns the project, members, apps, credentials, grants, quotas and audit (ADR-014), so
 * those parts are read from its /api/v1/projects API with the person's own token, exactly as it
 * answers: Codes adds nothing and copies nothing into its own database. Codes adds only what is
 * Codes': releases (with manifests and logs), trust tiers and playground run logs.
 *
 * There is no secret in it: Network lists credentials by id and last four characters only, and no
 * Codes table holds a secret (test/secrets.test.js). The audit log needs the admin role in Network;
 * for anyone else it is left out and the document says so. Any Network failure fails the whole
 * export: a partial export presented as complete would be wrong.
 */
const contractsVersion = require('openvibe-contracts/package.json').version;

const FORMAT = 'openvibe.codes.project-export';
const FORMAT_VERSION = 1;
const AUDIT_PAGE = 200;
const AUDIT_MAX_PAGES = 50;

async function buildExport({ network, token, project, includeAudit, releases, playground, trust, meta }) {
    const P = network.projects;
    const [members, apps, quotas] = await Promise.all([P.members(token, project.id), P.apps(token, project.id), P.quotas(token, project.id)]);
    const appList = await Promise.all((apps.apps || []).map(async (a) => {
        const [credentials, grants] = await Promise.all([P.credentials(token, project.id, a.id), P.grants(token, project.id, a.id)]);
        return { ...a, credentials: credentials.credentials || [], grants: grants.grants || [] };
    }));

    let audit = null;
    if (includeAudit) {
        audit = { entries: [], complete: true };
        let before;
        for (let page = 0; ; page++) {
            if (page === AUDIT_MAX_PAGES) { audit.complete = false; break; }
            const got = await P.audit(token, project.id, { before, limit: AUDIT_PAGE });
            audit.entries.push(...(got.entries || []));
            if (!got.next_before) break;
            before = got.next_before;
        }
    }

    const appIds = appList.map((a) => a.id);
    return {
        format: FORMAT,
        format_version: FORMAT_VERSION,
        exported_at: meta.now,
        exported_by: meta.subject,
        sources: {
            network: { url: meta.networkUrl, api: '/api/v1/projects', owns: ['project', 'members', 'apps', 'credentials', 'grants', 'quotas', 'audit'] },
            codes: { url: meta.baseUrl, contracts: contractsVersion, owns: ['releases', 'trust', 'playground_runs'] },
        },
        project,
        members: members.members || [],
        apps: appList,
        quotas: quotas.quotas || [],
        audit: audit || { entries: null, note: 'the audit log needs the admin role in this project' },
        codes: {
            releases: releases.listForProject(project.id),
            trust: appIds.map((id) => ({ app_id: id, ...trust.get(id), history: trust.history(id) })),
            playground_runs: playground.runsForProject(project.id),
        },
    };
}

module.exports = { buildExport, FORMAT, FORMAT_VERSION };
