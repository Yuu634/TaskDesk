'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { blankTree, blankNode } = require('../lib/core.cjs');
const { localPath, executionTree } = require('../lib/local-path.cjs');

test('Windows drive paths are mapped only for local WSL execution', () => {
  assert.equal(localPath('C:\\Users\\user\\my project', true), '/mnt/c/Users/user/my project');
  assert.equal(localPath('D:/project/src', true), '/mnt/d/project/src');
  assert.equal(localPath('C:\\project', false), 'C:\\project');
  assert.equal(localPath('relative/path', true), 'relative/path');
  const remote = blankTree({ cwd: 'C:\\remote', nodes: [blankNode({ machineId: 'ssh' })] });
  assert.deepEqual(executionTree(remote, { type: 'local' }, true), remote);
  assert.deepEqual(executionTree(remote, { type: 'ssh' }, true), remote);
});
test('local path validation applies to the execution snapshot without rewriting saved settings', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'work-tree-path-'));
  try {
    const tree = blankTree({ cwd, nodes: [blankNode({ title: 'Task' })] });
    const snapshot = executionTree(tree, { type: 'local' });
    assert.equal(snapshot.nodes[0].cwd, cwd);
    assert.equal(tree.nodes[0].cwd, '');
    tree.cwd = path.join(cwd, 'missing');
    assert.throws(() => executionTree(tree, { type: 'local' }), /作業ディレクトリが見つかりません: Task/);
    tree.cwd = 'relative';
    assert.throws(() => executionTree(tree, { type: 'local' }), /絶対パス/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
