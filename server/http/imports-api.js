'use strict';

/**
 * Portable sessions (plan §AD.22, conversation.import@1): what `openvibe-codes import` uploads, and what a machine reads
 * to resume one. A conductor is started from an import with POST /api/v1/conductor { import_id, folder, machine }.
 *
 *   POST   /sessions/imports                 the document, gzipped (application/octet-stream) → { import }
 *   GET    /sessions/imports                 the person's imports, newest first → { imports }
 *   GET    /sessions/imports/:id             one, with its last messages → { import }
 *   GET    /sessions/imports/:id/document    the document, gzipped: for the person's own machine (their bearer token)
 *   DELETE /sessions/imports/:id             forget it
 *
 * The person is the session cookie (this site) or their own Network token as a Bearer (the CLI, their machine). Another
 * person's import is not found, never forbidden.
 */
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { readBody } = require('./upload');

function createImportsApi({ sessionImports, actorLimits, config, keys = null, log = console }) {
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };
    async function bearerSubject(req) {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ') || !keys) return null;
        try {
            if (!keys.loaded()) await keys.ensure();
            const v = await keys.verifyUser(header.slice(7).trim(), { issuer: config.networkIssuer, audience: [config.oauth.sessionAudience, config.serviceAudience] });
            if (!v.ok) return null;
            const subject = typeof v.claims.subject_id === 'string' ? v.claims.subject_id : null;
            return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject || '') ? subject : null;
        } catch { return null; }
    }
    async function subjectOf(req) {
        if (sameOrigin(req) && signedIn(req)) return req.viewer.subject;
        return bearerSubject(req);
    }
    r.use('/sessions/imports', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    r.post('/sessions/imports', actorLimits.budget('codes.attachment.upload'), async (req, res) => {
        const subject = await subjectOf(req);
        if (!subject) return problem(req, res, 401, 'auth.required', 'sign in (or send your Network token) to import a session');
        if (!sameOrigin(req) && !(await bearerSubject(req))) return problem(req, res, 403, 'cross_site', 'cross-site uploads are refused');
        try {
            const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : await readBody(req, { maxBytes: sessionImports.MAX_BYTES });
            const saved = await sessionImports.save(subject, body);
            return res.status(201).json({ import: saved });
        } catch (e) {
            return problem(req, res, e.status || 500, e.code || 'import.failed', String((e && e.message) || 'the session could not be imported').slice(0, 300));
        }
    });

    r.get('/sessions/imports', actorLimits.reads('codes.read'), async (req, res) => {
        const subject = await subjectOf(req);
        if (!subject) return problem(req, res, 401, 'auth.required', 'sign in to see your imported sessions');
        return res.json({ imports: await sessionImports.list(subject) });
    });

    r.get('/sessions/imports/:id', actorLimits.reads('codes.read'), async (req, res) => {
        const subject = await subjectOf(req);
        if (!subject) return problem(req, res, 401, 'auth.required', 'sign in to see your imported session');
        const one = await sessionImports.get(subject, req.params.id);
        if (!one) return problem(req, res, 404, 'import.not_found', 'no such import of yours');
        return res.json({ import: one });
    });

    r.get('/sessions/imports/:id/document', actorLimits.reads('codes.read'), async (req, res) => {
        const subject = await subjectOf(req);
        if (!subject) return problem(req, res, 401, 'auth.required', 'the machine reads it with your token');
        const doc = await sessionImports.data(subject, req.params.id);
        if (!doc) return problem(req, res, 404, 'import.not_found', 'no such import of yours');
        res.set('Content-Type', 'application/gzip');
        res.set('X-Content-Type-Options', 'nosniff');
        return res.send(doc.gz);
    });

    r.delete('/sessions/imports/:id', actorLimits.budget('codes.attachment.upload'), async (req, res) => {
        const subject = await subjectOf(req);
        if (!subject) return problem(req, res, 401, 'auth.required', 'sign in to forget an import');
        if (!sameOrigin(req) && !(await bearerSubject(req))) return problem(req, res, 403, 'cross_site', 'cross-site changes are refused');
        return res.json(await sessionImports.remove(subject, req.params.id));
    });

    return r;
}

module.exports = { createImportsApi };
