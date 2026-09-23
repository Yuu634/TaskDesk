'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {blankTree,blankNode}=require('../lib/core.cjs');
const {createTaskPrompt,previousReport,recordReport}=require('../lib/task-reports.cjs');
test('task prompt preserves instructions and criteria but references only dependency reports',()=>{
  const a=blankNode({id:'a',title:'Prior'}), unrelated=blankNode({id:'unrelated'});
  const wp=blankNode({id:'wp',kind:'wp',prompt:'Shared constraint'});
  const b=blankNode({id:'b',parentId:'wp',prompt:'Current instruction',criteria:'Required evidence',dependsOn:['a']});
  const tree=blankTree({id:'tree',cwd:'/project',description:'Research context',nodes:[wp,a,b,unrelated],notionContext:['NOTION_BODY']});
  const value=createTaskPrompt(tree,b,{a:{response:'OLD_BODY'.repeat(10000),report:{path:'/project/reports/a.md',hostId:'local',status:'reported'}},unrelated:{response:'UNRELATED_BODY'}},'run');
  for(const text of ['Shared constraint','Current instruction','Required evidence','Research context','/project/reports/a.md'])assert(value.prompt.includes(text));
  for(const text of ['OLD_BODY','UNRELATED_BODY','NOTION_BODY'])assert(!value.prompt.includes(text));
  assert.equal(value.refs.length,1);assert.equal(value.report.path,'/project/.taskdesk/reports/tree/b/run.md');
  assert.equal(value.report.verified,false);
});
test('missing and other-machine reports remain explicit and unverified',()=>{
  const a=blankNode({id:'a'}),b=blankNode({dependsOn:['a']});
  const tree=blankTree({cwd:'/work',nodes:[a,b]});
  assert.equal(createTaskPrompt(tree,b,{},'r').refs[0].reportPath,null);
  const ref=createTaskPrompt(tree,b,{a:{report:{path:'/remote/a.md',hostId:'ssh:g15'}}},'r').refs[0];
  assert.match(ref.availability,/別マシン/);assert.equal(ref.verified,false);
});
test('legacy report references and reassessment preserve report path without claiming existence',()=>{
  const node=blankNode(),tree=blankTree({executionBackend:'orca',orca:{hostId:'ssh:g15',path:'/remote'},nodes:[node]});
  const report=previousReport(tree,node,{response:'Report: docs/design/README.md'});
  assert.equal(report.path,'/remote/docs/design/README.md');assert.equal(report.hostId,'ssh:g15');
  assert.equal(createTaskPrompt(tree,node,{},'new-run',report).report.path,report.path);
  assert.equal(recordReport(report,'No report saved').status,'legacy-reference');
  const saved=recordReport(report,'TASKDESK_REPORT: /remote/docs/design/README.md');
  assert.equal(saved.status,'reported');assert.equal(saved.verified,false);
});
