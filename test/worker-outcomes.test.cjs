'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {blankTree,blankNode,atomic}=require('../lib/core.cjs');
const {runWorker}=require('../lib/worker.cjs');
const execution=require('../lib/herdr-execution.cjs');
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
