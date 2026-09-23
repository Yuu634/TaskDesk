'use strict';
const path = require('node:path'), crypto = require('node:crypto');
const { atomic, assert } = require('./core.cjs');
const { call, verifyTerminal } = require('./orca.cjs');
const notifications = require('./notification-transport.cjs');
const { screenEvidence, reviewResult } = require('./orca-observation.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function workChanged(context, work) {
  const invoke = context.invoke || call;
  await verifyTerminal(context.target, work.binding, invoke);
  if (work.notification) {
    const feed = await (context.notifications || notifications).request(work.notification, 'collect', { threadId:work.event.threadId });
    return !feed.activity?.supported || !feed.activity.completed || feed.activity.fingerprint !== work.fingerprint || feed.activity.turnId !== work.event.turnId;
  }
  const screen = await invoke(context.target, ['terminal','read','--terminal',work.binding.handle,'--screen','--limit','300']);
  const evidence = screenEvidence(screen, work.binding);
  return evidence?.kind === 'working' || evidence?.kind === 'response' && work.baselineResponse && screen.terminal.tail.join('\n') !== work.baselineResponse;
}
async function refreshReport(context, config, work, hooks = {}) {
  const invoke = context.invoke || call, channel = context.notifications || notifications;
  const binding = work.binding, requestId = crypto.randomUUID();
  const report = message => hooks.onInteractive?.({ backend:'orca', ...binding, phase:'revising', promptSent:true, canComplete:false, message });
  const idle = async () => {
    const terminal = await verifyTerminal(context.target, binding, invoke);
    assert(terminal.agentIdentity === binding.tool, '作業ペインの AI が変わりました');
    const { wait } = await invoke(context.target, ['terminal','wait','--terminal',binding.handle,'--for','tui-idle','--timeout-ms','100']);
    return wait?.handle === binding.handle && wait.satisfied === true && !wait.blockedReason;
  };
  const prompt = 'TaskDesk 更新版結果報告 ' + requestId + '\n修正後の現在の状態を確認し、更新版の最終報告をこの会話に出してください。追加の修正や新しいタスクは実行しないでください。ただし、このTASKで指定された成果報告書がある場合は、その報告書のみ最新の内容に更新し、末尾に TASKDESK_REPORT: と保存先パスを記載してください。修正内容・最新の成果物のパス・実施済みの検証結果・未解決事項を区別し、未検証の内容を成功としないでください。回答の冒頭に「更新版結果報告 ' + requestId + '」を記載してください。\n現在の完了条件:\n' + (config.criteria || '未設定') + (work.report?.path ? '\nReport path:\n' + work.report.path : '');
  const file = path.join(context.runDir, 'orca', config.id, 'report-request-' + requestId + '.json');
  try {
    if (hooks.signal?.aborted) throw Error('実行を停止しました');
    assert(await idle(), '修正作業が終了してから再判定してください');
    const previous = work.notification ? await channel.request(work.notification, 'collect', { threadId:work.event.threadId }) : null;
    if (previous) assert(previous.activity?.supported && previous.activity.completed, '修正作業の終了を確認できません');
    const known = new Set((previous?.events || []).map(e => e.key));
    atomic(file, { requestId, status:'sending', binding, prompt });
    report('修正前の結果は無効です。同じ作業ペインに更新版の結果報告を依頼しています');
    await verifyTerminal(context.target, binding, invoke);
    if (hooks.signal?.aborted) throw Error('実行を停止しました');
    // Sending is never retried, even if its acknowledgement is lost.
    await invoke(context.target, ['terminal','send','--terminal',binding.handle,'--text',prompt,'--enter']);
    atomic(file, { requestId, status:'sent', binding, prompt });
    const deadline = Date.now() + Math.min(config.timeoutMinutes * 60000, 360000);
    while (Date.now() < deadline) {
      if (hooks.signal?.aborted) throw Error('実行を停止しました');
      await verifyTerminal(context.target, binding, invoke);
      report('修正後の結果待ち。同じ作業ペインの更新版報告を待っています');
      if (work.notification) {
        const feed = await channel.request(work.notification, 'collect', { threadId:work.event.threadId });
        const event = feed.events?.filter(e => !known.has(e.key) && e.token === work.notification.context.token && e.threadId === work.event.threadId && e.inputMessages?.some(s => require('./orca-execution.cjs').submittedPrompt(s) === prompt)).at(-1);
        if (event && feed.activity?.supported && feed.activity.completed && feed.activity.turnId === event.turnId && await idle()) {
          atomic(file, { requestId, status:'received', event });
          return { ...work, event, fingerprint:feed.activity.fingerprint, refreshReport:false };
        }
        if (feed.exit) throw Error('作業セッションが終了しました');
      } else {
        const screen = await invoke(context.target, ['terminal','read','--terminal',binding.handle,'--screen','--limit','300']);
        const answer = screen.terminal?.tail?.join('\n') || '';
        // The ID must occur after an assistant bullet, never just in echoed input.
        const assistant = answer.slice(answer.lastIndexOf('• '));
        if (screenEvidence(screen, binding)?.kind === 'response' && assistant.replace(/\s/g, '').includes(requestId) && await idle()) {
          atomic(file, { requestId, status:'received', screen });
          return { manualResult:reviewResult(screen), binding, baselineResponse:screen.terminal.tail.join('\n'), refreshReport:false };
        }
      }
      await delay(context.pollMs || 1000);
    }
    throw Error('更新版の報告を確認できませんでした。Orca を確認してください。自動再送しません');
  } catch (e) {
    if (hooks.signal?.aborted) throw e;
    return { failed: { outcome:'needs_review', response:'', workResponse:'', resultStale:true, assessment:{ outcome:'needs_review', detail:e.message }, reassessment:work } };
  }
}
module.exports = { refreshReport, workChanged };
