'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { atomic, read } = require('../lib/core.cjs');
const { localUrl } = require('../lib/local-http.cjs');
const { assertRuntimeProfile } = require('../lib/executor.cjs');
const root = path.resolve(__dirname, '..');
const dir = path.resolve(process.env.WORK_TREE_DATA || path.join(root, '.work-tree'));
const file = path.join(dir, 'service.json');
const delay = ms => new Promise(r => setTimeout(r, ms));
function verifyService(existing, state, expectedDir = dir) {
  if (state.server?.pid !== existing.pid) throw new Error('プロセスが一致しません。別のプロセスは停止しません');
  if (state.server.platform !== process.platform) throw new Error('別の環境で起動したサーバーです。起動元の環境で停止してください');
  if (state.server.dataDir && path.resolve(state.server.dataDir) !== expectedDir) throw new Error('保存先が一致しません。別のサーバーは停止しません');
}
async function stop(existing) {
  if (!existing) throw new Error('バックグラウンドサーバーの記録がありません。npm start で起動した場合は、そのターミナルで Ctrl+C を押してから npm run background を実行してください');
  let state;
  try { state = await (await fetch('http://127.0.0.1:' + existing.port + '/api/state', { signal: AbortSignal.timeout(2000) })).json(); }
  catch { throw new Error('サーバーを確認できません。別のプロセスは停止しません'); }
  verifyService(existing, state);
  if (state.runs?.some(r => r.state.status === 'starting' && r.pid === existing.pid)) throw new Error('herdr の実行準備中です。タスクの開始後に再起動してください');
  process.kill(existing.pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    await delay(100);
    const lock = read(path.join(dir, 'server.lock'));
    if (!lock || lock.pid !== existing.pid) {
      if (read(file)?.pid === existing.pid) fs.unlinkSync(file);
      console.log('Web サーバーを停止しました。実行中のワーカーは継続します'); return;
    }
  }
  throw new Error('サーバーの終了待ちがタイムアウトしました。二重起動は行いません');
}
async function main() {
  const action = process.argv[2] || 'start';
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('使用方法: node scripts/service.cjs start|stop|restart');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = read(file);
  if (action === 'stop' || action === 'restart') {
    await stop(existing);
    if (action === 'stop') return;
  }
  assertRuntimeProfile();
  const port = Number(process.env.PORT || (action === 'restart' && existing?.port) || 4317);
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/api/state', { signal: AbortSignal.timeout(1000) });
    if (response.ok) { console.log('起動済み: ' + localUrl(port) + ' (localhost only)'); return; }
  } catch {}
  const fd = fs.openSync(path.join(dir, 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'server.cjs')], { cwd: root, env: { ...process.env, PORT: String(port), WORK_TREE_DATA: dir }, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref(); fs.closeSync(fd);
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(200);
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/api/state', { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const state = await response.json();
        if (state.server.pid !== child.pid) throw new Error('ポートが別のサーバーに使用されています');
        atomic(file, { pid: child.pid, port }); console.log('起動しました: ' + localUrl(port) + ' (localhost only)'); return;
      }
    } catch {}
  }
  throw new Error('起動できませんでした。ログを確認してください: ' + path.join(dir, 'server.log'));
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { verifyService };
