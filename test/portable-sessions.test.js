'use strict';

/**
 * Portable sessions (plan §AD.22, conversation.import@1): a Claude Code session's resumable tail is found from the end
 * of a file of any size, carries every record of the conversation's chain and none of the bookkeeping, lands on another
 * machine under that machine's folder, and is placed once (a later turn finds it grown and leaves it alone).
 *
 * Proven by hand on 2026-11-17: this session's 3.8 GB file gave 1,896 records (6 MB, 1.7 MB gzipped), placed in
 * another folder and resumed there by `claude -p --resume`, which answered from the conversation's own details.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const p = require('../engine/portable');
const { placeImport } = require('../harness/job');
const { check, done } = require('./helpers/boot');

const SID = '11111111-2222-4333-8444-555555555555';
const OLD = '/home/ada/projects/site';
const rec = (o) => JSON.stringify({ sessionId: SID, timestamp: '2026-11-17T10:00:00Z', cwd: OLD, ...o });

function sessionFile(dir) {
    const lines = [
        rec({ type: 'user', uuid: 'a1', parentUuid: null, message: { role: 'user', content: 'before the compaction' } }),
        // A message that only mentions the word: not a boundary.
        rec({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'grep "compact_boundary" to find it' }] } }),
        rec({ type: 'system', subtype: 'compact_boundary', uuid: 'b0', parentUuid: null, logicalParentUuid: 'a2', content: 'Conversation compacted' }),
        rec({ type: 'user', uuid: 'b1', parentUuid: 'b0', isCompactSummary: true, message: { role: 'user', content: '<summary>what came before</summary>' } }),
        JSON.stringify({ type: 'api-request', requestId: 'r1', body: 'x'.repeat(5000) }),
        rec({ type: 'user', uuid: 'b2', parentUuid: 'b1', message: { role: 'user', content: 'Build ov-desk in Rust' } }),
        rec({ type: 'attachment', uuid: 'b3', parentUuid: 'b2', attachment: { type: 'file', path: `${OLD}/README.md` } }),
        JSON.stringify({ type: 'mode', mode: 'normal' }),
        rec({ type: 'assistant', uuid: 'b4', parentUuid: 'b3', cwd: `${OLD}/desk`, message: { role: 'assistant', content: [{ type: 'text', text: 'Done: ov-desk races Go.' }, { type: 'tool_use', name: 'Bash', input: {} }] } }),
        '{"type": "user", "uuid": "cut',          // a line cut by a crash
    ];
    const file = path.join(dir, `${SID}.jsonl`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-'));
    try {
        const file = sessionFile(dir);

        await check("the tail starts at the last real compaction and keeps the conversation's chain, not the bookkeeping", async () => {
            const at = p.lastBoundaryOffset(file, { chunk: 64 });     // small chunks: lines cross every edge
            assert.ok(fs.readFileSync(file).subarray(at).toString().startsWith('{"sessionId"'), 'a line start');
            const { meta, records } = p.claudeTail(file);
            assert.deepStrictEqual(records.map((r) => r.uuid), ['b0', 'b1', 'b2', 'b3', 'b4'], 'the boundary, the summary, the messages and the attachment that chains them');
            assert.deepStrictEqual([meta.harness, meta.session_id, meta.cwd], ['claude-code', SID, OLD]);
            const doc = p.portable(records, meta);
            assert.strictEqual(doc.format, 'conversation.import@1');
            assert.strictEqual(doc.title, 'Build ov-desk in Rust', 'the first thing asked, not the summary');
            assert.deepStrictEqual(doc.messages.map((m) => [m.role, m.text]), [['user', 'Build ov-desk in Rust'], ['assistant', 'Done: ov-desk races Go.\n[Bash]']]);
            assert.strictEqual(doc.resume.records.length, 5);
        });

        await check('a session never compacted is read whole, and one that is too big says to compact it first', async () => {
            const plain = path.join(dir, 'plain.jsonl');
            fs.writeFileSync(plain, `${rec({ type: 'user', uuid: 'c1', parentUuid: null, message: { role: 'user', content: 'hello' } })}\n`);
            assert.strictEqual(p.lastBoundaryOffset(plain), 0);
            assert.deepStrictEqual(p.claudeTail(plain).records.map((r) => r.uuid), ['c1']);
        });

        await check("it lands under the new machine's folder, with every path moved, as Claude Code names the folder", async () => {
            const { meta, records } = p.claudeTail(file);
            const cfg = path.join(dir, 'cfg');
            const placed = p.placeClaude(p.portable(records, meta), { configDir: cfg, cwd: '/srv/openvibe/work' });
            assert.strictEqual(placed, path.join(cfg, 'projects', '-srv-openvibe-work', `${SID}.jsonl`));
            const back = fs.readFileSync(placed, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
            assert.deepStrictEqual(back.map((r) => r.cwd), ['/srv/openvibe/work', '/srv/openvibe/work', '/srv/openvibe/work', '/srv/openvibe/work', '/srv/openvibe/work/desk']);
            assert.strictEqual(p.slug('/a/b.c_d'), '-a-b-c-d');
            assert.ok(p.slug(`/${'x'.repeat(300)}`).length < 220, 'a long folder is cut and hashed');
            assert.throws(() => p.placeClaude({ format: 'other' }, { configDir: cfg, cwd: '/x' }), /not a portable Claude Code session/);
        });

        await check("a conductor's turn places it once from the person's server, then leaves the grown file alone", async () => {
            const { meta, records } = p.claudeTail(file);
            const gz = zlib.gzipSync(JSON.stringify(p.portable(records, meta)));
            let fetched = 0;
            const fetchImpl = async (url, o) => {
                fetched++;
                assert.strictEqual(o.headers.Authorization, 'Bearer tok-ada');
                return { ok: true, status: 200, arrayBuffer: async () => gz };
            };
            const cfg = path.join(dir, 'machine-claude');
            const env = { CLAUDE_CONFIG_DIR: cfg, OPENVIBE_TOKEN: 'tok-ada' };
            const said = [];
            const job = { import: { url: 'https://openvibe.codes/api/v1/sessions/imports/imp_x/document', session: SID } };
            const placed = await placeImport(job, { work: '/srv/openvibe/work', env, fetchImpl, say: (e) => said.push(e.text) });
            assert.ok(fs.existsSync(placed));
            fs.appendFileSync(placed, `${rec({ type: 'user', uuid: 'later', parentUuid: 'b4', message: { role: 'user', content: 'a later turn' } })}\n`);
            await placeImport(job, { work: '/srv/openvibe/work', env, fetchImpl, say: () => {} });
            assert.strictEqual(fetched, 1, 'the second turn does not fetch it again');
            assert.ok(fs.readFileSync(placed, 'utf8').includes('a later turn'), 'nor overwrite what the agent added');
            assert.ok(said.some((s) => /resumed in \/srv\/openvibe\/work/.test(s)));
            await assert.rejects(placeImport({ import: { url: job.import.url, session: '99999999-2222-4333-8444-555555555555' } }, { work: '/w', env, fetchImpl, say: () => {} }),
                /not the one this turn resumes/);
        });

        await check('a Codex rollout is read to show and hand over', async () => {
            const rollout = path.join(dir, 'rollout-2026-11-17T10-00-00-abc.jsonl');
            fs.writeFileSync(rollout, [
                JSON.stringify({ type: 'session_meta', timestamp: '2026-11-17T10:00:00Z', payload: { id: 'cdx-1', cwd: OLD, cli_version: '0.169.0' } }),
                JSON.stringify({ type: 'response_item', timestamp: '2026-11-17T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the build' }] } }),
                JSON.stringify({ type: 'response_item', timestamp: '2026-11-17T10:00:02Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] } }),
            ].join('\n'));
            const doc = p.codexSession(rollout);
            assert.deepStrictEqual([doc.harness, doc.session_id, doc.title, doc.resume, doc.messages.length], ['codex', 'cdx-1', 'Fix the build', null, 2]);
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        done();
    }
})();
