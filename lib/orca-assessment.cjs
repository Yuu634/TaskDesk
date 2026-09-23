'use strict';
const path = require('node:path'), crypto = require('node:crypto');
const { atomic, assert } = require('./core.cjs');
const { call, verifyTerminal } = require('./orca.cjs');
const notifications = require('./notification-transport.cjs');
const { judgeOutcome } = require('./codex-notify.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
function paneCommand(c) {
  const source = 'require(' + JSON.stringify(path.join(c.dir, 'notify.cjs').replace(/\\/g, '/')) + ').launchPane(' + JSON.stringify(c.dir) + ',' + JSON.stringify(c.token) + ').catch(e=>{console.error(e.message);process.exitCode=1})';
  return 'node -e "eval(Buffer.from(\'' + Buffer.from(source).toString('base64') + '\',\'base64\').toString())"';
}
async function runPaneAssessment(context, config, work, hooks = {}) {
  const invoke = context.invoke || call, channel = context.notifications || notifications;
  const { binding, notification, event, fingerprint, prompt } = work;
  const id = crypto.randomUUID(), file = path.join(context.runDir, 'orca', config.id, 'assessment-' + id + '.json');
  let pane, prepared, verification = null, finished = false, lastReport;
  const started = Date.now(), timeout = Math.min(config.timeoutMinutes * 60000, (360 + (config.verification?.autoComplete ? config.verification.timeoutSeconds : 0)) * 1000);
  const record = phase => atomic(file, { id, phase, work, binding: pane, notification: prepared, createdAt: started });
  const report = message => { const value = { backend: 'orca', ...binding, assessmentBinding: pane, phase: 'verifying', promptSent: true, canComplete: false, message }; const key = JSON.stringify(value); if (key !== lastReport) hooks.onInteractive?.(value); lastReport = key; };
  const collectWork = () => channel.request(notification, 'collect', { threadId: event.threadId });
  const stable = f => f.activity?.supported && f.activity.completed && f.activity.turnId === event.turnId && f.activity.fingerprint === fingerprint;
  const finish = (outcome, detail, extra = {}) => {
    const assessment = { outcome, detail, source: 'orca-interactive-pane', workThreadId: event.threadId, workTurnId: event.turnId, binding: pane, finishedAt: new Date().toISOString(), ...extra };
    const result = { workResponse: event.response, response: event.response + '\n\nTaskDesk AI 判定（対話型・分割ペイン）:\n' + detail, outcome, assessment, interactive: true, automatic: true, reassessment: { ...work, ...(pane && prepared ? { assessmentPane:{ binding:pane, notification:prepared } } : {}) } };
    atomic(path.join(context.runDir, 'orca', config.id, 'result.json'), result);
    finished = true; record('completed'); hooks.onInteractive?.({ backend: 'orca', ...binding, assessmentBinding: pane, phase: 'completed', promptSent: true, message: '判定結果を記録しました。修正後は「修正後の結果を再判定」を押してください' }); return result;
  };
  try {
    await verifyTerminal(context.target, binding, invoke);
    if (!stable(await collectWork())) return finish('needs_review', '作業が再開されたため、判定を無効にしました');
    if (!config.criteria?.trim()) return finish('needs_review', '完了条件が未設定です');
    if (config.verification?.autoComplete) {
      report('補助検証を実行中');
      await channel.request(notification, 'verify', { event, fingerprint, verification: config.verification, verificationId: id });
      while (!verification) {
        if (hooks.signal?.aborted) throw Error('実行を停止しました');
        const f = await collectWork(); if (!stable(f)) return finish('needs_review', '補助検証中に作業が再開されました');
        verification = f.verification?.verificationId === id ? f.verification : null;
        if (Date.now() - started > timeout) return finish('needs_review', '補助検証の結果を回収できませんでした');
        if (!verification) await delay(context.pollMs || 1000);
      }
    }
    const spec = await channel.request(notification, 'prepare-pane', { assessmentId: id, event, criteria: config.criteria, prompt, verification });
    prepared = work.assessmentPane?.notification || { transport: notification.transport, context: spec.context };
    if (!stable(await collectWork())) return finish('needs_review', '判定開始前に作業が再開されました');
    await verifyTerminal(context.target, binding, invoke);
    if (work.assessmentPane) {
      pane = work.assessmentPane.binding;
      const terminal = await verifyTerminal(context.target, pane, invoke);
      assert(terminal.agentIdentity === 'codex', '判定ペインの AI が変わりました');
      const { wait } = await invoke(context.target, ['terminal','wait','--terminal',pane.handle,'--for','tui-idle','--timeout-ms','100']);
      assert(wait?.handle === pane.handle && wait.satisfied === true && !wait.blockedReason, '判定ペインの応答終了を待ってください');
      record('sending'); report('既存の判定ペインへ修正後の結果を渡しています');
      await invoke(context.target, ['terminal','send','--terminal',pane.handle,'--text',spec.prompt,'--enter']);
    } else {
    record('splitting'); report('同じタブに判定用ペインを作成中');
    // Never retry split: a lost acknowledgement may already have created a pane.
    const split = await invoke(context.target, ['terminal', 'split', '--terminal', binding.handle, '--direction', 'horizontal', '--command', paneCommand(spec.context)]);
    const handle = split.terminal?.handle || split.split?.handle || split.split?.terminal?.handle || split.split?.newTerminal?.handle;
    assert(handle && handle !== binding.handle, '判定ペインの作成結果が不明です。自動再作成しません');
    const t = (await invoke(context.target, ['terminal', 'show', '--terminal', handle])).terminal;
    assert(t?.incarnationId && t.worktreeId === binding.worktreeId && t.executionHostId === binding.hostId && t.tabId && t.tabId === binding.tabId, '判定ペインの実行先・タブが一致しません');
    pane = { handle, incarnationId: t.incarnationId, worktreeId: t.worktreeId, hostId: t.executionHostId, tabId: t.tabId, tool: 'codex' }; record('judging');
    }
    let threadId;
    while (true) {
      if (hooks.signal?.aborted) throw Error('実行を停止しました');
      await verifyTerminal(context.target, binding, invoke); await verifyTerminal(context.target, pane, invoke);
      const workFeed = await collectWork();
      if (!stable(workFeed)) return finish('needs_review', '判定中に作業が再開・変更されたため、この判定は無効です');
      const feed = await channel.request(prepared, 'collect', { threadId });
      if (feed.exit) return finish('needs_review', '判定用 Codex が終了しました: ' + (feed.exit.error || feed.exit.code));
      report('分割ペインの対話型 Codex が完了条件を判定中');
      const candidates = (feed.events || []).filter(e => e.token === prepared.context.token && e.attemptId === prepared.context.attemptId && e.runId === prepared.context.runId && e.nodeId === prepared.context.nodeId && (!threadId || e.threadId === threadId) && (threadId || e.rootSession) && e.inputMessages?.some(s => require('./orca-execution.cjs').submittedPrompt(s) === spec.prompt));
      const first = candidates[0];
      if (first && !threadId) { threadId = first.threadId; continue; }
      if (first && feed.activity?.supported && feed.activity.completed && feed.activity.turnId === first.turnId) {
        let parsed;
        try { parsed = JSON.parse(first.response); } catch { return finish('needs_review', '判定の JSON 形式が不正です。判定ペインを確認してください', { response: first.response, threadId }); }
        const outcome = judgeOutcome(parsed, config.criteria, verification);
        const labels = { met: '達成', unmet: '未達', unknown: '判断不能' }, items = config.criteria.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const rows = Array.isArray(parsed?.criteria) ? parsed.criteria : [];
        const detail = rows.map((r, i) => items[i] + '\n' + (labels[r?.status] || '判断不能') + ': ' + String(r?.evidence || '根拠なし')).join('\n\n') || '判定結果に条件ごとの根拠がありません';
        if (!stable(await collectWork())) return finish('needs_review', '作業が再開されたため判定を無効にしました');
        return finish(outcome, detail + (verification && verification.outcome !== 'completed' ? '\n補助検証が成功していないため、要確認です' : ''), { criteria: rows, verification, threadId, turnId: first.turnId });
      }
      if (Date.now() - started > timeout) return finish('needs_review', '判定が時間内に完了しませんでした。判定ペインを確認してください');
      await delay(context.pollMs || 1000);
    }
  } catch (e) {
    if (hooks.signal?.aborted) throw e;
    return finish('needs_review', e.message);
  } finally {
    if (hooks.signal?.aborted && pane) {
      try { await verifyTerminal(context.target, pane, invoke); await invoke(context.target, ['terminal', 'close', '--terminal', pane.handle]); } catch (e) { hooks.onLog?.(e.message); }
    }
    if (!finished) record('interrupted');
  }
}
module.exports = { runPaneAssessment, paneCommand };
