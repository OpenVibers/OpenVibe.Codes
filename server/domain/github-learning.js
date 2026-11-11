'use strict';

/** Owner configured, due based GitHub research. Network responses and clocks are injectable for fixture tests. */
const DEFAULT_TOPICS = ['agent-harness', 'coding-agent', 'agent-ui-protocol', 'browser-automation', 'streaming', 'design-system'];
const clamp = (n, min, max) => Math.max(min, Math.min(max, Math.trunc(Number(n) || min)));

function createGitHubLearning({ store, config, fetchImpl = globalThis.fetch, now = store.now, log = console }) {
    const db = store.db;
    const settings = async () => {
        const row = await db.maybe('SELECT * FROM github_learning_settings WHERE id=1');
        return row || { topics: DEFAULT_TOPICS, repos_per_day: 5, weekly_proposal: false, cost_cap: 1, next_due: new Date(0) };
    };
    async function github(url) {
        const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
        if (config.github && config.github.token) headers.authorization = `Bearer ${config.github.token}`;
        const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(12000) });
        if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
        return res.json();
    }
    async function runOnce() {
        const cfg = await settings();
        if (new Date(cfg.next_due).getTime() > now()) return { skipped: 'not_due' };
        const topics = Array.isArray(cfg.topics) ? cfg.topics.slice(0, 20) : DEFAULT_TOPICS;
        const found = new Map();
        for (const topic of topics) {
            const q = encodeURIComponent(`topic:${topic} pushed:>${new Date(now() - 30 * 86400000).toISOString().slice(0,10)}`);
            const data = await github(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`);
            for (const repo of data.items || []) if (repo.full_name && !repo.fork && !repo.archived) found.set(repo.full_name, repo);
        }
        const ranked = [...found.values()].sort((a,b) => Number(b.stargazers_count || 0)-Number(a.stargazers_count || 0)).slice(0, clamp(cfg.repos_per_day,1,20));
        const day = new Date(now()).toISOString().slice(0,10);
        const findings = [];
        for (const repo of ranked) {
            const old = await db.maybe('SELECT stars FROM github_learning_snapshots WHERE full_name=$1 ORDER BY observed_at DESC LIMIT 1', [repo.full_name]);
            const growth = Math.max(0, Number(repo.stargazers_count || 0) - Number(old && old.stars || 0));
            const [readme, detail] = await Promise.all([
                github(`https://api.github.com/repos/${repo.full_name}/readme`),
                github(`https://api.github.com/repos/${repo.full_name}/contents`),
            ]).then(async ([r, files]) => {
                const text = Buffer.from(r.content || '', 'base64').toString('utf8').slice(0, 12000);
                const key = (files || []).filter(x => x.type === 'file' && /^(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|AGENTS\.md|\.github)$/i.test(x.name)).slice(0,3);
                const snippets=[];
                for (const f of key) if (f.download_url) { try { const x=await fetchImpl(f.download_url,{signal:AbortSignal.timeout(7000)}); if(x.ok) snippets.push((await x.text()).slice(0,2500)); } catch (_) {} }
                return [text, snippets.join('\n').slice(0,3500)];
            });
            const license = repo.license && (repo.license.spdx_id || repo.license.name) || 'UNKNOWN';
            const headings = readme.split('\n').filter(line => /^#{1,3}\s/.test(line)).slice(0,8).join('; ');
            const extract = readme.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').slice(0,700);
            const keyExtract = detail.replace(/\s+/g,' ').slice(0,500);
            const summary = `License: ${license}. ${repo.description || 'No description supplied.'}\nREADME headings: ${headings || 'none found'}.\nREADME: ${extract}\nKey files: ${keyExtract || 'no common key file found'}.\nStar change since previous daily snapshot: +${growth}.`;
            await db.exec('INSERT INTO github_learning_snapshots(full_name,stars,observed_at) VALUES($1,$2,to_timestamp($3/1000.0))', [repo.full_name, Number(repo.stargazers_count || 0), now()]);
            await db.exec(`INSERT INTO github_learning_notes(finding_date,full_name,url,license,stars,star_growth,summary)
                VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(finding_date,full_name) DO NOTHING`, [day, repo.full_name, repo.html_url, license, Number(repo.stargazers_count || 0), growth, summary]);
            findings.push({ full_name: repo.full_name, license, stars: Number(repo.stargazers_count || 0), growth });
        }
        await db.exec("INSERT INTO github_learning_settings(id,next_due) VALUES(1,to_timestamp($1/1000.0)+interval '1 day') ON CONFLICT(id) DO UPDATE SET next_due=EXCLUDED.next_due,updated_at=now()", [now()]);
        return { date: day, findings };
    }
    return { settings, runOnce, async notes(limit = 50) { return db.many('SELECT * FROM github_learning_notes ORDER BY finding_date DESC,star_growth DESC LIMIT $1', [clamp(limit,1,100)]); } };
}

module.exports = { createGitHubLearning, DEFAULT_TOPICS };
