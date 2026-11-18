'use strict';
/**
 * The API harness's edit (harness/adapters/edit-match.js, after OpenCode's edit tool): exact first; then typographic
 * quotes, dashes and odd spaces forgiven; then trailing whitespace per line; CRLF files edited without touching their
 * other lines; replace_all; a new_string with $& or $1 written as it is; a miss that says where the closest lines are or
 * that the edit is already there; and the edit_file tool itself on disk.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyEdit, missHint } = require('../harness/adapters/edit-match');
const { runTool } = require('../harness/adapters/api');
const { check, done } = require('./helpers/boot');

(async () => {
    await check('exact, then quotes and dashes, then trailing whitespace', async () => {
        assert.deepStrictEqual(applyEdit('a = 1;\nb = 2;\n', 'b = 2;', 'b = 3;'), { text: 'a = 1;\nb = 3;\n', count: 1, tier: 'exact' });
        const smart = applyEdit('const s = “hello” — world;\n', 'const s = "hello" - world;', 'const s = "hi";');
        assert.deepStrictEqual([smart.text, smart.tier], ['const s = "hi";\n', 'unicode']);
        const trailing = applyEdit('if (x) {   \n    go();  \n}\n', 'if (x) {\n    go();\n}', 'if (y) {\n    stop();\n}');
        assert.deepStrictEqual([trailing.text, trailing.tier], ['if (y) {\n    stop();\n}\n', 'trailing-whitespace']);
    });

    await check('a CRLF file: matched through its LF view, the other lines keep their endings', async () => {
        const src = 'one\r\ntwo\r\nthree\nfour\r\n';
        const out = applyEdit(src, 'two\nthree', 'TWO\nthree');
        assert.strictEqual(out.text, 'one\r\nTWO\r\nthree\nfour\r\n', 'kept and replaced lines keep the region\'s endings');
    });

    await check('one match unless replace_all; $& and $1 are written as they are', async () => {
        assert.match(applyEdit('x\nx\n', 'x', 'y').error, /occurs 2 times/);
        assert.deepStrictEqual(applyEdit('x\nx\n', 'x', 'y', { replaceAll: true }), { text: 'y\ny\n', count: 2, tier: 'exact' });
        assert.strictEqual(applyEdit('echo HOME\n', 'HOME', '$HOME $& $1 $$').text, 'echo $HOME $& $1 $$\n', 'String.replace would have rewritten these');
        assert.match(applyEdit('a\n', '', 'b').error, /empty/);
    });

    await check('a miss says where the closest lines are, or that the edit is already there', async () => {
        const src = ['function add(a, b) {', '    return a + b;', '}', '', 'function sub(a, b) {', '    return a - b;', '}'].join('\n');
        const out = applyEdit(src, 'function sub(a,b) {\n  return a - b; // minus\n}', 'x');
        assert.strictEqual(out.error, 'old_string not found');
        assert.match(out.hint, /^The closest lines in the file:\n5\tfunction sub\(a, b\) \{/);
        assert.strictEqual(missHint(src, 'nothing like this at all', 'zzz'), '');
        assert.match(missHint(src, 'function mul(a, b) {', 'function sub(a, b) {\n    return a - b;'), /already in the file/);
    });

    await check('edit_file on disk: forgiving match, replace_all, a miss with its hint', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-edit-'));
        fs.writeFileSync(path.join(dir, 'a.js'), 'const q = ‘x’;   \nconst q2 = 1;\nconst q2b = 1;\n');
        let [msg, err] = runTool('edit_file', { path: 'a.js', old_string: "const q = 'x';", new_string: "const q = 'y';" }, dir);
        assert.strictEqual(err, false, msg);
        assert.match(msg, /matched ignoring/);
        assert.ok(fs.readFileSync(path.join(dir, 'a.js'), 'utf8').startsWith("const q = 'y';"));
        [msg, err] = runTool('edit_file', { path: 'a.js', old_string: '= 1;', new_string: '= 2;', replace_all: true }, dir);
        assert.deepStrictEqual([err, msg], [false, 'edited a.js (2 places)']);
        [msg, err] = runTool('edit_file', { path: 'a.js', old_string: 'const q2 = 2;\nconst q2b = 9;', new_string: 'x' }, dir);
        assert.strictEqual(err, true);
        assert.match(msg, /^old_string not found\. The closest lines in the file:\n2\tconst q2 = 2;/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
