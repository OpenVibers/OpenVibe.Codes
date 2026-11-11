'use strict';
// Codes points a person with no machines at the Link hub's pairing act, not the old hub anchor.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CHAT = fs.readFileSync(path.join(__dirname, '..', 'server/http/chat.js'), 'utf8');
const m = CHAT.match(/<a href="([^"]+)">Pair it first<\/a>/);
assert.ok(m, 'the Pair-it-first link exists');
assert.strictEqual(m[1], 'https://openvibe.link/machines#pair', 'it lands on the pairing act');
assert.ok(!CHAT.includes('openvibe.my/#machines'), 'no stale hub anchor remains in chat.js');

console.log('chat-pair-link.test.js: all assertions passed');
