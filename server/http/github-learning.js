'use strict';

const express = require('express');
const { asyncRouter } = require('./router');
const { esc } = require('../render/html');
const { DEFAULT_TOPICS } = require('../domain/github-learning');

function createGitHubLearningRoutes(ctx) {
    const { config, learning } = ctx;
    const page = asyncRouter();
    const api = asyncRouter();
    const json = express.json({ limit: '8kb' });
    const owner = req => req.viewer && req.viewer.kind === 'user' && req.viewer.role === 'owner';
    const deny = (req,res) => res.status(req.viewer ? 403 : 401).type('text/plain').send('Owner access required.');
    page.get('/learn', async (req,res) => {
        if (!owner(req)) return deny(req,res);
        const notes = await learning.notes(100);
        const body = `<main><h1>Learn</h1><p>Daily GitHub research findings, with license and observed star growth.</p>${notes.map(n=>`<article><h2><a href="${esc(n.url)}">${esc(n.full_name)}</a></h2><p>${esc(n.finding_date)} · ${esc(n.license || 'UNKNOWN')} · ${n.stars} stars · +${n.star_growth}</p><p>${esc(n.summary)}</p></article>`).join('') || '<p>No findings yet.</p>'}</main>`;
        return res.type('html').send(body);
    });
    page.get('/admin/github-learning', async (req,res) => {
        if (!owner(req)) return deny(req,res);
        const s = await learning.settings();
        const body = `<main><h1>GitHub learning settings</h1><form method="post"><label>Topics (one per line)<textarea name="topics">${esc((s.topics || DEFAULT_TOPICS).join('\n'))}</textarea></label><label>Repositories per day <input name="repos_per_day" type="number" min="1" max="20" value="${s.repos_per_day}"></label><label>Weekly proposal <input name="weekly_proposal" type="checkbox"${s.weekly_proposal ? ' checked' : ''}></label><label>Cost cap (USD) <input name="cost_cap" type="number" min="0" max="100" step="0.01" value="${s.cost_cap}"></label><p>GitHub token is the sealed GitHub token in owner account settings; its value is never shown here.</p><button class="ovk-btn ovk-btn--primary">Save</button></form></main>`;
        return res.type('html').send(body);
    });
    page.post('/admin/github-learning', express.urlencoded({extended:false,limit:'8kb'}), async (req,res) => {
        if (!owner(req)) return deny(req,res);
        const topics = String(req.body.topics || '').split(/[\n,]/).map(x=>x.trim().toLowerCase()).filter(x=>/^[a-z0-9][a-z0-9-]{0,49}$/.test(x)).slice(0,20);
        if (!topics.length) return res.status(422).type('text/plain').send('Add at least one valid GitHub topic.');
        const count = Math.max(1,Math.min(20,Number(req.body.repos_per_day)||5));
        const cap = Math.max(0,Math.min(100,Number(req.body.cost_cap)||0));
        await ctx.store.db.exec(`INSERT INTO github_learning_settings(id,topics,repos_per_day,weekly_proposal,cost_cap) VALUES(1,$1::jsonb,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET topics=EXCLUDED.topics,repos_per_day=EXCLUDED.repos_per_day,weekly_proposal=EXCLUDED.weekly_proposal,cost_cap=EXCLUDED.cost_cap,updated_at=now()`, [JSON.stringify(topics),count,req.body.weekly_proposal==='on',cap]);
        return res.redirect(303,'/admin/github-learning?saved=1');
    });
    api.get('/admin/github-learning', async (req,res) => {
        if (!owner(req)) return res.status(req.viewer ? 403 : 401).json({error:'owner_required'});
        const s=await learning.settings();
        return res.json({settings:{topics:s.topics,repos_per_day:s.repos_per_day,weekly_proposal:s.weekly_proposal,cost_cap:s.cost_cap,github_token_configured:Boolean(config.github && config.github.token)}});
    });
    api.put('/admin/github-learning', json, async (req,res) => {
        if (!owner(req)) return res.status(req.viewer ? 403 : 401).json({error:'owner_required'});
        const b=req.body||{}; const topics=Array.isArray(b.topics)?b.topics.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[a-z0-9][a-z0-9-]{0,49}$/.test(x)).slice(0,20):[];
        if(!topics.length) return res.status(422).json({error:'topics_required'});
        const count=Math.max(1,Math.min(20,Math.trunc(Number(b.repos_per_day)||5))), cap=Math.max(0,Math.min(100,Number(b.cost_cap)||0));
        await ctx.store.db.exec(`INSERT INTO github_learning_settings(id,topics,repos_per_day,weekly_proposal,cost_cap) VALUES(1,$1::jsonb,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET topics=EXCLUDED.topics,repos_per_day=EXCLUDED.repos_per_day,weekly_proposal=EXCLUDED.weekly_proposal,cost_cap=EXCLUDED.cost_cap,updated_at=now()`,[JSON.stringify(topics),count,b.weekly_proposal===true,cap]);
        return res.json({settings:{topics,repos_per_day:count,weekly_proposal:b.weekly_proposal===true,cost_cap:cap}});
    });
    return {page,api};
}

module.exports={createGitHubLearningRoutes};
