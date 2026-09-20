'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { createApp } = require('../server.cjs');
const { blankTree, blankNode, read } = require('../lib/core.cjs');
const { Client } = require('../lib/task-terminal.cjs');
const { call, targetFor } = require('../lib/herdr-execution.cjs');
const { capture } = require('../lib/executor.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn) { const end = Date.now() + 45000; while (Date.now() < end) { const r = await fn(); if (r) return r; await delay(200); } throw Error('timed out'); }
async function main() {
  if (process.env.HERDR_ENV !== '1') throw Error('herdr のターミナル内で実行してください');
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/herdr-interactive-')), app = createApp({ dataDir: dir, port: 0 });
  let client;
  try {
    await capture('cc', [path.join(root, 'test/fixtures/interactive-cli.c'), '-o', path.join(dir, 'codex')], '', 15000);
    fs.copyFileSync(path.join(dir, 'codex'), path.join(dir, 'claude')); fs.chmodSync(path.join(dir, 'claude'), 0o700);
    const address = await app.listen(); client = new Client('http://127.0.0.1:' + address.port);
    await client.request('/api/machines/local', 'PUT', { name: 'PTY fixture', codexPath: path.join(dir, 'codex'), claudePath: path.join(dir, 'claude') });
    const a = blankNode({ title: '仕様を調べる', prompt: 'first\n日本語 $(never) `never`', cli: { codex: { model: 'node-codex-model', effort: 'medium', approval: 'auto-review' } }, env: { FAKE_CAPTURE: path.join(dir, 'codex') } });
    const b = blankNode({ title: '画面を作る 日本語', prompt: 'second literal $(never) `never`', tool: 'claude', dependsOn: [a.id], reviewRequired: true, cli: { claude: { model: 'node-claude-model', effort: 'low', permissionMode: 'dontAsk' } }, env: { FAKE_CAPTURE: path.join(dir, 'claude') } });
    let tree = await client.request('/api/trees', 'POST', blankTree({ name: '対話連携の検証', cwd: dir, executionBackend: 'herdr', nodes: [a,b] }));
    const state = async rid => { const r = (await client.request('/api/state')).runs.find(r => r.id === rid); if (['failed','interrupted'].includes(r.state.status)) throw Error(JSON.stringify(r.state)); return r; };
    const ready = (rid, nid) => wait(async () => { const r = await state(rid); return r.state.nodes[nid]?.interactive?.phase === 'ready' && r; });
    const complete = (rid, nid, response, outcome = 'completed') => client.request('/api/runs/' + rid + '/control', 'POST', { action: 'complete', nodeId: nid, response, outcome });
    const started = await client.request('/api/trees/' + tree.id + '/run', 'POST', { nodeId: b.id });
    console.log('Native interactive run ' + started.id + '\nEvidence: ' + dir);
    await ready(started.id, a.id); await delay(1200);
    assert.equal((await state(started.id)).state.currentNodeId, a.id);
    assert(!fs.existsSync(path.join(dir,'claude.args')), 'next task must wait for explicit completion');
    await assert.rejects(complete(started.id, b.id, '違うノード'), /入力待ち/);
    await assert.rejects(complete(started.id, a.id, ''), /結果の要約/);
    await complete(started.id, a.id, '調査結果：依存先へ渡す要約');
    await ready(started.id, b.id);
    assert(fs.readFileSync(path.join(dir, 'codex.prompt'),'utf8').includes(a.prompt));
    const secondPrompt = fs.readFileSync(path.join(dir,'claude.prompt'),'utf8');
    assert(secondPrompt.includes(b.prompt)); assert(secondPrompt.includes('調査結果：依存先へ渡す要約'));
    for (const tool of ['codex','claude']) {
      const args = fs.readFileSync(path.join(dir, tool + '.args'),'utf8').trim().split('\n');
      assert.equal(args[args.indexOf('--model')+1], 'node-' + tool + '-model');
      assert(!args.includes('exec')); assert(!args.includes('-p')); assert(!args.includes('--output-format'));
      if (tool === 'codex') { assert(args.includes('model_reasoning_effort="medium"')); assert(args.includes('--approve-for-me')); }
      else { assert.equal(args[args.indexOf('--effort')+1], 'low'); assert.equal(args[args.indexOf('--permission-mode')+1], 'dontAsk'); }
    }
    await complete(started.id, b.id, '実装結果を確認済み');
    await wait(async () => (await state(started.id)).state.status === 'succeeded');
    const input = read(path.join(dir,'runs',started.id,'input.json')), binding = input.herdr.nodes[b.id];
    const info = (await call(input.herdr.target,['pane','process-info','--pane',binding.paneId])).process_info;
    assert.notEqual(info.foreground_process_group_id, info.shell_pid, 'native conversation remains open');
    assert(fs.readFileSync(path.join(dir,'runs',started.id,'herdr',b.id,'terminal.txt'),'utf8').includes('Fixture result'));
    tree = await client.request('/api/trees/' + tree.id, 'PUT', { ...tree, name: '改名したツリー', nodes: tree.nodes.map(n => n.id === b.id ? { ...n, title: '改名したノード', dependsOn: [], env: { FAKE_CAPTURE: path.join(dir,'again'), FAKE_DELAY: '10000' } } : n) });
    const again = await client.request('/api/trees/' + tree.id + '/run','POST',{ nodeId: b.id });
    await wait(async () => (await state(again.id)).state.nodes[b.id]?.interactive?.phase === 'working');
    await assert.rejects(complete(again.id, b.id, '実行中'), /入力待ち/);
    const nextInput = read(path.join(dir,'runs',again.id,'input.json'));
    assert.notEqual(nextInput.herdr.nodes[b.id].paneId, binding.paneId, 'rerun preserves previous conversation');
    await client.request('/api/runs/' + again.id + '/control','POST',{ action: 'stop' });
    await wait(async () => (await state(again.id)).state.status === 'cancelled');
    const stopped = (await call(input.herdr.target,['pane','process-info','--pane',nextInput.herdr.nodes[b.id].paneId])).process_info;
    assert.equal(stopped.foreground_process_group_id, stopped.shell_pid);
    tree = await client.request('/api/trees/' + tree.id, 'PUT', { ...tree, nodes: tree.nodes.map(n => n.id === b.id ? { ...n, env: { FAKE_CAPTURE: path.join(dir,'unexpected') } } : n) });
    const unexpected = await client.request('/api/trees/' + tree.id + '/run','POST',{nodeId:b.id});
    await ready(unexpected.id,b.id);
    await complete(unexpected.id,b.id,'期待する出力と異なる','unexpected');
    await wait(async()=> (await client.request('/api/state')).runs.find(r=>r.id===unexpected.id)?.state.status === 'failed');
    const recorded=(await client.request('/api/state')).runs.find(r=>r.id===unexpected.id).state;
    assert.equal(recorded.nodes[b.id].outcome,'unexpected'); assert.equal(recorded.nodes[b.id].response,'期待する出力と異なる');
    console.log('Passed: actual PTY input for both tools, CLI settings, literal multiline prompt, explicit completion, dependency results, retained conversation, safe rerun and stop.');
  } finally {
    if (client) for (const r of (await client.request('/api/state')).runs) if (['running','review','starting','paused'].includes(r.state.status)) await client.request('/api/runs/' + r.id + '/control','POST',{action:'stop'}).catch(()=>{});
    await delay(700);
    const bindings = read(path.join(dir,'herdr-bindings.json'));
    for (const [session,target] of Object.entries(bindings?.targets || {})) for (const tree of Object.values(target.trees)) if (tree.workspaceId) await call(targetFor(session),['workspace','close',tree.workspaceId]);
    await app.close();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
