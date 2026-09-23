'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { refreshReport, workChanged } = require('../lib/orca-revision.cjs');
function fixture(t, mode = 'notify') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-revision-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const binding = { handle:'work', incarnationId:'inc', worktreeId:'wt', hostId:'host', tool:'codex' };
  const old = { key:'old', token:'token', threadId:'thread', turnId:'old-turn', response:'old result' };
  const state = { sends:[], idle:true, replaced:false, lost:false, match:true };
  const context = { target:{}, runDir:dir, pollMs:1, invoke:async (_, args) => {
    if (args[1] === 'show') return { terminal:{ ...binding, incarnationId:state.replaced?'other':'inc', executionHostId:'host', connected:true, writable:true, agentIdentity:'codex' } };
    if (args[1] === 'wait') return { wait:{ handle:'work', satisfied:state.idle } };
    if (args[1] === 'send') { state.sends.push(args[args.indexOf('--text')+1]); if (state.lost) throw Error('ack lost'); return {send:{accepted:true}}; }
    if (args[1] === 'read') return { terminal:{handle:'work',source:'screen',tail:['• '+(state.sends.length ? state.sends[0].split('\n')[0] : 'old result'),'Worked for 1m','› Ask Codex to do anything']} };
    throw Error('Unexpected mutation '+args[1]);
  }, notifications:{request:async()=>{
    const prompt = state.sends[0];
    const event = prompt ? {...old,key:'new',turnId:'new-turn',response:'revised result',inputMessages:[state.match?prompt:'other prompt']} : old;
    return {events:prompt?[old,event]:[old],activity:{supported:true,completed:true,turnId:event.turnId,fingerprint:prompt?'new':'old'}};
  }}};
  const work = { binding, ...(mode === 'notify' ? {notification:{context:{token:'token'}},event:old,fingerprint:'old'} : {}) };
  const config = {id:'task',criteria:'new criteria',timeoutMinutes:0.001};
  return {context,work,config,state};
}
test('updated report is requested once in the original pane and replaces the old turn',async t=>{
  const f=fixture(t);const result=await refreshReport(f.context,f.config,f.work);
  assert.equal(f.state.sends.length,1);assert.equal(result.event.response,'revised result');assert.equal(result.fingerprint,'new');
  assert.match(f.state.sends[0],/new criteria/);assert.equal(await workChanged(f.context,f.work),true);assert.equal(await workChanged(f.context,result),false);
});
test('manual report remains needs-review even when the assistant says work is finished',async t=>{
  const f=fixture(t,'manual');const result=await refreshReport(f.context,f.config,f.work);
  assert.equal(result.manualResult.outcome,'needs_review');assert.match(result.manualResult.workResponse,/TaskDesk/);
});
for(const mode of ['busy','replaced','lost','unrelated']) test('report recovery never accepts stale output or retries: '+mode,async t=>{
  const f=fixture(t);if(mode==='busy')f.state.idle=false;if(mode==='replaced')f.state.replaced=true;if(mode==='lost')f.state.lost=true;if(mode==='unrelated')f.state.match=false;
  const result=await refreshReport(f.context,f.config,f.work);
  assert.equal(result.failed.outcome,'needs_review');assert.equal(result.failed.resultStale,true);
  assert.equal(f.state.sends.length,['lost','unrelated'].includes(mode)?1:0);
});
