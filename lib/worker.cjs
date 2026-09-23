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
  state.manualLabelVersion = 2;
  for(const [id,report] of Object.entries(input.previousReports || {})) if(state.nodes[id]) state.nodes[id].report=report;
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
    if (c.action === 'revise' && state.status === 'review' && c.nodeId === state.currentNodeId) { state.nodes[c.nodeId].resultStale = true; approval = null; }
    if (c.action === 'approve' && state.status === 'review' && c.nodeId === state.currentNodeId && !state.nodes[c.nodeId].resultStale) approval = true;
    if (c.action === 'label' && state.status === 'review' && c.nodeId === state.currentNodeId) {
      require('./manual-label.cjs').labelResult(state.nodes[c.nodeId], c.outcome, c.note);
      approval = c.outcome === 'completed' ? 'manual-label' : c.outcome === 'needs_review' ? null : 'label-stop';
      reassess = false;
    }
    if (c.action === 'reassess' && state.status === 'review' && c.nodeId === state.currentNodeId) { reassess = c; approval = null; }
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
    const remoteTree = { ...tree, completionMode:'ai', attachments: [], machineId: machine.id, runnerId: machine.id, nodes: [remoteNode] };
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
      const taskPrompt = !['plan','single'].includes(input.kind) ? require('./task-reports.cjs').createTaskPrompt(tree,node,state.nodes,input.id,input.orca?.reassessment?.report) : null;
      const prompt = taskPrompt ? taskPrompt.prompt : node.prompt + (input.kind === 'single' && node.criteria ? '\n\n完了条件:\n' + node.criteria : '');
      state.currentNodeId = node.id; state.status = 'running';
      state.nodes[node.id] = { status: 'running', startedAt: now(), machineId: machine.id, tool: config.tool };
      if(taskPrompt) Object.assign(state.nodes[node.id],{report:taskPrompt.report,reportReferences:taskPrompt.refs});
      controller = new AbortController(); save(); log('タスク: ' + node.title + ' / ' + config.tool + ' / ' + machine.name);
      emit({ nodeId: node.id, type: 'user', text: node.chatMessage || node.prompt, title: node.title });
      emit({ nodeId: node.id, type: 'status', text: config.tool + ' / ' + machine.name + ' / ' + config.cwd });
      try {
        const hooks = { onLog: log, onEvent: event => emit({ ...event, nodeId: node.id }), signal: controller.signal, onProgress: progress => { state.nodes[node.id].goalProgress = progress; emit({ nodeId: node.id, type: 'status', text: 'ゴール確認 ' + progress.attempt + ' / ' + progress.maxAttempts }); save(); } };
        hooks.onInteractive = value => { state.nodes[node.id].interactive = value; save(); };
        if (input.herdr) { state.nodes[node.id].herdr = input.herdr.nodes[node.id]; save(); }
        let result = input.orca
          ? await require('./orca-execution.cjs').runInOrca({ ...input.orca, completionMode:tree.completionMode || (node.reviewRequired ? 'manual' : 'ai'), report:state.nodes[node.id].report, machines, kind: input.kind, runDir: dir, runId: input.id }, config, prompt, hooks)
          : input.herdr
          ? await require('./herdr-execution.cjs').runInHerdr({ ...input.herdr, runDir: dir, runId: input.id }, config, machine, prompt, hooks)
          : machine.id === runnerId
          ? await runAgent(config, machine, prompt, hooks)
          : await remoteTask(machine, config, prompt, controller.signal);
        controller = null;
        if (stopping) { state.nodes[node.id].status = 'cancelled'; break; }
        state.nodes[node.id].response = result.response; state.nodes[node.id].finishedAt = now();
        if (typeof result.workResponse === 'string') state.nodes[node.id].workResponse = result.workResponse;
        if(taskPrompt) state.nodes[node.id].report=require('./task-reports.cjs').recordReport(taskPrompt.report,result.workResponse || result.response);
        state.nodes[node.id].outcome = result.outcome || 'completed';
        state.nodes[node.id].resultStale = Boolean(result.resultStale);
        if (result.assessment) state.nodes[node.id].assessment = result.assessment;
        state.nodes[node.id].canReassess = Boolean(result.reassessment);
        emit({ nodeId: node.id, type: 'result', text: result.response });
        if (!['completed', 'needs_review'].includes(state.nodes[node.id].outcome)) {
          state.nodes[node.id].status = 'failed';
          state.status = 'failed'; state.error = (state.nodes[node.id].outcome === 'unexpected' ? '想定外の結果です。' : 'エラーとして記録しました。') + (input.orca ? 'Orca の対話とツリーを確認してください' : '編集案を確認してください');
          save(); break;
        }
        const humanReview = input.kind !== 'plan' && (tree.completionMode ? tree.completionMode === 'manual' : node.reviewRequired);
        if (state.nodes[node.id].outcome === 'needs_review' || humanReview && !result.confirmedByUser) {
          if (humanReview && !result.confirmedByUser) state.nodes[node.id].outcome = 'needs_review';
          state.nodes[node.id].status = 'review'; state.status = 'review'; approval = null; save();
          let lastObserved = 0;
          while (!approval && !stopping) {
            await delay(500); controls();
            if (result.reassessment && !reassess && !['manual-label','label-stop'].includes(approval) && (approval || Date.now() - lastObserved > 4000)) {
              lastObserved = Date.now();
              const labelBeforeObservation = state.nodes[node.id].manualLabel;
              try {
                const changed = await require('./orca-revision.cjs').workChanged(input.orca, result.reassessment);
                if (changed && state.nodes[node.id].manualLabel === labelBeforeObservation && !['manual-label','label-stop'].includes(approval)) {
                  state.nodes[node.id].resultStale = true; approval = null; save();
                }
              } catch (e) { if (approval && state.nodes[node.id].manualLabel === labelBeforeObservation && !['manual-label','label-stop'].includes(approval)) { approval = null; log('修正状態を確認できません: ' + e.message); } }
            }
            if (reassess && result.reassessment && !stopping) {
              const request = reassess; reassess = false;
              state.nodes[node.id].reassessmentRequestId = request.id;
              state.nodes[node.id].resultHistory ||= [];
              state.nodes[node.id].resultHistory.push({ response:state.nodes[node.id].response, workResponse:state.nodes[node.id].workResponse, assessment:state.nodes[node.id].assessment, outcome:state.nodes[node.id].outcome, criteria:config.criteria, savedAt:now() });
              if (typeof request.criteria === 'string') config.criteria = request.criteria;
              state.nodes[node.id].resultStale = true;
              controller = new AbortController(); state.status = 'running'; state.nodes[node.id].status = 'running'; save();
              state.nodes[node.id].assessmentHistory ||= []; state.nodes[node.id].assessmentHistory.push(state.nodes[node.id].assessment);
              result = await require('./orca-execution.cjs').runInOrca({ ...input.orca, completionMode:tree.completionMode || (node.reviewRequired ? 'manual' : 'ai'), report:state.nodes[node.id].report, machines, kind: input.kind, runDir: dir, runId: input.id, reassessment: { ...result.reassessment, report:state.nodes[node.id].report, refreshReport:request.refreshReport === true } }, config, prompt, { ...hooks, signal: controller.signal });
              controller = null;
              Object.assign(state.nodes[node.id], { response: result.response, workResponse: result.workResponse, outcome: result.outcome, assessment: result.assessment, resultStale:Boolean(result.resultStale), finishedAt: now(), status: 'review' });
              if(taskPrompt) state.nodes[node.id].report=require('./task-reports.cjs').recordReport(state.nodes[node.id].report,result.workResponse || result.response);
              state.status = 'review'; emit({ nodeId: node.id, type: 'result', text: result.response }); save();
              if (humanReview && result.outcome === 'completed') { state.nodes[node.id].outcome = 'needs_review'; save(); }
              if (result.outcome === 'completed' && !humanReview) approval = true;
            }
          }
          if (stopping) { state.nodes[node.id].status = state.nodes[node.id].manualLabel?.outcome === 'completed' && state.nodes[node.id].outcome === 'completed' && !state.nodes[node.id].resultStale ? 'succeeded' : 'cancelled'; break; }
          if (approval === 'label-stop') { state.status = 'failed'; state.error = '人が完了以外のラベルを付与したため、後続TASKを停止しました'; save(); break; }
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
