'use strict';
// openvibe-sdk/html (0.175.0) is the one implementation every site shares (the consolidation of 2026-11-16).
// This service renders its own text (the ADRs openvibe-contracts ships), so its links are plain.
const { markdown } = require('openvibe-sdk/html');

module.exports = {
    markdown: (src, options = {}) => markdown(src, { trusted: true, ...options }),
};
