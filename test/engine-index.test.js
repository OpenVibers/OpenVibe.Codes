'use strict';
// The engine as a package: what it exports, and what it may depend on.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { check, done } = require('./helpers/boot');
const engine = require('../engine');

const DIR = path.join(__dirname, '..', 'engine');

(async () => {
    await check('the engine exports every module and the names a caller wants', () => {
        for (const name of ['router', 'chain', 'budget', 'transcript', 'effort', 'scope', 'runerror', 'proof', 'review']) {
            assert.ok(engine[name], `${name} is exported`);
        }
        for (const name of ['classify', 'pick', 'outcome', 'nextStep', 'evaluate', 'limitsFor', 'parse', 'parseText', 'fitEffort', 'pickModel']) {
            assert.equal(typeof engine[name], 'function', `${name} is a function`);
        }
    });

    await check('the engine needs nothing but node itself', () => {
        const builtins = new Set(require('node:module').builtinModules);
        for (const file of fs.readdirSync(DIR)) {
            if (!file.endsWith('.js')) continue;
            const source = fs.readFileSync(path.join(DIR, file), 'utf8');
            for (const m of source.matchAll(/require\('([^']+)'\)/g)) {
                const name = m[1];
                if (name.startsWith('.')) continue;
                assert.ok(builtins.has(name.replace(/^node:/, '')), `${file} requires ${name}, which is not a node builtin`);
            }
        }
    });

    await check('every module of the engine has a file and a test', () => {
        const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));
        const tests = fs.readdirSync(__dirname).filter((f) => f.startsWith('engine-') && f.endsWith('.test.js'))
            .map((f) => f.replace(/^engine-/, '').replace(/\.test\.js$/, ''));
        for (const name of files) {
            assert.ok(tests.includes(name.replace(/-/g, '-')), `${name} has a test`);
        }
    });

    done();
})();
