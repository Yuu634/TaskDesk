'use strict';
const { assert, orderedTasks } = require('./core.cjs');

// Keep dependency edges and ancestor prompts intact in a partial execution.
function selectExecution(tree, nodeId) {
  const byId = new Map(tree.nodes.map(n => [n.id, n]));
  const root = byId.get(nodeId);
  assert(root, '実行するノードが見つかりません');
  const selected = new Set();
  function addTask(node) {
    if (selected.has(node.id)) return;
    selected.add(node.id);
    node.dependsOn.forEach(id => addTask(byId.get(id)));
  }
  function descend(node) {
    if (node.kind === 'task') addTask(node);
    else tree.nodes.filter(n => n.parentId === node.id).forEach(descend);
  }
  descend(root);
  assert(selected.size, '実行するタスクがありません');
  for (const id of [...selected]) {
    let parent = byId.get(id).parentId;
    while (parent) { selected.add(parent); parent = byId.get(parent).parentId; }
  }
  const result = { ...tree, nodes: tree.nodes.filter(n => selected.has(n.id)) };
  assert(orderedTasks(result).length, '実行するタスクがありません');
  return result;
}
module.exports = { selectExecution };
