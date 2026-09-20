'use strict';
const { ensureService } = require('../lib/herdr.cjs');
const { call, targetFor } = require('../lib/herdr-execution.cjs');
const { serverUrl } = require('../lib/task-terminal.cjs');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('npm run herdr -- [--tree ツリーID] [--session default] [--focus]\n各ツリーのSpaceと管理画面を作成・再利用し、herdr実行を有効にします。AIはノード実行時に起動します。'); return; }
  let treeId, session = 'default', focus = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tree' && args[i + 1]) treeId = args[++i];
    else if (args[i] === '--session' && args[i + 1]) session = args[++i];
    else if (args[i] === '--focus') focus = true;
    else if (args[i] !== '--down') throw new Error('不明な引数: ' + args[i]);
  }
  if (process.env.HERDR_ENV !== '1') throw new Error('herdr 内のターミナルから実行してください');
  if (process.platform === 'win32') throw new Error('WSL / Linux / macOS で実行してください');
  const target = targetFor(session), client = await ensureService(serverUrl());
  const state = await client.request('/api/state');
  if (!state.server?.capabilities?.includes('herdr-execution')) throw new Error('起動中の TaskDesk サーバーが旧バージョンです。ファイルの更新だけでは起動中のサーバーに反映されません。\n同じ環境・保存先で npm run restart を実行し、その後 npm run herdr を再実行してください。\nnpm start で起動した場合は、元のターミナルで Ctrl+C → npm run background で再起動してください。');
  const trees = state.trees.filter(t => !treeId || t.id === treeId);
  if (!trees.length) throw new Error('対象のツリーがありません。Web画面で作成してください');
  for (const tree of trees) {
    const opened = await client.request('/api/herdr/open', 'POST', { treeId: tree.id, session });
    console.log(tree.name + ': Space ' + opened.workspaceId + ' / 管理ペイン ' + opened.paneId);
    if (focus) await call(target, ['workspace', 'focus', opened.workspaceId]);
  }
  console.log('Web: ' + client.url + '/');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
