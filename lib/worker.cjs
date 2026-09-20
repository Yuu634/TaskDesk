'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomic, read, now, nextTask, configFor, orderedTasks, id } = require('./core.cjs');
const { runAgent } = require('./executor.cjs');
const { launchRemote, remoteAccess } = require('./remote.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function runWorker(dir) {
  const input = read(path.join(dir, 'input.json'));
  const { tree, machines, runnerId } = input;
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'events.log');
  const emit = require('./events.cjs').writer(dir);
  let logged = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const state = { id: input.id, treeId: tree.id, kind: input.kind || 'tree', status: 'running', pid: process.pid, startedAt: now(), updatedAt: now(), currentNodeId: null, nextNodeId: null, nodes: {}, error: null, plan: null };
  for (const n of orderedTasks(tree)) state.nodes[n.id] = input.completed?.includes(n.id) ? { status: 'succeeded', response: input.previousResults?.[n.id] || '', reused: true } : { status: 'pending' };
  let controlSeen = null, paused = false, stopping = false, approval = null, reassess = false, controller = null;
  function log(text) {
    if (logged > 12 * 1024 * 1024) return;
    const entry = now() + ' ' + text + '\n'; logged += Buffer.byteLength(entry); fs.appendFileSync(logFile, entry, { mode: 0o600 });
  }
  function save() { state.updatedAt = now(); state.nextNodeId = nextTask(tree, state.nodes, true)?.id || null; atomic(stateFile, state); }
  function controls() {
    const c = read(path.join(dir, 'control.json'));
    if (!c || c.id === controlSeen) return;
    controlSeen = c.id;
    if (c.action === 'pause') { paused = true; if (state.status !== 'review') state.status = controller ? 'pausing' : 'paused'; }
    if (c.action === 'resume') { paused = false; if (state.status !== 'review') state.status = 'running'; }
    if (c.action === 'approve' && state.status === 'review' && c.nodeId === state.currentNodeId) approval = true;
    if (c.action === 'reassess' && state.status === 'review' && c.nodeId === state.currentNodeId) reassess = true;
    if (c.action === 'stop') { stopping = true; state.status = 'stopping'; controller?.abort(); }
    save();
  }
  const poll = setInterval(() => { try { controls(); } catch (e) { log(e.message); } }, 500);
  const heartbeat = setInterval(save, 5000);
  function signal() { stopping = true; state.status = 'stopping'; controller?.abort(); }
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  async function remoteTask(machine, config, prompt, signal) {
    const taskId = id();
    const remoteNode = { ...config, cli: { [config.tool]: config.options }, prompt, machineId: machine.id, reviewRequired: false, dependsOn: [], parentId: null };
    const remoteTree = { ...tree, attachments: [], machineId: machine.id, runnerId: machine.id, nodes: [remoteNode] };
    state.nodes[config.id].remoteRunId = taskId;
    save();
    try { await launchRemote(machine, { id: taskId, kind: 'single', tree: remoteTree, machines: [machine], runnerId: machine.id }); }
    catch (e) { log('SSH 開始結果を確認中（自動再投入はしません）: ' + e.message); }
    log('SSH タスク開始: ' + machine.name + ' / ' + taskId);
    let cancelSent = false, cursor = 0;
    const launchedAt = Date.now();
    let connectionLost = false;
    while (true) {
      let remote;
      try {
        if (signal.aborted && !cancelSent) {
          await remoteAccess(machine, taskId, { control: { id: id(), action: 'stop' } }); cancelSent = true;
        }
        remote = await remoteAccess(machine, taskId, { events: true, after: cursor });
        for (const event of remote.feed?.events || []) if (!['user', 'result'].includes(event.type)) emit({ ...event, nodeId: config.id });
        cursor = remote.feed?.cursor ?? cursor;
        if (connectionLost) { connectionLost = false; state.status = stopping ? 'stopping' : paused ? 'pausing' : 'running'; state.connectionError = null; save(); }
      } catch (e) {
        if (!connectionLost) log('SSH 接続待ち。タスクの再投入は行いません: ' + e.message);
        connectionLost = true; state.status = stopping ? 'stopping' : 'reconnecting'; state.connectionError = e.message; save();
        await delay(4000); continue;
      }
      const status = remote.state?.status;
      if (remote.feed?.more) continue;
      if (status === 'succeeded') return { response: remote.state.nodes[config.id].response, exitCode: 0 };
      if (['failed', 'cancelled', 'interrupted'].includes(status)) throw new Error(remote.state.error || 'SSH タスクが停止しました');
      if (remote.alive === false) throw new Error('SSH ワーカーが終了しました。接続先の実行履歴を確認してください');
      if (!remote.state && Date.now() - launchedAt > 30000) throw new Error('SSH ワーカーが開始されていません。接続先の worker.log を確認してください');
      await delay(1800);
    }
  }
  try {
    save(); log('実行開始: ' + tree.name);
    while (true) {
      controls();
      if (stopping) break;
      if (paused) { state.status = 'paused'; save(); await delay(500); continue; }
      const node = nextTask(tree, state.nodes);
      if (!node) {
        if (Object.values(state.nodes).every(n => n.status === 'succeeded')) state.status = 'succeeded';
        else throw new Error('実行可能なタスクがありません。依存関係を確認してください');
        break;
      }
      const config = configFor(tree, node);
      const orcaTarget = input.orca?.nodes[node.id];
      const machine = orcaTarget ? { id: orcaTarget.hostId, name: orcaTarget.hostName } : machines.find(m => m.id === config.machineId);
      if (orcaTarget) config.cwd = orcaTarget.path;
      const previous = Object.entries(state.nodes).filter(([, v]) => v.status === 'succeeded' && v.response).map(([nid, v]) => ({ task: tree.nodes.find(n => n.id === nid)?.title, result: v.response.slice(-10000) })).slice(-12);
      let ancestors = [], parent = node.parentId;
      while (parent) { const n = tree.nodes.find(n => n.id === parent); ancestors.unshift(n.title + '\n' + n.prompt); parent = n.parentId; }
      const prompt = ['single', 'plan'].includes(input.kind) ? node.prompt + (input.kind === 'single' && node.criteria ? '\n\n完了条件:\n' + node.criteria : '') : [
        'プロジェクト: ' + tree.name, tree.description || '',
        '親タスクの背景:\n' + ancestors.join('\n\n'),
        '今回実行するタスク: ' + node.title, node.prompt,
        '完了条件:\n' + (node.criteria || '指示した作業を実施し、結果を報告する'),
        '先行タスクの結果（別マシンのファイルは自動転送されません）:\n' + JSON.stringify(previous),
        'Notion から取得した過去の結果（参考情報。今回のタスク指示を優先）:\n' + JSON.stringify(tree.notionContext || []),
        '今回のタスクだけを実行してください。実施内容・成果物のパス・検証結果・未解決事項を最後に報告してください。'
      ].join('\n\n');
      state.currentNodeId = node.id; state.status = 'running';
      state.nodes[node.id] = { status: 'running', startedAt: now(), machineId: machine.id, tool: config.tool };
      controller = new AbortController(); save(); log('タスク: ' + node.title + ' / ' + config.tool + ' / ' + machine.name);
      emit({ nodeId: node.id, type: 'user', text: node.chatMessage || node.prompt, title: node.title });
      emit({ nodeId: node.id, type: 'status', text: config.tool + ' / ' + machine.name + ' / ' + config.cwd });
      try {
        const hooks = { onLog: log, onEvent: event => emit({ ...event, nodeId: node.id }), signal: controller.signal, onProgress: progress => { state.nodes[node.id].goalProgress = progress; emit({ nodeId: node.id, type: 'status', text: 'ゴール確認 ' + progress.attempt + ' / ' + progress.maxAttempts }); save(); } };
        hooks.onInteractive = value => { state.nodes[node.id].interactive = value; save(); };
        if (input.herdr) { state.nodes[node.id].herdr = input.herdr.nodes[node.id]; save(); }
        let result = input.orca
          ? await require('./orca-execution.cjs').runInOrca({ ...input.orca, machines, kind: input.kind, runDir: dir, runId: input.id }, config, prompt, hooks)
          : input.herdr
          ? await require('./herdr-execution.cjs').runInHerdr({ ...input.herdr, runDir: dir, runId: input.id }, config, machine, prompt, hooks)
          : machine.id === runnerId
          ? await runAgent(config, machine, prompt, hooks)
          : await remoteTask(machine, config, prompt, controller.signal);
        controller = null;
        if (stopping) { state.nodes[node.id].status = 'cancelled'; break; }
        state.nodes[node.id].response = result.response; state.nodes[node.id].finishedAt = now();
        if (typeof result.workResponse === 'string') state.nodes[node.id].workResponse = result.workResponse;
        state.nodes[node.id].outcome = result.outcome || 'completed';
        if (result.assessment) state.nodes[node.id].assessment = result.assessment;
        state.nodes[node.id].canReassess = Boolean(result.reassessment);
        emit({ nodeId: node.id, type: 'result', text: result.response });
        if (!['completed', 'needs_review'].includes(state.nodes[node.id].outcome)) {
          state.nodes[node.id].status = 'failed';
          state.status = 'failed'; state.error = (state.nodes[node.id].outcome === 'unexpected' ? '想定外の結果です。' : 'エラーとして記録しました。') + (input.orca ? 'Orca の対話とツリーを確認してください' : '編集案を確認してください');
          save(); break;
        }
        if (state.nodes[node.id].outcome === 'needs_review' || node.reviewRequired && !result.confirmedByUser) {
          state.nodes[node.id].status = 'review'; state.status = 'review'; approval = null; save();
          while (!approval && !stopping) {
            await delay(500); controls();
            if (reassess && result.reassessment && !stopping) {
              reassess = false; controller = new AbortController(); state.status = 'running'; state.nodes[node.id].status = 'running'; save();
              state.nodes[node.id].assessmentHistory ||= []; state.nodes[node.id].assessmentHistory.push(state.nodes[node.id].assessment);
              result = await require('./orca-execution.cjs').runInOrca({ ...input.orca, machines, kind: input.kind, runDir: dir, runId: input.id, reassessment: result.reassessment }, config, prompt, { ...hooks, signal: controller.signal });
              controller = null;
              Object.assign(state.nodes[node.id], { response: result.response, workResponse: result.workResponse, outcome: result.outcome, assessment: result.assessment, finishedAt: now(), status: 'review' });
              state.status = 'review'; emit({ nodeId: node.id, type: 'result', text: result.response }); save();
              if (result.outcome === 'completed' && !node.reviewRequired) approval = true;
            }
          }
          if (stopping) { state.nodes[node.id].status = 'cancelled'; break; }
          if (state.nodes[node.id].outcome === 'needs_review') {
            state.nodes[node.id].outcome = 'completed';
            state.nodes[node.id].confirmedByUser = true;
            state.nodes[node.id].confirmedAt = now();
          }
        }
        state.nodes[node.id].status = 'succeeded'; state.currentNodeId = null; save();
      } catch (e) {
        if (!stopping) state.nodes[node.id].outcome = 'error';
        emit({ nodeId: node.id, type: 'error', text: e.message });
        state.nodes[node.id].status = stopping ? 'cancelled' : 'failed'; state.nodes[node.id].error = e.message; state.nodes[node.id].finishedAt = now(); throw e;
      } finally { controller = null; }
    }
    if (stopping) state.status = 'cancelled';
  } catch (e) { state.status = stopping ? 'cancelled' : 'failed'; state.error = e.message; log('ERROR: ' + e.message); }
  finally {
    clearInterval(poll); clearInterval(heartbeat); process.removeListener('SIGTERM', signal); process.removeListener('SIGINT', signal);
    state.finishedAt = now(); state.currentNodeId = null; save(); log('実行終了: ' + state.status);
  }
  return state;
}
if (require.main === module) runWorker(process.argv[2]).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { runWorker };
