'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomic, read, assert } = require('./core.cjs');
const { cliArgs } = require('./cli-options.cjs');
const { resolveExecutable } = require('./executor.cjs');
const { call, discover, resolveTarget, verifyTerminal } = require('./orca.cjs');
const notifications = require('./notification-transport.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Some Windows PTYs leak terminal colour replies into the first input. Strip
// only those exact leading protocol replies, never arbitrary user text.
function submittedPrompt(value) {
  return String(value).replace(/^(?:(?:\x1b)?\](?:10|11);rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}(?:\x1b?\\|\x07))+/i, '');
}

// This function runs on the selected host, not the TaskDesk server.
async function bootstrap(payload, resolveExecutable) {
  const fs = require('node:fs'), path = require('node:path');
  const env = { ...process.env, ...payload.env };
  delete env.WORK_TREE_ORCA_INPUT;
  if (!Object.hasOwn(payload.env, 'NOTION_TOKEN')) delete env.NOTION_TOKEN;
  process.chdir(payload.cwd);
  let directory;
  if (payload.mcp) {
    directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'work-tree-orca-'));
    const file = path.join(directory, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify(payload.mcp), { mode: 0o600 });
    payload.args[payload.args.indexOf('--mcp-config') + 1] = file;
  }
  const resolved = resolveExecutable(payload.command, payload.tool, env);
  if (payload.notification) {
    const { dir, token } = payload.notification;
    try { payload.args = await require(path.join(dir, 'notify.cjs')).configure(dir, token, resolved, payload.args, env); }
    catch (e) { require(path.join(dir, 'notify.cjs')).atomic(path.join(dir, 'exit.json'), { error: e.message, code: 1 }); throw e; }
  }
  const child = require('node:child_process').spawn(resolved.command, [...resolved.prefix, ...payload.args], { env, stdio: 'inherit', shell: false });
  child.on('spawn', () => {
    if (payload.notification?.startupPrompt) require(path.join(payload.notification.dir, 'notify.cjs')).atomic(path.join(payload.notification.dir, 'started.json'), { token: payload.notification.token, pid: child.pid, at: Date.now() });
  });
  const cleanup = () => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); };
  const exited = value => { if (payload.notification) require(path.join(payload.notification.dir, 'notify.cjs')).atomic(path.join(payload.notification.dir, 'exit.json'), value); };
  child.on('error', e => { exited({ error: e.message, code: 1 }); console.error(e.message); cleanup(); process.exitCode = 1; });
  child.on('exit', (code, signal) => { exited({ code, signal }); cleanup(); process.exitCode = code ?? 1; });
}
function launchInput(config, selection, prompt, notification) {
  assert(!Object.keys(config.env || {}).some(k => /^(ORCA_|HERDR_|WORK_TREE_ORCA_)/.test(k)), 'Orca の識別用環境変数は上書きできません');
  assert(!(config.attachments || []).some(a => a.id), 'Orca 実行ではアップロード添付は転送されません。実行先にファイルを置き、パス添付を指定してください');
  const prepared = { ...config, cwd: selection.path, imagePaths: [] };
  const refs = [];
  const paths = selection.platform === 'win32' ? path.win32 : path.posix;
  for (const a of config.attachments || []) {
    const file = paths.resolve(selection.path, a.path);
    refs.push({ name: a.name, path: file, kind: a.kind });
    if (a.kind === 'image' && config.tool === 'codex') prepared.imagePaths.push(file);
  }
  if (refs.length) prompt += '\n\n実行先の添付ファイル（必要に応じて読み取る）:\n' + JSON.stringify(refs);
  if (config.options.mode === 'plan') prompt += '\n\n計画モード: 調査と計画だけを行い、実装・ファイル変更・外部サービスへの変更は実行しないでください。';
  const mcp = config.tool === 'claude' && (Object.keys(config.options.mcpServers || {}).length || config.options.strictMcp) ? { mcpServers: config.options.mcpServers || {} } : null;
  if (mcp) prepared.mcpConfigPath = '__WORK_TREE_TARGET_MCP__';
  const payload = { cwd: selection.path, tool: config.tool, command: selection.executable || config.tool, env: config.env || {}, args: cliArgs(prepared, { interactive: true }), mcp, notification };
  const launchData = Buffer.from(JSON.stringify(payload)).toString('base64');
  assert(launchData.length < 24000, 'Orca の起動設定が大きすぎます。MCP 設定や環境変数を短くしてください');
  // Only base64 crosses the user's shell; settings and environment are argv/data.
  const source = 'const fs=require("node:fs"),path=require("node:path");(' + bootstrap.toString() + ')(JSON.parse(Buffer.from(process.env.WORK_TREE_ORCA_INPUT,"base64").toString()),' + resolveExecutable.toString() + ').catch(e=>{console.error(e.message);process.exitCode=1})';
  const command = 'node -e "eval(Buffer.from(\'' + Buffer.from(source).toString('base64') + '\',\'base64\').toString())"';
  assert(command.length < 28000, 'Orca の起動設定が大きすぎます。MCP 設定や環境変数を短くしてください');
  const quotedLength = prompt.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').length;
  assert(prompt.length < 24000 && quotedLength < 28000 && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(prompt), 'Orca プロンプトは先行結果を含め 24000 文字未満で、端末制御文字を含まない内容にしてください。引用符が多い場合も短くしてください');
  return { command, prompt, env: { WORK_TREE_ORCA_INPUT: launchData } };
}
async function runInOrca(context, config, prompt, hooks = {}) {
  const invoke = context.invoke || call, { target, runDir, runId } = context;
  if (context.reassessment) {
    const work = context.reassessment;
    await verifyTerminal(target, work.binding, invoke);
    const channel = context.notifications || notifications;
    const feed = await channel.request(work.notification, 'collect', { threadId: work.event.threadId });
    const event = feed.events?.filter(e => e.threadId === work.event.threadId && e.token === work.notification.context.token).at(-1);
    assert(event && feed.activity?.supported && feed.activity.completed && feed.activity.turnId === event.turnId, '作業が終了してから再判定してください');
    atomic(path.join(runDir, 'orca', config.id, 'dispatch.json'), { binding: work.binding, notification: work.notification, status: 'reassessment' });
    return require('./orca-assessment.cjs').runPaneAssessment(context, config, { ...work, event, fingerprint: feed.activity.fingerprint }, hooks);
  }
  const selection = context.nodes[config.id];
  assert(selection, 'Orca 実行先が保存されていません');
  const catalog = await discover(target, invoke);
  assert(catalog.target.runtimeId === target.runtimeId, 'Orca が再起動されました');
  assert(resolveTarget(selection, catalog).path === selection.path, 'Orca ワークツリーのパスが変わりました');
  const initial = launchInput(config, selection, prompt);
  const dir = path.join(runDir, 'orca', config.id), file = path.join(dir, 'dispatch.json');
  assert(!read(file), 'このタスクは起動済みです。Orca の対話を確認してください。自動再送はしません');
  const channel = context.notifications || notifications;
  const notification = config.tool === 'codex' ? await channel.prepare(selection, context.machines, { runId, nodeId: config.id, prompt: initial.prompt }) : null;
  const input = launchInput(config, selection, prompt, notification?.context);
  const received = read(path.join(dir, 'received.json'), { keys: [], threadId: null });
  let binding, observedActivity, submitted = false, receipt = null, completeSeen, last = '', completed = false, currentPhase = 'starting';
  const start = Date.now(), pollMs = context.pollMs || 1000;
  const record = status => atomic(file, { runId, nodeId: config.id, status, binding, receipt, notification });
  const report = (phase, message, detail = {}) => {
    currentPhase = phase;
    const value = { backend: 'orca', phase, promptSent: submitted, notificationMode: notification ? 'notify' : 'manual', ...binding, ...detail, ...(message ? { message } : {}) };
    const key = JSON.stringify(value); if (key === last) return; last = key;
    atomic(path.join(dir, 'interactive.json'), value); hooks.onInteractive?.(value);
  };
  async function notificationRequest(action, payload) {
    while (true) {
      if (hooks.signal?.aborted) throw Error('実行を停止しました');
      if (Date.now() - start > config.timeoutMinutes * 60000) throw Error('Orca 対話タスクの制限時間を超えました');
      try { return await channel.request(notification, action, { ...(action === 'collect' ? { threadId: received.threadId } : {}), ...payload }); }
      catch (e) {
        if (/識別|不正|一致/.test(e.message)) throw e;
        report('reconnecting', '通知経路の再接続を待っています: ' + e.message);
        await delay(pollMs);
      }
    }
  }
  async function inspect() { return verifyTerminal(target, binding, invoke); }
  async function idle() {
    const t = await inspect();
    if (!t.agentIdentity && notification?.context.startupPrompt && submitted && received.threadId && observedActivity?.supported && observedActivity.completed && observedActivity.turnId === received.latest?.turnId) return { phase: 'ready', ready: true };
    if (t.agentIdentity !== config.tool) return { phase: 'starting', ready: false };
    try {
      const { wait } = await invoke(target, ['terminal', 'wait', '--terminal', binding.handle, '--for', 'tui-idle', '--timeout-ms', '100']);
      assert(wait?.handle === binding.handle, 'Orca の待機対象が一致しません');
      return { phase: wait.blockedReason ? 'blocked' : wait.satisfied ? 'ready' : 'working', ready: wait.satisfied === true && !wait.blockedReason };
    } catch (e) { if (e.code === 'timeout') return { phase: 'working', ready: false }; throw e; }
  }
  try {
    if (hooks.signal?.aborted) throw Error('実行を停止しました');
    record('creating'); report('starting');
    // A lost create acknowledgement must never create a second terminal.
    const created = await invoke(target, ['terminal', 'create', '--worktree', 'identity:' + selection.identityKey, '--title', ('TaskDesk · ' + config.title).slice(0, 80) + ' · ' + runId.slice(0, 8), '--command', input.command], { agent: config.tool, env: input.env });
    assert(created.terminal?.handle, 'Orca 端末の作成結果が不明です。Orca を確認してください');
    const t = (await invoke(target, ['terminal', 'show', '--terminal', created.terminal.handle])).terminal;
    assert(t?.handle === created.terminal.handle && t.incarnationId && t.worktreeId === selection.worktreeId && t.executionHostId === selection.hostId, '作成された Orca 端末の実行先が一致しません');
    binding = { handle: t.handle, incarnationId: t.incarnationId, worktreeId: selection.worktreeId, hostId: selection.hostId, path: selection.path, tool: config.tool, tabId: t.tabId };
    record('created');
    while (true) {
      if (hooks.signal?.aborted) throw Error('実行を停止しました');
      if (Date.now() - start > config.timeoutMinutes * 60000) throw Error('Orca 対話タスクの制限時間を超えました');
      let feed, status;
      try {
        if (notification) feed = await channel.request(notification, 'collect', { threadId: received.threadId });
        observedActivity = feed?.activity;
        if (feed?.exit) throw Object.assign(Error(feed.exit.error || 'Codex が終了しました。TASK の完了は確認されていません'), { fatal: true });
        if (!submitted && notification?.context.startupPrompt && feed?.started?.token === notification.context.token) {
          submitted = true; receipt = { delivery: 'startup-argument', pid: feed.started.pid }; record('submitted'); report('submitted', 'Codex の起動引数としてプロンプトを渡しました');
        }
        status = await idle();
      } catch (e) {
        if (e.fatal || /識別|一致|再起動/.test(e.message)) throw e;
        report('reconnecting', '通知・端末の接続を待っています。完了扱いにはしません: ' + e.message);
        await delay(pollMs); continue;
      }
      if (!submitted && notification && !feed?.ready) {
        report('starting', 'Codex の通知設定と回収経路を確認中');
        if (Date.now() - start > (context.startupTimeoutMs || 60000)) throw Error('通知経路の準備が完了しません。プロンプトは送信していません');
        await delay(pollMs); continue;
      }
      if (!submitted && !status.ready && status.phase !== 'blocked' && Date.now() - start > (context.startupTimeoutMs || 60000)) throw Error('AI CLI の起動を確認できません。Orca のタブで Node.js・AI CLI のパス、ログイン、初回確認を確認してください');
      if (!submitted && status.ready) {
        const terminal = await inspect(); assert(terminal.agentIdentity === config.tool, 'AI ツールの識別が変わりました');
        submitted = true; record('sending');
        try {
          const result = await invoke(target, ['terminal', 'send', '--terminal', binding.handle, '--text', input.prompt, '--enter', '--wait-submit', '5']);
          receipt = result.send?.prompt;
          assert(result.send?.accepted && result.send.handle === binding.handle && receipt?.processIncarnation === binding.incarnationId && receipt.stages?.includes('turn_started'), 'プロンプトの実行開始を確認できません。Orca の端末で送信結果を確認してください');
          record('submitted'); report('submitted');
        } catch (e) {
          record('uncertain'); report('uncertain', e.message + '。自動再送しません');
          throw Error('Orca の送信結果が不明です。既存タブを確認してください。自動再送しません: ' + e.message);
        }
      } else {
        const phase = submitted ? status.phase === 'starting' ? 'unknown' : status.phase : status.phase === 'blocked' ? 'startup-blocked' : 'starting';
        if (!submitted || !status.ready || !received.latest) report(phase, status.ready ? notification ? 'Codex の終了通知を待っています' : '手動記録モード：Orca の対話を確認して結果を記録してください' : undefined);
        if (submitted && feed?.events?.length) {
          const c = notification.context;
          const events = feed.events.filter(e => /^[a-f0-9]{64}$/.test(e.key) && e.token === c.token && e.attemptId === c.attemptId && e.runId === runId && e.nodeId === config.id && e.hostId === selection.hostId && e.identityKey === selection.identityKey);
          for (const event of events) {
            if (!received.threadId) {
              if (!event.rootSession || !event.inputMessages?.some(message => submittedPrompt(message) === input.prompt)) continue;
              received.threadId = event.threadId;
            }
            if (event.threadId !== received.threadId || received.keys.includes(event.key)) continue;
            atomic(path.join(dir, 'event-' + event.key + '.json'), event);
            received.keys.push(event.key); received.latest = event;
            atomic(path.join(dir, 'received.json'), received);
          }
          await notificationRequest('ack', { keys: received.keys });
          const event = received.latest, activity = feed.activity;
          if (!event && status.ready) report('confirmation', '通知を受信しましたが親セッションを照合できません。Orca の結果を確認してください', { canComplete: true });
          if (event && status.ready) {
            const detail = { response: event.response, threadId: event.threadId, turnId: event.turnId, canComplete: true };
            const matching = events.at(-1)?.key === event.key && activity?.supported && activity.completed && activity.turnId === event.turnId;
            if (!matching) report('confirmation', 'Codex の応答が終了しました。結果を確認してください', detail);
            if (context.kind === 'plan' && matching) {
              let valid = false;
              try { require('./core.cjs').parsePlan(event.response); valid = true; }
              catch { report('confirmation', '計画 JSON を検証できません。結果を確認してください', detail); }
              if (valid) {
                const finalFeed = await notificationRequest('collect');
                if (finalFeed.activity?.fingerprint === activity.fingerprint && finalFeed.activity?.completed && (await idle()).ready) {
                  completed = true; record('completed'); return { response: event.response, outcome: 'completed', automatic: true };
                }
              }
            }
            if (matching && context.kind !== 'plan') {
              const work = { binding, notification, event, fingerprint: activity.fingerprint, prompt };
              atomic(path.join(dir, 'work-result.json'), work);
              const result = await require('./orca-assessment.cjs').runPaneAssessment(context, config, work, hooks);
              completed = true; record('completed'); return result;
            } else if (!matching) report('confirmation', '応答終了は受信しましたが、ターン状態を照合できないため確認待ちです', detail);
          }
        }
        const control = read(path.join(runDir, 'control.json'));
        if (submitted && control?.action === 'complete' && control.nodeId === config.id && control.id !== completeSeen) {
          completeSeen = control.id;
          if (!status.ready || currentPhase === 'verifying') report(currentPhase, 'Agent と検証が終了してから結果を記録してください');
          else {
            assert((await idle()).ready, 'Orca の対話状態が変わりました');
            assert(typeof control.response === 'string' && control.response.trim(), '結果の要約を入力してください');
            const outcome = control.outcome || 'completed'; assert(['completed', 'error', 'unexpected'].includes(outcome), '結果ラベルが不正です');
            try { atomic(path.join(dir, 'transcript.json'), await invoke(target, ['terminal', 'read', '--terminal', binding.handle, '--limit', '64000'])); } catch (e) { hooks.onLog?.('端末記録: ' + e.message); }
            completed = true; record('completed'); report('completed');
            return { response: control.response.trim(), outcome, interactive: true, confirmedByUser: true };
          }
        }
      }
      await delay(pollMs);
    }
  } finally {
    if (!completed && notification) {
      try { await channel.request(notification, 'cancel'); } catch (e) { hooks.onLog?.('検証の停止を確認できません: ' + e.message); }
    }
    // Leave failed/uncertain conversations available for inspection. Only an
    // explicit stop or a task timeout closes our exact terminal incarnation.
    if (!completed && binding && (hooks.signal?.aborted || Date.now() - start > config.timeoutMinutes * 60000)) {
      try {
        const terminal = await inspect(); assert(terminal.agentIdentity === config.tool || !terminal.agentIdentity && notification?.context.startupPrompt, 'AI ツールの識別が変わりました');
        const result = await invoke(target, ['terminal', 'close', '--terminal', binding.handle]);
        assert(result.close?.ptyKilled === true || result.close?.ptyStopVerdict === 'exited', 'Orca が端末の停止を確認できませんでした'); record('stopped');
      }
      catch (e) { hooks.onLog?.('Orca の停止を確認できません。端末を確認してください: ' + e.message); }
    }
  }
}
module.exports = { launchInput, runInOrca, submittedPrompt };
