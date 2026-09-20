'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Notion, notionId, DEFAULT_PAGE, plain, rich, hash } = require('../lib/notion.cjs');
const { blankTree, blankNode } = require('../lib/core.cjs');
const { fixture } = require('./fixtures/notion-api.cjs');
const root = path.resolve(__dirname, '../.test-data'); fs.mkdirSync(root, { recursive: true });
const machines = [{ id: 'local' }];
function setup() {
  const dir = fs.mkdtempSync(path.join(root, 'notion-')), mock = fixture(), options = { fetchImpl: mock.fetch, interval: 0 }, client = new Notion(dir, options);
  client.configure({ token: 'fixture-secret', sourceId: mock.source });
  const group = blankNode({ kind: 'group', prompt: '背景' });
  const node = blankNode({ title: '実装', parentId: group.id, order: 1, prompt: '実装する', env: { SECRET: 'private' }, cli: { codex: { model: 'local-model' } } });
  const tree = blankTree({ nodes: [group, node], cwd: dir });
  return { dir, mock, options, client, tree, node };
}
test('Notion app links use the selected p parameter and reject external URLs', () => {
  assert.equal(notionId(DEFAULT_PAGE), '3dfc4f28-d284-80f9-b020-c1f92d5c2314');
  assert.throws(() => notionId('https://attacker.invalid/3dfc4f28d28480f9b020c1f92d5c2314'));
});
test('dedicated database creation uses the selected parent and data source schema', async () => {
  const { client, mock } = setup(); client.configure({ sourceId: '' });
  const status = await client.createDatabase(); assert.equal(status.sourceId, mock.source);
  const request = mock.calls.find(c => c.endpoint === 'databases');
  assert.equal(request.body.parent.page_id, notionId(DEFAULT_PAGE));
  assert.equal(request.headers['Notion-Version'], '2025-09-03');
  assert(request.body.initial_data_source.properties['WT Key']);
  await assert.rejects(() => client.createDatabase(), /設定済み/);
});
test('Notion plans roundtrip without leaking credentials or changing execution settings', async () => {
  const { client, mock, tree, node } = setup(); await client.push(tree);
  assert.equal(mock.rows.length, 3);
  assert(!JSON.stringify(mock.rows).includes('private')); assert(!JSON.stringify(client.status()).includes('fixture-secret'));
  const row = mock.rows.find(r => plain(r.properties['WT Key']) === tree.id + ':' + node.id);
  row.properties.Prompt = rich('Notion で編集した依頼');
  const next = await client.pull(tree, machines);
  assert.equal(next.nodes.find(n => n.id === node.id).prompt, 'Notion で編集した依頼');
  assert.equal(next.nodes.find(n => n.id === node.id).env.SECRET, 'private');
  assert.equal(next.nodes.find(n => n.id === node.id).cli.codex.model, 'local-model');
  assert.equal(next.revision, tree.revision + 1);
});
test('Notion detects both directions of plan conflict and rejects invalid remote graphs', async () => {
  const { client, mock, tree, node } = setup(); await client.push(tree);
  const local = structuredClone(tree); local.name = 'local edit';
  await assert.rejects(() => client.pull(local, machines), /ローカル/);
  const remote = mock.rows.find(r => plain(r.properties['WT Key']) === tree.id + ':' + node.id); remote.properties.Prompt = rich('remote edit');
  await assert.rejects(() => client.push(local), /Notion 側/);
  const next = await client.pull(local, machines, true); assert.equal(next.name, tree.name);
  const before = client.links[tree.id].hash; remote.properties.Parent = rich(node.id);
  await assert.rejects(() => client.pull(next, machines), /グループ|循環/);
  assert.equal(client.links[tree.id].hash, before);
});
test('result retries reconcile partial writes after restart without duplicate pages or blocks', async () => {
  const { client, mock, dir, options, tree, node } = setup(); await client.push(tree);
  const job = { sourceId: mock.source, treeId: tree.id, runId: 'test-run', nodeId: node.id, title: node.title, text: '長い作業結果\n'.repeat(30000), status: 'succeeded' };
  mock.failAppendOnce = true; await assert.rejects(() => client.saveResult(job), /接続できません/);
  const resumed = new Notion(dir, options); await resumed.saveResult(job);
  const results = mock.rows.filter(r => r.properties.Kind.select.name === 'Result'); assert.equal(results.length, 1);
  const text = mock.blocks.get(results[0].id).map(b => plain({ rich_text: b.paragraph.rich_text })).join(''); assert.equal(text, job.text);
  await resumed.saveResult(job); assert.equal(mock.blocks.get(results[0].id).map(b => plain({ rich_text: b.paragraph.rich_text })).join(''), job.text);
});
test('removed nodes remain in Notion as inactive rows and do not return on pull', async () => {
  const { client, mock, tree, node } = setup(); await client.push(tree);
  tree.nodes = tree.nodes.filter(n => n.id !== node.id); await client.push(tree);
  assert.equal(mock.rows.find(r => plain(r.properties['WT Key']) === tree.id + ':' + node.id).properties.Removed.checkbox, true);
  const next = await client.pull(tree, machines); assert.equal(hash(next), hash(tree));
});
