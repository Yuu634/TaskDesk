'use strict';
const path = require('node:path');
const { read } = require('../lib/core.cjs');
const { runtimeProfile, probe, resolveExecutable, capture } = require('../lib/executor.cjs');

async function main() {
  const profile = runtimeProfile();
  if (!profile.ok) throw new Error(profile.error);
  console.log('実行ユーザー: ' + profile.username);
  console.log('ホーム: ' + profile.homedir);
  const dir = process.env.WORK_TREE_DATA || path.join(__dirname, '..', '.work-tree');
  const machine = read(path.join(dir, 'database.json'))?.machines?.find(m => m.id === 'local') || { type: 'local', codexPath: 'codex', claudePath: 'claude' };
  const result = await probe(machine);
  console.log('Codex: ' + result.tools.codex);
  console.log('Claude Code: ' + result.tools.claude);
  const cmd = resolveExecutable(machine.codexPath, 'codex');
  const status = await capture(cmd.command, cmd.prefix.concat(['login', 'status']), '', 15000, { includeStderr: true });
  console.log('Codex 認証: ' + status.trim());
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
