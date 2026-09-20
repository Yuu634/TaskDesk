'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { capture, shellQuote, resolveExecutable, killTree } = require('./executor.cjs');
const { parseResponse } = require('./herdr.cjs');
const { atomic, read, assert } = require('./core.cjs');
const { cliArgs, prepare } = require('./cli-options.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));

function targetFor(session = 'default') {
  assert(typeof session === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(session), 'herdr セッション名が不正です');
  return { session, binary: process.env.HERDR_BIN || 'herdr' };
}
async function call(target, args) {
  const binary = target.binary || 'herdr';
  const command = /\.cjs$/.test(binary) ? process.execPath : binary;
  const prefix = /\.cjs$/.test(binary) ? [binary] : [];
  const output = await capture(command, [...prefix, '--session', target.session, ...args], '', 15000);
  return args[1] === 'read' ? { text: output } : parseResponse(output);
}
function label(text, id, siblings = []) {
  const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  const chars = Array.from(clean(text)), base = chars.slice(0, 80).join('');
  const duplicate = siblings.some(n => n.id !== id && Array.from(clean(n.name ?? n.title)).slice(0, 80).join('') === base);
  const suffix = duplicate || chars.length > 80 ? ' · ' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 8) : '';
  return chars.slice(0, 80 - suffix.length).join('') + suffix || '名称未設定';
}
async function verifyPane(target, binding, invoke = call) {
  const pane = (await invoke(target, ['pane', 'get', binding.paneId])).pane;
  assert(pane && pane.terminal_id === binding.terminalId && pane.workspace_id === binding.workspaceId && pane.tokens?.wt_binding === binding.bindingId && pane.tokens?.wt_owner === binding.owner, 'herdr ペインの所有関係が変わりました。再接続を確認してください');
  return pane;
}
async function shellReady(target, paneId, invoke = call) {
  const result = await invoke(target, ['pane', 'process-info', '--pane', paneId]);
  const info = result.process_info;
  assert(info?.shell_pid && info.foreground_process_group_id === info.shell_pid, 'herdr ペインで別のプロセスが動いています。シェルに戻してから実行してください');
}

// A native interactive CLI occupies the pane. The coordinator never impersonates
// its lifecycle, and a settled terminal is not treated as task completion.
async function runInHerdr(context, config, machine, prompt, hooks = {}) {
  const { target, nodes, runDir, runId } = context, binding = nodes[config.id], invoke = context.invoke || call;
  assert(binding, 'herdr のノード対応がありません');
  const dir = path.join(runDir, 'herdr', config.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dispatchFile = path.join(dir, 'dispatch.json');
  assert(!read(dispatchFile), 'この実行は送信済みです。herdr の対話を確認してください');
  await verifyPane(target, binding, invoke); await shellReady(target, binding.paneId, invoke);
  if (hooks.signal?.aborted) throw new Error('実行を停止しました');
  const prepared = prepare(config, prompt, { directory: path.join(dir, 'input') });
  assert(Buffer.byteLength(prepared.prompt, 'utf8') <= 96 * 1024, '対話送信は依存先の結果を含めて 96 KiB 以内です。プロンプトや結果の要約を短くしてください');
  const resolved = resolveExecutable(config.tool === 'codex' ? machine.codexPath : machine.claudePath, config.tool, { ...process.env, ...config.env });
  const argv = [...resolved.prefix, ...cliArgs(prepared.config, { interactive: true })];
  const pidFile = path.join(dir, 'process.pid'), script = path.join(dir, 'launch.sh');
  const env = Object.entries(config.env || {}).filter(([key]) => !key.startsWith('HERDR_'));
  const source = '#!/bin/sh\nset -e\ncd ' + shellQuote(config.cwd) + '\n' +
    `printf '%s\\n' "$$" > ` + shellQuote(pidFile) + '\n' +
    (Object.hasOwn(config.env || {}, 'NOTION_TOKEN') ? '' : 'unset NOTION_TOKEN\n') +
    env.map(([key, value]) => 'export ' + key + '=' + shellQuote(value)).join('\n') + '\nexec ' + [resolved.command, ...argv].map(shellQuote).join(' ') + '\n';
  fs.writeFileSync(script, source, { mode: 0o700 });
  const safeArgs = argv.map(arg => arg.startsWith('mcp_servers.') ? arg.split('=')[0] + '=<設定済み>' : arg);
  hooks.onEvent?.({ type: 'launch', text: [resolved.command, ...safeArgs].map(shellQuote).join(' '), cwd: config.cwd });
  hooks.onLog?.('対話 CLI 起動: ' + config.tool + ' / ' + (config.options?.model || '既定モデル'));
  let submitted = false, ownedPid = null, lastPhase = '', launchError = null, completeSeen = null, completed = false, submissionWarning = '';
  const start = Date.now(), pollMs = context.pollMs || 500;
  const report = (phase, extra = {}) => {
    const value = { phase, promptSent: submitted, paneId: binding.paneId, workspaceId: binding.workspaceId, ...(submissionWarning ? { message: submissionWarning } : {}), ...extra };
    if (JSON.stringify(value) === lastPhase) return;
    lastPhase = JSON.stringify(value); atomic(path.join(dir, 'interactive.json'), value); hooks.onInteractive?.(value);
  };
  async function identity() {
    await verifyPane(target, binding, invoke);
    if (!ownedPid) {
      try { const value = fs.readFileSync(pidFile, 'utf8').trim(); if (/^[1-9][0-9]*$/.test(value)) ownedPid = Number(value); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const info = (await invoke(target, ['pane', 'process-info', '--pane', binding.paneId])).process_info;
    if (ownedPid) assert(info?.foreground_process_group_id === ownedPid, '対話 CLI が終了したか、ペインの実行プロセスが変わりました');
    return info;
  }
  async function stopOwned() {
    if (!ownedPid) { try { await identity(); } catch {} }
    if (!ownedPid) return;
    try {
      await identity();
      if (context.terminate) await context.terminate(ownedPid);
      else killTree({ pid: ownedPid });
    } catch (e) { hooks.onLog?.('停止対象の照合: ' + e.message); }
  }
  try {
    atomic(dispatchFile, { runId, nodeId: config.id, status: 'launching' }); report('starting');
    try { await invoke(target, ['pane', 'run', binding.paneId, '/bin/sh ' + shellQuote(script)]); }
    catch (e) { launchError = e; hooks.onLog?.('起動結果を確認中。再送しません: ' + e.message); }
    while (true) {
      if (hooks.signal?.aborted) throw new Error('実行を停止しました');
      await identity();
      let agent = null;
      if (ownedPid) {
        const pane = await verifyPane(target, binding, invoke);
        if (pane.agent === config.tool) agent = (await invoke(target, ['agent', 'get', binding.paneId])).agent;
      }
      if (agent) assert(agent.agent === config.tool && agent.pane_id === binding.paneId && agent.terminal_id === binding.terminalId, '対話 Agent の識別が変わりました');
      const status = agent?.agent_status;
      if (!submitted && agent && ['idle', 'done'].includes(status)) {
        await identity();
        await invoke(target, ['agent', 'rename', binding.paneId, binding.agentAlias]);
        // Persist intent before sending; lost acknowledgements never cause replay.
        submitted = true; atomic(dispatchFile, { runId, nodeId: config.id, status: 'sending', pid: ownedPid });
        try { await invoke(target, ['agent', 'prompt', binding.paneId, prepared.prompt]); }
        catch (e) { submissionWarning = '送信結果を herdr で確認してください。自動再送はしません: ' + e.message; hooks.onLog?.(submissionWarning); }
        atomic(dispatchFile, { runId, nodeId: config.id, status: 'submitted', pid: ownedPid });
        report('submitted');
        await delay(pollMs); continue;
      }
      const phase = !submitted ? status === 'blocked' ? 'startup-blocked' : 'starting' : status === 'blocked' ? 'blocked' : status === 'working' ? 'working' : ['idle', 'done'].includes(status) ? 'ready' : 'unknown';
      report(phase);
      const control = read(path.join(runDir, 'control.json'));
      if (control?.action === 'complete' && control.nodeId === config.id && control.id !== completeSeen) {
        completeSeen = control.id;
        if (phase !== 'ready') report(phase, { message: 'Agent が入力待ちになってから完了を確定してください' });
        else {
          await identity();
          const current = (await invoke(target, ['agent', 'get', binding.paneId])).agent;
          assert(current?.agent === config.tool && current.terminal_id === binding.terminalId && ['idle', 'done'].includes(current.agent_status), '対話の状態が変わりました。完了前に確認してください');
          assert(typeof control.response === 'string' && control.response.trim(), '後続タスクへ渡す結果の要約を入力してください');
          try {
            const transcript = await invoke(target, ['agent', 'read', binding.paneId, '--source', 'recent-unwrapped', '--lines', '200']);
            fs.writeFileSync(path.join(dir, 'terminal.txt'), String(transcript.text || '').slice(-64000), { mode: 0o600 });
          } catch (e) { hooks.onLog?.('端末記録の取得: ' + e.message); }
          const outcome = control.outcome || 'completed';
          assert(['completed','error','unexpected'].includes(outcome), '結果ラベルが不正です');
          completed = true; report('completed');
          atomic(dispatchFile, { runId, nodeId: config.id, status: 'completed', pid: ownedPid });
          return { response: control.response.trim(), outcome, interactive: true, confirmedByUser: true };
        }
      }
      // Startup trust/login screens may require the user; don't dismiss them.
      if (!submitted && !agent && Date.now() - start > 30000) throw new Error('対話 CLI の起動を確認できません。herdr のペインを確認してください。' + (launchError?.message || ''));
      if (Date.now() - start > config.timeoutMinutes * 60000) throw new Error('対話タスクの制限時間を超えました');
      await delay(pollMs);
    }
  } finally {
    if (!completed) await stopOwned();
    // Keep session inputs available for follow-up conversation in the native CLI.
    prepared.cleanup();
  }
}
module.exports = { call, targetFor, label, verifyPane, shellReady, runInHerdr };
