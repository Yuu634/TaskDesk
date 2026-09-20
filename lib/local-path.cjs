'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assert } = require('./core.cjs');
const isWSL = process.platform === 'linux' && /microsoft/i.test(os.release());

// Translate drive paths only for local execution under WSL. Remote paths must
// retain the spelling expected by the remote host. Saved plans stay portable.
function localPath(value, wsl = isWSL) {
  if (wsl && /^[a-z]:[\\/]/i.test(value)) return '/mnt/' + value[0].toLowerCase() + '/' + value.slice(3).replaceAll('\\', '/');
  return value;
}
function executionTree(source, runner, wsl = isWSL) {
  const tree = structuredClone(source);
  if (runner.type !== 'local') return tree;
  for (const node of tree.nodes.filter(n => n.kind === 'task')) {
    if ((node.machineId || tree.machineId) !== 'local') continue;
    const original = node.cwd || tree.cwd;
    const resolved = localPath(original, wsl);
    assert(resolved?.trim(), '作業ディレクトリを指定してください: ' + node.title);
    assert(path.isAbsolute(resolved), '実行マシン上の絶対パスを指定してください: ' + node.title + ' · ' + original);
    let directory = false;
    try { directory = fs.statSync(resolved).isDirectory(); } catch {}
    assert(directory, '作業ディレクトリが見つかりません: ' + node.title + ' · ' + resolved + (resolved !== original ? '（Windows パスから変換）' : ''));
    node.cwd = resolved;
  }
  return tree;
}
module.exports = { isWSL, localPath, executionTree };
