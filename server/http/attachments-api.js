'use strict';

/**
 * A person's attachments (owner 2026-11-07). The composer uploads each file before the message is sent (so the page can
 * show progress and a × before submit), then names the ids in the message; a form without JavaScript sends the same
 * files as multipart instead and the page's route saves them.
 *
 *   POST   /attachments             one file: multipart (`file`) or a raw body with X-File-Name; → { attachment }
 *   GET    /attachments/:id         its bytes, owner-only; images and PDFs inline, everything else a download
 *   DELETE /attachments/:id         an upload that is not attached to a message yet
 *
 * A chat message's own copy is listed at /api/v1/tasks/:id/messages/:mid/attachments/:i (conductor), and every
 * attachment is listed under the turn it belongs to on the task page. Nothing here is public: every query is scoped to
 * the signed-in person, and another person's attachment answers 404, never 403 (which would say it exists).
 */
const { http } = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { readMultipart, readBody, isMultipart } = require('./upload');

const FILE = /^fil_[0-9A-HJKMNP-TV-Z]{26}$/;
const INLINE = /^(image\/(png|jpeg|gif|webp|avif|heic)|application\/pdf)$/;

function createAttachmentsApi({ attachments, actorLimits, config, keys = null, log = console }) {
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    /** The person: the session cookie, or their own Network access token as a Bearer (what a job on their machine has). */
    async function subjectOf(req) {
        if (signedIn(req)) return req.viewer.subject;
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
    const sameOrigin = (req) => {
        const origin = req.get('origin');
        if (!origin) return true;
        try { return new URL(origin).origin === new URL(config.baseUrl).origin; } catch { return false; }
    };
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    r.post('/attachments', actorLimits.budget('codes.attachment.upload'), async (req, res) => {
        const subject = await subjectOf(req);
        if (!subject) return problem(req, res, 401, 'auth.required', 'sign in to attach a file');
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site uploads are refused');
        try {
            let file;
            if (isMultipart(req)) {
                const { files } = await readMultipart(req, { maxBytes: attachments.MAX_FILE_BYTES });
                if (!files.length) return problem(req, res, 422, 'attachment.empty', 'choose a file to attach');
                if (files.length > 1) return problem(req, res, 422, 'attachment.too_many', 'upload one file at a time');
                file = files[0];
            } else {
                const name = String(req.get('x-file-name') || '').trim();
                if (!name) return problem(req, res, 422, 'attachment.name_required', 'send the file as multipart, or with X-File-Name');
                file = { name, type: String(req.get('content-type') || ''), buffer: await readBody(req, { maxBytes: attachments.MAX_FILE_BYTES }) };
            }
            const saved = await attachments.save(subject, file);
            log.info(`[Codes] attachment ${saved.id} (${saved.size} bytes) uploaded by ${subject}`);
            return res.status(201).json({ attachment: saved });
        } catch (e) {
            return problem(req, res, e.status || 500, e.code || 'attachment.failed', String((e && e.message) || 'the file could not be attached').slice(0, 300));
        }
    });

    r.get('/attachments/:id', actorLimits.reads('codes.read'), async (req, res) => {
        const subject = await subjectOf(req);
        if (!subject) return problem(req, res, 401, 'auth.required', 'sign in to read your attachment');
        if (!FILE.test(String(req.params.id))) return problem(req, res, 404, 'attachment.not_found', 'no such attachment');
        const row = await attachments.get(subject, req.params.id);
        if (!row) return problem(req, res, 404, 'attachment.not_found', 'no such attachment of yours');
        const name = String(row.name || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
        res.set('Content-Type', row.mime || 'application/octet-stream');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Security-Policy', "default-src 'none'; sandbox");
        res.set('Content-Disposition', `${INLINE.test(String(row.mime || '')) ? 'inline' : 'attachment'}; filename="${name}"`);
        return res.send(Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data || ''));
    });

    r.delete('/attachments/:id', actorLimits.budget('codes.attachment.upload'), async (req, res) => {
        const subject = await subjectOf(req);
        if (!subject) return problem(req, res, 401, 'auth.required', 'sign in to remove an attachment');
        if (!sameOrigin(req)) return problem(req, res, 403, 'cross_site', 'cross-site changes are refused');
        if (!FILE.test(String(req.params.id))) return problem(req, res, 404, 'attachment.not_found', 'no such attachment');
        try {
            return res.json(await attachments.remove(subject, req.params.id));
        } catch (e) {
            return problem(req, res, e.status || 500, e.code || 'attachment.failed', String((e && e.message) || 'the attachment could not be removed'));
        }
    });

    return r;
}

module.exports = { createAttachmentsApi, FILE };
