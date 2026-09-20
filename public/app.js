'use strict';
const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => crypto.randomUUID();
const active = new Set(['starting', 'running', 'pausing', 'paused', 'review', 'stopping', 'reconnecting']);
const labels = { pending: '未着手', starting: '開始中', running: '実行中', pausing: '停止予約', paused: '一時停止', review: '確認待ち', succeeded: '完了', failed: '失敗', cancelled: '停止', interrupted: '中断', stopping: '停止中', reconnecting: '再接続待ち' };
let data = { trees: [], machines: [], runs: [] }, selectedId = localStorage.getItem('work-tree:selected'), nodeId = null, draft = null, dirty = false, tab = 'node', token = '', toastTimer, refreshing = false;
let nodeSubmitting = false, editingTree = false, editingBackup = null, editingWasDirty = false;
let pendingPlanId = localStorage.getItem('work-tree:pending-plan'), importingPlan = false;
let machineEditing = null, modalKind = '', invalidEnvNodeId = null;
function toast(message, error = false) { $('#toast').textContent = message; $('#toast').className = 'visible' + (error ? ' error' : ''); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').className = '', error ? 7000 : 3500); }
async function api(url, method = 'GET', payload) {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Work-Tree-Token': token }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || '通信に失敗しました'); return value;
}
const current = () => draft;
const latest = tid => data.runs.find(r => r.treeId === tid && r.kind === 'tree');
const matchingRun = t => { const r = t && latest(t.id); return r?.treeRevision === t?.revision ? r : null; };
const nodeRun = (t, nid) => data.runs.find(r => r.treeId === t.id && r.treeRevision === t.revision && ['tree', 'node'].includes(r.kind) && r.state.nodes?.[nid]);
const busy = () => draft && data.runs.find(r => r.treeId === draft.id && active.has(r.state.status));
const machineName = mid => data.machines.find(m => m.id === mid)?.name || '未設定';
const toolName = t => t === 'claude' ? 'Claude Code' : 'Codex';
function statusBadge(status) { return '<span class="status-badge ' + esc(status) + '"><i class="dot ' + esc(status) + '"></i>' + esc(labels[status] || status) + '</span>'; }
function tasks(t) {
  const nodes = []; const walk = p => t.nodes.filter(n => n.parentId === p).sort((a, b) => a.order - b.order).forEach(n => n.kind === 'task' ? nodes.push(n) : walk(n.id)); walk(null); return nodes;
}
function suggested(t, state = {}) { return tasks(t).find(n => (!state[n.id] || state[n.id].status === 'pending') && n.dependsOn.every(d => ['succeeded', 'running'].includes(state[d]?.status))); }
function nodeStatus(n, t, state) {
  if (n.kind === 'task') return nodeRun(t, n.id)?.state.nodes[n.id]?.status || state?.nodes?.[n.id]?.status || 'pending';
  const desc = descendants(n.id, t).filter(d => t.nodes.find(x => x.id === d)?.kind === 'task');
  const statuses = desc.map(id => nodeRun(t, id)?.state.nodes[id]?.status || state?.nodes?.[id]?.status || 'pending');
  if (statuses.length && statuses.every(s => s === 'succeeded')) return 'succeeded';
  for (const s of ['failed', 'running', 'review', 'cancelled']) if (statuses.includes(s)) return s;
  return 'pending';
}
function descendants(nid, t = draft) {
  const result = [];
  function walk(p) { t.nodes.filter(n => n.parentId === p).forEach(n => { result.push(n.id); walk(n.id); }); } walk(nid); return result;
}
function markDirty() { dirty = true; $('#dirty-label').hidden = false; $('#save-tree').disabled = false; renderNodeFooter(); renderProposals(); }
function discardOK() { return !dirty || confirm('未保存の変更があります。変更を破棄しますか？'); }
function selectTree(tid, force = false) {
  if (!force && tid === selectedId) return;
  if (!force && tid !== selectedId && !discardOK()) return;
  selectedId = tid; localStorage.setItem('work-tree:selected', tid || ''); draft = structuredClone(data.trees.find(t => t.id === tid) || null); dirty = false; editingTree = false; editingBackup = null; invalidEnvNodeId = null; nodeId = draft?.nodes[0]?.id || null; tab = 'node'; render();
}
function renderSidebar() {
  $('#tree-count').textContent = data.trees.length; $('#machine-count').textContent = data.machines.length;
  const query = $('#search').value.toLowerCase();
  $('#tree-list').innerHTML = data.trees.filter(t => t.name.toLowerCase().includes(query)).map(t => {
    const r = data.runs.find(r => r.treeId === t.id && active.has(r.state.status)) || data.runs.find(r => r.treeId === t.id && r.treeRevision === t.revision && ['tree', 'node'].includes(r.kind)), s = r?.state;
    const now = t.nodes.find(n => n.id === s?.currentNodeId);
    return '<button class="tree-item ' + (selectedId === t.id ? 'selected' : '') + '" data-tree="' + esc(t.id) + '" aria-pressed="' + (selectedId === t.id) + '"><div class="tree-item-top"><strong>' + esc(t.name) + '</strong>' + statusBadge(s?.status || 'pending') + '</div><div class="task-preview"><span>現在のタスク</span><em>' + esc(now?.title || (s?.status === 'succeeded' ? '実行完了' : s ? '—' : '未実行')) + '</em></div></button>';
  }).join('') || '<p class="muted" style="padding:15px">ツリーがありません</p>';

}
function interactiveLabel(value) {
  const backend = value.backend === 'orca' ? 'Orca' : 'herdr';
  if (value.phase === 'confirmation') return value.message || '応答終了・結果の確認待ち';
  if (value.phase === 'verifying') return value.message || 'Orca の同じタブで完了条件を判定中';
  if (value.phase === 'reconnecting') return '通知・端末の再接続待ち';
  return value.message || ({ starting: '対話 CLI を起動中', 'startup-blocked': backend + ' で起動時の確認に回答してください', submitted: 'プロンプトを送信しました', working: backend + ' で作業中', blocked: backend + ' で承認・質問に回答してください', ready: '対話を継続、または結果を記録してください', unknown: backend + ' の状態を確認してください', uncertain: backend + ' で送信結果を確認してください', completed: '結果を記録しました' })[value.phase] || value.phase;
}
function showComplete(runId) {
  const run = data.runs.find(r => r.id === runId), nid = run?.state.currentNodeId;
  if (!['ready', 'confirmation'].includes(run?.state.nodes?.[nid]?.interactive?.phase)) throw new Error('Agent が入力待ちになるまでお待ちください');
  modalKind = 'complete';
  const hint = run.executionBackend === 'orca' ? '完了なら後続 TASK へ進みます。エラー・想定外結果なら後続を止めます。Orca の対話を確認し、必要ならツリーを編集してください。' : '完了なら後続 TASK へ進みます。エラー・想定外結果なら後続を止め、TASK の下に編集案を表示します。';
  modal('タスクの結果を記録', esc(draft?.nodes.find(n => n.id === nid)?.title || ''), field('結果ラベル', '<select id="complete-outcome">' + options([['completed','完了'],['error','エラー'],['unexpected','想定外結果']], 'completed') + '</select>') + field('結果の要約', '<textarea id="complete-response" maxlength="60000" placeholder="実施内容・成果物・検証結果を入力してください"></textarea>', hint), '<button class="button close-modal">戻る</button><button class="button primary" data-modal-action="complete" data-run="' + runId + '" data-node-id="' + nid + '">結果を記録</button>');
  $('#complete-response').value = run.state.nodes[nid].interactive.response || '';
}
function selectedWP() {
  let n = draft?.nodes.find(n => n.id === nodeId);
  while (n && n.kind !== 'group') n = draft.nodes.find(x => x.id === n.parentId);
  return n;
}
function renderHeader() {
  const t = current();
  document.body.classList.toggle('tree-editing', editingTree);
  $('#inline-edit-tools').hidden = !editingTree;
  if (!t) { $('#project-header').innerHTML = '<h1>ワークツリーを作成してください</h1>'; return; }
  const running = busy(), r = running || matchingRun(t), next = TaskDeskExecution.nextExecution(t, TaskDeskExecution.executionProgress(t, data.runs));
  let controls = '<button class="button primary" data-action="start" ' + (running || editingTree || !tasks(t).length ? 'disabled' : '') + '>ツリーを実行</button>' +
    '<button class="button" data-action="run-wp" ' + (running || nodeSubmitting || editingTree || !next.wp ? 'disabled' : '') + '>次WPを実行</button>' +
    '<button class="button" data-action="run-selected" ' + (running || nodeSubmitting || editingTree || !next.task ? 'disabled' : '') + '>次TASKを実行</button>' +
    '<button class="button" data-action="edit-tree" ' + (running ? 'disabled' : '') + '>' + (editingTree ? '編集を完了' : 'ツリー編集') + '</button>';
  if (running) controls += '<div class="running-controls">' + statusBadge(running.state.status) +
    '<button class="text-button" data-control="' + (running.state.status === 'paused' ? 'resume' : 'pause') + '" data-run="' + running.id + '">' + (running.state.status === 'paused' ? '再開' : '一時停止') + '</button><button class="text-button danger-text" data-control="stop" data-run="' + running.id + '">停止</button></div>';
  else if (r && ['failed', 'cancelled', 'interrupted'].includes(r.state.status)) controls += '<button class="text-button" data-action="resume-tree">続きから</button>';
  const interactive = running?.state.nodes?.[running.state.currentNodeId]?.interactive;
  if (interactive) controls += '<div class="interactive-controls"><span>' + esc(interactiveLabel(interactive)) + '</span>' + orcaFocusButton(running, running.state.currentNodeId) + '<button class="button small primary" data-complete-run="' + running.id + '" ' + (!['ready', 'confirmation'].includes(interactive.phase) ? 'disabled' : '') + '>結果を記録</button></div>';
  $('#project-header').innerHTML = '<div class="project-heading"><p class="eyebrow">TASK TREE</p>' + (editingTree ? '<input class="tree-title-input" data-tree-name value="' + esc(t.name) + '" maxlength="160" aria-label="ツリー名">' : '<h1>' + esc(t.name) + '</h1>') + '</div><div class="project-actions">' + controls + '</div>';
  $('#next-execution').innerHTML = '<span>次WP：<strong>' + esc(next.wp?.title || (next.complete ? 'すべて完了' : next.task ? 'WP なし' : '依存先の完了待ち')) + '</strong></span><span>次TASK：<strong>' + esc(next.task?.title || (next.complete ? 'すべて完了' : '実行可能な TASK なし')) + '</strong></span>';
  $('#dirty-label').hidden = !dirty; $('#save-tree').disabled = !dirty || Boolean(running);
}
function renderCanvas() {
  const t = current(), stage = $('#canvas-stage');
  $('#node-count').textContent = t ? t.nodes.filter(n => n.kind === 'group').length + ' WP / ' + tasks(t).length + ' TASK' : '';
  if (!t?.nodes.length) { stage.innerHTML = '<div class="empty"><h2>タスクはまだありません</h2><p>ツリー編集から WP と TASK を追加してください。</p>' + (t && !editingTree ? '<button class="button" data-action="edit-tree">ツリー編集</button>' : '') + '</div>'; $('#execution-strip').innerHTML = ''; return; }
  const state = (busy() || matchingRun(t))?.state;
  const number = new Map(tasks(t).map((n, i) => [n.id, String(i + 1).padStart(2, '0')]));
  function editDetails(n) {
    const children = new Set([n.id, ...descendants(n.id)]);
    return '<details class="inline-details"><summary>詳細</summary><div class="inline-fields">' +
      '<label class="field">プロンプト<textarea data-inline-field="prompt" data-id="' + n.id + '">' + esc(n.prompt) + '</textarea></label>' +
      (n.kind === 'task' ? '<label class="field">完了条件<textarea data-inline-field="criteria" data-id="' + n.id + '">' + esc(n.criteria) + '</textarea></label><div class="field"><span class="field-label">先に完了させる TASK</span><div class="deps-list">' + t.nodes.filter(x => x.kind === 'task' && x.id !== n.id).map(x => '<label><input type="checkbox" data-inline-dep="' + x.id + '" data-id="' + n.id + '" ' + (n.dependsOn.includes(x.id) ? 'checked' : '') + '>' + esc(x.title) + '</label>').join('') + '</div></div>' : '') +
      '<label class="field">配置先<select data-inline-parent data-id="' + n.id + '">' + options([['', '最上位'], ...t.nodes.filter(x => x.kind === 'group' && !children.has(x.id)).map(x => [x.id,x.title])], n.parentId || '') + '</select></label>' +
      '<div class="inline-move"><button class="button small" data-move-node="' + n.id + '" data-direction="-1">上へ</button><button class="button small" data-move-node="' + n.id + '" data-direction="1">下へ</button><button class="text-button" data-node-settings="' + n.id + '">実行設定</button></div></div></details>';
  }
  function editName(n) { return '<button class="drag-handle" draggable="true" data-drag-id="' + n.id + '" aria-label="' + esc(n.title) + 'を移動">⠿</button><input data-inline-field="title" data-id="' + n.id + '" value="' + esc(n.title) + '" maxlength="200" aria-label="ノード名"><button class="remove-node" data-remove-node="' + n.id + '" aria-label="' + esc(n.title) + 'を削除">×</button>'; }
  function taskCard(n) {
    const badge = outcomeBadge(n,t);
    const card = editingTree ? '<article class="tree-node editable" data-drop-node="' + n.id + '"><div class="inline-name"><span class="task-index">' + number.get(n.id) + '</span>' + editName(n) + '</div>' + (badge ? '<div class="task-outcome">' + badge + '</div>' : '') + editDetails(n) + '</article>' :
      '<button class="tree-node ' + (nodeId === n.id ? 'selected' : '') + '" data-node="' + n.id + '" aria-label="' + esc(n.title + '、' + labels[nodeStatus(n,t,state)]) + '"><span class="task-index">' + number.get(n.id) + '</span><strong>' + esc(n.title) + '</strong>' + (badge || statusBadge(nodeStatus(n,t,state))) + '</button>';
    return '<div class="task-cell">' + card + '<div data-task-proposals="' + n.id + '"></div></div>';
  }
  function contents(parentId) {
    const children = t.nodes.filter(n => n.parentId === parentId).sort((a, b) => a.order - b.order);
    return children.map(n => n.kind === 'group' ? group(n) : '<div class="task-row' + (editingTree ? ' edit-task-row' : '') + '">' + taskCard(n) + '</div>').join('');
  }
  const orderedGroups = [];
  const visitGroups = parent => t.nodes.filter(n=>n.parentId===parent && n.kind==='group').sort((a,b)=>a.order-b.order).forEach(n=>{ orderedGroups.push(n); visitGroups(n.id); });
  visitGroups(null);
  function group(n) {
    const i = orderedGroups.findIndex(x => x.id === n.id) + 1;
    const peers = t.nodes.filter(x=>x.parentId===n.parentId && x.kind==='group').sort((a,b)=>a.order-b.order);
    const moveButtons = '<div class="wp-order-controls"><button class="text-button" data-move-node="' + n.id + '" data-direction="-1" aria-label="WP を上へ" ' + (peers[0]?.id===n.id?'disabled':'') + '>↑</button><button class="text-button" data-move-node="' + n.id + '" data-direction="1" aria-label="WP を下へ" ' + (peers.at(-1)?.id===n.id?'disabled':'') + '>↓</button></div>';
    if (editingTree) return '<section class="wp-panel editable-wp" data-drop-parent="' + n.id + '" data-drop-node="' + n.id + '"><div class="wp-heading inline-name"><span class="wp-index">WP ' + String(i).padStart(2,'0') + '</span>' + editName(n) + moveButtons + '<button class="button small" data-add-to="' + n.id + '">＋ TASK</button></div><div class="wp-content">' + contents(n.id) + editDetails(n) + '<div class="drop-zone" data-drop-parent="' + n.id + '">この WP に移動</div></div></section>';
    return '<section class="wp-panel ' + (selectedWP()?.id === n.id ? 'selected-wp' : '') + '"><button class="wp-heading" data-select-wp="' + n.id + '" aria-pressed="' + (nodeId === n.id) + '"><span class="wp-index">WP ' + String(i).padStart(2, '0') + '</span><h2>' + esc(n.title) + '</h2>' + statusBadge(nodeStatus(n, t, state)) + '</button><div class="wp-content">' + (contents(n.id) || '<p class="muted">TASK はまだありません</p>') + '</div></section>';
  }
  stage.innerHTML = contents(null) + (editingTree ? '<div class="drop-zone root-drop" data-drop-parent="">最上位に移動</div>' : '');
  renderProposals();
  const curr = t.nodes.find(n => n.id === state?.currentNodeId);
  $('#execution-strip').innerHTML = state ? '<span>現在のタスク</span><strong>' + esc(curr?.title || (state.status === 'succeeded' ? 'すべて完了' : labels[state.status] || '—')) + '</strong>' + statusBadge(state.status) : '';
}
function options(items, selected) { return items.map(([v, name]) => '<option value="' + esc(v) + '" ' + (v === selected ? 'selected' : '') + '>' + esc(name) + '</option>').join(''); }
function field(label, content, hint = '') { return '<label class="field"><span class="field-label">' + label + '</span>' + content + (hint ? '<small>' + hint + '</small>' : '') + '</label>'; }
function nodeInput(key, value, type = 'input', attrs = '') { return type === 'textarea' ? '<textarea data-field="' + key + '" ' + attrs + '>' + esc(value) + '</textarea>' : '<input data-field="' + key + '" value="' + esc(value) + '" ' + attrs + '>'; }
function nodeSelect(key, value, list) { return '<select data-field="' + key + '">' + options(list, value) + '</select>'; }
function openNodePanel() {
  $('#node-error').hidden = true;
  renderInspector();
  if (!$('#node-dialog').open) $('#node-dialog').showModal();
}
function nodeError(message) { const box = $('#node-error'); box.textContent = message; box.hidden = false; }
function renderNodeFooter() {
  const t = draft, n = draft?.nodes.find(n => n.id === nodeId), running = busy();
  const result = running?.state.nodes?.[running.state.currentNodeId], ready = ['ready', 'confirmation'].includes(result?.interactive?.phase);
  $('#node-footer').innerHTML = '<small role="status">' + (nodeSubmitting ? '起動を準備しています…' : running ? (running.executionBackend === 'orca' ? 'Orca で対話を続けられます' : '実行中です') : dirty ? '未保存の変更あり' : '設定は保存済み') + '</small>' + orcaFocusButton(running || (n && nodeRun(t, n.id)), n?.id) +
    (['herdr', 'orca'].includes(running?.executionBackend) ? '<button class="button primary" data-complete-run="' + running.id + '" ' + (!ready ? 'disabled' : '') + '>結果を記録</button>' : tab === 'node' && n ? '<button class="button primary" data-action="run-node" ' + (running || nodeSubmitting ? 'disabled' : '') + '>タスク実行</button>' : '') +
    '<button class="button" data-close-node>閉じる</button>';
}
function nodeOptions(n, t) {
  const tool = n.tool || t.tool, legacy = {};
  if (n.model) legacy.model = n.model;
  if (tool === 'codex' && n.sandbox && n.sandbox !== 'workspace-write') legacy.sandbox = n.sandbox;
  if (tool === 'claude' && n.claudePermission && n.claudePermission !== 'acceptEdits') legacy.permissionMode = n.claudePermission;
  return { ...CliUI.catalog.defaults[tool], ...t.cli?.[tool], ...legacy, ...n.cli?.[tool] };
}
function nodeExecutionSettings(n, t) {
  const tool = n.tool || t.tool, c = nodeOptions(n, t);
  const models = [...(CliUI.catalog.models[tool] || [])];
  if (c.model && !models.some(m => m.id === c.model)) models.unshift({ id: c.model, name: c.model });
  const select = (key, value, choices) => '<select data-node-option="' + key + '">' + options(choices, value || '') + '</select>';
  const efforts = tool === 'codex' ? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
  const v = n.verification || { command: '', args: [], timeoutSeconds: 60, autoComplete: false };
  return '<div class="node-execution">' +
    (t.executionBackend === 'orca' && tool === 'codex' ? '<p class="muted">終了通知の受信後、同じ Orca タブを分割し、新しい読み取り専用の対話型 Codex で判定します。作業の会話は残ります。判定後も追加質問できますが、ラベル更新には「完了条件を再判定」を使ってください。全条件を達成なら「完了」、未達・判断不能・条件未設定・判定失敗なら「要確認」です。判定にも AI の利用枠を使用します。</p><details class="detail-box"><summary>完了条件の自動検証（補助・任意）</summary><p class="muted">検証スクリプトは不要です。追加する場合は同じワークツリーで実行し、その結果も判定に使用します。</p>' +
      field('検証プログラム', '<input data-verification="command" value="' + esc(v.command) + '" placeholder="node または実行ファイルの絶対パス">') +
      field('引数（JSON 配列）', '<textarea data-verification="args">' + esc(JSON.stringify(v.args)) + '</textarea>') +
      field('検証の制限時間（秒）', '<input type="number" min="1" max="600" data-verification="timeoutSeconds" value="' + v.timeoutSeconds + '">') +
      '<label class="checkbox-field"><input type="checkbox" data-verification="autoComplete" ' + (v.autoComplete ? 'checked' : '') + '>補助検証を実行する（失敗時は必ず要確認）</label><p class="muted">通知経路が手動の場合やターン状態を照合できない場合は、手動で結果を記録してください。</p></details>' : '') +
    (t.executionBackend === 'orca' ? orcaPicker(n.orca || t.orca, 'node', !n.orca) :
    field('作業マシン', nodeSelect('machineId', n.machineId, [['', '既定 · ' + machineName(t.machineId)], ...data.machines.map(m => [m.id, m.name + (m.type === 'ssh' ? ' / SSH' : ' / ローカル')])])) +
    field('作業ディレクトリ', nodeInput('cwd', n.cwd, 'input', 'placeholder="' + esc(t.cwd || '実行マシン上の絶対パス') + '"'))) +
    field('AI コーディングツール', nodeSelect('tool', n.tool, [['', '既定 · ' + toolName(t.tool)], ['codex', 'Codex'], ['claude', 'Claude Code']])) +
    field('モデル名', select('model', c.model, [['', 'CLI の既定値'], ...models.map(m => [m.id, m.id])])) +
    '<div class="field-row">' + field('Thinking', select('effort', c.effort, [['', 'CLI の既定値'], ...efforts.map(x => [x, x])])) +
    field('Approve', tool === 'codex' ? select('approval', c.approval, [['never', '追加承認なし'], ['auto-review', '自動承認レビュー']]) : select('permissionMode', c.permissionMode, [['default', '標準'], ['acceptEdits', 'ファイル編集を許可'], ['plan', '計画のみ'], ['dontAsk', '事前許可済みのみ'], ['auto', '自動判定'], ['bypassPermissions', '権限確認をスキップ']])) + '</div><p id="node-target" class="muted execution-target"></p></div>';
}
function renderExecutionTarget() {
  const out = $('#node-target'), n = draft?.nodes.find(n => n.id === nodeId); if (!out || !n) return;
  const c = nodeOptions(n, draft), tool = n.tool || draft.tool;
  const o = n.orca || draft.orca;
  out.textContent = toolName(tool) + ' · ' + (c.model || 'CLI の既定モデル') + ' · Thinking: ' + (c.effort || 'CLI の既定値') +
    (c.mode !== 'task' ? ' · ' + (c.mode === 'plan' ? '計画モード' : 'ゴールモード') : '') +
    (draft.executionBackend === 'orca' ? '\nOrca / ' + ((n.orca || draft.orca)?.hostId || '未設定') + ' / ' + ((n.orca || draft.orca)?.path || 'ワークツリー未設定') : draft.executionBackend === 'herdr' ? '\nherdr / ' + draft.name + ' / ' + n.title : '');
  if (draft.executionBackend === 'orca') out.textContent += '\n' + (tool !== 'codex' || o?.notificationMode === 'manual' || o?.hostId !== 'local' && !o?.notificationMachineId ? '手動記録モード' : '終了通知 → AI による完了条件の判定');
}
const followupPrompts = new Map();
let addingTask = false;
const followupKey = () => draft.id + '/' + nodeId;
function workResultText(result) {
  if (typeof result?.workResponse === 'string') return result.workResponse;
  const response = result?.response || '', detail = result?.assessment?.detail;
  // Older runs stored the work and assessment in one response. Strip only the known suffix.
  if (typeof detail === 'string') {
    const suffix = response.match(/\n\nTaskDesk AI 判定（[^\n]*）:\n/gu)?.at(-1);
    if (suffix && response.endsWith(suffix + detail)) return response.slice(0, -(suffix + detail).length);
  }
  return response;
}
async function addFollowupTask() {
  if (addingTask || busy() || nodeSubmitting) return;
  const source = draft.nodes.find(n => n.id === nodeId), prompt = ($('#followup-prompt')?.value || '').trim();
  if (source?.kind !== 'task' || !prompt) throw new Error('タスク追加プロンプトを入力してください');
  addingTask = true; renderInspector();
  try {
    if (dirty) await save();
    const proposal = await api('/api/trees/' + draft.id + '/proposals', 'POST', { revision:draft.revision, scope:'insert', nodeId:source.id, request:prompt });
    if (proposal.status === 'failed') throw new Error(proposal.error);
    data.proposals ||= []; data.proposals.unshift(proposal);
    toast('AI が追加タスクを生成しています。生成後、この TASK の直後に自動追加します');
  } finally { addingTask = false; render(); }
}
function renderInspector() {
  renderNodeFooter();
  $('.inspector-tabs').hidden = false;
  $('#node-tab').classList.toggle('active', tab === 'node'); $('#result-tab').classList.toggle('active', tab === 'result'); $('#history-tab').classList.toggle('active', tab === 'history');
  const t = current(), target = $('#inspector-content'), n = t?.nodes.find(n => n.id === nodeId);
  $('#node-dialog-title').textContent = tab === 'history' ? '実行履歴' : n?.title || 'タスク設定';
  $('.dialog-eyebrow').textContent = n?.kind === 'group' ? 'WORK PACKAGE' : 'TASK';
  if (!t) { target.innerHTML = ''; return; }
  if (tab === 'history') {
    const runs = data.runs.filter(r => r.treeId === t.id);
    target.innerHTML = runs.map(r => '<article class="history-item"><div class="history-top">' + statusBadge(r.state.status) + '<span>' + esc(new Date(r.createdAt).toLocaleString('ja-JP')) + '</span></div>' + (r.state.error ? '<div class="error-box">' + esc(r.state.error) + '</div>' : '') + '<button class="button small" data-log="' + r.id + '">実行ログ</button>' + Object.entries(r.state.nodes || {}).map(([nid,x]) => '<h3>' + esc(t.nodes.find(n => n.id === nid)?.title || nid) + (x.outcome ? ' · ' + outcomeNames[x.outcome] : '') + '</h3>' + (x.response ? '<pre class="result-text">' + esc(x.response) + '</pre>' : '')).join('') + '</article>').join('') || '<p class="empty">実行履歴はまだありません</p>'; return;
  }
  if (!n) { target.innerHTML = '<p class="empty">WP または TASK を追加してください</p>'; return; }
  if (tab === 'result') {
    const insertion = (data.proposals || []).find(p=>p.treeId===t.id && p.anchorId===n.id && p.scope==='insert');
    const generating = (data.proposals || []).some(p=>p.treeId===t.id && p.status==='generating');
    const run = nodeRun(t, n.id) || data.runs.find(r => r.treeId === t.id && ['tree', 'node'].includes(r.kind) && r.state.nodes?.[n.id]?.response !== undefined);
    const result = run?.state.nodes?.[n.id], old = run && run.treeRevision !== t.revision;
    const outcome = Object.hasOwn(outcomeNames, result?.outcome) ? result.outcome : 'pending';
    target.innerHTML = '<div class="task-result-header"><span class="outcome-badge result-outcome ' + outcome + '" role="status" aria-label="完了ラベル：' + esc(outcomeNames[outcome] || '未判定') + '"><span aria-hidden="true">' + ({completed:'✓',needs_review:'!',error:'×',unexpected:'!',pending:'○'}[outcome]) + '</span> ' + esc(outcomeNames[outcome] || '未判定') + '</span>' +
      (n.kind === 'task' ? '<button class="button primary" data-add-followup ' + (busy() || nodeSubmitting || addingTask || generating ? 'disabled' : '') + '>タスク追加</button>' : '') + '</div>' +
      (insertion ? '<p role="status">' + esc(insertion.status==='generating' ? 'AI がバックグラウンドで生成中です。完了すると自動追加します…' : insertion.status==='applied' ? (insertion.nodes?.length || 0) + ' 件の TASK を追加しました：' + insertion.summary : insertion.error || '追加は完了していません') + '</p>' : '') +
      (old ? '<p class="muted">前のツリー設定で実行した結果です。</p>' : '') +
      (result?.confirmedByUser ? '<p class="muted">人が完了を承認済み</p>' : '') +
      '<h3>実行結果内容</h3><pre class="result-text" id="work-result-text">' + esc(workResultText(result) || '実行結果はまだありません') + '</pre>' +
      '<h3>完了条件判定結果内容</h3><pre class="result-text" id="assessment-result-text">' + esc(result?.assessment?.detail || result?.assessment?.response || '完了条件の判定結果はまだありません') + '</pre>' +
      (n.kind === 'task' ? field('タスク追加プロンプト（追加したいタスク一覧・箇条書き）', '<textarea id="followup-prompt" class="prompt" maxlength="12000" ' + (addingTask || generating ? 'disabled' : '') + ' placeholder="- エラーの原因を調査する&#10;- 修正を実装する&#10;- 次の TASK に必要な動作を検証する">' + esc((followupPrompts.get(followupKey()) ?? insertion?.request) || '') + '</textarea>') + '<p class="muted">AI が現在の TASK・実行結果・次の TASK を踏まえ、間を補完する TASK を生成し、同じ WP 内に自動追加します。各 TASK にプロンプトと完了条件を設定します。生成には AI の利用枠を使用します。' + (busy() ? '実行終了後に追加できます。' : '') + '</p>' : '') +
      (!old && result?.status === 'review' ? '<button class="button primary" data-control="approve" data-run="' + run.id + '" data-approve-node="' + n.id + '">結果を確認し、完了として次へ進む</button>' : '') +
      (!old && result?.canReassess && (result.status === 'review' || !busy()) ? '<button class="button" data-reassess="' + run.id + '" data-reassess-node="' + n.id + '">完了条件を再判定</button>' : '') +
      (result?.error ? '<div class="error-box">' + esc(result.error) + '</div>' : '');
    return;
  }
  const run = nodeRun(t, n.id), result = run?.state.nodes?.[n.id];
  target.innerHTML = '<div class="node-status-line">' + statusBadge(nodeStatus(n, t, run?.state)) + (busy() ? '<span>実行中の設定は変更できません</span>' : '') + '</div><fieldset id="node-fields" ' + (busy() || nodeSubmitting ? 'disabled' : '') + '>' +
    field(n.kind === 'group' ? '共通プロンプト' : 'プロンプト', nodeInput('prompt', n.prompt, 'textarea', 'class="prompt" placeholder="このタスクで実行する内容を入力"')) +
    (n.kind === 'task' ? field('完了条件（1 行に 1 条件）', nodeInput('criteria', n.criteria, 'textarea', 'placeholder="例：ログイン成功時にホーム画面が表示される"')) : '') +
    (n.kind === 'task' ? nodeExecutionSettings(n, t) : '') + '</fieldset>';
  renderExecutionTarget();
}
function render() { renderSidebar(); renderHeader(); renderCanvas(); renderInspector(); renderProposals(); }
function newNode(parentId = null) { return { id: uid(), title: '新しいタスク', kind: 'task', parentId, order: draft?.nodes.length || 0, prompt: '', criteria: '', tool: '', machineId: '', cwd: '', model: '', env: {}, dependsOn: [], sandbox: 'workspace-write', claudePermission: 'acceptEdits', reviewRequired: false }; }
async function save() {
  if (!draft || !dirty) return;
  if ($('[data-verification="args"]:invalid')) throw new Error('検証引数を文字列の JSON 配列で入力してください');
  if (invalidEnvNodeId) throw new Error('環境変数の JSON が不正です。修正してから保存してください');
  const envInput = $('[data-field="env"]');
  if (envInput) { try { JSON.parse(envInput.value); } catch { throw new Error('環境変数の JSON が不正です'); } }
  draft = await api('/api/trees/' + draft.id, 'PUT', draft); data.trees[data.trees.findIndex(t => t.id === draft.id)] = structuredClone(draft); dirty = false; if (editingTree) { editingBackup = structuredClone(draft); editingWasDirty = false; } render(); toast('変更を保存しました');
}
function modal(title, subtitle, contents, footer = '') {
  $('#modal-content').innerHTML = '<div class="modal-header"><div><h2>' + title + '</h2><p>' + subtitle + '</p></div><button class="close-modal" aria-label="閉じる">×</button></div><div class="modal-body">' + contents + '<div id="modal-error" class="error-box" hidden></div></div>' + (footer ? '<div class="modal-footer">' + footer + '</div>' : '');
  if (!$('#modal').open) $('#modal').showModal();
}
function closeModal() { $('#modal').close(); modalKind = ''; }
const modalButton = (action, label) => '<button class="button primary" data-modal-action="' + action + '">' + label + '</button>';
function showNew() {
  if (!discardOK()) return;
  modalKind = 'generate';
  const briefFields = [['purpose', '目的', '何を実現したいですか？'], ['current', '現状', '現在できていること、困っていること'], ['flow', '想定タスクフロー', '1. 調査\n2. 実装\n3. 検証'], ['criteria', '完了条件', '何ができれば完了としますか？'], ['constraints', '制約', '使用する技術、変更しない箇所など']];
  modal('タスクツリー作成', '目的と、今考えている進め方を入力してください。', briefFields.map(([key, title, hint]) => field(title, '<textarea id="brief-' + key + '" maxlength="12000" ' + (key === 'purpose' ? 'required' : '') + ' placeholder="' + esc(hint) + '"></textarea>')).join('') +
    '<details class="creation-settings" open><summary>実行の既定設定</summary>' + executionSettings({ ...(draft || {}), name: '', description: '', tool: draft?.tool || 'codex', machineId: draft?.machineId || 'local', runnerId: draft?.runnerId || 'local', cwd: draft?.cwd || '', timeoutMinutes: draft?.timeoutMinutes || 60 }) + '</details>', '<button class="button close-modal">閉じる</button>' + modalButton('generate', 'タスクツリー作成'));
  backendSettings();
  $('#brief-purpose').focus();
}
function executionSettings(t) {
  return field('ツリー名', '<input id="setting-name" value="' + esc(t.name) + '" maxlength="160">') + field('説明', '<textarea id="setting-description">' + esc(t.description) + '</textarea>') +
    field('実行先', '<select id="setting-backend">' + options([['direct', '通常実行'], ['herdr', 'herdr の対話 Agent'], ['orca', 'Orca の対話 Agent']], t.executionBackend || 'direct') + '</select>') +
    '<div id="orca-tree-settings">' + orcaPicker(t.orca, 'tree') + '<p class="muted">TaskDesk と Orca を同じ PC・ユーザーで起動してください。タスクごとに専用タブを作り、Orca のホスト上で AI ツールを実行します。実行先には Node.js と AI CLI が必要です。</p></div>' +
    field('herdr セッション', '<input id="setting-herdr-session" value="' + esc(t.herdrSession || 'default') + '">', 'Spaces にツリー名、Agents に実行ノード名を表示します。') +
    '<div class="field-row">' + field('既定の AI ツール', '<select id="setting-tool">' + options([['codex', 'Codex'], ['claude', 'Claude Code']], t.tool) + '</select>') + field('既定の実行マシン', '<select id="setting-machine">' + options(data.machines.map(m => [m.id, m.name]), t.machineId) + '</select>') + '</div>' +
    field('既定の作業ディレクトリ', '<input id="setting-cwd" value="' + esc(t.cwd) + '" placeholder="実行マシン上の絶対パス">') +
    field('実行管理を常駐させるマシン', '<select id="setting-runner">' + options(data.machines.map(m => [m.id, m.name + (m.type === 'ssh' ? '（PC を閉じても継続）' : '（この PC の起動中のみ）')]), t.runnerId) + '</select>', 'SSH を選ぶと、ツリー全体を接続先に渡して順次実行します。') +
    '<div class="detail-box warn">ブラウザを閉じても実行は継続します。手元の PC をスリープする場合は、常時稼働する SSH マシンで実行管理してください。スリープ中のローカル処理は動作しません。</div>' +
    field('タスクあたりの制限時間（分）', '<input id="setting-timeout" type="number" min="1" max="1440" value="' + t.timeoutMinutes + '">') + CliUI.render(t, {}, false, t.tool);
}
function readExecutionSettings() {
  const backend = $('#setting-backend').value;
  return { name: $('#setting-name').value.trim(), description: $('#setting-description').value, executionBackend: backend, herdrSession: $('#setting-herdr-session').value.trim() || 'default', tool: $('#setting-tool').value, machineId: $('#setting-machine').value, runnerId: backend === 'orca' ? 'local' : $('#setting-runner').value, cwd: $('#setting-cwd').value.trim(), timeoutMinutes: Number($('#setting-timeout').value), ...(backend === 'orca' ? { orca: readOrcaPicker('tree') } : {}), ...CliUI.read() };
}
function showSettings() {
  if (!draft) return; modalKind = 'settings'; const t = draft;
  modal('ツリーの実行設定', 'タスクが継承する設定と、実行を管理するマシンを指定します。',
    '<fieldset style="border:0;padding:0;margin:0" ' + (busy() ? 'disabled' : '') + '>' +
    executionSettings(t) + '</fieldset>',
    '<button class="button danger" data-modal-action="delete-tree" ' + (busy() ? 'disabled' : '') + '>ツリーを削除</button><button class="button primary" data-modal-action="settings-save" ' + (busy() ? 'disabled' : '') + '>設定を保存</button>');
  backendSettings();
}
function showMachines() {
  modalKind = 'machines';
  modal('マシンと AI ツール', 'ローカルと SSH 接続先の実行環境を管理します。',
    data.machines.map(m => '<div class="machine-card"><h3>▤ ' + esc(m.name) + '</h3><p>' + esc(m.type === 'local' ? data.server?.hostname + ' · ' + data.server?.platform : m.host + ':' + m.port + ' · SSH') + '</p><div class="machine-buttons"><button class="button small" data-probe="' + m.id + '">接続・CLI 確認</button><button class="button small" data-edit-machine="' + m.id + '">編集</button>' + (m.type === 'ssh' ? '<button class="button small danger" data-delete-machine="' + m.id + '">削除</button>' : '') + '</div><div class="machine-probe" id="probe-' + m.id + '"></div></div>').join('') +
    '<div class="detail-box">SSH 接続先は Linux / macOS と Node.js 22 以降に対応。鍵認証、known_hosts 登録、AI CLI のログインを事前に行ってください。</div>', modalButton('add-machine', '＋ SSH マシンを追加'));
}
function editMachine(mid = null) {
  modalKind = 'machine-edit'; machineEditing = mid;
  const m = data.machines.find(x => x.id === mid) || { name: '', host: '', port: 22, nodePath: 'node', codexPath: 'codex', claudePath: 'claude', type: 'ssh' };
  modal(mid ? 'マシン設定を編集' : 'SSH マシンを追加', '接続先の認証情報をコピーせず、既存の SSH 設定を利用します。',
    field('表示名', '<input id="machine-name" value="' + esc(m.name) + '" placeholder="開発サーバー">') +
    (m.type === 'ssh' ? '<div class="field-row">' + field('接続先 / SSH config 名', '<input id="machine-host" value="' + esc(m.host) + '" placeholder="user@server">') + field('ポート', '<input id="machine-port" type="number" value="' + m.port + '">') + '</div>' + field('Node.js の実行パス', '<input id="machine-node" value="' + esc(m.nodePath) + '">', '非対話 SSH で PATH が通らない場合は絶対パスを指定します。') : '') +
    field('Codex の実行パス', '<input id="machine-codex" value="' + esc(m.codexPath) + '">') + field('Claude Code の実行パス', '<input id="machine-claude" value="' + esc(m.claudePath) + '">', '実行マシンの CLI を指定。Windows の npm 版は JS エントリを自動検出します。'), modalButton('save-machine', '保存する'));
}
async function showLog(rid) {
  modalKind = 'log'; const r = data.runs.find(r => r.id === rid);
  modal('実行ログ', esc(r?.treeName || '') + ' · 最新 64 KB', '<pre id="log-output" class="result-text" style="max-height:55vh">ログを読み込み中…</pre>', '<button class="button" data-log-refresh="' + rid + '">更新</button>');
  try { const result = await api('/api/runs/' + rid + '/log'); if ($('#log-output')) $('#log-output').textContent = result.log || 'ログはまだありません'; } catch (e) { if ($('#log-output')) $('#log-output').textContent = e.message; }
}
function useInteractive() {
  if (!draft) return;
  if (['herdr', 'orca'].includes(draft.executionBackend) && draft.runnerId !== 'local') throw new Error('対話実行の管理マシンは「このマシン」にしてください');
}
async function startTree(resume = false) {
  useInteractive(); await save(); if (!draft) return;
  if (draft.executionBackend !== 'orca' && !draft.cwd && tasks(draft).some(n => !n.cwd)) { showSettings(); toast('実行する作業ディレクトリを設定してください', true); return; }
  if (!resume && matchingRun(draft) && !confirm('このツリーを最初から再実行します。既存の成果物が変更される場合があります。続行しますか？')) return;
  const run = await api('/api/trees/' + draft.id + '/run', 'POST', { resume }); await refresh(); toast(run.connectionError ? 'SSH で開始状況を確認しています' : 'ツリーの実行を開始しました');
}
async function modalAction(action, button) {
  button.disabled = true;
  try {
    if (action === 'generate') {
      const brief = Object.fromEntries(['purpose', 'current', 'flow', 'criteria', 'constraints'].map(k => [k, $('#brief-' + k).value.trim()]));
      if (!brief.purpose) throw new Error('目的を入力してください');
      const prompt = [['目的', brief.purpose], ['現状', brief.current], ['想定タスクフロー', brief.flow], ['完了条件', brief.criteria], ['制約', brief.constraints]].map(([k,v]) => k + '：\n' + v).join('\n\n');
      const created = await api('/api/generate', 'POST', { ...readExecutionSettings(), brief, prompt });
      pendingPlanId = created.id; localStorage.setItem('work-tree:pending-plan', created.id);
      button.textContent = '作成中…'; toast('ツリーを作成しています'); await refresh();
    }
    if (action === 'complete') {
      const response = $('#complete-response').value.trim();
      if (!response) throw new Error('結果の要約を入力してください');
      await api('/api/runs/' + button.dataset.run + '/control', 'POST', { action: 'complete', nodeId: button.dataset.nodeId, response, outcome: $('#complete-outcome').value });
      closeModal(); await refresh();
    }
    if (action === 'settings-save') {
      const backup = structuredClone(draft);
      Object.assign(draft, readExecutionSettings()); markDirty();
      try { await save(); closeModal(); } catch (e) { draft = backup; throw e; }
    }
    if (action === 'delete-tree' && confirm('このタスクツリーを削除しますか？ 実行履歴のファイルは保持されます。')) { await api('/api/trees/' + draft.id, 'DELETE'); closeModal(); draft = null; dirty = false; selectedId = null; await refresh(); }
    if (action === 'add-machine') editMachine();
    if (action === 'save-machine') {
      const existing = data.machines.find(m => m.id === machineEditing);
      const m = { name: $('#machine-name').value, host: $('#machine-host')?.value.trim(), port: Number($('#machine-port')?.value || 22), nodePath: $('#machine-node')?.value || 'node', codexPath: $('#machine-codex').value, claudePath: $('#machine-claude').value };
      await api('/api/machines' + (existing ? '/' + existing.id : ''), existing ? 'PUT' : 'POST', m); await refresh(); showMachines(); toast('マシン設定を保存しました');
    }
  } catch (e) { const box = $('#modal-error'); if (box) { box.hidden = false; box.textContent = e.message; } else toast(e.message, true); }
  finally { button.disabled = action === 'generate' && Boolean(pendingPlanId); }
}
async function action(name) {
  if (invalidEnvNodeId) throw new Error('環境変数の JSON を修正してから操作してください');
  if (name === 'settings') return showSettings();
  if (name === 'edit-tree') {
    if (!draft || busy()) return;
    if (editingTree) { await save(); editingTree = false; editingBackup = null; }
    else { editingBackup = structuredClone(draft); editingWasDirty = dirty; editingTree = true; }
    renderHeader(); renderCanvas(); return;
  }
  if (name === 'cancel-edit') { if (editingBackup) { draft = editingBackup; dirty = editingWasDirty; } editingTree = false; editingBackup = null; render(); return; }
  if (['run-selected', 'run-wp'].includes(name)) {
    if (nodeSubmitting || busy()) return;
    nodeSubmitting = true;
    try { await save(); await api('/api/trees/' + draft.id + '/run', 'POST', { next: name === 'run-wp' ? 'wp' : 'task', revision: draft.revision }); await refresh(); }
    finally { nodeSubmitting = false; renderHeader(); }
    return;
  }
  if (name === 'start') return startTree(false);
  if (name === 'resume-tree') return startTree(true);
  if (!draft) return showNew();
  if (nodeSubmitting) return;
  if (busy()) throw new Error('実行を停止してから編集してください');
  if (name === 'save-node') {
    nodeSubmitting = true; renderInspector();
    try { await save(); }
    finally { nodeSubmitting = false; renderInspector(); }
    return;
  }
  const n = draft.nodes.find(n => n.id === nodeId);
  if (name === 'run-node' && n) {
    useInteractive(); const selectedNode = n.id;
    nodeSubmitting = true; $('#node-error').hidden = true; renderInspector();
    try {
      await save();
      const run = await api('/api/trees/' + draft.id + '/run', 'POST', { nodeId: selectedNode, revision: draft.revision });
      editingTree = false; editingBackup = null; renderHeader(); renderCanvas();
      await refresh();
      const state = data.runs.find(r => r.id === run.id)?.state;
      if (state?.status === 'failed') throw new Error(state.error || 'ノード実行を開始できませんでした');
      toast(['herdr', 'orca'].includes(run.executionBackend) ? run.executionBackend + ' でノード実行を開始しました' : 'ノード実行を開始しました');
    } catch (e) { nodeError(e.message); }
    finally { nodeSubmitting = false; renderInspector(); }
    return;
  }
  if (['add-wp', 'add-root', 'add-child', 'add-sibling'].includes(name)) {
    if (name === 'add-child' && n) {
      if (n.kind === 'task') {
        if (draft.nodes.some(x => x.dependsOn.includes(n.id))) throw new Error('依存先として使用中のタスクはグループに変更できません');
        if (n.prompt && !confirm('このノードをグループに変更します。既存のプロンプトは子タスクの共通背景になります。続行しますか？')) return;
        n.kind = 'group'; n.dependsOn = [];
      }
    }
    const added = newNode(name === 'add-child' ? n?.id || null : name === 'add-sibling' ? n?.parentId || null : null); if (name === 'add-wp') { added.kind = 'group'; added.title = '新しい WP'; } draft.nodes.push(added); nodeId = added.id;
  }
  if (name === 'delete-node' && n) {
    const gone = new Set([n.id, ...descendants(n.id)]);
    if (!confirm(n.title + ' と子ノード（計 ' + gone.size + ' 個）を削除しますか？')) return;
    draft.nodes = draft.nodes.filter(x => !gone.has(x.id)).map(x => ({ ...x, dependsOn: x.dependsOn.filter(d => !gone.has(d)) })); nodeId = draft.nodes[0]?.id || null;
  }
  if (['move-up', 'move-down'].includes(name) && n) {
    const siblings = draft.nodes.filter(x => x.parentId === n.parentId).sort((a, b) => a.order - b.order); const i = siblings.indexOf(n), other = siblings[i + (name === 'move-up' ? -1 : 1)];
    if (!other) return; [n.order, other.order] = [other.order, n.order];
  }
  markDirty(); render();
  if (name.startsWith('add-')) { editingTree = true; renderHeader(); renderCanvas(); document.querySelector('[data-inline-field="title"][data-id="' + nodeId + '"]')?.focus(); }
}
document.addEventListener('click', async event => {
  const b = event.target.closest('button'); if (!b || b.disabled) return;
  try {
    if (b.classList.contains('close-modal')) return closeModal();
    if (b.dataset.completeRun) return showComplete(b.dataset.completeRun);
    if (b.dataset.nodeSettings) { nodeId = b.dataset.nodeSettings; tab = 'node'; return openNodePanel(); }
    if (b.dataset.addTo) { nodeId = b.dataset.addTo; return await action('add-child'); }
    if (b.dataset.removeNode) { nodeId = b.dataset.removeNode; return await action('delete-node'); }
    if (b.dataset.moveNode) { moveByButton(b.dataset.moveNode, Number(b.dataset.direction)); return; }
    if (b.dataset.closeNode !== undefined) { if (canCloseNode()) $('#node-dialog').close(); return; }
    if (b.dataset.editNode) { nodeId = b.dataset.editNode; renderInspector(); renderHeader(); renderCanvas(); return; }
    if (b.dataset.selectWp) { nodeId = b.dataset.selectWp; renderHeader(); renderCanvas(); return; }
    if (b.dataset.tree) return selectTree(b.dataset.tree);
    if (b.dataset.node) { if (invalidEnvNodeId) throw new Error('環境変数の JSON を修正してから別のノードを選んでください'); nodeId = b.dataset.node; tab = 'node'; renderHeader(); renderCanvas(); openNodePanel(); return; }
    if (b.dataset.action) return await action(b.dataset.action);
    if (b.dataset.modalAction) return await modalAction(b.dataset.modalAction, b);
    if (b.dataset.log || b.dataset.logRefresh) return await showLog(b.dataset.log || b.dataset.logRefresh);
    if (b.dataset.reassess) {
      b.disabled = true;
      try { await api('/api/runs/' + b.dataset.reassess + '/reassess', 'POST', { nodeId: b.dataset.reassessNode }); toast('再判定を開始しました'); await refresh(); } finally { b.disabled = false; }
      return;
    }
    if (b.hasAttribute('data-add-followup')) return await addFollowupTask();
    if (b.dataset.control) {
      if (b.dataset.control === 'stop' && !confirm('この実行を停止しますか？ 実行済みの変更は保持されます。')) return;
      b.disabled = true;
      try { await api('/api/runs/' + b.dataset.run + '/control', 'POST', { action: b.dataset.control, nodeId: b.dataset.approveNode }); toast(b.dataset.control === 'pause' ? '現在のタスク終了後に一時停止します' : '操作を送信しました'); await refresh(); } finally { b.disabled = false; }
    }
    if (b.dataset.editMachine) return editMachine(b.dataset.editMachine);
    if (b.dataset.deleteMachine && confirm('この SSH マシンを削除しますか？')) { await api('/api/machines/' + b.dataset.deleteMachine, 'DELETE'); await refresh(); showMachines(); }
    if (b.dataset.probe) {
      b.disabled = true; const out = $('#probe-' + b.dataset.probe); out.textContent = '接続と CLI を確認しています…';
      try { const r = await api('/api/machines/' + b.dataset.probe + '/probe', 'POST', {}); out.textContent = r.hostname + ' / ' + r.platform + ' / Node ' + r.node + (r.runtime ? '\n実行ユーザー: ' + (r.runtime.ok ? r.runtime.username : r.runtime.error) : '') + '\nCodex: ' + r.tools.codex + '\nClaude Code: ' + r.tools.claude + '\n※ ログイン状態と実行権限は npm run doctor または実行時に確認できます'; } catch (e) { out.textContent = e.message; } finally { b.disabled = false; }
    }
  } catch (e) { if ($('#node-dialog').open) nodeError(e.message); else toast(e.message, true); }
});
$('#inspector-content').addEventListener('input', event => {
  if (event.target.id === 'followup-prompt') { followupPrompts.set(followupKey(), event.target.value); return; }
  const input = event.target, n = draft?.nodes.find(n => n.id === nodeId); if (!n || busy() || nodeSubmitting) return;
  $('#node-error').hidden = true;
  if (input.dataset.verification) {
    const key = input.dataset.verification;
    n.verification ||= { command: '', args: [], timeoutSeconds: 60, autoComplete: false };
    try {
      let value = key === 'autoComplete' ? input.checked : key === 'timeoutSeconds' ? Number(input.value) : input.value;
      if (key === 'args') { value = JSON.parse(value); if (!Array.isArray(value) || !value.every(x => typeof x === 'string')) throw Error(); }
      n.verification[key] = value; input.setCustomValidity('');
    } catch { input.setCustomValidity('文字列の JSON 配列を指定してください'); }
    markDirty(); return;
  }
  if (input.dataset.nodeOption) {
    const tool = n.tool || draft.tool; n.cli ||= {}; n.cli[tool] ||= {}; n.cli[tool][input.dataset.nodeOption] = input.value; markDirty(); renderExecutionTarget(); return;
  }
  if (input.dataset.treeOption === 'executionBackend') { draft.executionBackend = input.value; markDirty(); renderHeader(); renderExecutionTarget(); return; }
  if (input.dataset.dependency) { n.dependsOn = [...document.querySelectorAll('[data-dependency]:checked')].map(x => x.dataset.dependency); markDirty(); renderCanvas(); return; }
  const key = input.dataset.field; if (!key) return;
  if (invalidEnvNodeId && ['kind', 'tool', 'parentId'].includes(key)) { input.value = n[key] || ''; return toast('環境変数の JSON を先に修正してください', true); }
  let value = input.type === 'checkbox' ? input.checked : input.value;
  if (key === 'kind' && value === 'task' && draft.nodes.some(x => x.parentId === n.id)) { input.value = n.kind; return toast('子ノードを移動または削除してから変更してください', true); }
  if (key === 'kind' && value === 'group' && draft.nodes.some(x => x.dependsOn.includes(n.id))) { input.value = n.kind; return toast('ほかのタスクの依存先から外してから変更してください', true); }
  if (key === 'parentId') value = value || null;
  if (key === 'env') { try { value = JSON.parse(value); if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(v => typeof v !== 'string')) throw new Error('object required'); input.setCustomValidity(''); invalidEnvNodeId = null; } catch { input.setCustomValidity('文字列の値を持つ JSON オブジェクトを指定してください'); invalidEnvNodeId = n.id; markDirty(); return; } }
  n[key] = value; if (key === 'kind' && value === 'group') n.dependsOn = []; markDirty(); renderCanvas(); renderExecutionTarget();
  if (['kind', 'tool', 'parentId'].includes(key)) renderInspector();
});
$('#new-tree').onclick = showNew; $('#machines-button').onclick = showMachines;
$('#search').oninput = renderSidebar; $('#save-tree').onclick = () => save().catch(e => toast(e.message, true));
function canCloseNode() {
  if (!invalidEnvNodeId) return true;
  nodeError('環境変数の JSON を修正してから閉じてください'); return false;
}
$('#close-node').onclick = () => { if (canCloseNode()) $('#node-dialog').close(); };
$('#node-dialog').addEventListener('cancel', event => { if (!canCloseNode()) event.preventDefault(); });
$('#open-history').onclick = () => { tab = 'history'; openNodePanel(); };
$('#result-tab').onclick = () => {
  if (invalidEnvNodeId || $('[data-verification="args"]:invalid')) return nodeError('入力内容を修正してからタブを切り替えてください');
  tab = 'result'; renderInspector();
};
$('#node-tab').onclick = () => { if (invalidEnvNodeId) return; tab = 'node'; renderInspector(); }; $('#history-tab').onclick = () => { if (invalidEnvNodeId) return toast('環境変数の JSON を修正してください', true); tab = 'history'; renderInspector(); };
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); save().catch(e => toast(e.message, true)); }
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) && !$('#modal').open && !$('#node-dialog').open) { event.preventDefault(); $('#search').focus(); }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
async function settlePlan() {
  if (importingPlan || !pendingPlanId) return;
  const run = data.runs.find(r => r.id === pendingPlanId);
  if (!run || active.has(run.state.status)) return;
  importingPlan = true;
  try {
    if (run.state.status !== 'succeeded') throw new Error(run.state.error || 'ツリーの作成に失敗しました');
    // Import does not execute the generated tasks.
    const tree = await api('/api/runs/' + run.id + '/import', 'POST', {});
    data.trees = [tree, ...data.trees.filter(t => t.id !== tree.id)];
    if (modalKind === 'generate') closeModal();
    if (!dirty) selectTree(tree.id, true);
    else { renderSidebar(); toast('新しいツリーを作成しました'); }
  } catch (e) { toast(e.message, true); const b = $('[data-modal-action="generate"]'); if (b) { b.disabled = false; b.textContent = 'タスクツリー作成'; } }
  finally { pendingPlanId = null; localStorage.removeItem('work-tree:pending-plan'); importingPlan = false; }
}
function moveNode(id, parentId, beforeId = null) {
  if (!editingTree || busy()) return;
  const n = draft.nodes.find(n => n.id === id);
  if (!n || parentId === id || descendants(id).includes(parentId)) return toast('自分自身や子孫の中には移動できません', true);
  if (parentId && draft.nodes.find(n => n.id === parentId)?.kind !== 'group') return;
  if (beforeId === id) return;
  const siblings = draft.nodes.filter(n => n.parentId === parentId && n.id !== id).sort((a,b) => a.order-b.order);
  const index = beforeId ? siblings.findIndex(n => n.id === beforeId) : siblings.length;
  siblings.splice(index < 0 ? siblings.length : index, 0, n); n.parentId = parentId;
  siblings.forEach((n,i) => n.order = i); nodeId = id; markDirty(); renderCanvas();
}
function moveByButton(id, direction) {
  const n = draft.nodes.find(n => n.id === id), siblings = draft.nodes.filter(x => x.parentId === n.parentId && (n.kind !== 'group' || x.kind === 'group')).sort((a,b) => a.order-b.order), index = siblings.indexOf(n);
  if (index + direction < 0 || index + direction >= siblings.length) return;
  moveNode(id, n.parentId, direction < 0 ? siblings[index-1].id : siblings[index+2]?.id || null);
}
$('#canvas-stage').addEventListener('input', event => {
  const input = event.target, n = draft?.nodes.find(n => n.id === input.dataset.id);
  if (!editingTree || busy() || !n) return;
  if (input.dataset.inlineField) { n[input.dataset.inlineField] = input.value; markDirty(); }
  if (input.dataset.inlineDep) { n.dependsOn = input.checked ? [...new Set([...n.dependsOn,input.dataset.inlineDep])] : n.dependsOn.filter(id => id !== input.dataset.inlineDep); markDirty(); }
  if (input.hasAttribute('data-inline-parent')) moveNode(n.id, input.value || null);
});
$('#project-header').addEventListener('input', event => { if (event.target.hasAttribute('data-tree-name') && editingTree && !busy()) { draft.name = event.target.value; markDirty(); } });
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const nextData = await api('/api/state');
    const changed = JSON.stringify(nextData) !== JSON.stringify(data);
    data = nextData; $('#connection-label').textContent = '実行サーバーに接続済み';
    if (pendingPlanId) {
      void settlePlan();
      const plan = data.runs.find(r => r.id === pendingPlanId), nid = plan?.state.currentNodeId;
      if (modalKind === 'generate' && plan?.executionBackend === 'orca') {
        let out = $('#creation-progress');
        if (!out) { out = document.createElement('div'); out.id = 'creation-progress'; $('#modal-content').append(out); }
        out.innerHTML = '<p>Orca で計画を作成中です。</p>' + orcaFocusButton(plan, nid);
        if (['ready', 'confirmation'].includes(plan.state.nodes?.[nid]?.interactive?.phase)) out.innerHTML += '<button class="button small" data-complete-run="' + esc(plan.id) + '">計画 JSON を記録</button>';
      }
    }
    if (!changed) return;
    if (!data.trees.some(t => t.id === selectedId)) { selectedId = data.trees[0]?.id || null; draft = structuredClone(data.trees[0] || null); nodeId = draft?.nodes[0]?.id || null; dirty = false; }
    if (!dirty && selectedId) draft = structuredClone(data.trees.find(t => t.id === selectedId));
    renderProposals();
    renderSidebar(); if (!editingTree || !$('#project-header').contains(document.activeElement)) renderHeader();
    // Keep a focused editor stable while polling live execution state.
    const focusedEditor = $('#inspector-content').contains(document.activeElement) && document.activeElement.matches('input:enabled, textarea:enabled, select:enabled');
    if (!dirty && !editingTree && !$('#modal').open && (!focusedEditor || busy())) { renderCanvas(); renderInspector(); }
  } catch (e) { $('#connection-label').textContent = '再接続を待っています'; }
  finally { refreshing = false; }
}
async function init() { try { token = (await api('/api/session')).token; await CliUI.init(); await refresh(); render(); setInterval(refresh, 2000); } catch (e) { toast(e.message, true); } }
init();
