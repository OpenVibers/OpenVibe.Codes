'use strict';
// Every icon Codes names in its navbar and app bar is an OpenVibe glyph. A name the set does not have draws nothing:
// the conductor's tab showed an empty active pill on phones (10-30, a Font Awesome name the set lacked), which is why the layout names
// glyphs now and never a Font Awesome class.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const glyphs = require('openvibe-shared/glyphs');
const { check, done } = require('./helpers/boot');

const LAYOUT = path.join(__dirname, '..', 'server', 'render', 'layout.js');

(async () => {
    await check('every navbar and app bar icon is a glyph Shared draws', () => {
        const used = [...new Set((fs.readFileSync(LAYOUT, 'utf8').match(/icon: '([a-z0-9-]+)'/g) || []).map((s) => s.slice(7, -1)))];
        assert.ok(used.length > 5, 'the layout names its icons');
        const missing = used.filter((name) => !glyphs.NAMES.includes(name));
        assert.deepStrictEqual(missing, [], `glyphs Shared does not have: ${missing.join(', ')}`);
    });
    done();
})();
