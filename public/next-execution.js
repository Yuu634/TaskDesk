(function (root) {
  'use strict';
  const canonical = value => JSON.stringify(value, function (key, item) {
    return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
  });
  function taskDefinitions(tree) {
    const definitions = {}, visiting = new Set();
    function definition(id) {
      if (definitions[id]) return definitions[id];
      const n = tree.nodes.find(n => n.id === id);
      if (!n || visiting.has(id)) return 'invalid';
      visiting.add(id);
      const ancestors = []; let parent = n.parentId;
      const seen = new Set();
      while (parent && !seen.has(parent)) {
        seen.add(parent); const p = tree.nodes.find(n => n.id === parent); if (!p) break;
        ancestors.unshift([p.title || '', p.prompt || '']); parent = p.parentId;
      }
      const orca = n.orca || tree.orca;
      definitions[id] = canonical({
        title: n.title || '', prompt: n.prompt || '', criteria: n.criteria || '', ancestors,
        description: tree.description || '', backend: tree.executionBackend || 'direct',
        tool: n.tool || tree.tool, machineId: n.machineId || tree.machineId, cwd: n.cwd || tree.cwd,
        orca: orca && Object.fromEntries(['projectId','hostId','worktreeId','identityKey','executable'].map(k => [k, orca[k] || ''])),
        model: n.model || '', env: n.env || {}, sandbox: n.sandbox, claudePermission: n.claudePermission,
        cli: { ...(tree.cli || {}), ...Object.fromEntries(Object.entries(n.cli || {}).map(([k,v]) => [k, { ...tree.cli?.[k], ...v }])) },
        attachments: [...(tree.attachments || []), ...(n.attachments || [])], verification: n.verification || null,
        dependencies: [...(n.dependsOn || [])].sort()
      });
      visiting.delete(id); return definitions[id];
    }
    tree.nodes.filter(n => n.kind === 'task').forEach(n => definition(n.id));
    return Object.fromEntries(Object.keys(definitions).map(id => {
      const dependencies = new Set();
      function collect(key) {
        for (const dep of tree.nodes.find(n => n.id === key)?.dependsOn || []) {
          if (dependencies.has(dep)) continue;
          dependencies.add(dep); collect(dep);
        }
      }
      collect(id);
      return [id, canonical([definitions[id], [...dependencies].sort().map(dep => [dep, definitions[dep] || 'missing'])])];
    }));
  }
  function taskMatches(tree, run, id, definitions = taskDefinitions(tree)) {
    return run.treeId === tree.id && (run.taskDefinitions ? run.taskDefinitions[id] === definitions[id] && definitions[id] !== undefined : run.treeRevision === tree.revision);
  }
  function taskRun(tree, runs, id) {
    const run = runs.find(r => r.treeId === tree.id && ['node','tree'].includes(r.kind) && meaningfulAttempt(r.state?.nodes?.[id]));
    return run && taskMatches(tree, run, id) ? run : null;
  }
  function meaningfulAttempt(state) {
    if (!state || state.status === 'pending' || state.reused) return false;
    // An explicitly stopped launch with no observed AI work/result does not
    // replace an earlier completion. Real failures and observed work still do.
    return !(state.status === 'cancelled' && state.interactive?.promptSent === true && state.interactive.executionStarted === false && !state.response && !state.workResponse && !state.outcome && !state.resultStale);
  }
  function nextExecution(tree, states = {}) {
    const ordered = [];
    function walk(parent) { tree.nodes.filter(n => n.parentId === parent).sort((a, b) => a.order - b.order).forEach(n => n.kind === 'group' ? walk(n.id) : ordered.push(n)); }
    walk(null);
    const blocked = ordered.some(n => ['running','review'].includes(states[n.id]?.status) || states[n.id]?.outcome === 'needs_review' && !['cancelled','failed','interrupted'].includes(states[n.id]?.status));
    const task = !blocked && ordered.find(n => !['succeeded', 'running', 'review'].includes(states[n.id]?.status) && n.dependsOn.every(id => states[id]?.status === 'succeeded')) || null;
    const wp = task?.parentId ? tree.nodes.find(n => n.id === task.parentId) || null : null;
    return { task, wp, complete: ordered.length > 0 && ordered.every(n => states[n.id]?.status === 'succeeded') };
  }
  function executionProgress(tree, runs) {
    const result = {}, seen = new Set(), definitions = taskDefinitions(tree);
    for (const run of runs) {
      if (run.treeId !== tree.id || !['node', 'tree'].includes(run.kind)) continue;
      for (const [id, state] of Object.entries(run.state?.nodes || {})) {
        if (seen.has(id) || !meaningfulAttempt(state)) continue;
        seen.add(id);
        if (taskMatches(tree, run, id, definitions)) result[id] = state;
      }
    }
    return result;
  }
  if (typeof module === 'object' && module.exports) module.exports = { nextExecution, executionProgress, taskDefinitions, taskMatches, taskRun };
  else root.TaskDeskExecution = { nextExecution, executionProgress, taskDefinitions, taskMatches, taskRun };
})(typeof globalThis === 'object' ? globalThis : this);
