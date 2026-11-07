'use strict';
/**
 * The skills hub (the Compute plan §5, E6): versioned skills, rules and MCP servers for people and projects, shared
 * through openvibe-sdk/share, with the gallery showing public records only.
 *
 *   - a new record is private and is not in the gallery;
 *   - public is listed and readable anonymously, link is readable by id but not listed, private answers 404;
 *   - saving a version keeps the old one, and a rollback copies it into a new version (history is never rewritten);
 *   - the Node's sync manifest is exactly the person's picks, at their newest version;
 *   - the page renders a skill body through the markup gate, never as HTML.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const ada = t.network.addUser('ada');
    const bo = t.network.addUser('bo');

    const api = (p, o = {}) => t.get(p, { as: o.as, json: o.json, method: o.method, headers: o.headers });
    const bearer = t.network.userToken(ada);
    const create = async (as, body) => api('/api/v1/skills', { as, json: body, method: 'POST' });
    const skillBody = (name, note = '') => `---\nname: ${name}\ndescription: A test skill.\n---\n\n# ${name}\n\n${note}\n`;
    const base = (over = {}) => ({
        kind: 'skill', slug: `skill-${Math.random().toString(36).slice(2, 8)}`, title: 'A skill',
        summary: 'One line about the skill.', body: skillBody('a-skill'), audience: 'private', tools: ['claude-code'], ...over,
    });
    const gallery = async (o = {}) => (await api(`/api/v1/skills${o.query || ''}`, o)).json();

    try {
        let pub;
        let priv;
        let link;

        await check('a new record is private, v1, and not in the gallery', async () => {
            const made = await create(ada, base({ title: 'Private notes' }));
            assert.strictEqual(made.status, 201, made.text);
            priv = made.json().skill;
            assert.strictEqual(priv.audience, 'private');
            assert.strictEqual(priv.version, 1);
            assert.strictEqual(priv.owner_subject, ada.subject);
            const list = await gallery();
            assert.ok(!list.skills.some((s) => s.id === priv.id), 'a private record is not listed');
            const anon = await api(`/api/v1/skills/${priv.id}`);
            assert.strictEqual(anon.status, 404);
            const owner = await api(`/api/v1/skills/${priv.id}`, { as: ada });
            assert.strictEqual(owner.status, 200);
        });

        await check('public is listed and readable; link is readable by id but not listed', async () => {
            pub = (await create(ada, base({ title: 'Public ship', slug: 'public-ship', audience: 'public' }))).json().skill;
            link = (await create(ada, base({ title: 'Secret link', slug: 'secret-link', audience: 'link' }))).json().skill;
            const list = await gallery();
            assert.ok(list.skills.some((s) => s.id === pub.id));
            assert.ok(!list.skills.some((s) => s.id === link.id), 'a link record is not in the gallery');
            const anon = await api(`/api/v1/skills/${link.id}`);
            assert.strictEqual(anon.status, 200);
            assert.strictEqual(anon.json().skill.audience, 'link');
        });

        await check('versions grow and a rollback copies the old body into a new version', async () => {
            const v2 = await api(`/api/v1/skills/${pub.id}/versions`, {
                as: ada, method: 'POST', json: { body: skillBody('public-ship', 'The second version.'), summary: 'Second' },
            });
            assert.strictEqual(v2.status, 201, v2.text);
            assert.strictEqual(v2.json().skill.version, 2);
            assert.ok(v2.json().skill.body.includes('The second version.'));
            const first = await api(`/api/v1/skills/${pub.id}/versions/1`, { as: ada });
            assert.strictEqual(first.status, 200);
            const rolled = await api(`/api/v1/skills/${pub.id}/rollback`, { as: ada, method: 'POST', json: { version: 1 } });
            assert.strictEqual(rolled.status, 201, rolled.text);
            assert.strictEqual(rolled.json().skill.version, 3);
            assert.strictEqual(rolled.json().skill.body, first.json().version.body);
            const history = await api(`/api/v1/skills/${pub.id}/versions`, { as: ada });
            assert.deepStrictEqual(history.json().versions.map((v) => v.version), [3, 2, 1]);
            assert.strictEqual(history.json().versions[0].note, 'rolled back to 1');
            const old = await api(`/api/v1/skills/${pub.id}/versions/2`, { as: ada });
            assert.ok(old.json().version.body.includes('The second version.'), 'an old version is never rewritten');
        });

        await check('the four audiences move the record in and out of the gallery', async () => {
            for (const audience of ['people', 'link', 'private']) {
                const moved = await api(`/api/v1/skills/${pub.id}/audience`, { as: ada, method: 'POST', json: { audience } });
                assert.strictEqual(moved.status, 200, moved.text);
                assert.strictEqual(moved.json().skill.audience, audience);
                const list = await gallery();
                assert.ok(!list.skills.some((s) => s.id === pub.id), `${audience} is not in the gallery`);
            }
            const back = await api(`/api/v1/skills/${pub.id}/audience`, { as: ada, method: 'POST', json: { audience: 'public' } });
            assert.strictEqual(back.status, 200);
            const list = await gallery();
            assert.ok(list.skills.some((s) => s.id === pub.id));
        });


        await check('the Share sheet is openvibe-sdk/share: the owner sets the audience, a stranger gets 404', async () => {
            const share = (o = {}) => t.get(`/api/v1/skill/${pub.id}/share`, {
                as: o.as, method: o.method, json: o.json,
                headers: { 'x-requested-with': 'ov-share', ...(o.headers || {}) },
            });
            const read = await share({ as: ada });
            assert.strictEqual(read.status, 200, read.text);
            assert.strictEqual(read.json().audience, 'public');
            const etag = read.headers.get('etag');
            assert.ok(etag, 'the share sheet carries an ETag');
            const moved = await share({ as: ada, method: 'PUT', json: { audience: 'people' }, headers: { 'if-match': etag } });
            assert.strictEqual(moved.status, 200, moved.text);
            assert.strictEqual(moved.json().audience, 'people');
            const listed = await gallery();
            assert.ok(!listed.skills.some((s) => s.id === pub.id), 'people is not in the gallery');
            const stranger = await share({ as: bo });
            assert.strictEqual(stranger.status, 404, 'a non-owner cannot read the share settings');
            const back = await share({ as: ada, method: 'PUT', json: { audience: 'public' } });
            assert.strictEqual(back.status, 200, back.text);
        });

        await check('the sync manifest is each person\'s own picks', async () => {
            const now = (await api(`/api/v1/skills/${pub.id}`, { as: ada })).json().skill;
            const added = await api(`/api/v1/me/skills/${pub.id}`, { as: ada, method: 'POST', json: { project: 'demo' } });
            assert.strictEqual(added.status, 201, added.text);
            const mine = (await api('/api/v1/me/skills?project=demo', { as: ada })).json();
            assert.ok(mine.skills.some((s) => s.id === pub.id), 'the project pick is in the manifest');
            assert.strictEqual(mine.skills.find((s) => s.id === pub.id).version, now.version);
            const other = (await api('/api/v1/me/skills?project=demo', { as: bo })).json();
            assert.ok(!other.skills.some((s) => s.id === pub.id), 'somebody else\'s picks are not in this manifest');
            const removed = await api(`/api/v1/me/skills/${pub.id}/remove`, { as: ada, method: 'POST', json: { project: 'demo' } });
            assert.strictEqual(removed.status, 200);
            const after = (await api('/api/v1/me/skills?project=demo', { as: ada })).json();
            assert.ok(!after.skills.some((s) => s.id === pub.id));
        });

        await check('the Node\'s sync authenticates the manifest with a bearer token', async () => {
            const res = await t.get('/api/v1/me/skills?project=demo', { headers: { authorization: `Bearer ${bearer}` } });
            assert.strictEqual(res.status, 200, res.text);
            assert.ok(Array.isArray(res.json().skills), 'the manifest is a list');
        });

        await check('a body is untrusted: the page goes through the markup gate', async () => {
            const made = (await create(ada, base({ title: 'Markup test', slug: 'markup-test', audience: 'public', body: '# Safe heading\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))' }))).json().skill;
            const page = await t.get(`/skills/${made.id}`, { as: ada });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Safe heading'));
            assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the script is shown as text');
            assert.ok(!page.text.includes('<script>alert(1)</script>'));
            assert.ok(!page.text.includes('href="javascript:'), 'a javascript: link is not a link');
        });

        await check('invalid input and a duplicate slug are refused', async () => {
            const badKind = await create(ada, base({ kind: 'plugin' }));
            assert.strictEqual(badKind.status, 422);
            assert.strictEqual(badKind.json().code, 'skill.invalid');
            const badAudience = await create(ada, base({ audience: 'everyone' }));
            assert.strictEqual(badAudience.status, 422);
            const dup = await create(ada, base({ slug: 'public-ship', title: 'Another' }));
            assert.strictEqual(dup.status, 409);
            assert.strictEqual(dup.json().code, 'skill.slug_taken');
        });

        await check('the gallery page lists public records and not private ones', async () => {
            const page = await t.get('/skills');
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('Public ship'));
            assert.ok(!page.text.includes('Private notes'));
            const mine = await t.get('/skills', { as: ada });
            assert.ok(mine.text.includes('Private notes'), 'the owner sees their own record on the page');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
