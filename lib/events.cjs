'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Only public messages and tool activity are exposed. Reasoning events are ignored.
function normalize(event) {
  const item = event.item;
  if (/^item\.(started|updated|completed)$/.test(event.type) && item) {
    const base = { itemId: item.id, status: item.status || (event.type === 'item.completed' ? 'completed' : 'running') };
    if (item.type === 'agent_message') return [{ ...base, type: 'assistant', text: item.text || '' }];
    if (item.type === 'command_execution') return [{ ...base, type: 'tool', text: item.command || '', detail: item.aggregated_output || '', exitCode: item.exit_code }];
    if (item.type === 'file_change') return [{ ...base, type: 'file', text: (item.changes || []).map(c => c.kind + ': ' + c.path).join('\n') }];
    if (item.type === 'mcp_tool_call') return [{ ...base, type: 'tool', text: 'MCP: ' + item.server + ' / ' + item.tool, detail: JSON.stringify(item.result || item.error || '') }];
  }
  if (event.type === 'assistant') return (event.message?.content || []).flatMap((c, i) => {
    const base = { itemId: c.id || event.message.id + ':' + i, status: 'completed' };
    if (c.type === 'text') return [{ ...base, type: 'assistant', text: c.text }];
    if (c.type === 'tool_use') return [{ ...base, type: 'tool', status: 'running', text: c.name, detail: JSON.stringify(c.input) }];
    return [];
  });
  if (event.type === 'user') return (event.message?.content || []).filter(c => c.type === 'tool_result').map(c => ({ type: 'tool', itemId: c.tool_use_id, status: c.is_error ? 'failed' : 'completed', text: 'ツールの結果', detail: typeof c.content === 'string' ? c.content : JSON.stringify(c.content) }));
  if (event.type === 'turn.failed' || event.type === 'error') return [{ type: 'error', text: event.error?.message || event.message || 'AI の実行エラー' }];
  return [];
}
function writer(dir) {
  const file = path.join(dir, 'chat.jsonl'); let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  return event => {
    if (size > 32 * 1024 * 1024) return;
    const value = { ...event, id: randomUUID(), time: new Date().toISOString() };
    for (const key of ['text', 'detail']) if (typeof value[key] === 'string' && value[key].length > 24000) value[key] = value[key].slice(0, 24000) + '\n…表示を省略（最終結果は実行履歴に保持）';
    const line = JSON.stringify(value) + '\n'; size += Buffer.byteLength(line); fs.appendFileSync(file, line, { mode: 0o600 });
  };
}
function readEvents(dir, after = 0) {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('イベントの読み取り位置が不正です');
  let fd;
  try {
    fd = fs.openSync(path.join(dir, 'chat.jsonl'), 'r'); const size = fs.fstatSync(fd).size;
    if (after > size) after = 0;
    const buffer = Buffer.alloc(Math.min(512 * 1024, size - after)); fs.readSync(fd, buffer, 0, buffer.length, after);
    const end = buffer.lastIndexOf(10) + 1;
    return { events: end ? buffer.subarray(0, end).toString('utf8').trimEnd().split('\n').map(JSON.parse) : [], cursor: after + end, more: after + end < size };
  } catch (e) { if (e.code === 'ENOENT') return { events: [], cursor: 0, more: false }; throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { normalize, writer, readEvents };
