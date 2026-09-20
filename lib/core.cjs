'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateOptions, effectiveOptions, validateAttachments } = require('./cli-options.cjs');

const ACTIVE = new Set(['starting', 'running', 'pausing', 'paused', 'review', 'stopping', 'reconnecting']);
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function assert(ok, message) { if (!ok) throw new Error(message); }
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  // Windows readers / indexers can briefly hold the destination without delete
  // sharing. Keep the previous complete snapshot and retry the atomic replace.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, file); break; }
    catch (e) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 5) {
        try { fs.unlinkSync(temp); } catch {}
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}
function read(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function validateMachine(m) {
  assert(m && /^[a-zA-Z0-9_-]+$/.test(m.id), 'マシン ID が不正です');
  assert(typeof m.name === 'string' && m.name.trim(), 'マシン名を入力してください');
  assert(['local', 'ssh'].includes(m.type), 'マシン種別が不正です');
  if (m.type === 'ssh') {
    assert(typeof m.host === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(m.host), 'SSH 接続先は user@host または SSH config の名前を指定してください');
    assert(Number.isInteger(m.port) && m.port > 0 && m.port < 65536, 'SSH ポートが不正です');
    assert(typeof m.nodePath === 'string' && m.nodePath.length > 0 && !/[\r\n\0]/.test(m.nodePath), 'Node.js の実行パスが不正です');
  }
  for (const key of ['codexPath', 'claudePath']) assert(typeof m[key] === 'string' && m[key].length > 0 && !/[\r\n\0]/.test(m[key]), 'AI ツールの実行パスが不正です');
  return m;
}
function validateTree(t, machines) {
  assert(t.executionBackend === undefined || ['direct', 'herdr', 'orca'].includes(t.executionBackend), '実行先が不正です');
  const validateOrca = value => {
    if (value === undefined || value === null) return;
    assert(value && typeof value === 'object' && !Array.isArray(value), 'Orca 実行先が不正です');
    for (const key of ['projectId', 'hostId', 'worktreeId']) assert(typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 4096 && !/[\x00-\x1f]/.test(value[key]), 'Orca 実行先をすべて選択してください');
    for (const key of ['identityKey', 'executable']) assert(value[key] === undefined || typeof value[key] === 'string' && value[key].length <= 4096 && !/[\x00-\x1f]/.test(value[key]), 'Orca の識別情報または実行パスが不正です');
    assert(value.notificationMode === undefined || ['notify', 'manual'].includes(value.notificationMode), '通知モードが不正です');
    if (value.notificationMachineId) assert(machines.some(m => m.id === value.notificationMachineId && m.type === 'ssh'), '通知回収用の SSH 接続がありません');
  };
  validateOrca(t.orca);
  assert(t.herdrSession === undefined || typeof t.herdrSession === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(t.herdrSession), 'herdr セッション名が不正です');
  validateOptions(t?.cli); validateAttachments(t?.attachments);
  if (t.brief !== undefined) {
    assert(t.brief && typeof t.brief === 'object' && !Array.isArray(t.brief), '作成要件が不正です');
    for (const key of ['purpose', 'current', 'flow', 'criteria', 'constraints']) assert(typeof t.brief[key] === 'string' && t.brief[key].length <= 12000, '作成要件は各項目 12000 文字以内で入力してください');
  }
  assert(t && typeof t.name === 'string' && t.name.trim() && t.name.length <= 160, 'ツリー名を入力してください（160 文字以内）');
  assert(Array.isArray(t.nodes) && t.nodes.length <= 300, 'ノード数は 300 個以内にしてください');
  assert(['codex', 'claude'].includes(t.tool), 'AI ツールが不正です');
  const mids = new Set(machines.map(m => m.id));
  assert(mids.has(t.machineId) && mids.has(t.runnerId), '実行マシンが見つかりません');
  assert(typeof t.cwd === 'string', '作業ディレクトリが不正です');
  assert(Number.isFinite(t.timeoutMinutes) && t.timeoutMinutes >= 1 && t.timeoutMinutes <= 1440, '制限時間は 1〜1440 分です');
  const byId = new Map();
  for (const n of t.nodes) {
    validateOrca(n.orca);
    if (n.verification != null) {
      const v = n.verification;
      assert(v && typeof v === 'object' && !Array.isArray(v) && typeof v.autoComplete === 'boolean', '自動完了設定が不正です');
      assert(typeof v.command === 'string' && v.command.length <= 4096 && !/[\x00-\x1f]/.test(v.command), '検証プログラムが不正です');
      assert(Array.isArray(v.args) && v.args.length <= 100 && v.args.every(a => typeof a === 'string' && a.length <= 10000 && !a.includes('\0')), '検証引数は文字列の JSON 配列で指定してください');
      assert(Number.isInteger(v.timeoutSeconds) && v.timeoutSeconds >= 1 && v.timeoutSeconds <= 600, '検証の制限時間は 1〜600 秒です');
      if (v.autoComplete) {
        assert(v.command.trim() && (n.tool || t.tool) === 'codex' && t.executionBackend === 'orca', '自動完了には Orca の Codex と検証プログラムを指定してください');
        const o = n.orca || t.orca;
        assert(o && o.notificationMode !== 'manual' && (o.hostId === 'local' || o.notificationMachineId), '自動完了には通知回収経路を設定してください');
      }
    }
    validateOptions(n.cli); validateAttachments(n.attachments);
    assert(typeof n.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(n.id) && !['__proto__', 'constructor', 'prototype'].includes(n.id) && !byId.has(n.id), 'ノード ID が不正または重複しています');
    assert(typeof n.title === 'string' && n.title.trim() && n.title.length <= 200, 'ノード名を入力してください（200 文字以内）');
    assert(['group', 'task'].includes(n.kind), 'ノード種別が不正です');
    assert(typeof n.prompt === 'string' && n.prompt.length <= 60000, 'プロンプトは 60000 文字以内です');
    assert(!n.tool || ['codex', 'claude'].includes(n.tool), 'AI ツールが不正です');
    assert(!n.machineId || mids.has(n.machineId), 'ノードのマシンが見つかりません');
    assert(typeof n.cwd === 'string' && typeof n.model === 'string' && typeof n.criteria === 'string', 'ノード設定が不正です');
    assert(['read-only', 'workspace-write'].includes(n.sandbox), '権限設定が不正です');
    assert(['plan', 'acceptEdits', 'dontAsk'].includes(n.claudePermission), 'Claude Code の権限設定が不正です');
    assert(n.env && typeof n.env === 'object' && !Array.isArray(n.env), '環境変数は JSON オブジェクトです');
    for (const [k, v] of Object.entries(n.env)) assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && !v.includes('\0'), '環境変数の名前または値が不正です');
    assert(Array.isArray(n.dependsOn) && new Set(n.dependsOn).size === n.dependsOn.length, '依存関係が不正です');
    assert(n.kind !== 'group' || n.dependsOn.length === 0, '依存関係は実行タスクに設定してください');
    assert(Number.isFinite(n.order), 'ノード順序が不正です');
    byId.set(n.id, n);
  }
  for (const n of t.nodes) {
    assert(n.parentId === null || byId.has(n.parentId), '親ノードが見つかりません');
    if (n.parentId) assert(byId.get(n.parentId).kind === 'group', '子ノードはグループの下に配置してください');
    const seen = new Set([n.id]); let p = n.parentId;
    while (p) { assert(!seen.has(p), '親子関係に循環があります'); seen.add(p); p = byId.get(p).parentId; }
    assert(seen.size <= 16, 'ツリーの深さは 16 階層までです');
    for (const d of n.dependsOn) assert(byId.has(d) && byId.get(d).kind === 'task' && d !== n.id, '依存先には別の実行タスクを指定してください');
  }
  const visiting = new Set(), visited = new Set();
  function visit(n) {
    assert(!visiting.has(n.id), '実行順の依存関係に循環があります');
    if (visited.has(n.id)) return;
    visiting.add(n.id); n.dependsOn.forEach(d => visit(byId.get(d))); visiting.delete(n.id); visited.add(n.id);
  }
  t.nodes.forEach(visit);
  return t;
}
function orderedTasks(tree) {
  const list = [];
  function walk(parent) {
    tree.nodes.filter(n => n.parentId === parent).sort((a, b) => a.order - b.order).forEach(n => {
      if (n.kind === 'task') list.push(n); else walk(n.id);
    });
  }
  walk(null); return list;
}
function nextTask(tree, statuses, projected = false) {
  const done = new Set(Object.entries(statuses).filter(([, s]) => s.status === 'succeeded' || (projected && s.status === 'running')).map(([key]) => key));
  return orderedTasks(tree).find(n => (!statuses[n.id] || statuses[n.id].status === 'pending') && n.dependsOn.every(d => done.has(d))) || null;
}
function configFor(tree, node) {
  const tool = node.tool || tree.tool;
  return { ...node, orca: node.orca || tree.orca, tool, options: effectiveOptions(tree, node, tool), attachments: [...(tree.attachments || []), ...(node.attachments || [])], machineId: node.machineId || tree.machineId, cwd: node.cwd || tree.cwd, timeoutMinutes: tree.timeoutMinutes };
}
function blankNode(overrides = {}) {
  return { id: id(), title: '新しいタスク', kind: 'task', parentId: null, order: 0, prompt: '', criteria: '', tool: '', machineId: '', cwd: '', model: '', env: {}, dependsOn: [], sandbox: 'workspace-write', claudePermission: 'acceptEdits', reviewRequired: false, ...overrides };
}
function blankTree(overrides = {}) {
  return { id: id(), name: '新しいタスクツリー', description: '', tool: 'codex', machineId: 'local', runnerId: 'local', cwd: '', timeoutMinutes: 60, nodes: [], revision: 1, createdAt: now(), updatedAt: now(), ...overrides };
}
function parsePlan(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(cleaned); } catch { throw new Error('AI が有効な JSON を返しませんでした。実行ログを確認して再生成してください'); }
  assert(value && Array.isArray(value.nodes) && value.nodes.length > 0 && value.nodes.length <= 100, 'AI の計画には 1〜100 ノードが必要です');
  const mapping = new Map();
  value.nodes.forEach(n => { assert(typeof n.id === 'string' && !mapping.has(n.id), 'AI のノード ID が重複または不正です'); mapping.set(n.id, id()); });
  const nodes = value.nodes.map((n, i) => {
    assert(!n.parentId || mapping.has(n.parentId), 'AI の親ノードが不正です');
    assert(!n.dependsOn || Array.isArray(n.dependsOn), 'AI の依存関係が不正です');
    assert((n.dependsOn || []).every(d => mapping.has(d)), 'AI の依存先が不正です');
    return blankNode({ id: mapping.get(n.id), title: n.title, kind: n.kind, prompt: n.prompt || '', criteria: n.criteria || '', parentId: n.parentId ? mapping.get(n.parentId) : null, dependsOn: (n.dependsOn || []).map(d => mapping.get(d)), order: i });
  });
  return { name: typeof value.name === 'string' ? value.name : 'AI が作成したツリー', nodes };
}
module.exports = { ACTIVE, id, now, assert, atomic, read, validateMachine, validateTree, orderedTasks, nextTask, configFor, blankNode, blankTree, parsePlan };
