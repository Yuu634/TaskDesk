'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {blankTree,blankNode,atomic}=require('../lib/core.cjs');
const {runWorker}=require('../lib/worker.cjs');
const execution=require('../lib/herdr-execution.cjs');
test('worker forwards persisted report references and records the new report without historical body',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'td-reports-'));
 const a=blankNode({id:'a',title:'Previous'}),b=blankNode({id:'b',prompt:'Current work',criteria:'Evidence',dependsOn:['a'],order:1});
 const tree=blankTree({id:'tree',cwd:dir,nodes:[a,b]});
 const prior={path:'/archive/a.md',hostId:'remote',status:'reported',verified:false};
 atomic(path.join(dir,'input.json'),{id:'reports-run',kind:'tree',tree,completed:['a'],previousResults:{a:'OLD_TRANSCRIPT'},previousReports:{a:prior},machines:[{id:'local'}],runnerId:'local',herdr:{nodes:{b:{}}}});
 const old=execution.runInHerdr;
 execution.runInHerdr=async(context,config,machine,prompt)=>{
  assert(prompt.includes('/archive/a.md'));assert(!prompt.includes('OLD_TRANSCRIPT'));
  const output=require('../lib/task-reports.cjs').createTaskPrompt(tree,b,{},'reports-run').report.path;
  return {response:'TASKDESK_REPORT: '+output,outcome:'completed'};
 };
 try {
  const state=await runWorker(dir);
  assert.equal(state.status,'succeeded');assert.deepEqual(state.nodes.a.report,prior);
  assert.equal(state.nodes.b.report.status,'reported');assert.equal(state.nodes.b.report.verified,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'))).nodes.b.reportReferences[0].hostId,'remote');
 }finally{execution.runInHerdr=old;}
});
for (const stop of [false,true]) test('a delayed Orca observation cannot undo a saved manual completion, stop='+stop,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wt-label-race-')),a=blankNode({prompt:'A'});
 atomic(path.join(dir,'input.json'),{id:'race',tree:blankTree({cwd:dir,nodes:[a]}),machines:[{id:'local'}],runnerId:'local',orca:{nodes:{[a.id]:{hostId:'local',path:dir}}}});
 const orca=require('../lib/orca-execution.cjs'),revision=require('../lib/orca-revision.cjs');
 const oldRun=orca.runInOrca,oldObserve=revision.workChanged;let release,observing=false;
 orca.runInOrca=async()=>({response:'done',outcome:'needs_review',reassessment:{binding:{}}});
 revision.workChanged=()=>{observing=true;return new Promise(r=>{release=r;});};
 const pending=runWorker(dir),file=path.join(dir,'state.json');
 const wait=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){assert(Date.now()<deadline);await new Promise(r=>setTimeout(r,20));}};
 try {
  await wait(()=>observing);
  atomic(path.join(dir,'control.json'),{id:'label',action:'label',nodeId:a.id,outcome:'completed',note:'checked'});
  await wait(()=>JSON.parse(fs.readFileSync(file)).nodes[a.id].manualLabel?.outcome==='completed');
  if(stop){atomic(path.join(dir,'control.json'),{id:'stop',action:'stop'});await wait(()=>JSON.parse(fs.readFileSync(file)).status==='stopping');}
  release(true);const state=await pending;
  assert.equal(state.nodes[a.id].status,'succeeded');assert.equal(state.nodes[a.id].outcome,'completed');assert.equal(state.nodes[a.id].resultStale,false);
  assert.equal(state.status,stop?'cancelled':'succeeded');
 }finally {release?.(false);orca.runInOrca=oldRun;revision.workChanged=oldObserve;}
});
test('manual completion mode waits for human approval even after AI success and stays inside the selected tasks',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wt-manual-mode-')),a=blankNode({prompt:'first'}),b=blankNode({prompt:'second',dependsOn:[a.id],order:1});
 atomic(path.join(dir,'input.json'),{id:'manual-test',tree:blankTree({completionMode:'manual',cwd:dir,nodes:[a,b]}),machines:[{id:'local'}],runnerId:'local',herdr:{nodes:{[a.id]:{},[b.id]:{}}}});
 const previous=execution.runInHerdr;let calls=0;execution.runInHerdr=async()=>{calls++;return{response:'AI passed',outcome:'completed'};};
 const pending=runWorker(dir);
 try {
  for(const node of [a,b]) {
   const deadline=Date.now()+5000;let state;
   do {await new Promise(r=>setTimeout(r,20));state=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));assert(Date.now()<deadline);} while(state.status!=='review'||state.currentNodeId!==node.id);
   assert.equal(state.nodes[node.id].outcome,'needs_review');
   if(node===a){assert.equal(calls,1);assert.equal(state.nodes[b.id].status,'pending');}
   atomic(path.join(dir,'control.json'),{id:node.id,action:'label',nodeId:node.id,outcome:'completed',note:'checked'});
  }
  assert.equal((await pending).status,'succeeded');assert.equal(calls,2);
 }finally {execution.runInHerdr=previous;}
});
test('review reassessment uses original work and updates outcome without rerunning work',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wt-reassess-')),a=blankNode({prompt:'first'});
 atomic(path.join(dir,'input.json'),{id:'reassess-test',tree:blankTree({cwd:dir,nodes:[a]}),machines:[{id:'local'}],runnerId:'local',orca:{nodes:{[a.id]:{hostId:'local',path:dir}}}});
 const orca=require('../lib/orca-execution.cjs'),previous=orca.runInOrca;let calls=0;
 orca.runInOrca=async (context,config)=>{calls++;if(calls===2){assert.equal(context.reassessment.work,'original');assert.equal(context.reassessment.refreshReport,true);assert(context.reassessment.report.path.includes('reassess-test.md'));assert.equal(config.criteria,'updated criteria');}return{response:calls===1?'修正前の判定':'更新版の判定',workResponse:calls===1?'old':'new',outcome:calls===1?'needs_review':'completed',assessment:{outcome:calls===1?'needs_review':'completed'},reassessment:{work:'original'}};};
 const pending=runWorker(dir);
 try{
  const deadline=Date.now()+5000;
  while(JSON.parse(fs.readFileSync(path.join(dir,'state.json'))).status!=='review'){assert(Date.now()<deadline);await new Promise(r=>setTimeout(r,20));}
  atomic(path.join(dir,'control.json'),{id:'reassess',action:'reassess',nodeId:a.id,refreshReport:true,criteria:'updated criteria'});
  const state=await pending;assert.equal(state.status,'succeeded');assert.equal(calls,2);assert.equal(state.nodes[a.id].assessmentHistory[0].outcome,'needs_review');assert.equal(state.nodes[a.id].outcome,'completed');
  assert.equal(state.nodes[a.id].resultHistory[0].workResponse,'old');assert.equal(state.nodes[a.id].workResponse,'new');assert.equal(state.nodes[a.id].resultStale,false);
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
