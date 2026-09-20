'use strict';
let orcaCatalog = null, orcaLoading = false, orcaError = '';
function orcaPicker(value, scope, inherited = false) {
  const v = { notificationMode: 'notify', ...(value || {}) }, catalog = orcaCatalog || { projects: [], hosts: [], worktrees: [] };
  const pick = (key, title, choices) => {
    if (v[key] && !choices.some(([id]) => id === v[key])) choices.push([v[key], '保存済み · ' + v[key]]);
    return field(title, '<select data-orca-key="' + key + '" ' + (inherited ? 'disabled' : '') + '>' + options([['', '選択してください'], ...choices], v[key] || '') + '</select>');
  };
  const worktrees = catalog.worktrees.filter(w => w.projectId === v.projectId && w.hostId === v.hostId);
  const selected = catalog.worktrees.find(w => w.id === v.worktreeId && w.hostId === v.hostId);
  return '<div data-orca-picker="' + scope + '" data-value="' + esc(JSON.stringify(v)) + '">' +
    (scope === 'node' ? '<label class="checkbox-row"><input type="checkbox" data-orca-inherit ' + (inherited ? 'checked' : '') + '>ツリーの Orca 実行先を継承</label>' : '') +
    pick('projectId', 'Orca プロジェクト', catalog.projects.map(p => [p.id, p.displayName || p.id])) +
    pick('hostId', 'Orca 実行ホスト', catalog.hosts.map(h => [h.id, h.name + (h.kind !== 'local' && !h.connected ? '（未接続）' : '')])) +
    pick('worktreeId', 'Orca ワークツリー', worktrees.map(w => [w.id, (w.displayName || w.branch) + ' · ' + w.path])) +
    field('AI ツールの実行パス（任意）', '<input data-orca-key="executable" value="' + esc(v.executable || '') + '" placeholder="空欄なら選択した codex / claude を PATH から起動" ' + (inherited ? 'disabled' : '') + '>') +
    pick('notificationMode', 'Codex の終了通知', [['notify', '終了通知を回収する'], ['manual', '手動で結果を記録する']]) +
    (v.hostId && v.hostId !== 'local' ? pick('notificationMachineId', '通知回収に使う SSH 接続', data.machines.filter(m => m.type === 'ssh').map(m => [m.id, m.name + ' · ' + m.host])) + '<p class="muted">Orca と同じホスト・ユーザーの接続を「設定 → マシンと AI ツール」で登録してください。未設定の場合は手動記録になります。</p>' : '<p class="muted">ローカルの Codex 終了通知を回収します。自動完了は各 TASK の検証設定で有効にできます。</p>') +
    '<p class="muted">' + esc(selected?.path || v.path || 'Orca に登録済みのワークツリーを選択します。') + '</p>' +
    (orcaError ? '<p class="error-box" role="alert">' + esc(orcaError) + '</p>' : '') +
    '<button type="button" class="button small" data-orca-refresh ' + (orcaLoading ? 'disabled' : '') + '>' + (orcaLoading ? 'Orca を確認中…' : 'Orca から一覧を更新') + '</button></div>';
}
function redrawOrcaPickers() {
  document.querySelectorAll('[data-orca-picker]').forEach(element => {
    element.outerHTML = orcaPicker(JSON.parse(element.dataset.value), element.dataset.orcaPicker, Boolean(element.querySelector('[data-orca-inherit]')?.checked));
  });
}
async function refreshOrcaTargets() {
  if (orcaLoading) return;
  orcaLoading = true; orcaError = ''; redrawOrcaPickers();
  try { orcaCatalog = await api('/api/orca/targets'); } catch (e) { orcaError = e.message; }
  finally { orcaLoading = false; redrawOrcaPickers(); }
}
function readOrcaPicker(scope) {
  const element = document.querySelector('[data-orca-picker="' + scope + '"]');
  return element ? JSON.parse(element.dataset.value) : undefined;
}
function backendSettings() {
  const backend = $('#setting-backend')?.value;
  if (!backend) return;
  $('#orca-tree-settings').hidden = backend !== 'orca';
  $('#setting-herdr-session').closest('.field').hidden = backend !== 'herdr';
  for (const key of ['machine', 'cwd', 'runner']) $('#setting-' + key).closest('.field').hidden = backend === 'orca';
  if (backend === 'orca' && !orcaCatalog && !orcaLoading && !orcaError) void refreshOrcaTargets();
}
document.addEventListener('change', event => {
  if (event.target.id === 'setting-backend') return backendSettings();
  const element = event.target.closest('[data-orca-picker]'); if (!element || (busy() && modalKind !== 'generate')) return;
  const scope = element.dataset.orcaPicker, value = JSON.parse(element.dataset.value), key = event.target.dataset.orcaKey;
  const inherited = Boolean(element.querySelector('[data-orca-inherit]')?.checked);
  if (key) {
    value[key] = event.target.value;
    if (key === 'projectId' || key === 'hostId') { delete value.worktreeId; delete value.identityKey; delete value.path; if (key === 'hostId') delete value.notificationMachineId; }
    if (key === 'worktreeId') {
      const w = orcaCatalog?.worktrees.find(w => w.id === value.worktreeId && w.hostId === value.hostId && w.projectId === value.projectId);
      value.identityKey = w?.identity?.key; value.path = w?.path;
    }
  }
  if (scope === 'node') {
    const node = draft.nodes.find(n => n.id === nodeId); if (!node) return;
    node.orca = inherited ? null : value; markDirty(); renderExecutionTarget();
  }
  element.outerHTML = orcaPicker(inherited ? draft.orca : value, scope, inherited);
});
document.addEventListener('click', async event => {
  const refresh = event.target.closest('[data-orca-refresh]');
  if (refresh && !refresh.disabled) { await refreshOrcaTargets(); return; }
  const focus = event.target.closest('[data-orca-focus]'); if (!focus || focus.disabled) return;
  focus.disabled = true;
  try { await api('/api/orca/focus', 'POST', { runId: focus.dataset.orcaFocus, nodeId: focus.dataset.orcaNode }); }
  catch (e) { toast(e.message, true); } finally { focus.disabled = false; }
});
function orcaFocusButton(run, nid) {
  return run?.executionBackend === 'orca' && run.state.nodes?.[nid]?.interactive?.handle ? '<button class="button small" data-orca-focus="' + esc(run.id) + '" data-orca-node="' + esc(nid) + '">Orca で開く</button>' : '';
}
