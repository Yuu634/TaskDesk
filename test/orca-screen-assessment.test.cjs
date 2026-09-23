'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {parseScreen,runScreenAssessment,workFingerprint}=require('../lib/orca-screen-assessment.cjs');
const {blankTree,blankNode,configFor}=require('../lib/core.cjs');
const binding={handle:'work',incarnationId:'i-work',worktreeId:'wt',hostId:'ssh:g15',tabId:'tab',tool:'codex',path:'/project'};
const frame=(handle,lines)=>({terminal:{handle,source:'screen',tail:[...lines,'Worked for 1m','› Ask Codex to do anything']}});
const output=(id='request',taskId='task',status='met')=>['• TASKDESK_ASSESSMENT_BEGIN '+id,JSON.stringify({requestId:id,taskId,criteria:[{id:1,status,evidence:'file.txt:1'}]}),'TASKDESK_ASSESSMENT_END '+id];
test('screen parser rejects stale, echoed, incomplete and mismatched responses',()=>{
 assert(parseScreen(frame('work',output()),binding,'request','task'));
 assert.equal(parseScreen(frame('work',output('old')),binding,'request','task'),null);
 assert.equal(parseScreen(frame('work',output('request','other')),binding,'request','task'),null);
 assert.equal(parseScreen(frame('work',output().slice(0,2)),binding,'request','task'),null);
 assert.equal(parseScreen(frame('work',['• Earlier answer','› '+output().join('\n')]),binding,'request','task'),null);
 assert.equal(parseScreen(frame('other',output()),binding,'request','task'),null);
 assert.equal(parseScreen(frame('work',[...output(),'• Working (1s · esc to interrupt)']),binding,'request','task'),null);
});
test('completed JSON without Worked for survives wrapped IDs and animated footer',()=>{
 const screen=frame('work',output());
 screen.terminal.tail=screen.terminal.tail.filter(s=>!s.startsWith('Worked for'));
 screen.terminal.tail.splice(3,0,'  done 1:29 AM','⠁ ⠄ ⢀');
 screen.terminal.tail[1]=screen.terminal.tail[1].replace('requestId','requestId').replace('request','req\n  uest');
 assert(parseScreen(screen,binding,'request','task'));
 assert.equal(workFingerprint('• Final answer\n  Worked for 1m\n› input'),workFingerprint('• Final\n answer\n  done 1:29 AM\n⠁ ⠄\n› input'));
 assert.notEqual(workFingerprint('• Final answer\n› input'),workFingerprint('• Changed answer\n› input'));
});
for(const scenario of ['success','animated','unmet','changed','wrong-id','lost-split','recovered-split','unrelated-pane','ambiguous','cancel','verification'])test('Orca-only assessment: '+scenario,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'td-screen-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const node=blankNode({id:'task',prompt:'Inspect artifact',criteria:'Artifact exists'}),tree=blankTree({cwd:'/project',nodes:[node]});
 const config=configFor(tree,node);if(scenario==='verification')config.verification={autoComplete:true};
 const workScreen=frame('work',['• Work finished']),work={binding,baselineResponse:workScreen.terminal.tail.join('\n'),report:{path:'/project/report.md'}};
 let requestId,splits=0,closed=0,reads=0;const controller=new AbortController();
 const invoke=async(_,args)=>{
  const op=args[1],handle=args[3];
  if(op==='list')return {terminals:splits&&['recovered-split','unrelated-pane','ambiguous'].includes(scenario)?(scenario==='ambiguous'?['judge','another']:['judge']).map(handle=>({handle,tabId:'tab',worktreeId:'wt',executionHostId:'ssh:g15',connected:true})):[],truncated:false};
  if(op==='show')return {terminal:{handle,incarnationId:'i-'+handle,worktreeId:'wt',executionHostId:'ssh:g15',tabId:'tab',agentIdentity:'codex',connected:true,writable:true}};
  if(op==='wait')return {wait:{handle,satisfied:true}};
  if(op==='read'){
   const screen=structuredClone(handle==='work' ? scenario==='changed'&&splits ? frame('work',['• Changed work']) : workScreen : frame(handle,output(['wrong-id','unrelated-pane'].includes(scenario)?'old':requestId,'task',scenario==='unmet'?'unmet':'met')));
   if(scenario==='animated'){screen.terminal.tail=screen.terminal.tail.filter(s=>!s.startsWith('Worked for'));screen.terminal.tail.splice(-1,0,'  done 1:29 AM','⠁ '+ ++reads);}
   return screen;
  }
  if(op==='split'){
   splits++;
   const command=args[args.indexOf('--command')+1];
   const encoded=command.match(/WORK_TREE_ORCA_INPUT='([^']+)'/)[1],payload=JSON.parse(Buffer.from(encoded,'base64'));
   requestId=payload.initialPrompt.match(/requestId=([\w-]+)/)[1];
   assert(payload.initialPrompt.includes('/project/report.md'));assert(payload.args.includes('read-only'));
   if(['lost-split','recovered-split','unrelated-pane','ambiguous'].includes(scenario))throw Error('Timed out waiting for split pane handle');
   if(scenario==='cancel')controller.abort();
   return {terminal:{handle:'judge'}};
  }
  if(op==='close'){closed++;return {};}
  throw Error('Unexpected operation '+op);
 };
 const context={invoke,target:{},nodes:{task:{...binding,platform:'linux'}},runDir:dir,runId:'run',pollMs:1,assessmentTimeoutMs:25,splitRecoveryMs:25};
 if(scenario==='cancel'){await assert.rejects(runScreenAssessment(context,config,work,{signal:controller.signal}));assert.equal(closed,1);}
 else {const result=await runScreenAssessment(context,config,work);assert.equal(result.outcome,['success','animated','recovered-split'].includes(scenario)?'completed':'needs_review',result.assessment.detail);assert.equal(result.assessment.source,'orca-screen-pane');}
 assert.equal(splits,1);
});
