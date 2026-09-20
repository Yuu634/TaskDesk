'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {blankTree,blankNode,atomic}=require('../lib/core.cjs');
const {runWorker}=require('../lib/worker.cjs');
const execution=require('../lib/herdr-execution.cjs');
test('review reassessment uses original work and updates outcome without rerunning work',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wt-reassess-')),a=blankNode({prompt:'first'});
 atomic(path.join(dir,'input.json'),{id:'reassess-test',tree:blankTree({cwd:dir,nodes:[a]}),machines:[{id:'local'}],runnerId:'local',orca:{nodes:{[a.id]:{hostId:'local',path:dir}}}});
 const orca=require('../lib/orca-execution.cjs'),previous=orca.runInOrca;let calls=0;
 orca.runInOrca=async context=>{calls++;if(calls===2)assert.deepEqual(context.reassessment,{work:'original'});return{response:'判定結果',outcome:calls===1?'needs_review':'completed',assessment:{outcome:calls===1?'needs_review':'completed'},reassessment:{work:'original'}};};
 const pending=runWorker(dir);
 try{
  const deadline=Date.now()+5000;
  while(JSON.parse(fs.readFileSync(path.join(dir,'state.json'))).status!=='review'){assert(Date.now()<deadline);await new Promise(r=>setTimeout(r,20));}
  atomic(path.join(dir,'control.json'),{id:'reassess',action:'reassess',nodeId:a.id});
  const state=await pending;assert.equal(state.status,'succeeded');assert.equal(calls,2);assert.equal(state.nodes[a.id].assessmentHistory[0].outcome,'needs_review');assert.equal(state.nodes[a.id].outcome,'completed');
 }finally{orca.runInOrca=previous;}
});
test('needs_review blocks dependents until explicit human approval and preserves AI evidence',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wt-review-')),a=blankNode({prompt:'first'}),b=blankNode({prompt:'second',dependsOn:[a.id],order:1});
 atomic(path.join(dir,'input.json'),{id:'review-test',tree:blankTree({cwd:dir,nodes:[a,b]}),machines:[{id:'local'}],runnerId:'local',herdr:{nodes:{[a.id]:{},[b.id]:{}}}});
 const previous=execution.runInHerdr;let calls=0;
 execution.runInHerdr=async()=>({response:'根拠不足',outcome:++calls===1?'needs_review':'completed',assessment:{outcome:'needs_review',detail:'根拠不足'}});
 const pending=runWorker(dir);
 try{
  const deadline=Date.now()+5000;
  while(JSON.parse(fs.readFileSync(path.join(dir,'state.json'))).status!=='review') {assert(Date.now()<deadline);await new Promise(r=>setTimeout(r,20));}
  assert.equal(calls,1);
  atomic(path.join(dir,'control.json'),{id:'approve',action:'approve',nodeId:a.id});
  const state=await pending;
  assert.equal(state.status,'succeeded');assert.equal(calls,2);
  assert.equal(state.nodes[a.id].outcome,'completed');assert.equal(state.nodes[a.id].confirmedByUser,true);
  assert.equal(state.nodes[a.id].assessment.outcome,'needs_review');
 }finally{execution.runInHerdr=previous;}
});
for (const outcome of ['completed','error','unexpected','cli-error']) test('worker records '+outcome+' and only advances on completion',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wt-outcome-')),a=blankNode({prompt:'first'}),b=blankNode({prompt:'second',dependsOn:[a.id],order:1});
 atomic(path.join(dir,'input.json'),{id:'outcome-test',tree:blankTree({cwd:dir,nodes:[a,b]}),machines:[{id:'local'}],runnerId:'local',herdr:{nodes:{[a.id]:{},[b.id]:{}}}});
 const previous=execution.runInHerdr; let calls=0;
 execution.runInHerdr=async()=>{calls++;if(outcome==='cli-error')throw Error('CLI failed');return{response:'確認結果',outcome,confirmedByUser:true};};
 try {
  const result=await runWorker(dir);
  assert.equal(calls,outcome==='completed'?2:1);
  assert.equal(result.nodes[a.id].outcome,outcome==='cli-error'?'error':outcome);
  assert.equal(result.nodes[b.id].status,outcome==='completed'?'succeeded':'pending');
  assert.equal(result.status,outcome==='completed'?'succeeded':'failed');
 }finally{execution.runInHerdr=previous;}
});
