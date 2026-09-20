'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { assert, configFor, orderedTasks } = require('./core.cjs');
const { isWSL, localPath } = require('./local-path.cjs');

let detectedBinary;
function rpcLocation(target) {
  let binary = target.binary;
  if (!path.isAbsolute(binary)) binary = (process.env.PATH || process.env.Path || '').split(path.delimiter).map(dir => path.join(dir, binary)).find(file => fs.existsSync(file)) || binary;
  try { binary = fs.realpathSync(binary); } catch {}
  const base = path.dirname(binary), modulePath = 'app.asar.unpacked/out/cli/runtime-client.js';
  const clientPath = [target.rpcClient && localPath(target.rpcClient), process.env.ORCA_RPC_CLIENT && localPath(process.env.ORCA_RPC_CLIENT), path.resolve(base, '..', modulePath), path.join(base, 'resources', modulePath), path.resolve(base, '..', 'Resources', modulePath)].find(file => file && fs.existsSync(file));
  assert(clientPath, 'Orca 同梱の runtime client が見つかりません。対応する Orca をインストールするか ORCA_RPC_CLIENT に runtime-client.js のパスを指定してください');
  const windowsBridge = isWSL && /\.exe$/i.test(binary);
  const windowsPath = file => /^\/mnt\/[a-z]\//i.test(file) ? file[5].toUpperCase() + ':/' + file.slice(7) : '//wsl.localhost/' + process.env.WSL_DISTRO_NAME + file;
  return { command: windowsBridge ? 'node.exe' : process.execPath, bridge: windowsBridge ? windowsPath(path.join(__dirname, 'orca-rpc.cjs')) : path.join(__dirname, 'orca-rpc.cjs'), clientPath: windowsBridge ? windowsPath(clientPath) : clientPath };
}
function targetFor() {
  if (process.env.ORCA_BIN) return { binary: localPath(process.env.ORCA_BIN) };
  if (detectedBinary) return { binary: detectedBinary };
  const installed = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'orca', 'resources', 'bin', 'orca.exe');
  if (installed && fs.existsSync(installed)) detectedBinary = installed;
  if (!detectedBinary && isWSL && !(process.env.PATH || '').split(':').some(dir => fs.existsSync(path.join(dir, 'orca')))) {
    try {
      const appData = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('LocalApplicationData')"], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const binary = localPath(path.win32.join(appData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe'));
      if (fs.existsSync(binary)) detectedBinary = binary;
    } catch { /* Explicit ORCA_BIN remains available when WSL interop is disabled. */ }
  }
  return { binary: detectedBinary || 'orca' };
}
// CLI errors and unsatisfied waits may exit nonzero while returning useful JSON.
function call(target, args, launch) {
  return new Promise((resolve, reject) => {
    const binary = target.binary, fixture = /\.cjs$/.test(binary);
    let command = fixture ? process.execPath : binary, argv = [...(fixture ? [binary] : []), ...args, '--json'], input = '';
    if (launch && fixture) argv.push('--launch-spec', JSON.stringify(launch));
    else if (launch) {
      assert(args[0] === 'terminal' && args[1] === 'create', '不正な Orca 起動要求です');
      const location = rpcLocation(target), opt = key => args[args.indexOf(key) + 1];
      command = location.command; argv = [location.bridge];
      input = JSON.stringify({ clientPath: location.clientPath, runtimeId: target.runtimeId, params: { worktree: opt('--worktree'), title: opt('--title'), command: opt('--command'), launchAgent: launch.agent, env: launch.env, rendererBacked: true, focus: false, activate: false } });
    }
    const env = { ...process.env }; delete env.ORCA_ENVIRONMENT; delete env.ORCA_PAIRING_CODE;
    const child = spawn(command, argv, { windowsHide: true, shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(Error('Orca の応答がタイムアウトしました。操作は自動再送しません')); }, 25000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', s => { out += s; if (out.length > 8 * 1024 * 1024) { child.kill(); finish(Error('Orca の応答が大きすぎます')); } });
    child.stderr.on('data', s => { err = (err + s).slice(-4000); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.on('error', e => finish(Error('Orca CLI を起動できません。Orca を起動し、必要なら ORCA_BIN に CLI のパスを指定してください: ' + e.message)));
    child.on('close', () => {
      if (settled) return;
      try {
        const envelope = JSON.parse(out);
        if (!envelope.ok) { const e = Error(envelope.error?.message || err || 'Orca の操作に失敗しました'); e.code = envelope.error?.code; throw e; }
        if (target.runtimeId) assert(envelope._meta?.runtimeId === target.runtimeId, 'Orca が再起動されたため実行を中断しました');
        finish(null, { ...envelope.result, runtimeId: envelope._meta?.runtimeId });
      } catch (e) { finish(e); }
    });
  });
}
async function discover(target = targetFor(), invoke = call) {
  const status = await invoke(target, ['status']);
  assert(status.runtime?.reachable && status.runtime.runtimeId, 'Orca を同じユーザーで起動し、SSH ホストを接続してください');
  const pinned = { ...target, runtimeId: status.runtime.runtimeId };
  const results = await Promise.allSettled([
    // host list is assembled by the CLI and labels its envelope runtime "local".
    invoke(pinned, ['project', 'list']), invoke({ ...target, runtimeId: undefined }, ['host', 'list']), invoke(pinned, ['worktree', 'list', '--limit', '10000'])
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const [p, h, w] = results.map(r => r.value);
  assert(!w.truncated, 'Orca のワークツリー一覧が省略されています');
  const hosts = h.hosts.map(host => ({ ...host, id: host.kind === 'ssh' && !host.id.startsWith('ssh:') ? 'ssh:' + host.id : host.id }));
  return { target: pinned, projects: p.projects, hosts, worktrees: w.worktrees.filter(w => !w.isArchived), omittedHostIds: w.hostScope?.omittedHostIds || [] };
}
function resolveTarget(selection, catalog) {
  assert(selection?.projectId && selection.hostId && selection.worktreeId, 'Orca のプロジェクト・ホスト・ワークツリーを選択してください');
  const host = catalog.hosts.find(h => h.id === selection.hostId);
  assert(host && ['local', 'ssh'].includes(host.kind), 'Orca のローカルまたは SSH ホストを選択してください');
  assert(host && (host.kind === 'local' || host.connected === true) && !catalog.omittedHostIds.includes(host.id), '指定した Orca ホストが未接続です。Orca で接続してください');
  assert(catalog.projects.some(p => p.id === selection.projectId), 'Orca プロジェクトが見つかりません');
  const w = catalog.worktrees.find(w => w.id === selection.worktreeId && w.projectId === selection.projectId && w.hostId === selection.hostId);
  assert(w && w.identity?.key && (!selection.identityKey || w.identity.key === selection.identityKey), '指定した Orca ワークツリーの所属・識別情報が変わりました。選択し直してください');
  assert(!w.isBare && !w.isArchived, '実行できない Orca ワークツリーです');
  return { ...selection, identityKey: w.identity.key, path: w.path, hostName: host.name, platform: host.platform, displayName: w.displayName };
}
async function prepareTree(tree, target = targetFor(), invoke = call) {
  if (invoke === call && !/\.cjs$/.test(target.binary)) target = { ...target, rpcClient: rpcLocation(target).clientPath };
  const catalog = await discover(target, invoke), nodes = {};
  for (const node of orderedTasks(tree)) nodes[node.id] = resolveTarget(configFor(tree, node).orca, catalog);
  return { target: catalog.target, nodes };
}
async function verifyTerminal(target, binding, invoke = call) {
  const terminal = (await invoke(target, ['terminal', 'show', '--terminal', binding.handle])).terminal;
  assert(terminal && terminal.handle === binding.handle && terminal.incarnationId === binding.incarnationId && terminal.worktreeId === binding.worktreeId && terminal.executionHostId === binding.hostId && !terminal.orphaned && terminal.connected && terminal.writable, 'Orca 端末の接続・識別情報が変わりました。Orca で状態を確認してください');
  return terminal;
}
module.exports = { targetFor, call, discover, resolveTarget, prepareTree, verifyTerminal, rpcLocation };
