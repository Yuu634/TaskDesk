'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { normalize, writer, readEvents } = require('../lib/events.cjs');
test('chat formatting renders Markdown without executing HTML or unsafe URL schemes', () => {
  const { format } = require('../public/chat-format.js');
  const html = format('## Result\n- **passed**\n<script>alert(1)</script>\n[x](javascript:alert(1))\n[y](https://example.com/?a=\"x\")\n```html\n<img src=x onerror=alert(1)>\n```');
  assert(html.includes('<h4>Result</h4>')); assert(html.includes('<strong>passed</strong>'));
  assert(!html.includes('<script>')); assert(!html.includes('<img')); assert(!html.includes('href="javascript:'));
  assert(html.includes('rel="noopener noreferrer"')); assert(html.includes('&quot;x&quot;'));
});
test('public CLI events preserve command progress and exclude reasoning', () => {
  assert.deepEqual(normalize({ type: 'item.completed', item: { type: 'reasoning', text: 'private' } }), []);
  const [cmd] = normalize({ type: 'item.completed', item: { id: 'a', type: 'command_execution', command: 'npm test', aggregated_output: 'passed', exit_code: 0 } });
  assert.equal(cmd.type, 'tool'); assert.equal(cmd.detail, 'passed'); assert.equal(cmd.status, 'completed');
  const claude = normalize({ type: 'assistant', message: { id: 'a', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '調査しています' }, { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'readme' } }] } });
  assert.equal(claude.length, 2); assert.equal(claude[0].type, 'assistant'); assert.equal(claude[1].type, 'tool');
});
test('durable chat pagination preserves unicode, cursor boundaries, and partial trailing lines', () => {
  const root = path.resolve(__dirname, '../.test-data'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'events-')), emit = writer(dir);
  for (let i = 0; i < 80; i++) emit({ type: 'assistant', text: '日本語🌱'.repeat(1000) + i });
  let cursor = 0, count = 0, more;
  do { const page = readEvents(dir, cursor); count += page.events.length; more = page.more; assert(page.cursor > cursor); cursor = page.cursor; assert(page.events.every(e => !e.text.includes('\ufffd'))); } while (more);
  assert.equal(count, 80); fs.appendFileSync(path.join(dir, 'chat.jsonl'), '{"type":'); assert.equal(readEvents(dir, cursor).events.length, 0);
  assert.throws(() => readEvents(dir, -1));
});
