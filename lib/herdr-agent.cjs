'use strict';
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { read, atomic, ACTIVE } = require('./core.cjs');
const { runAgent, shellQuote } = require('./executor.cjs');
const { writer } = require('./events.cjs');
const { call, verifyPane } = require('./herdr-execution.cjs');
const { plain } = require('./task-terminal.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function main(dir) {
  dir = path.resolve(dir);
  const job = read(path.join(dir, 'job.json'));
  if (!job?.ticket || read(path.join(dir, 'bridge.json'))) throw new Error('実行ブリッジは開始済み、または入力が不正です');
  const { target, binding, config, ticket } = job;
  await verifyPane(target, binding);
  // The bridge owns lifecycle reporting; CLI hooks must not target another pane.
  for (const key of Object.keys(process.env)) if (key.startsWith('HERDR_')) delete process.env[key];
  const emit = writer(dir), controller = new AbortController();
  let started = false, finished = false, closing = false, state = '', reporting = Promise.resolve(), taskPromise;
  const output = text => { process.stdout.write(plain(text) + '\n'); };
  const record = status => atomic(path.join(dir, 'bridge.json'), { ticket, runId: job.runId, nodeId: job.nodeId, pid: process.pid, status, time: new Date().toISOString() });
  function report(next) {
    if (state === next) return reporting;
    state = next;
    reporting = reporting.catch(() => {}).then(() => call(target, ['pane', 'report-agent', binding.paneId, '--source', 'custom:work-tree-node', '--agent', 'work-tree', '--state', next]));
    return reporting;
  }
  function result(value) { atomic(path.join(dir, 'result.json'), { ticket, runId: job.runId, nodeId: job.nodeId, ...value }); }
  function stop() {
    controller.abort();
    if (!started) { finished = true; result({ ok: false, error: '実行を停止しました' }); record('finished'); }
  }
  const lines = readline.createInterface({ input: process.stdin, terminal: false });
  async function execute(line) {
    if (started || finished || closing || line.trim() !== 'work-tree:' + ticket) return;
    if (read(path.join(dir, 'control.json'))?.ticket === ticket || controller.signal.aborted) { stop(); return; }
    started = true; record('running');
    try {
      await report('working');
      output(config.title + ' / ' + config.tool);
      const value = await runAgent(config, job.machine, job.prompt, {
        signal: controller.signal,
        onLaunch: launch => {
          const command = [launch.command, ...launch.args].map(shellQuote).join(' ');
          const text = '作業ディレクトリ: ' + launch.cwd + '\n$ ' + command;
          output(text);
          emit({ type: 'launch', text });
          output('\nプロンプトを送信します:\n' + job.prompt + '\n');
        },
        onLog: text => {
          const file = path.join(dir, 'events.log');
          if (!fs.existsSync(file) || fs.statSync(file).size < 12 * 1024 * 1024) fs.appendFileSync(file, text + '\n', { mode: 0o600 });
        },
        onEvent: event => { emit(event); if (event.text) output(event.text); },
        onProgress: progress => emit({ type: 'progress', progress })
      });
      result({ ok: true, result: value }); output('\n結果:\n' + value.response);
    } catch (e) { result({ ok: false, error: e.message }); output('停止／失敗: ' + e.message); }
    finally { finished = true; record('finished'); }
  }
  lines.on('line', line => { if (!started) taskPromise = execute(line); });
  lines.on('close', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  process.stdout.on('error', stop);
  try {
    if (read(path.join(dir, 'control.json'))?.ticket === ticket) stop();
    else { await report('idle'); record('ready'); output('TaskDesk · ' + config.title + '\nアプリからの実行依頼を待っています。'); }
    const readyAt = Date.now();
    while (!closing) {
      const control = read(path.join(dir, 'control.json'));
      if (control?.ticket === ticket && control.action === 'stop') stop();
      const coordinator = read(path.join(job.runDir, 'state.json'));
      let alive = true; try { process.kill(job.coordinatorPid, 0); } catch { alive = false; }
      if (!alive || !started && Date.now() - readyAt > 30000) stop();
      if (finished) {
        const node = coordinator?.nodes?.[job.nodeId];
        if (node?.status === 'review') await report('blocked').catch(() => {});
        else await report('idle').catch(() => {});
        if (!alive || !coordinator || !ACTIVE.has(coordinator.status) || ['succeeded', 'failed', 'cancelled'].includes(node?.status) || controller.signal.aborted) closing = true;
      }
      await delay(200);
    }
  } finally {
    controller.abort(); await taskPromise;
    lines.close(); process.stdin.pause(); await reporting.catch(() => {});
    await call(target, ['pane', 'release-agent', binding.paneId, '--source', 'custom:work-tree-node', '--agent', 'work-tree']).catch(() => {});
    record('closed');
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop);
    process.stdout.off('error', stop);
  }
}
if (require.main === module) main(process.argv[2]).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
