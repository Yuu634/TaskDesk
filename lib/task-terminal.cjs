'use strict';
const { ACTIVE, blankTree, blankNode } = require('./core.cjs');
const { selectExecution } = require('./task-selection.cjs');

function serverUrl(value = process.env.WORK_TREE_URL || 'http://127.0.0.1:' + (process.env.PORT || 4317)) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('WORK_TREE_URL は http://127.0.0.1:4317 のようなローカル URL を指定してください');
  return url.origin;
}
class Client {
  constructor(url) { this.url = serverUrl(url); this.token = null; }
  async request(route, method = 'GET', data) {
    if (method !== 'GET' && !this.token) this.token = (await this.request('/api/session')).token;
    const response = await fetch(this.url + route, { method, signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', ...(this.token ? { 'X-Work-Tree-Token': this.token } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const value = await response.json();
    // Never retry mutations automatically: a timeout may have followed a successful start.
    if (!response.ok) { if (response.status === 403) this.token = null; throw new Error(value.error || '通信に失敗しました'); }
    return value;
  }
}
function rows(tree) {
  const result = [];
  function visit(parentId, depth) {
    (tree?.nodes || []).filter(n => n.parentId === parentId).sort((a, b) => a.order - b.order).forEach(node => {
      result.push({ node, depth }); if (node.kind === 'group') visit(node.id, depth + 1);
    });
  }
  visit(null, 0); return result;
}
// Strip terminal controls, including OSC links/titles, from AI and user text.
function plain(value) {
  return String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\t/g, '  ');
}
const labels = { pending: '未着手', starting: '開始中', running: '実行中', pausing: '停止予約', paused: '一時停止', review: '確認待ち', succeeded: '完了', failed: '失敗', cancelled: '停止', interrupted: '中断', stopping: '停止中', reconnecting: '再接続待ち' };
const HELP = `↑↓ / j k: ノード選択  ←→ / h l: ツリー切替  Tab: ツリー切替
Enter: 詳細  PgUp/PgDn: 詳細スクロール  : コマンド  q: 終了（実行は継続）

new ツリー名 | 作業ディレクトリ    新しいツリーを作成
add タスク名 / group グループ名    選択グループ内、または同階層へ追加
rename 名前 / prompt 指示 / criteria 完了条件    選択ノードを編集
cwd パス / tool codex|claude       ツリーの既定値を設定
review on|off                     選択タスクの実行後確認
deps 1,3 / deps none              行番号で依存先を指定
move 2 / move root                親グループを変更
up / down                        同階層で並べ替え
run                              選択ノード／グループ＋依存先を実行
run-tree                         ツリー全体を実行
continue                         前回の全体実行の未完了部分から再実行
pause / resume / stop / approve   実行制御・結果の確認後に承認
history / history 1               履歴一覧／番号で選択
result / log / detail             選択履歴の結果／ログ／ノード詳細
chat 追加依頼                     選択タスクに追加依頼
help / web                       この説明／Web 画面の URL

プロンプトと完了条件の \\n は改行に変換。全設定・削除・添付は Web 画面で編集。
run は依存先も毎回実行します。終了済みの依存タスクも再実行されます。`;

class TerminalModel {
  constructor(client) { this.client = client; this.data = { trees: [], runs: [] }; this.treeId = null; this.nodeId = null; this.runId = null; this.detail = HELP; this.notice = '操作: :help'; this.stale = false; }
  get tree() { return this.data.trees.find(t => t.id === this.treeId); }
  get node() { return this.tree?.nodes.find(n => n.id === this.nodeId); }
  get runs() { return this.data.runs.filter(r => r.treeId === this.treeId && r.kind !== 'plan'); }
  get activeRun() { return this.runs.find(r => ACTIVE.has(r.state.status)); }
  get run() { return this.runs.find(r => r.id === this.runId) || this.activeRun || this.runs[0]; }
  async refresh() {
    try {
      this.data = await this.client.request('/api/state'); this.stale = false;
      if (!this.tree) { this.treeId = this.data.trees[0]?.id; this.runId = null; }
      if (!this.node) this.nodeId = rows(this.tree)[0]?.node.id;
    } catch (e) { this.stale = true; throw e; }
  }
  switchTree(delta) {
    const trees = this.data.trees; if (!trees.length) return;
    this.treeId = trees[(trees.findIndex(t => t.id === this.treeId) + delta + trees.length) % trees.length].id;
    this.nodeId = rows(this.tree)[0]?.node.id; this.runId = null; this.describe();
  }
  selectNode(delta) {
    const list = rows(this.tree); if (!list.length) return;
    this.nodeId = list[Math.max(0, Math.min(list.length - 1, list.findIndex(r => r.node.id === this.nodeId) + delta))].node.id; this.describe();
  }
  describe() {
    const n = this.node;
    this.detail = n ? `${n.title}\nID: ${n.id}\n種別: ${n.kind} / AI: ${n.tool || this.tree.tool}\n作業: ${n.cwd || this.tree.cwd || '未設定'}\n依存先: ${n.dependsOn.map(id => this.tree.nodes.find(n => n.id === id)?.title).join(', ') || 'なし'}\n実行後確認: ${n.reviewRequired ? 'あり' : 'なし'}\n\n指示:\n${n.prompt}\n\n完了条件:\n${n.criteria}` : 'ノードがありません。:add タスク名 で追加できます。';
  }
  requireNode() { if (!this.node) throw new Error('ノードを選択してください'); return this.node; }
  async edit(change) {
    if (!this.tree) throw new Error('ツリーを作成してください: new 名前 | 作業ディレクトリ');
    const tree = structuredClone(this.tree); change(tree);
    await this.client.request('/api/trees/' + tree.id, 'PUT', tree);
    await this.refresh(); this.describe(); return '保存しました';
  }
  async execute(line) {
    const match = line.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/); if (!match) return;
    const [, command, arg = ''] = match;
    if (command === 'help') { this.detail = HELP; return; }
    if (command === 'web') { this.detail = 'Web 画面: ' + this.client.url + '/\nブラウザで開くと、詳細設定・添付・Notion 連携を編集できます。'; return; }
    if (command === 'new') {
      const split = arg.indexOf('|'), name = (split < 0 ? arg : arg.slice(0, split)).trim(), cwd = split < 0 ? '' : arg.slice(split + 1).trim();
      if (!name) throw new Error('new ツリー名 | 作業ディレクトリ');
      const tree = await this.client.request('/api/trees', 'POST', blankTree({ name, cwd })); this.treeId = tree.id; this.nodeId = null; this.runId = null;
      await this.refresh(); this.describe(); return 'ツリーを作成しました';
    }
    if (!this.tree) throw new Error('ツリーを作成してください: new 名前 | 作業ディレクトリ');
    if (['add', 'group'].includes(command)) {
      if (!arg.trim()) throw new Error('名前を入力してください');
      const node = blankNode({ title: arg, kind: command === 'group' ? 'group' : 'task', parentId: this.node?.kind === 'group' ? this.node.id : this.node?.parentId || null, order: Math.max(0, ...this.tree.nodes.map(n => n.order)) + 1 });
      const result = await this.edit(t => t.nodes.push(node)); this.nodeId = node.id; this.describe(); return result;
    }
    if (['cwd', 'tool'].includes(command)) return this.edit(t => { t[command] = arg; });
    if (['rename', 'prompt', 'criteria', 'review', 'deps', 'move', 'up', 'down'].includes(command)) {
      const id = this.requireNode().id, list = rows(this.tree);
      return this.edit(t => {
        const node = t.nodes.find(n => n.id === id);
        if (['rename', 'prompt', 'criteria'].includes(command)) node[command === 'rename' ? 'title' : command] = arg.replace(/\\n/g, '\n');
        if (command === 'review') { if (!['on', 'off'].includes(arg)) throw new Error('review on または review off'); node.reviewRequired = arg === 'on'; }
        const at = text => { if (!/^[1-9]\d*$/.test(text) || !list[Number(text) - 1]) throw new Error('ノードの行番号を指定してください'); return list[Number(text) - 1].node.id; };
        if (command === 'deps') node.dependsOn = arg === 'none' ? [] : arg.split(',').map(s => at(s.trim()));
        if (command === 'move') node.parentId = arg === 'root' ? null : at(arg);
        if (['up', 'down'].includes(command)) {
          const siblings = t.nodes.filter(n => n.parentId === node.parentId).sort((a, b) => a.order - b.order);
          const from = siblings.findIndex(n => n.id === id), to = from + (command === 'up' ? -1 : 1);
          if (to >= 0 && to < siblings.length) { [siblings[from], siblings[to]] = [siblings[to], siblings[from]]; siblings.forEach((n, i) => { n.order = i; }); }
        }
      });
    }
    if (['run', 'run-tree', 'continue'].includes(command)) {
      if (command === 'run' && !this.data.server?.capabilities?.includes('node-execution')) throw new Error('Web サーバーを更新後のコードで再起動してください（ノード実行 API がありません）');
      const payload = command === 'run' ? { nodeId: this.requireNode().id } : { resume: command === 'continue' };
      if (command === 'run') this.detail = '実行対象（依存先を含む）:\n' + selectExecution(this.tree, this.node.id).nodes.filter(n => n.kind === 'task').map(n => n.title).join('\n');
      const run = await this.client.request('/api/trees/' + this.treeId + '/run', 'POST', payload);
      this.runId = run.id; await this.refresh(); return '実行を開始しました';
    }
    if (['pause', 'resume', 'stop', 'approve'].includes(command)) {
      const run = this.activeRun; if (!run) throw new Error('実行中のタスクがありません');
      if (command === 'approve' && this.run?.id !== run.id) throw new Error('現在の実行履歴を選び、結果を確認してから承認してください');
      await this.client.request('/api/runs/' + run.id + '/control', 'POST', { action: command, nodeId: run.state.currentNodeId }); return '操作を送信しました: ' + command;
    }
    if (command === 'chat') {
      const node = this.requireNode(); if (!arg.trim()) throw new Error('追加依頼を入力してください');
      const run = await this.client.request('/api/trees/' + this.treeId + '/chat', 'POST', { nodeId: node.id, message: arg }); this.runId = run.id; await this.refresh(); return '追加依頼を開始しました';
    }
    if (command === 'history') {
      if (arg) {
        const run = /^[1-9]\d*$/.test(arg) && this.runs[Number(arg) - 1]; if (!run) throw new Error('履歴番号が不正です'); this.runId = run.id;
      }
      this.detail = this.runs.map((r, i) => `${i + 1}. ${r.createdAt} ${r.kind} ${labels[r.state.status] || r.state.status}\n   ${r.id}`).join('\n') || '実行履歴がありません'; return;
    }
    if (command === 'result') {
      const state = this.run?.state;
      this.detail = state ? Object.entries(state.nodes || {}).map(([id, n]) => `${this.tree.nodes.find(n => n.id === id)?.title || id} [${labels[n.status] || n.status}]\n${n.response || n.error || '結果待ち'}`).join('\n\n') + (state.error ? '\n\n' + state.error : '') : '実行履歴がありません'; return;
    }
    if (command === 'log') { if (!this.run) throw new Error('実行履歴がありません'); this.detail = (await this.client.request('/api/runs/' + this.run.id + '/log')).log || 'ログ待ち'; return; }
    if (command === 'detail') { this.describe(); return; }
    throw new Error('不明なコマンドです。help で操作を確認してください');
  }
}
module.exports = { Client, TerminalModel, rows, plain, labels, serverUrl, HELP };
