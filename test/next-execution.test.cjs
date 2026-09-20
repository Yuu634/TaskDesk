'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { nextExecution, executionProgress } = require('../public/next-execution.js');
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
