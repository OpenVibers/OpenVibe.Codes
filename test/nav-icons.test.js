'use strict';
// Every icon Codes names in its navbar and app bar exists in Shared's navbar icon set. A name the set does not have
// draws nothing: the conductor's tab showed an empty active pill on phones (10-30, `fa-chart-simple`).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { check, done } = require('./helpers/boot');

const SHARED = path.join(__dirname, '..', 'node_modules', 'openvibe-shared', 'nav-icons.js');
const LAYOUT = path.join(__dirname, '..', 'server', 'render', 'layout.js');

(async () => {
    await check('every navbar and app bar icon is one Shared can draw', () => {
        const have = new Set(fs.readFileSync(SHARED, 'utf8').match(/fa-[a-z0-9-]+/g) || []);
        assert.ok(have.size > 20, 'the shared icon set was read');
        const used = [...new Set((fs.readFileSync(LAYOUT, 'utf8').match(/icon: '(fa-[a-z0-9-]+)'/g) || []).map((s) => s.slice(7, -1)))];
        assert.ok(used.length > 5, 'the layout names its icons');
        const missing = used.filter((name) => !have.has(name));
        assert.deepStrictEqual(missing, [], `icons Shared does not have: ${missing.join(', ')}`);
    });
    done();
})();
