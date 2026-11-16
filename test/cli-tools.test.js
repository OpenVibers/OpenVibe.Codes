'use strict';
// `openvibe-codes tools` (plan 2026-11-13 §AD.12 (f); the owner, 11-15: tools "from gui to cmd"): find and run through
// openvibe.tools/mcp, the person's own tools, and make: a model drafts a tool from a sentence and it is made, private
// unless asked. key=value pairs become the input (numbers and JSON read as such); signed out, making asks to sign in.
const assert = require('assert');
const { check, done } = require('./helpers/boot');
const { tools, inputOf, bodyOf } = require('../bin/tools');

function fake() {
    const calls = [];
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ path: u.pathname + u.search, auth: (init.headers || {}).Authorization || null, body });
        if (u.pathname === '/mcp' && body.params.name === 'find_tools') return reply(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify([{ tool: 'dns', name: 'DNS', summary: 'DNS records', input: { properties: { target: {} } } }]) }] } });
        if (u.pathname === '/mcp' && body.params.name === 'run_tool') return reply(200, { jsonrpc: '2.0', id: body.id, result: body.params.arguments.tool === 'bad' ? { content: [{ type: 'text', text: 'input.target is required' }], isError: true } : { content: [{ type: 'text', text: '{"records":{"A":["1.2.3.4"]}}' }] } });
        if (u.pathname === '/api/v1/made-tools/draft' && body.kind === 'code') return reply(200, { draft: { kind: 'code', name: 'Price with tax' }, body: { slug: 'price-with-tax', name: 'Price with tax', summary: 'Adds tax.', kind: 'code', input: { type: 'object', properties: { price: { type: 'number' } } }, output: { kind: 'text' }, source_code: 'function run(input) { return String(input.price * 1.1); }', net: 'deny', hosting: 'openvibe', visibility: 'private' } });
        if (u.pathname === '/api/v1/made-tools/draft') return reply(200, { draft: { name: 'Meeting notes', summary: 'Notes to actions.', instructions: 'Do it.', inputs: [{ label: 'Note', kind: 'long' }, { label: 'People', kind: 'number' }], answer: 'fields', fields: [{ label: 'Actions' }] } });
        if (u.pathname === '/api/v1/made-tools/import/val' || u.pathname === '/api/v1/made-tools/import/pipedream') return reply(200, { draft: { kind: 'code', name: 'Greet' }, notes: ['It reads Deno.env (its secrets on Val Town).'], net: 'deny', body: { slug: body.url ? 'greet' : 'step', name: body.url ? 'Greet' : 'Step', summary: 'Greets.', kind: 'code', net: 'deny', input: { type: 'object', properties: { name: { type: 'string' } } }, output: { kind: 'text' }, source_code: 'async function run(input) { return "hi"; }', visibility: 'private' } });
        if (u.pathname === '/api/v1/made-tools' && init.method === 'POST' && body.slug === 'greet') return reply(409, { title: 'You already have a tool called greet' });
        if (u.pathname === '/api/v1/made-tools' && init.method === 'POST') return reply(201, { id: 'mtl_01JCZ3NDEKTSV4RRFFQ69G5FA1', name: body.name, summary: body.summary, visibility: body.visibility, input: body.input });
        if (u.pathname === '/api/v1/made-tools') return reply(200, { tools: [{ id: 'mtl_01JCZ3NDEKTSV4RRFFQ69G5FA1', name: 'Meeting notes', summary: 'x', visibility: 'private', version: 1, runs: 3 }] });
        return reply(404, {});
    };
    return { calls, fetchImpl };
}

(async () => {
    await check('find and run through openvibe.tools/mcp; key=value is the input', async () => {
        const f = fake(); const lines = [];
        delete process.env.OPENVIBE_TOOLS_TOKEN; delete process.env.OPENVIBE_TOKEN;
        assert.strictEqual(await tools(['find', 'dns', 'records'], { out: (s) => lines.push(s), fetchImpl: f.fetchImpl }), 0);
        assert.match(lines.join('\n'), /^dns\n    DNS records\n    takes: target/);
        assert.deepStrictEqual(f.calls[0].body.params.arguments, { need: 'dns records', limit: 10 });
        assert.strictEqual(f.calls[0].auth, null, 'signed out: no token');
        lines.length = 0;
        assert.strictEqual(await tools(['run', 'dns', 'target=example.com', 'n=3'], { out: (s) => lines.push(s), fetchImpl: f.fetchImpl }), 0);
        assert.deepStrictEqual(f.calls[1].body.params.arguments, { tool: 'dns', input: { target: 'example.com', n: 3 } });
        assert.match(lines.join('\n'), /"A": \[/, 'the result, pretty');
        lines.length = 0;
        assert.strictEqual(await tools(['run', 'bad'], { out: (s) => lines.push(s), fetchImpl: f.fetchImpl }), 1, 'a failed run exits 1');
        assert.match(lines[0], /failed: input.target is required/);
        assert.deepStrictEqual(inputOf([], '{"a":1}'), { a: 1 }, '--input JSON wins');
        assert.deepStrictEqual(inputOf(['on=true', 'list=["x"]', 'n=-2.5'], null), { on: true, list: ['x'], n: -2.5 });
        assert.throws(() => inputOf(['oops'], null), /not key=value/);
    });

    await check('make: a model drafts it from your words and it is made, private unless asked; mine lists yours', async () => {
        const f = fake(); const lines = [];
        delete process.env.OPENVIBE_TOOLS_TOKEN; delete process.env.OPENVIBE_TOKEN;
        assert.strictEqual(await tools(['make', 'turn meeting notes into actions'], { out: (s) => lines.push(s), fetchImpl: f.fetchImpl }), 1);
        assert.match(lines[0], /Sign in first/, 'making needs a sign-in');
        process.env.OPENVIBE_TOOLS_TOKEN = 'tok-ada';
        lines.length = 0;
        assert.strictEqual(await tools(['make', 'turn meeting notes into actions', '--public'], { out: (s) => lines.push(s), fetchImpl: f.fetchImpl }), 0);
        const made = f.calls.find((c) => c.path === '/api/v1/made-tools' && c.body);
        assert.strictEqual(made.auth, 'Bearer tok-ada');
        assert.deepStrictEqual([made.body.visibility, made.body.kind, made.body.prompt.model, Object.keys(made.body.input.properties), made.body.output.kind], ['public', 'prompt', 'auto', ['note', 'people'], 'json']);
        assert.match(lines.join('\n'), /Made Meeting notes \(mtl_\w+, public\)[\s\S]*try it: openvibe-codes tools run mtl_\w+ note=… people=…/);
        assert.strictEqual(bodyOf({ name: 'X', inputs: [], answer: 'text' }).visibility, 'private', 'private unless asked');
        lines.length = 0;
        assert.strictEqual(await tools(['mine'], { out: (s) => lines.push(s), fetchImpl: f.fetchImpl }), 0);
        assert.match(lines[0], /Meeting notes\s+\(private, v1, 3 runs\)/);
        delete process.env.OPENVIBE_TOOLS_TOKEN;
    });

    await check('make --code: Tools writes the run(input) code and its body is made as it is', async () => {
        const f = fake(); const lines = [];
        process.env.OPENVIBE_TOOLS_TOKEN = 'tok-ada';
        assert.strictEqual(await tools(['make', 'add sales tax to a price', '--code'], { out: (s) => lines.push(s), fetchImpl: f.fetchImpl }), 0);
        const draft = f.calls.find((c) => c.path === '/api/v1/made-tools/draft');
        assert.deepStrictEqual(draft.body, { description: 'add sales tax to a price', kind: 'code' });
        const made = f.calls.find((c) => c.path === '/api/v1/made-tools' && c.body);
        assert.deepStrictEqual([made.body.kind, made.body.visibility, /function run/.test(made.body.source_code), made.body.prompt], ['code', 'private', true, undefined]);
        assert.match(lines.join('\n'), /Made Price with tax \(mtl_\w+, private\)[\s\S]*price=…/);
        delete process.env.OPENVIBE_TOOLS_TOKEN;
    });

    await check('bring: a val by its address, a Pipedream step from its file; made as yours with its notes', async () => {
        const f = fake(); const lines = [];
        process.env.OPENVIBE_TOOLS_TOKEN = 'tok-ada';
        assert.strictEqual(await tools(['bring', 'https://www.val.town/v/ada/greet'], { out: (s) => lines.push(s), fetchImpl: f.fetchImpl }), 0);
        assert.deepStrictEqual(f.calls.filter((c) => c.body).map((c) => c.path), ['/api/v1/made-tools/import/val', '/api/v1/made-tools', '/api/v1/made-tools'], 'converted, then made (its name was taken, so again with a suffix)');
        assert.deepStrictEqual(f.calls[0].body, { url: 'https://www.val.town/v/ada/greet' });
        assert.match(f.calls[2].body.slug, /^greet-[a-z0-9]{1,4}$/);
        assert.match(lines.join('\n'), /Brought Greet \(mtl_\w+, private\)[\s\S]*note: It reads Deno\.env/);
        const file = require('path').join(require('os').tmpdir(), `pd-step-${process.pid}.js`);
        require('fs').writeFileSync(file, 'export default defineComponent({ async run() { return 1; } })');
        const g = fake();
        assert.strictEqual(await tools(['bring', '--pipedream', file, '--public'], { out: () => {}, fetchImpl: g.fetchImpl }), 0);
        assert.deepStrictEqual([g.calls[0].path, g.calls[0].body.name, /defineComponent/.test(g.calls[0].body.code), g.calls[1].body.visibility], ['/api/v1/made-tools/import/pipedream', `pd-step-${process.pid}`, true, 'public']);
        require('fs').unlinkSync(file);
        assert.strictEqual(await tools(['bring'], { out: () => {}, fetchImpl: g.fetchImpl }), 1, 'an address is needed');
        delete process.env.OPENVIBE_TOOLS_TOKEN;
    });

    await check('help and an unknown command', async () => {
        const lines = [];
        assert.strictEqual(await tools([], { out: (s) => lines.push(s) }), 0);
        assert.match(lines[0], /find "<need>"/);
        lines.length = 0;
        assert.strictEqual(await tools(['fly'], { out: (s) => lines.push(s) }), 1);
    });
    await done();
})();
