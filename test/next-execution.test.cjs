'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { nextExecution, executionProgress } = require('../public/next-execution.js');
const { taskDefinitions, taskRun } = require('../public/next-execution.js');
test('cancelled unconfirmed relaunch preserves completion and cancelled review can be retried', () => {
 const tree={id:'t',revision:1,nodes:['a','b','c','d'].map((id,i)=>({id,kind:'task',parentId:null,order:i,dependsOn:i?['abcd'[i-1]]:[]}))};
 const run=nodes=>({treeId:'t',treeRevision:1,kind:'node',state:{status:'cancelled',nodes}});
 const completed=run({a:{status:'succeeded'},b:{status:'succeeded'},c:{status:'succeeded'}});
 const stopped=run({a:{status:'cancelled',interactive:{promptSent:true,executionStarted:false}}});
 const cancelledReview=run({d:{status:'cancelled',outcome:'needs_review',resultStale:true}});
 const runs=[stopped,cancelledReview,completed];
 assert.equal(taskRun(tree,runs,'a'),completed);
 assert.equal(nextExecution(tree,executionProgress(tree,runs)).task.id,'d');
 stopped.state.nodes.a.interactive.executionStarted=true;
 assert.equal(nextExecution(tree,executionProgress(tree,runs)).task.id,'a');
 stopped.state.nodes.a={status:'failed',outcome:'error'};
 assert.equal(executionProgress(tree,runs).a.status,'failed');
 cancelledReview.state.nodes.d.status='review';
 assert.equal(nextExecution(tree,executionProgress(tree,runs)).task,null);
});
test('completion follows task content across edits and never falls back past a newer attempt', () => {
  const tree = { id:'t', revision:1, nodes:[
    {id:'a',kind:'task',parentId:null,order:0,prompt:'A',criteria:'tested',dependsOn:[]},
    {id:'b',kind:'task',parentId:null,order:1,prompt:'B',dependsOn:['a']}
  ] };
  const run = {treeId:'t',treeRevision:1,kind:'node',taskDefinitions:taskDefinitions(tree),state:{nodes:{a:{status:'succeeded',outcome:'completed'}}}};
  tree.revision++;tree.nodes[1].prompt='B edited';
  assert.equal(executionProgress(tree,[run]).a.status,'succeeded');
  assert.equal(taskRun(tree,[run],'a'),run);
  assert.equal(nextExecution(tree,executionProgress(tree,[run])).task.id,'b');
  tree.nodes[0].criteria='new criteria';
  assert.equal(executionProgress(tree,[run]).a,undefined);
  assert.equal(taskRun(tree,[run],'a'),null);
  tree.nodes[0].criteria='tested';
  const failed={...run,state:{nodes:{a:{status:'failed',outcome:'error'}}}};
  assert.equal(executionProgress(tree,[failed,run]).a.status,'failed');
  const review={...run,state:{nodes:{a:{status:'review',outcome:'needs_review'}}}};
  assert.equal(nextExecution(tree,executionProgress(tree,[review,run])).task,null);
  const before=taskDefinitions(tree);tree.nodes[0].prompt='changed prerequisite';
  assert.notEqual(taskDefinitions(tree).b,before.b);
});
test('next execution follows order and dependencies, and ignores old revisions', () => {
  const tree = { id: 't', revision: 2, nodes: [
    { id: 'wp', parentId: null, kind: 'group', order: 0 },
    { id: 'b', parentId: 'wp', kind: 'task', order: 0, dependsOn: ['a'] },
    { id: 'a', parentId: 'wp', kind: 'task', order: 1, dependsOn: [] }
  ] };
  assert.equal(nextExecution(tree).task.id, 'a');
  const states = executionProgress(tree, [
    { treeId: 't', treeRevision: 1, kind: 'tree', state: { nodes: { b: { status: 'succeeded' } } } },
    { treeId: 't', treeRevision: 2, kind: 'node', state: { nodes: { a: { status: 'succeeded' }, b: { status: 'pending' } } } }
  ]);
  assert.equal(nextExecution(tree, states).task.id, 'b');
  assert.equal(nextExecution(tree, states).wp.id, 'wp');
  states.b = { status: 'succeeded' };
  assert.equal(nextExecution(tree, states).complete, true);
});
