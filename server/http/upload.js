'use strict';

/**
 * Multipart support for the composers (owner 2026-11-07): without JavaScript a form with files is a plain
 * `multipart/form-data` post, and the server reads it here. The Web Request parser in Node (undici) does the boundary
 * work; this module caps the bytes, turns the files into `{ name, type, buffer }`, and keeps the fields a form sends.
 *
 *   readMultipart(req, { maxBytes })             → { fields: { name: value | [values] }, files: [{ name, type, buffer }] }
 *   readBody(req, { maxBytes })                  → a raw body (the upload API's application/octet-stream)
 *   formBody({ urlencoded, maxBytes })           Express middleware: urlencoded or multipart, into req.body/req.files
 */
const express = require('express');

const DEFAULT_MAX = 50 * 1024 * 1024;

const tooLarge = () => Object.assign(new Error('the body is larger than this form accepts'), { status: 413, code: 'attachment.body_too_large' });

/** Every byte of a request, stopping at the cap rather than trusting Content-Length. */
async function readBytes(req, maxBytes = DEFAULT_MAX) {
    const cap = Number(maxBytes) > 0 ? Number(maxBytes) : DEFAULT_MAX;
    const known = Number(req.headers['content-length']);
    if (Number.isFinite(known) && known > cap + 1024 * 1024) throw tooLarge();
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > cap + 1024 * 1024) throw tooLarge();
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

const isMultipart = (req) => /^multipart\/form-data\b/i.test(String(req.headers['content-type'] || ''));

/** A multipart body as its fields and files. */
async function readMultipart(req, { maxBytes = DEFAULT_MAX } = {}) {
    const type = String(req.headers['content-type'] || '');
    if (!isMultipart(req)) throw Object.assign(new Error('that is not a multipart form'), { status: 415, code: 'attachment.content_type' });
    const body = await readBytes(req, maxBytes);
    let form;
    try {
        form = await new Request('http://codes.invalid/form', { method: 'POST', headers: { 'content-type': type }, body });
        form = await form.formData();
    } catch (e) {
        throw Object.assign(new Error('the form could not be read'), { status: 400, code: 'attachment.bad_form' });
    }
    const fields = {};
    const files = [];
    const put = (key, value) => {
        if (!(key in fields)) fields[key] = value;
        else if (Array.isArray(fields[key])) fields[key].push(value);
        else fields[key] = [fields[key], value];
    };
    for (const [key, value] of form.entries()) {
        if (typeof value === 'string') { put(key, value); continue; }
        if (!value || typeof value.arrayBuffer !== 'function') continue;
        files.push({ name: String(value.name || 'file'), type: String(value.type || ''), buffer: Buffer.from(await value.arrayBuffer()) });
    }
    return { fields, files };
}

/** The body of an upload (application/octet-stream) as bytes. */
const readBody = (req, { maxBytes = DEFAULT_MAX } = {}) => readBytes(req, maxBytes);

/**
 * One middleware for a page that takes both kinds of form: the ordinary urlencoded post (with or without JavaScript)
 * and the multipart one the no-JavaScript composer sends. req.body is the fields; req.files is the files.
 */
function formBody({ urlencoded = express.urlencoded({ extended: false, limit: '1mb' }), maxBytes = DEFAULT_MAX } = {}) {
    return (req, res, next) => {
        if (!isMultipart(req)) return urlencoded(req, res, (err) => next(err));
        readMultipart(req, { maxBytes }).then(({ fields, files }) => {
            req.body = fields;
            req.files = files;
            next();
        }, (err) => {
            if (err && err.status) { res.status(err.status).type('text/plain').send(`${err.message}\n`); return; }
            next(err);
        });
    };
}

module.exports = { readMultipart, readBody, readBytes, formBody, isMultipart, DEFAULT_MAX };
