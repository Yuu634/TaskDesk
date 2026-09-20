(function (root) {
  'use strict';
  function nextExecution(tree, states = {}) {
    const ordered = [];
    function walk(parent) { tree.nodes.filter(n => n.parentId === parent).sort((a, b) => a.order - b.order).forEach(n => n.kind === 'group' ? walk(n.id) : ordered.push(n)); }
    walk(null);
    const task = ordered.find(n => !['succeeded', 'running', 'review'].includes(states[n.id]?.status) && n.dependsOn.every(id => states[id]?.status === 'succeeded')) || null;
    const wp = task?.parentId ? tree.nodes.find(n => n.id === task.parentId) || null : null;
    return { task, wp, complete: ordered.length > 0 && ordered.every(n => states[n.id]?.status === 'succeeded') };
  }
  function executionProgress(tree, runs) {
    const result = {};
    for (const run of runs) {
      if (run.treeId !== tree.id || run.treeRevision !== tree.revision || !['node', 'tree'].includes(run.kind)) continue;
      for (const [id, state] of Object.entries(run.state?.nodes || {})) if (!result[id] && state.status !== 'pending') result[id] = state;
    }
    return result;
  }
  if (typeof module === 'object' && module.exports) module.exports = { nextExecution, executionProgress };
  else root.TaskDeskExecution = { nextExecution, executionProgress };
})(typeof globalThis === 'object' ? globalThis : this);
