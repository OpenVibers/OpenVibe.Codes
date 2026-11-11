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
 await check('capped Exchange analysis creates one weekly review goal task',async()=>{
  const clock=Date.parse('2026-11-11T00:00:00Z'); const notes=[]; const calls=[];
  const settings={topics:['agent-harness'],repos_per_day:1,weekly_proposal:true,cost_cap:0.5,owner_subject:'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2K3',next_due:new Date(0),weekly_due:new Date(0)};
  const db={maybe:async(sql)=>sql.includes('github_learning_settings')?settings:sql.includes('github_learning_snapshots')?{stars:32}:sql.includes('github_learning_notes WHERE')?{id:1,full_name:'example/agent',url:'https://github.com/example/agent',license:'MIT',analysis:notes[0]?.analysis,suggested_repo:'OpenVibe.Codes',suggested_change:'Add a bounded parser test'}:null,
   many:async()=>notes,exec:async(sql,args)=>{if(sql.includes('INSERT INTO github_learning_notes'))notes.push({analysis:args[7]});}};
  const fetchImpl=async(url,opts)=>{calls.push({url,opts});return {ok:true,status:200,json:async()=>url.includes('/search/repositories')?fixture.search:url.includes('/readme')?{content:Buffer.from(fixture.readme).toString('base64')}:url.includes('/releases')?[]:url.includes('/contents/')?{content:Buffer.from('{"name":"fixture"}').toString('base64')}:url.includes('/contents')?fixture.contents:{choices:[{message:{content:JSON.stringify({new:'New parser pattern',use:'A bounded parser test',repo:'OpenVibe.Codes',change:'Add a bounded parser test'})}}],x_openvibe:{cost_usd:0.002}}};};
  const started=[];const tasks={latestProject:async()=> 'prj_fixture',start:async(input)=>{started.push(input);return {id:'tsk_fixture'};}};
  const runTokens={mint:async(input)=>{assert.equal(input.budget.usd,0.5);return {token:'fixture-token'};}};
  const learning=createGitHubLearning({store:{db,now:()=>clock},config:{github:{token:''},exchange:{url:'https://api.openvibe.exchange'},goals:{enabled:true}},tasks,runTokens,fetchImpl});
  const result=await learning.runOnce();
  assert.equal(result.proposal.task_id,'tsk_fixture');assert.match(notes[0].analysis,/New parser pattern/);
  assert.equal(started.length,1);assert.equal(started[0].args.push.pull_request,true);assert.match(started[0].args.goal.goal,/Never merge/);
  assert(calls.some(x=>x.url.endsWith('/v1/chat/completions')));assert(calls.every(x=>!x.url.startsWith('https://fixture/')));
 });
 done();
})().catch(e=>{console.error(e);process.exit(1);});
