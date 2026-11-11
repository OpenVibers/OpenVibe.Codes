'use strict';
const assert = require('assert');
const fixture = require('./fixtures/github-learning.json');
const { check, done } = require('./helpers/boot');
const { createGitHubLearning } = require('../server/domain/github-learning');

(async()=>{
 await check('daily GitHub learning searches recorded fixtures and writes license checked findings',async()=>{
  let clock=Date.parse('2026-11-11T00:00:00Z'); const snapshots=[{stars:32}]; const notes=[]; let settings=null;
  const db={maybe:async(sql,args)=>sql.includes('github_learning_settings')?settings:sql.includes('github_learning_snapshots')?snapshots[0]||null:null,
   many:async()=>notes,
   exec:async(sql,args)=>{if(sql.includes('github_learning_snapshots'))snapshots.unshift({stars:32}); else if(sql.includes('github_learning_notes'))notes.push({full_name:args[1],license:args[3],star_growth:args[5],summary:args[6]}); else if(sql.includes('github_learning_settings'))settings={topics:['agent-harness'],repos_per_day:1,weekly_proposal:false,cost_cap:1,next_due:new Date(clock+86400000)};}};
  const fetchImpl=async(url)=>({ok:true,status:200,json:async()=>url.includes('/search/repositories')?fixture.search:url.endsWith('/readme')?{content:Buffer.from(fixture.readme).toString('base64')}:fixture.contents,text:async()=>'{"name":"fixture"}'});
  const learning=createGitHubLearning({store:{db,now:()=>clock},config:{github:{token:''}},fetchImpl});
  const result=await learning.runOnce(); assert.equal(result.findings[0].license,'MIT'); assert.equal(result.findings[0].growth,10);
  assert.equal(notes[0].license,'MIT'); assert.match(notes[0].summary,/Architecture/); assert.match(notes[0].summary,/Star change/);
  assert.equal((await learning.runOnce()).skipped,'not_due');
 });
 done();
})().catch(e=>{console.error(e);process.exit(1);});
