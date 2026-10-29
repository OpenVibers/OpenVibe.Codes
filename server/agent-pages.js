'use strict';
// The Markdown twins of openvibe.codes' public pages (openvibe-shared/agent-layer), rendered by the same
// page builders the routes use (createPageRoutes().publicViews + render/layout.js's renderPage), so a
// twin cannot drift from its page. Anonymous only; a run's page is a person's run and has no twin.
const { renderPage } = require('./render/layout');

function createAgentPages(ctx, publicViews) {
    const views = publicViews;
    const twin = (page, path) => (page ? { html: renderPage({ ...page, viewer: { kind: 'anonymous' }, config: ctx.config, path }) } : null);

    async function renderPublicPage(path) {
        if (path === '/') return twin(views.home(), path);
        if (path === '/start') return twin(views.start(), path);
        if (path === '/harnesses') return twin(views.harnesses(), path);
        if (path === '/improve') return twin(views.improve(), path);
        if (path === '/updates') return twin(views.updates(), path);
        if (path === '/policy') return twin(views.policy(), path);
        let m = /^\/policy\/([^/]+)$/.exec(path);
        if (m) return twin(views.policyDoc(decodeURIComponent(m[1])), path);
        m = /^\/improve\/([^/]+)\/([^/]+)$/.exec(path);
        if (m) return twin(await views.improveRepo(decodeURIComponent(m[1]), decodeURIComponent(m[2])), path);
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
