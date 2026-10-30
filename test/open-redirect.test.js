'use strict';
// Open redirect regression (WS-R task 5): the sign-in "next" never leaves the site. Browsers drop tab and
// newline characters from a URL and read a backslash as "/", so "/<TAB>/evil.com" is "//evil.com" to them;
// until 2026-09-26 it got through here.
const assert = require('assert');
const { sanitizeNext } = require('../server/auth/sso');

const config = { baseUrl: 'https://site.openvibe.test', networkUrl: 'https://openvibe.network' };
const home = (v) => {
    const out = String(sanitizeNext(v, config));
    const host = new URL(out.replace(/[\t\n\r]/g, ''), 'https://site.openvibe.test').host;
    return host === 'site.openvibe.test' || host === 'openvibe.network';
};
for (const v of ['//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com', 'http:evil.com', '/\t/evil.com', '/\n/evil.com', '\t//evil.com',
    ' //evil.com', '/\\/evil.com', 'https:/\\evil.com', '///evil.com', 'javascript:alert(1)', '/%09/evil.com']) {
    assert.ok(home(v), `${JSON.stringify(v)} stays on the site (got ${JSON.stringify(sanitizeNext(v, config))})`);
    assert.ok(!/^\s*javascript:/i.test(String(sanitizeNext(v, config))), JSON.stringify(v));
}
assert.strictEqual(sanitizeNext('/settings?tab=a', config), '/settings?tab=a', 'a plain relative path is kept');

// The shared navbar's silent sign-in sends the whole page address: on this site's own origin it is that page's path
// (before 2026-10-22 it went to the home page); anywhere else, or a lookalike host, goes home.
// The SDK keeps a same-site address whole (it is still this site's own origin, never another one).
assert.strictEqual(sanitizeNext('https://site.openvibe.test/a/b?x=1#c', config), 'https://site.openvibe.test/a/b?x=1#c');
for (const v of ['https://evil.com/a', 'https://site.openvibe.test.evil.com/a', 'https://site.openvibe.test@evil.com/', 'http://site.openvibe.test/a']) {
    assert.strictEqual(sanitizeNext(v, config), '/', v);
}
// A same-site address whose path looks protocol-relative is still this site's own origin: the browser
// reads it as the path //evil.com of site.openvibe.test, never as another host.
assert.ok(home('https://site.openvibe.test//evil.com'), 'a same-site address stays on the site');
assert.ok(home('https://site.openvibe.test/a'), 'a same-site address stays on the site');
console.log('open redirect: all checks passed');
