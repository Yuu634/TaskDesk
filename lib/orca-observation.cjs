'use strict';
const path = require('node:path');
const { read, atomic, ACTIVE } = require('./core.cjs');
const { call, verifyTerminal } = require('./orca.cjs');

// Screen evidence can request review, but can never establish that criteria passed.
function screenEvidence(value, binding) {
  const terminal = value?.terminal;
  if (binding.tool !== 'codex' || terminal?.handle !== binding.handle || terminal.source !== 'screen' || !Array.isArray(terminal.tail)) return null;
  const lines = terminal.tail.filter(x => typeof x === 'string');
  const working = lines.find(x => /^\s*•\s+(?:Working|Thinking)\s*\(/.test(x));
  if (working && lines.some(x => /esc to interrupt/i.test(x))) return { kind: 'working', evidence: working.trim() };
  const worked = lines.find(x => /^\s*Worked for \d[^\r\n]*$/.test(x));
  const answer = lines.some(x => /^\s*•\s+\S/.test(x));
  const input = lines.some(x => /^\s*›/.test(x));
  if (worked && answer && input) return { kind: 'response', evidence: worked.trim() };
  return null;
}
function reviewResult(screen) {
  const response = screen.terminal.tail.join('\n');
  return { response, workResponse: response, outcome: 'needs_review', assessment: {
    detail: 'Orca の応答終了を確認しました。通知を利用しない手動記録モードのため、完了条件は未判定です。表示中の端末画面を保存しています（全文ではない場合があります）。結果を確認して完了を承認してください。'
  } };
}
function timedOutNode(state) {
  if (state.status !== 'failed' || state.error !== 'Orca 対話タスクの制限時間を超えました') return null;
  return Object.keys(state.nodes || {}).find(id => state.nodes[id].status === 'failed' && state.nodes[id].error === state.error) || null;
}
class OrcaObservation {
  constructor(store, invoke = call) { this.store = store; this.invoke = invoke; this.cache = new Map(); this.scanning = false; }
  async refresh() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const recoverable = run => ['node', 'tree'].includes(run.kind) && this.store.data.trees?.some(t => t.id === run.treeId && t.revision === run.treeRevision) && this.store.data.runs.find(r => r.treeId === run.treeId && ['node', 'tree'].includes(r.kind))?.id === run.id;
      const targets = this.store.data.runs.filter(r => r.executionBackend === 'orca' && (ACTIVE.has(this.store.state(r).status) || recoverable(r) && timedOutNode(this.store.state(r))));
      const keys = new Set(targets.map(r => r.id));
      for (const key of this.cache.keys()) if (!keys.has(key)) this.cache.delete(key);
      await Promise.allSettled(targets.map(async run => {
        try {
          const state = this.store.state(run), nodeId = state.currentNodeId || timedOutNode(state), interactive = state.nodes?.[nodeId]?.interactive;
          if (!interactive?.promptSent || interactive.notificationMode !== 'manual' || interactive.backend !== 'orca') return this.cache.delete(run.id);
          const input = read(path.join(this.store.runDir(run.id), 'input.json'));
          if (!input?.orca?.target) return;
          const before = await verifyTerminal(input.orca.target, interactive, this.invoke);
          if (before.agentIdentity !== interactive.tool) throw Error('AI identity changed');
          const screen = await this.invoke(input.orca.target, ['terminal', 'read', '--terminal', interactive.handle, '--screen', '--limit', '300']);
          const evidence = screenEvidence(screen, interactive);
          if (!evidence) return this.cache.delete(run.id);
          let idle = false;
          if (evidence.kind === 'response') {
            const value = await this.invoke(input.orca.target, ['terminal', 'wait', '--terminal', interactive.handle, '--for', 'tui-idle', '--timeout-ms', '100']);
            idle = value.wait?.handle === interactive.handle && value.wait.satisfied === true && !value.wait.blockedReason;
          }
          const after = await verifyTerminal(input.orca.target, interactive, this.invoke);
          if (after.agentIdentity !== interactive.tool) throw Error('AI identity changed');
          this.cache.set(run.id, { nodeId, binding: interactive, evidence, idle, checkedAt: Date.now() });
          // Only migrate a finished, latest run. Never race a live worker's writes.
          const latest = this.store.state(run);
          if (latest.offlineReview && latest.currentNodeId === nodeId && (evidence.kind === 'working' || evidence.kind === 'response' && latest.nodes[nodeId].workResponse && latest.nodes[nodeId].workResponse !== screen.terminal.tail.join('\n'))) {
            latest.nodes[nodeId].resultStale = true;
            atomic(path.join(this.store.runDir(run.id), 'state.json'), latest);
          }
          if (evidence.kind === 'response' && idle && recoverable(run) && timedOutNode(latest) === nodeId && JSON.stringify(latest) === JSON.stringify(state)) {
            atomic(path.join(this.store.runDir(run.id), 'before-timeout-recovery.json'), state);
            Object.assign(latest.nodes[nodeId], reviewResult(screen), { status: 'review', error: null, interactive: { ...interactive, phase: 'confirmation', canComplete: false, executionStarted: true } });
            Object.assign(latest, { status: 'review', currentNodeId: nodeId, error: null, offlineReview: true, updatedAt: new Date().toISOString() });
            atomic(path.join(this.store.runDir(run.id), 'state.json'), latest);
          }
        } catch { this.cache.delete(run.id); }
      }));
    } finally { this.scanning = false; }
  }
  decorate(run, state) {
    const item = this.cache.get(run.id), interactive = item && state.nodes?.[item.nodeId]?.interactive;
    if (!item || Date.now() - item.checkedAt > 15000 || !ACTIVE.has(state.status) || state.status === 'review' || state.currentNodeId !== item.nodeId || !interactive?.promptSent || interactive.notificationMode !== 'manual') return state;
    if (['handle','incarnationId','worktreeId','hostId'].some(k => interactive[k] !== item.binding[k])) return state;
    const ready = item.evidence.kind === 'response' && item.idle;
    const observed = { ...interactive, phase: ready ? 'confirmation' : 'working', executionStarted: true, startEvidence: { source:'orca-screen', ...item.evidence, checkedAt:item.checkedAt }, canComplete:ready,
      message: ready ? 'Orca で AI の応答終了を確認しました。手動記録モードのため、結果を確認して「結果を記録」を押してください' : 'Orca の画面で AI の実行を確認しました。応答を待っています' };
    return { ...state, nodes: { ...state.nodes, [item.nodeId]: { ...state.nodes[item.nodeId], interactive:observed } } };
  }
}
module.exports = { OrcaObservation, screenEvidence, reviewResult };
