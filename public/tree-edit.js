'use strict';
const outcomeNames = { completed: '完了', needs_review: '要確認', error: 'エラー', unexpected: '想定外結果' };
function taskOutcome(n, t) {
  const currentRun = nodeRun(t,n.id);
  const run = currentRun?.state.nodes[n.id]?.outcome ? currentRun : data.runs.find(r => r.treeId === t.id && ['tree','node'].includes(r.kind) && ['succeeded','failed','review'].includes(r.state.nodes?.[n.id]?.status) && !r.state.nodes[n.id].reused);
  const result = run?.state.nodes[n.id];
  return result ? { run, result, outcome: result.outcome || (result.status === 'succeeded' ? 'completed' : result.status === 'review' ? 'needs_review' : 'error') } : null;
}
function outcomeBadge(n, t) {
  const item = taskOutcome(n,t); if (!item) return '';
  const currentRun = nodeRun(t,n.id), currentResult = currentRun?.state.nodes[n.id];
  if (currentResult?.status === 'running') return '';
  const previous = !TaskDeskExecution.taskMatches(t, item.run, n.id) || currentRun && currentRun.id !== item.run.id;
  return '<span class="outcome-badge ' + item.outcome + '" title="' + (previous ? '編集前・前回の実行結果' : 'タスクの実行結果') + '">' + (previous ? '前回：' : '') + outcomeNames[item.outcome] + '</span>';
}
function proposalMarkup(p) {
  const disabled = dirty || busy() || p.stale, title = p.sourceNodeId ? '結果からのツリー編集案' : 'AI 編集案';
  const diff = (p.changes || []).map(c => {
    const details = n => n ? [n.kind === 'group' ? 'WP' : 'TASK', n.title, 'プロンプト：' + n.prompt, '完了条件：' + n.criteria, '配置先：' + (draft.nodes.find(x=>x.id===n.parentId)?.title || n.parentId || '最上位'), '順序：' + n.order, '依存先：' + n.dependsOn.map(id=>draft.nodes.find(n=>n.id===id)?.title || id).join('、')].join('\n') : 'なし';
    return '<li><strong>' + ({add:'追加',remove:'削除',update:'変更'})[c.kind] + ' · ' + esc(c.after?.title || c.before.title) + '</strong><div class="proposal-diff"><div><small>変更前</small><pre>' + esc(details(c.before)) + '</pre></div><div><small>変更後</small><pre>' + esc(details(c.after)) + '</pre></div></div></li>';
  }).join('');
  let contents = p.status === 'generating' ? '<p role="status">編集案を作成しています…</p>' : p.status === 'failed' ? '<p class="error-text">' + esc(p.error) + '</p>' : p.status === 'dismissed' ? '<p>この編集案は見送りました。</p>' : p.status === 'applied' ? '<p>編集案を適用しました。</p>' : '<p>' + esc(p.summary) + '</p><details data-proposal-details="' + p.id + '"><summary>変更内容を確認（' + (p.changes?.length || 0) + ' 件）</summary><ul class="proposal-changes">' + diff + '</ul></details>';
  if (p.status === 'ready') contents += '<p class="proposal-hint">' + (p.stale ? 'ツリーや実行結果が更新されています。再生成してください。' : dirty ? '未保存の編集があります。保存してから案を再生成してください。' : '適用してもタスクは自動実行しません。') + '</p><div class="proposal-actions"><button class="button small primary" data-proposal-action="apply" data-proposal="' + p.id + '" ' + (disabled ? 'disabled' : '') + '>この案で編集する</button><button class="button small" data-proposal-action="dismiss" data-proposal="' + p.id + '">編集しない</button></div>';
  if (p.status === 'failed') contents += '<button class="text-button" data-proposal-action="dismiss" data-proposal="' + p.id + '">見送る</button>';
  if (p.status === 'failed' || p.status === 'dismissed' || p.status === 'ready' && p.stale) contents += '<button class="text-button" data-proposal-action="retry" data-proposal="' + p.id + '" ' + (busy() ? 'disabled' : '') + '>編集案を再生成</button>';
  return '<article class="proposal-card" data-proposal-id="' + p.id + '"><div class="proposal-heading"><strong>' + title + '</strong><small>' + p.scopeIds.length + ' ノードを対象</small></div>' + contents + '</article>';
}
function renderProposals() {
  if (!draft) { $('#manual-proposals').innerHTML = ''; return; }
  const proposals = (data.proposals || []).filter(p => p.treeId === draft.id && p.scope !== 'insert');
  const update = (el, html) => {
    if (el.dataset.html === html) return;
    const open = [...el.querySelectorAll('details[open]')].map(x => x.dataset.proposalDetails);
    el.innerHTML = html; el.dataset.html = html;
    el.querySelectorAll('details').forEach(x => { if (open.includes(x.dataset.proposalDetails)) x.open = true; });
  };
  update($('#manual-proposals'), proposals.filter(p=>!p.sourceNodeId && !['applied','dismissed'].includes(p.status)).map(proposalMarkup).join(''));
  for (const el of document.querySelectorAll('[data-task-proposals]')) {
    const n = draft.nodes.find(n=>n.id===el.dataset.taskProposals), latestResult = n && taskOutcome(n,draft);
    const p = proposals.find(p=>p.sourceNodeId === el.dataset.taskProposals && p.sourceRunId === latestResult?.run.id);
    update(el, p ? proposalMarkup(p) : '');
  }
}
async function showAIEdit(anchor = nodeId) {
  if (busy()) throw Error('実行終了後に編集してください');
  modalKind = 'ai-edit';
  modal('AI でツリーを編集', '編集案を確認してから適用できます。',
    field('編集範囲', '<select id="ai-scope">' + options([['tree','ツリー全体'], ...draft.nodes.map(n=>[n.id,(n.kind==='group'?'WP · ':'TASK · ')+n.title+(n.kind==='group'?' と配下':'' )])], anchor || 'tree') + '</select>') +
    field('変更したいこと', '<textarea id="ai-request" maxlength="12000" placeholder="例：原因調査を先に行い、検証TASKを追加する"></textarea>') +
    '<p class="muted">現在の編集を保存してから案を作成します。モデルは対象TASK・WPの設定、全体の場合はツリーの既定値を使います。</p>',
    '<button class="button close-modal">戻る</button><button class="button primary" data-ai-generate>編集案を作成</button>');
}
document.addEventListener('click', async event => {
  const b = event.target.closest('button'); if (!b || b.disabled) return;
  try {
    if (b.hasAttribute('data-ai-edit')) return await showAIEdit(b.dataset.aiEdit || nodeId);
    if (b.hasAttribute('data-ai-generate')) {
      const request = $('#ai-request').value.trim(), scope = $('#ai-scope').value;
      if (!request) throw Error('変更したいことを入力してください');
      b.disabled = true;
      try { await save(); await api('/api/trees/' + draft.id + '/proposals','POST',{ revision: draft.revision, scope: scope === 'tree' ? 'tree' : 'branch', nodeId: scope === 'tree' ? undefined : scope, request }); closeModal(); await refresh(); renderProposals(); }
      finally { b.disabled = false; }
    }
    if (b.dataset.proposalAction) {
      b.disabled = true;
      try {
        const p = data.proposals.find(p=>p.id === b.dataset.proposal), action = b.dataset.proposalAction;
        if (action === 'retry') {
          await save();
          await api('/api/trees/' + draft.id + '/proposals','POST',{ revision:draft.revision, scope:p.scope === 'downstream' ? 'branch' : p.scope, nodeId:p.anchorId, request:p.request, sourceRunId:p.sourceRunId, sourceNodeId:p.sourceNodeId });
        } else {
          if (action === 'apply' && dirty) throw Error('未保存の編集を保存し、案を再生成してください');
          const result = await api('/api/proposals/' + p.id + '/' + action,'POST',{});
          if (result.tree && action === 'apply') { draft = result.tree; data.trees[data.trees.findIndex(t=>t.id===draft.id)] = structuredClone(draft); editingBackup = structuredClone(draft); editingWasDirty = false; if (!draft.nodes.some(n=>n.id===nodeId)) nodeId = draft.nodes[0]?.id || null; render(); toast('編集案を適用しました'); }
        }
        await refresh(); renderProposals();
      } finally { b.disabled = false; }
    }
  } catch (e) { if ($('#modal').open && $('#modal-error')) { $('#modal-error').hidden = false; $('#modal-error').textContent = e.message; } else toast(e.message,true); }
});

// Native HTML drag and drop, with frame-based scrolling even when the cursor
// stays still at an edge. Stop on every exit path to avoid runaway scrolling.
let treeDrag = null, dragFrame = 0, dragPoint = null;
function clearDropMarks() { document.querySelectorAll('.drop-before,.drop-after,.drag-over').forEach(el=>el.classList.remove('drop-before','drop-after','drag-over')); }
function stopTreeDrag() { treeDrag = null; dragPoint = null; cancelAnimationFrame(dragFrame); dragFrame = 0; clearDropMarks(); }
function scrollTreeDrag() {
  if (!treeDrag || !dragPoint || !editingTree) return stopTreeDrag();
  const edge = 90, y = dragPoint.y, speed = y < edge ? -Math.ceil(20*(edge-y)/edge) : y > innerHeight-edge ? Math.ceil(20*(y-innerHeight+edge)/edge) : 0;
  if (speed) {
    const under = document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,dragPoint.x)), Math.max(0,Math.min(innerHeight-1,y)));
    let scroller = under;
    while (scroller && scroller !== document.body && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    (scroller && scroller !== document.body ? scroller : document.scrollingElement).scrollTop += speed;
  }
  dragFrame = requestAnimationFrame(scrollTreeDrag);
}
function treeDropTarget(event) {
  const hit = event.target instanceof Element ? event.target : document.elementFromPoint(event.clientX,event.clientY);
  if (!hit) return null;
  const zone = hit.closest('.drop-zone');
  if (zone) return { el:zone, parentId:zone.dataset.dropParent || null, beforeId:null, inside:true };
  let el = hit.closest('[data-drop-node]');
  if (draft.nodes.find(n=>n.id===treeDrag)?.kind === 'group') el = hit.closest('.editable-wp');
  const n = draft.nodes.find(n=>n.id===el?.dataset.dropNode); if (!n || n.id === treeDrag) return null;
  const rect = el.getBoundingClientRect(), after = event.clientY > rect.top + rect.height/2;
  const siblings = draft.nodes.filter(x=>x.parentId===n.parentId).sort((a,b)=>a.order-b.order);
  return { el, parentId:n.parentId, beforeId:after ? siblings[siblings.indexOf(n)+1]?.id || null : n.id, after };
}
$('#canvas-stage').addEventListener('dragstart', event => {
  const handle = event.target.closest('[data-drag-id]'); if (!handle || !editingTree || busy()) return event.preventDefault();
  treeDrag = handle.dataset.dragId; dragPoint = { x:event.clientX, y:event.clientY };
  event.dataTransfer.setData('application/work-tree', treeDrag); event.dataTransfer.effectAllowed = 'move';
  dragFrame = requestAnimationFrame(scrollTreeDrag);
});
document.addEventListener('dragover', event => {
  if (!treeDrag) return;
  event.preventDefault(); dragPoint = { x:event.clientX, y:event.clientY }; clearDropMarks();
  const target = treeDropTarget(event); if (target) target.el.classList.add(target.inside ? 'drag-over' : target.after ? 'drop-after' : 'drop-before');
});
document.addEventListener('drop', event => {
  if (!treeDrag) return; event.preventDefault();
  const dragged = treeDrag, target = treeDropTarget(event); stopTreeDrag();
  if (target) moveNode(dragged,target.parentId,target.beforeId);
});
document.addEventListener('dragend',stopTreeDrag);
document.addEventListener('dragleave', event => { if (!event.relatedTarget && (event.clientY <= 0 || event.clientY >= innerHeight || event.clientX <= 0 || event.clientX >= innerWidth)) { dragPoint = null; stopTreeDrag(); } });
window.addEventListener('blur',stopTreeDrag);
document.addEventListener('keydown', event => { if (event.key === 'Escape') stopTreeDrag(); });
