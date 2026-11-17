'use strict';
/**
 * Which Codes job runner is current (Link v0.76.0): GET /api/v1/runner → { version, protocol }.
 *
 * Each Link that runs the Codes worker asks this every few hours and, when the answer is newer than the runner it has,
 * installs that release from OpenVibe.Codes' own tag beside the old one, checks it and swaps it in between jobs
 * (Link internal/codesrunner). The answer names a version and nothing else: the Link builds the download address
 * itself, so this route can never point a machine at other code. The server and the runner are one release, so the
 * version is this server's own. Public, and cached briefly: it says nothing about anyone.
 */
const express = require('express');
const { version } = require('../../package.json');

const PROTOCOL = 'openvibe-codes@1.0.0';

function createRunnerApi() {
    const r = express.Router();
    r.get('/runner', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.json({ version, protocol: PROTOCOL });
    });
    return r;
}

module.exports = { createRunnerApi, PROTOCOL };
