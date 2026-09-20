'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApp } = require('../server.cjs');
const { blankTree, blankNode } = require('../lib/core.cjs');
const { selectExecution } = require('../lib/task-selection.cjs');
const { Client, TerminalModel, rows, plain, serverUrl } = require('../lib/task-terminal.cjs');
const { parseResponse, launchCommand, semanticState, Reporter } = require('../lib/herdr.cjs');
const { clip, wrap } = require('../scripts/task-tree.cjs');

test('group selection preserves external dependencies and excludes unrelated siblings', () => {
  const g = blankNode({ kind: 'group' }), dep = blankNode(), child = blankNode({ parentId: g.id, dependsOn: [dep.id] }), other = blankNode();
  const tree = blankTree({ nodes: [g, dep, child, other] });
  assert.deepEqual(selectExecution(tree, g.id).nodes.map(n => n.id), [g.id, dep.id, child.id]);
  assert.throws(() => selectExecution(tree, 'unknown'), /見つかりません/);
  assert.throws(() => selectExecution(blankTree({ nodes: [g] }), g.id), /ありません/);
  assert.deepEqual(rows(tree).map(r => [r.node.id, r.depth]), [[g.id, 0], [child.id, 1], [dep.id, 0], [other.id, 0]]);
});
test('terminal output removes escape sequences and clips Japanese text by display width', () => {
  assert.equal(plain('safe\x1b]52;c;SECRET\x07\x1b[31mred\x1b[0m\x00'), 'safered');
  assert.equal(plain('\x1b]0;title\x1b\\日本語\u202e'), '日本語');
  assert.equal(clip('日本語abc', 7), '日本語a');
  assert.equal(clip('abc\x1b[2J', 8), 'abc');
  assert.deepEqual(wrap('日本語abc\nnext', 5), ['日本', '語abc', 'next']);
});
test('herdr accepts empty acknowledgements, parses identifiers and rejects API errors', () => {
  assert.deepEqual(parseResponse(''), {});
  assert.deepEqual(parseResponse('{"result":{"pane":{"pane_id":"w3:p7"}}}'), { pane: { pane_id: 'w3:p7' } });
  assert.throws(() => parseResponse('{"error":{"message":"not available"}}'), /not available/);
  assert.throws(() => parseResponse('unexpected output'), /JSON/);
});
test('API client permits only local origins and shell launch quotes literal paths', () => {
  assert.equal(serverUrl('http://localhost:4317/'), 'http://localhost:4317');
  for (const url of ['https://localhost', 'http://example.com', 'http://localhost@evil.test', 'http://localhost/a', 'http://localhost/?a=1']) assert.throws(() => serverUrl(url));
  const script = '/tmp/$(bad) `bad` file\'s.cjs';
  assert.match(launchCommand('http://localhost:4317', '/a b/node', script), /^'\/a b\/node' /);
  assert(launchCommand('http://localhost:4317', '/a b/node', script).includes("'\\''"));
});
test('herdr reports semantic states, refreshes display tokens and releases its own source', async () => {
  const old = process.env.HERDR_ENV; process.env.HERDR_ENV = '1';
  try {
    const calls = [], reporter = new Reporter('w9:p8', async args => calls.push(args));
    const model = { data: { runs: [{ state: { status: 'running' } }] }, tree: { name: 'Test' }, activeRun: { state: { status: 'running' } } };
    await reporter.update(model); await reporter.update(model);
    assert.equal(calls.length, 2); assert(calls[0].includes('working')); assert(calls[1].includes('--ttl-ms'));
    model.data.runs[0].state.status = 'review'; await reporter.update(model); assert(calls[2].includes('blocked'));
    model.stale = true; await reporter.update(model); assert(calls[4].includes('unknown'));
    await reporter.close(); assert.equal(calls[6][1], 'release-agent'); assert.equal(calls[6][2], 'w9:p8');
    assert.equal(calls[7][1], 'report-metadata'); assert(calls[7].includes('--clear-token'));
    assert.equal(semanticState({ runs: [] }), 'idle');
  } finally { if (old === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = old; }
});
test('terminal edits share the Web API, keep revision protection, and execute only selected scope', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-tree-herdr-'));
  const app = createApp({ dataDir: dir, port: 0 }); const address = await app.listen();
  t.after(() => app.close());
  const client = new Client('http://127.0.0.1:' + address.port), model = new TerminalModel(client);
  const fixture = path.join(__dirname, 'fixtures/fake-cli.cjs');
  await client.request('/api/machines/local', 'PUT', { name: 'fixture', codexPath: fixture, claudePath: fixture });
  await model.refresh();
  await model.execute('new Test | ' + dir); await model.execute('group Parent'); const group = model.nodeId;
  await model.execute('prompt Shared context'); await model.execute('add Child'); const child = model.nodeId;
  await model.execute('prompt Literal $(not-a-command) \\nNext line'); await model.execute('criteria Verify output');
  assert.equal(model.node.parentId, group); assert.match(model.node.prompt, /\nNext line/);
  await model.execute('add Sibling'); await model.execute('prompt Should not run');
  model.nodeId = child;
  await model.execute('run');
  const runId = model.runId;
  assert.equal(model.run.kind, 'node');
  const deadline = Date.now() + 10000;
  while (model.run.state.status !== 'succeeded' && Date.now() < deadline) { await new Promise(r => setTimeout(r, 60)); await model.refresh(); }
  assert.equal(model.run.state.status, 'succeeded'); assert.deepEqual(Object.keys(model.run.state.nodes), [child]);
  await model.execute('result'); assert.match(model.detail, /Literal \$\(not-a-command\)/);
  await model.execute('history 1'); assert.equal(model.runId, runId);
  await model.execute('log'); assert.match(model.detail, /実行終了/);
  // Another client saves after the terminal's snapshot: stale edits must fail.
  const tree = structuredClone(model.tree); tree.name = 'From Web'; await client.request('/api/trees/' + tree.id, 'PUT', tree);
  await assert.rejects(model.execute('rename Stale edit'), /別の画面で更新/);
  await model.refresh(); assert.equal(model.tree.name, 'From Web');
  await assert.rejects(model.execute('deps 999'), /行番号/);
  await assert.rejects(model.execute('move 2'), /親子関係|グループ/);
  assert.equal((await client.request('/api/state')).trees.find(t => t.id === tree.id).nodes.find(n => n.id === child).title, 'Child');
});
test('launch command keeps metacharacters literal when executed by a shell', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-tree-launch-'));
  const script = path.join(dir, "a ' $x `not-command`.cjs");
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const output = execFileSync('/bin/sh', ['-c', launchCommand('http://127.0.0.1:4317', process.execPath, script)], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), ['--url', 'http://127.0.0.1:4317']);
});
