'use strict';
/**
 * The ADR renderer (server/render/markdown.js): pipe tables render as tables (14 ADRs have them; they showed as a
 * paragraph of pipes), everything stays escaped, and a delimiter-looking line is checked in linear time.
 */
const assert = require('assert');
const { markdown } = require('../server/render/markdown');

const t = markdown('Intro\n\n| Concern | Owner |\n|---|:-:|\n| Rows | `authority` |\n| a \\| b | **x** |\n| <script> | |\n\nafter');
assert.strictEqual(t, '<p>Intro</p>\n<div class="table-wrap" tabindex="0" role="region" aria-label="Table: Concern, Owner"><table><thead><tr>'
    + '<th scope="col">Concern</th><th scope="col">Owner</th></tr></thead><tbody><tr><td>Rows</td><td><code>authority</code></td></tr>'
    + '<tr><td>a | b</td><td><strong>x</strong></td></tr><tr><td>&lt;script&gt;</td><td></td></tr></tbody></table></div>\n<p>after</p>');
assert.strictEqual(markdown('a | b\nc | d'), '<p>a | b c | d</p>', 'pipes without a delimiter row are text');
assert.strictEqual(markdown('| a | b |\n| --- |'), '<p>| a | b | | --- |</p>', 'a delimiter row must match the header');
const started = Date.now();
markdown(`${'|a'.repeat(20000)}|\n${'|-'.repeat(20000)}|\n${'| x | y |\n'.repeat(20000)}`);
markdown(`| a |\n${'|-'.repeat(40000)}x`);
// A wide header and many rows together stay bounded (64 columns, 1000 rows).
markdown(`${'|a'.repeat(5000)}|\n${'|-'.repeat(5000)}|\n${`${'|x'.repeat(5000)}|\n`.repeat(5000)}`);
const tall = markdown(`| a |\n|---|\n${'| x |\n'.repeat(3000)}`);
assert.strictEqual((tall.match(/<tr>/g) || []).length, 1001, 'a header and 1000 rows');
assert.ok(Date.now() - started < 1500, `pathological tables took ${Date.now() - started} ms`);
console.log('markdown: all checks passed');
