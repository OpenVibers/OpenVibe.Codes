'use strict';

/**
 * The developer console moved to OpenVibe.Services on 2026-10-08 (owner decision; openvibe-contracts 0.113.0). Every
 * address it had here answers with a permanent redirect to the same path and query there, so bookmarks, links,
 * search results and API clients keep working:
 *
 *   GET and HEAD                301 Moved Permanently (search engines move the page's ranking with it)
 *   any other method            308 Permanent Redirect (the method and body are kept: a POST stays a POST)
 *
 * What stays here: the home page, the agents (/harnesses, /api/v1/harnesses), Improve OpenVibe, the community
 * documents (/policy and /policy/<document>), the update log, sign-in and the legal pages. /docs/harnesses, the
 * catalog's old address, now lives at /harnesses on this site.
 */
const SERVICES_ORIGIN = 'https://openvibe.services';

// The console's paths (and everything under them), and the platform policy pages that moved with it.
const MOVED_PREFIXES = ['/docs', '/projects', '/releases', '/apps', '/oauth', '/tools', '/manifests', '/staff'];
const MOVED_EXACT = ['/policy/rfc', '/policy/compatibility', '/policy/licensing', '/policy/transparency'];
// The console's API: everything under /api/v1 but the agent catalog.
const API_STAYS = /^\/api\/v1\/harnesses(\/|$)/;

const under = (p, prefix) => p === prefix || p.startsWith(`${prefix}/`);

/** Where a request moved to, or null when this site still answers it. */
function movedTo(req) {
    const p = req.path;
    if (p === '/docs/harnesses' || p === '/docs/harnesses/') return '/harnesses';
    const q = req.originalUrl.slice(req.path.length);   // the query string (and nothing else) as it was sent
    if (MOVED_EXACT.includes(p) || MOVED_PREFIXES.some((x) => under(p, x))) return `${SERVICES_ORIGIN}${p}${q}`;
    if (under(p, '/api/v1') && !API_STAYS.test(p)) return `${SERVICES_ORIGIN}${p}${q}`;
    return null;
}

function createMovedRoutes() {
    return (req, res, next) => {
        const to = movedTo(req);
        if (!to) return next();
        res.set('Cache-Control', 'public, max-age=86400');
        return res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, to);
    };
}

module.exports = { createMovedRoutes, movedTo, SERVICES_ORIGIN, MOVED_PREFIXES, MOVED_EXACT };
