'use strict';

/**
 * Moving a session to OpenVibe Codes from any harness (plan §AD.24; the owner, 11-18: "finish the system for
 * transferring sessions or conversations from all harnesses like Claude Code … a prompt method they can just send their
 * agent and a manual method"):
 *   - the readers: a Claude Code tail from text, Codex, Gemini CLI (session and checkpoint), an OpenCode export and a
 *     Markdown hand-over, recognised by what they hold;
 *   - the importer (engine/importer-main.js): finds the session the agent runs under, uploads with a one-time link;
 *   - the one file /import.cjs serves runs with nothing installed;
 *   - /import: a link (one upload, then refused), the message for one's agent, the command, the sessions here;
 *   - a session that is not Claude Code's continues as a conductor with its whole conversation attached.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const p = require('../engine/portable');
const { main } = require('../engine/importer-main');
const kit = require('../server/http/import-kit');
const { boot, check, done } = require('./helpers/boot');

const SID = '11111111-2222-4333-8444-666666666666';
const claudeLines = (cwd) => [
    { type: 'user', uuid: 'a0', parentUuid: null, sessionId: SID, cwd, message: { role: 'user', content: 'Before the compaction' } },
    { type: 'system', subtype: 'compact_boundary', uuid: 'b0', parentUuid: null, sessionId: SID, cwd },
    { type: 'user', uuid: 'b1', parentUuid: 'b0', sessionId: SID, cwd, message: { role: 'user', content: 'Carry this session' } },
    { type: 'assistant', uuid: 'b2', parentUuid: 'b1', sessionId: SID, cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'Carried.' }] } },
].map((r) => JSON.stringify(r)).join('\n') + '\n';
const codexLines = (cwd) => [
    { type: 'session_meta', timestamp: '2026-11-18T01:00:00Z', payload: { id: 'codex-0001-abcd', cwd, cli_version: '0.80.0' } },
    { type: 'response_item', timestamp: '2026-11-18T01:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the Codex bug' }] } },
    { type: 'response_item', timestamp: '2026-11-18T01:00:02Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed in codex.' }] } },
].map((r) => JSON.stringify(r)).join('\n') + '\n';
const gemini = { sessionId: 'gem-5555-aaaa', startTime: '2026-11-18T00:00:00Z', lastUpdated: '2026-11-18T00:05:00Z',
    messages: [{ type: 'user', content: 'Plan the Gemini work' }, { type: 'info', content: 'switched model' }, { type: 'gemini', content: [{ text: 'Planned.' }] }] };
const opencode = { info: { id: 'ses_opencode01', title: 'Fix it', directory: '/w/app', time: { created: 1763420000000, updated: 1763420100000 } },
    messages: [{ info: { role: 'user', time: { created: 1763420000000 } }, parts: [{ type: 'text', text: 'Fix the OpenCode bug' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash' }, { type: 'text', text: 'Fixed it.' }] }] };
const handoverMd = '# Moving to Codes\n\n## User\nShip the transfer\nUser settings: keep them\n\n## Assistant\nShipped it.\n';

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-transfer-'));
    const t = await boot();
    const ada = t.network.addUser('ada-transfer');
    try {
        await check('every harness is read, recognised by what the file holds', async () => {
            const c = p.fromText(claudeLines('/home/ada/site'), { name: `${SID}.jsonl` });
            assert.deepStrictEqual([c.harness, c.session_id, c.counts.records, c.resume.records[0].uuid], ['claude-code', SID, 3, 'b0'], 'from the last compaction on');
            const x = p.fromText(codexLines('/w/x'));
            assert.deepStrictEqual([x.harness, x.session_id, x.title, x.source.cwd, x.resume], ['codex', 'codex-0001-abcd', 'Fix the Codex bug', '/w/x', null]);
            assert.deepStrictEqual(x.transcript.map((m) => m.text), ['Fix the Codex bug', 'Fixed in codex.'], 'the whole conversation travels for the hand-over');
            const g = p.fromText(JSON.stringify(gemini));
            assert.deepStrictEqual([g.harness, g.session_id, g.title, g.counts.messages], ['gemini', 'gem-5555-aaaa', 'Plan the Gemini work', 2], 'info lines are not conversation');
            const gc = p.fromText(JSON.stringify([{ role: 'user', parts: [{ text: 'Saved chat' }] }, { role: 'model', parts: [{ text: 'Reply' }] }]), { name: 'checkpoint-x.json' });
            assert.deepStrictEqual([gc.harness, gc.messages.map((m) => m.role)], ['gemini', ['user', 'assistant']]);
            const o = p.fromText(JSON.stringify(opencode));
            assert.deepStrictEqual([o.harness, o.session_id, o.title, o.source.cwd, o.messages[1].text], ['opencode', 'ses_opencode01', 'Fix the OpenCode bug', '/w/app', '[bash]\nFixed it.']);
            const h = p.fromText(handoverMd, { name: 'ov-handover.md' });
            assert.deepStrictEqual([h.harness, h.title], ['handover', 'Moving to Codes']);
            assert.deepStrictEqual(h.transcript.map((m) => [m.role, m.text.trim()]), [['user', '# Moving to Codes'], ['user', 'Ship the transfer\nUser settings: keep them'], ['assistant', 'Shipped it.']], 'a line that only mentions "User" is not a turn');
            const plain = p.fromText('Just some notes about the work.');
            assert.deepStrictEqual([plain.harness, plain.counts.messages], ['handover', 1]);
        });

        // A machine with a session of three harnesses for one folder.
        const home = path.join(tmp, 'home');
        const cwd = '/home/ada/site';
        fs.mkdirSync(path.join(home, '.claude', 'projects', p.slug(cwd)), { recursive: true });
        fs.writeFileSync(path.join(home, '.claude', 'projects', p.slug(cwd), `${SID}.jsonl`), claudeLines(cwd));
        fs.mkdirSync(path.join(home, '.codex', 'sessions', '2026', '11', '18'), { recursive: true });
        fs.writeFileSync(path.join(home, '.codex', 'sessions', '2026', '11', '18', 'rollout-2026-11-18-x.jsonl'), codexLines(cwd));
        const gdir = path.join(home, '.gemini', 'tmp', require('crypto').createHash('sha256').update(cwd).digest('hex'), 'chats');
        fs.mkdirSync(gdir, { recursive: true });
        fs.writeFileSync(path.join(gdir, 'session-2026-11-18-a.json'), JSON.stringify(gemini));

        await check('the importer takes the session of the agent it runs under, and uploads it with the link', async () => {
            const sent = [];
            const fetchImpl = async (url, o) => { sent.push({ url, o, doc: JSON.parse(zlib.gunzipSync(o.body).toString()) }); return { ok: true, status: 201, json: async () => ({ import: { id: 'imp_x', resumable: sent[sent.length - 1].doc.harness === 'claude-code' } }) }; };
            const link = `cdi_${'A'.repeat(32)}`;
            const lines = [];
            const run = (argv, env) => main(argv, { portable: p, base: 'https://codes.test', env, fetchImpl, out: (l) => lines.push(l), home, cwd });
            assert.strictEqual(await run(['--link', link], { CLAUDECODE: '1' }), 0);
            assert.strictEqual(sent[0].doc.harness, 'claude-code');
            assert.strictEqual(sent[0].url, 'https://codes.test/api/v1/sessions/imports');
            assert.strictEqual(sent[0].o.headers.Authorization, `Bearer ${link}`);
            assert.ok(lines.some((l) => l === 'Continue it: https://codes.test/conductor?import=imp_x'));
            assert.strictEqual(await run(['--link', link], { GEMINI_CLI: '1' }), 0);
            assert.strictEqual(sent[1].doc.harness, 'gemini');
            assert.strictEqual(await run(['--link', link, '--from', 'codex'], {}), 0);
            assert.strictEqual(sent[2].doc.harness, 'codex');
            assert.ok(lines.some((l) => /reads this whole conversation first/.test(l)));
            fs.writeFileSync(path.join(tmp, 'h.md'), handoverMd);
            assert.strictEqual(await run(['--link', link, '--file', path.join(tmp, 'h.md')], {}), 0);
            assert.strictEqual(sent[3].doc.harness, 'handover');
            assert.strictEqual(await run([], {}), 2, 'no link: it says where to make one');
            assert.ok(lines.some((l) => l.includes('https://codes.test/import')));
            assert.strictEqual(await run(['--link', 'cdi_short'], {}), 2);
        });

        await check('the one file /import.cjs serves runs with nothing installed', async () => {
            const res = await t.get('/import.cjs');
            assert.strictEqual(res.status, 200);
            assert.match(res.headers.get('content-type'), /javascript/);
            assert.ok(res.text.includes(`const OV_BASE = ${JSON.stringify(t.config.baseUrl.replace(/\/+$/, ''))}`));
            const file = path.join(tmp, 'ov-import.cjs');
            fs.writeFileSync(file, res.text);
            const out = path.join(tmp, 'out.json.gz');
            const env = { PATH: process.env.PATH, HOME: home, CLAUDECODE: '1' };
            const said = execFileSync(process.execPath, [file, '--out', out, '--cwd', cwd], { cwd: tmp, env, encoding: 'utf8' });
            assert.match(said, /Wrote claude-code session/);
            assert.strictEqual(JSON.parse(zlib.gunzipSync(fs.readFileSync(out)).toString()).session_id, SID);
            assert.match(execFileSync(process.execPath, [file, '--help'], { env, encoding: 'utf8' }), /--link cdi_/);
        });

        let token = null;
        await check('/import makes a one-time link, with the message for one\'s agent and the command', async () => {
            const first = await t.get('/import', { as: ada });
            assert.strictEqual(first.status, 200);
            for (const words of ['Ask your agent', 'Do it yourself', 'Or drop a session file', 'Your sessions', 'Make a link']) assert.ok(first.text.includes(words), words);
            const made = await t.get('/import/link', { as: ada, form: {}, method: 'POST' });
            assert.strictEqual(made.status, 200);
            token = (/cdi_[A-Za-z0-9_-]{32}/.exec(made.text) || [])[0];
            assert.ok(token, 'the link is on the page');
            assert.ok(made.text.includes(`node /tmp/ov-import.cjs --link ${token}`), 'the message names the command');
            assert.ok(made.text.includes('Works once, until'));
            const api = await t.get('/api/v1/sessions/import-links', { as: ada, method: 'POST' });
            assert.strictEqual(api.status, 201, api.text);
            assert.match(api.json().prompt, /Please move this conversation to OpenVibe Codes/);
            assert.match(api.json().command.unix, /curl -fsSL .*\/import\.cjs .*--link cdi_/);
            assert.strictEqual((await t.get('/api/v1/sessions/import-links', { method: 'POST' })).status, 401, 'signed out: no link');
        });

        let gem = null;
        await check('a link uploads one session (a raw file is read), then is refused; a refused upload gives it back', async () => {
            const up = (body, name) => t.get('/api/v1/sessions/imports', { method: 'POST', bearer: token, body, headers: { 'content-type': 'application/octet-stream', 'x-ov-filename': name } });
            const bad = await up(Buffer.alloc(0), 'empty.json');
            assert.ok(bad.status >= 400 && bad.status < 500);
            const ok = await up(zlib.gzipSync(JSON.stringify(gemini)), 'session-2026-11-18-a.json');
            assert.strictEqual(ok.status, 201, ok.text);
            gem = ok.json().import;
            assert.deepStrictEqual([gem.harness, gem.resumable, gem.title], ['gemini', false, 'Plan the Gemini work']);
            assert.strictEqual(ok.json().continue_url, `${t.config.baseUrl}/conductor?import=${gem.id}`);
            const again = await up(zlib.gzipSync(JSON.stringify(gemini)), 'again.json');
            assert.strictEqual(again.status, 401);
            assert.strictEqual(again.json().code, 'import.link_invalid');
            const list = await t.get('/import', { as: ada });
            assert.ok(list.text.includes('Plan the Gemini work') && list.text.includes(`/conductor?import=${gem.id}`));
        });

        await check('a session that is not Claude Code\'s continues with its whole conversation attached', async () => {
            const project = 'prj_01M7A6T4Y2ZNWTMM8VR6HW5T17';
            t.ctx.conductor.projectFor = async () => project;
            const res = await t.get('/conductor', { as: ada, form: { import_id: gem.id, folder: '/srv/openvibe/work' } });
            assert.strictEqual(res.status, 303, res.text);
            assert.match(res.headers.get('location') || '', /^\/tasks\/tsk_/, res.headers.get('location'));
            const att = await t.ctx.store.db.maybe("SELECT name, data FROM codes_attachments WHERE subject = $1 AND name LIKE 'handover-gemini-%'", [ada.subject]);
            assert.ok(att, 'the hand-over is attached');
            const text = Buffer.from(att.data).toString('utf8');
            assert.ok(text.includes('## User') && text.includes('Plan the Gemini work') && text.includes('Planned.'));
            const task = await t.ctx.store.db.one("SELECT prompt, agent, import_id FROM run_tasks WHERE subject = $1 AND kind = 'conductor' ORDER BY created_at DESC LIMIT 1", [ada.subject]);
            assert.match(task.prompt, /continuing a conversation that started in Gemini CLI/);
            assert.strictEqual(task.import_id, null, 'not resumed: handed over');
        });
    } finally {
        await t.close();
        fs.rmSync(tmp, { recursive: true, force: true });
        done();
    }
})();
