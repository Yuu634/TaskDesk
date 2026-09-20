'use strict';
const readline = require('node:readline');
const { Client, TerminalModel, rows, plain, labels, serverUrl } = require('../lib/task-terminal.cjs');
const { ensureService, Reporter } = require('../lib/herdr.cjs');

const segments = new Intl.Segmenter('ja', { granularity: 'grapheme' });
function clip(text, width) {
  let result = '', used = 0;
  for (const { segment } of segments.segment(plain(text).replace(/\n/g, ' '))) {
    const n = segment.codePointAt(0), size = n >= 0x1100 && (n <= 0x115f || n >= 0x2e80 && n <= 0xa4cf || n >= 0xac00 && n <= 0xd7af || n >= 0xf900 && n <= 0xfaff || n >= 0xfe10 && n <= 0xfe6f || n >= 0xff01 && n <= 0xff60 || n >= 0x1f000) ? 2 : 1;
    if (used + size > width) break; used += size; result += segment;
  }
  return result;
}
function wrap(text, width) {
  return plain(text).split('\n').flatMap(line => {
    const result = [];
    while (line) { const part = clip(line, width); if (!part) break; result.push(part); line = line.slice(part.length); }
    return result.length ? result : [''];
  });
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('npm run tui -- [--url http://127.0.0.1:4317] [--once]\n--once: ツリー一覧を出力。引数なし: 対話画面。:help で操作一覧。'); return; }
  let url = serverUrl(), once = false, explicit = false, treeId = null, noReport = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) { url = serverUrl(args[++i]); explicit = true; }
    else if (args[i] === '--once') once = true;
    else if (args[i] === '--tree' && args[i + 1]) treeId = args[++i];
    else if (args[i] === '--no-report') noReport = true;
    else throw new Error('不明な引数: ' + args[i]);
  }
  if (!once && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('対話ターミナルで実行してください。一覧だけなら --once を指定できます');
  const client = explicit || once ? new Client(url) : await ensureService(url);
  const model = new TerminalModel(client); model.treeId = treeId; await model.refresh();
  if (once) {
    for (const tree of model.data.trees) { console.log(plain(tree.name) + ' [' + tree.id + ']'); for (const { node, depth } of rows(tree)) console.log('  '.repeat(depth + 1) + (node.kind === 'group' ? '▾ ' : '• ') + plain(node.title)); }
    return;
  }
  const reporter = new Reporter(noReport ? null : process.env.HERDR_PANE_ID);
  let closing = false, busy = false, refreshing = false, command = null, pasted = false, scroll = 0, poll;
  let reporting = Promise.resolve(), reportPending = false;
  function report() {
    if (reportPending || closing) return;
    reportPending = true;
    reporting = reporter.update(model).catch(e => { if (!closing) model.notice = 'herdr 状態通知: ' + e.message; }).finally(() => { reportPending = false; });
  }
  function draw() {
    if (closing) return;
    const width = Math.max(10, process.stdout.columns || 80), height = Math.max(6, process.stdout.rows || 24), tree = model.tree, run = model.run;
    const list = rows(tree), index = list.findIndex(r => r.node.id === model.nodeId), count = Math.max(1, Math.floor((height - 8) / 2));
    const offset = Math.max(0, Math.min(index - Math.floor(count / 2), list.length - count));
    const output = ['TaskDesk × herdr  |  ' + (model.stale ? '接続待ち・表示は最終取得時点' : url),
      `${model.data.trees.findIndex(t => t.id === model.treeId) + 1}/${model.data.trees.length}  ${tree?.name || 'ツリーなし'}  |  ${tree?.cwd || '作業ディレクトリ未設定'}`,
      `履歴: ${run ? run.kind + ' / ' + (labels[run.state.status] || run.state.status) + ' / ' + run.id.slice(0, 8) : '未実行'}  ${busy ? '処理中…' : ''}`];
    for (let i = offset; i < Math.min(list.length, offset + count); i++) {
      const { node, depth } = list[i], status = run?.treeRevision === tree.revision ? run.state.nodes?.[node.id]?.status : null;
      output.push(`${node.id === model.nodeId ? '▶' : ' '} ${i + 1}. ${'  '.repeat(depth)}${node.kind === 'group' ? '▾' : '•'} ${node.title}  ${status ? '[' + (labels[status] || status) + ']' : ''}`);
    }
    while (output.length < count + 3) output.push('');
    output.push('─'.repeat(width - 1));
    const detail = wrap(model.detail, width - 1), available = Math.max(0, height - output.length - 3);
    scroll = Math.max(0, Math.min(scroll, Math.max(0, detail.length - available)));
    output.push(...detail.slice(scroll, scroll + available));
    while (output.length < height - 3) output.push('');
    output.push('↑↓ 選択  ←→ ツリー  : コマンド  PgUp/PgDn 詳細  ? ヘルプ  q 終了');
    output.push(model.notice || '');
    output.push(command === null ? ':help でコマンド一覧' : ':' + command + '▏');
    process.stdout.write('\x1b[H' + output.slice(0, height).map(s => clip(s, width - 1) + '\x1b[K').join('\r\n') + '\x1b[J');
  }
  async function refresh() {
    if (closing || busy || refreshing) return;
    refreshing = true;
    try { await model.refresh(); } catch (e) { model.notice = '接続エラー: ' + e.message; }
    finally { refreshing = false; report(); draw(); }
  }
  async function execute(line) {
    busy = true; draw();
    try { model.notice = await model.execute(line) || '表示を更新しました'; await model.refresh(); scroll = 0; }
    catch (e) { model.notice = e.message; }
    finally { busy = false; report(); draw(); }
  }
  async function close() {
    if (closing) return; closing = true; clearInterval(poll);
    process.stdin.off('keypress', keypress); process.stdout.off('resize', draw);
    process.stdin.setRawMode(false); process.stdin.pause();
    process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
    await reporting; await reporter.close().catch(() => {});
    process.off('SIGINT', close); process.off('SIGTERM', close);
  }
  function keypress(text, key = {}) {
    if (key.ctrl && key.name === 'c') { void close(); return; }
    if (closing || busy) return;
    if (key.sequence === '\x1b[200~') { pasted = true; return; }
    if (key.sequence === '\x1b[201~') { pasted = false; return; }
    if (command !== null) {
      if (pasted) { command += plain(text || '').replace(/[\r\n]/g, '\\n'); draw(); return; }
      if (key.name === 'escape') command = null;
      else if (key.name === 'return' || key.name === 'enter') { const line = command; command = null; void execute(line); return; }
      else if (key.name === 'backspace') command = [...command].slice(0, -1).join('');
      else if (key.ctrl && key.name === 'u') command = '';
      else if (!key.ctrl && !key.meta && text && !text.includes('\x1b')) command += plain(text);
    } else if (!pasted) {
      if (text === 'q') { void close(); return; }
      if (text === ':') command = '';
      else if (key.name === 'up' || text === 'k') { model.selectNode(-1); scroll = 0; }
      else if (key.name === 'down' || text === 'j') { model.selectNode(1); scroll = 0; }
      else if (key.name === 'left' || text === 'h') { model.switchTree(-1); scroll = 0; }
      else if (key.name === 'right' || key.name === 'tab' || text === 'l') { model.switchTree(1); scroll = 0; }
      else if (key.name === 'pageup') scroll = Math.max(0, scroll - 5);
      else if (key.name === 'pagedown') scroll += 5;
      else if (key.name === 'return') { model.describe(); scroll = 0; }
      else if (text === '?') { void execute('help'); return; }
    }
    draw();
  }
  readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
  process.stdin.on('keypress', keypress); process.stdout.on('resize', draw);
  process.on('SIGINT', close); process.on('SIGTERM', close);
  poll = setInterval(refresh, 2000); report(); draw();
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { clip, wrap };
