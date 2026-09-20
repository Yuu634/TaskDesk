'use strict';
const path = require('node:path');
const { capture, shellQuote } = require('./executor.cjs');
const { serverUrl, Client } = require('./task-terminal.cjs');
const { read } = require('./core.cjs');
const root = path.resolve(__dirname, '..');

async function herdr(args) {
  const output = await capture(process.env.HERDR_BIN || 'herdr', args, '', 10000);
  return parseResponse(output);
}
function parseResponse(output) {
  // Commands such as pane run/send-keys acknowledge success with empty stdout.
  if (!output.trim()) return {};
  let data; try { data = JSON.parse(output); } catch { throw new Error('herdr の応答が JSON ではありません: ' + output.slice(0, 500)); }
  if (data.error || data.ok === false) throw new Error(data.error?.message || JSON.stringify(data.error || data));
  return data.result || data;
}
function launchCommand(url, node = process.execPath, script = path.join(root, 'scripts/task-tree.cjs')) {
  return [node, script, '--url', serverUrl(url)].map(shellQuote).join(' ');
}
async function ensureService(url) {
  const client = new Client(url);
  let state;
  try { state = await client.request('/api/state'); } catch (e) {
    if (process.env.WORK_TREE_URL) throw new Error('WORK_TREE_URL に接続できません: ' + e.message);
    const dir = path.resolve(process.env.WORK_TREE_DATA || path.join(root, '.work-tree'));
    const lock = read(path.join(dir, 'server.lock'));
    if (lock && lock.platform !== process.platform) throw new Error('別環境または旧バージョンの server.lock が残っています。元の Windows / WSL 環境でサーバーを停止済みか確認し、使用する環境で npm run background を実行してから接続してください');
    await capture(process.execPath, [path.join(root, 'scripts/service.cjs'), 'start'], '', 15000);
    state = await client.request('/api/state');
  }
  if (!state.server?.capabilities?.includes('node-execution')) throw new Error('起動中の TaskDesk は旧バージョンです。同じ環境・保存先で npm run restart を実行してください。npm start で起動した場合は元のターミナルで Ctrl+C → npm run background で再起動してください');
  const expected = path.resolve(process.env.WORK_TREE_DATA || path.join(root, '.work-tree'));
  if (!process.env.WORK_TREE_URL && state.server.dataDir !== expected) throw new Error('別の保存先のサーバーが起動しています。PORT / WORK_TREE_DATA、または接続先 WORK_TREE_URL を指定してください');
  return client;
}
function semanticState(data) {
  const states = data.runs.map(r => r.state.status);
  if (states.some(s => ['review', 'paused', 'reconnecting'].includes(s))) return 'blocked';
  if (states.some(s => ['starting', 'running', 'pausing', 'stopping'].includes(s))) return 'working';
  return 'idle';
}
class Reporter {
  constructor(pane = process.env.HERDR_PANE_ID, call = herdr) { this.pane = process.env.HERDR_ENV === '1' ? pane : null; this.call = call; this.previous = ''; this.last = 0; this.seq = 0; }
  async update(model) {
    if (!this.pane) return;
    const state = model.stale ? 'unknown' : semanticState(model.data);
    const summary = (model.tree?.name || 'Task Tree') + ' · ' + (model.stale ? '接続待ち' : model.activeRun?.state.status || 'idle');
    const key = state + ':' + summary;
    if (key === this.previous && Date.now() - this.last < 15000) return;
    this.seq = Math.max(Date.now(), this.seq + 1);
    await this.call(['pane', 'report-agent', this.pane, '--source', 'custom:work-tree', '--agent', 'work-tree', '--state', state, '--seq', String(this.seq)]);
    await this.call(['pane', 'report-metadata', this.pane, '--source', 'custom:work-tree', '--token', 'summary=' + summary, '--ttl-ms', '30000']);
    this.previous = key; this.last = Date.now();
  }
  async close() {
    if (!this.pane) return;
    this.seq = Math.max(Date.now(), this.seq + 1);
    await this.call(['pane', 'release-agent', this.pane, '--source', 'custom:work-tree', '--agent', 'work-tree', '--seq', String(this.seq)]);
    await this.call(['pane', 'report-metadata', this.pane, '--source', 'custom:work-tree', '--clear-token', 'summary']);
  }
}
module.exports = { herdr, parseResponse, launchCommand, ensureService, semanticState, Reporter };
