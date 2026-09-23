'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createApp } = require('../server.cjs');
const { blankTree, blankNode, id, atomic, read, ACTIVE } = require('../lib/core.cjs');
const { runAgent, capture } = require('../lib/executor.cjs');
const { BOOTSTRAP, ACCESS, files } = require('../lib/remote.cjs');
const fixture = path.join(__dirname, 'fixtures/fake-cli.cjs');
const testRoot = path.resolve(__dirname, '../.test-data'); fs.mkdirSync(testRoot, { recursive: true });
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 15000) { const until = Date.now() + timeout; while (Date.now() < until) { const value = await fn(); if (value) return value; await delay(80); } throw new Error('Test timed out'); }
async function setup(t, notionOptions) {
  const dir = fs.mkdtempSync(path.join(testRoot, 'integration-')); let app = createApp({ dataDir: dir, port: 0, notionOptions }), address = await app.listen();
  let base = 'http://127.0.0.1:' + address.port, token = (await (await fetch(base + '/api/session')).json()).token;
  const request = async (url, method = 'GET', data, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Work-Tree-Token': token, ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: r.status, data: await r.json() };
  };
  await request('/api/machines/local', 'PUT', { name: 'fixture', codexPath: fixture, claudePath: fixture });
  t.after(async () => {
    for (const run of app.store.data.runs) if (ACTIVE.has(app.store.state(run).status)) atomic(path.join(app.store.runDir(run.id), 'control.json'), { id: id(), action: 'stop' });
    await app.close();
  });
  return { dir, request, get app() { return app; }, async restart() { await app.close(); app = createApp({ dataDir: dir, port: 0, notionOptions }); address = await app.listen(); base = 'http://127.0.0.1:' + address.port; token = (await (await fetch(base + '/api/session')).json()).token; },
    async create(nodes, overrides = {}) { const r = await request('/api/trees', 'POST', blankTree({ cwd: dir, nodes, ...overrides })); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; },
    state(runId) { return read(path.join(dir, 'runs', runId, 'state.json')); } };
}
test('next TASK then next WP skip completed dependencies and stop after all tasks', async t => {
  const s = await setup(t), trace = path.join(s.dir, 'trace');
  const wp = blankNode({ kind: 'group', title: 'WP' });
  const a = blankNode({ parentId: wp.id, prompt: 'A', env: { FAKE_NAME: 'A', FAKE_TRACE: trace } });
  const b = blankNode({ parentId: wp.id, order: 1, prompt: 'B', dependsOn: [a.id], env: { FAKE_NAME: 'B', FAKE_TRACE: trace } });
  const tree = await s.create([wp, a, b]);
  for (const next of ['task', 'wp']) {
    const r = await s.request('/api/trees/' + tree.id + '/run', 'POST', { next, revision: tree.revision });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await waitFor(() => s.state(r.data.id)?.status === 'succeeded');
  }
  assert.equal(fs.readFileSync(trace, 'utf8'), 'A\nB\n');
  assert.equal((await s.request('/api/trees/' + tree.id + '/run', 'POST', { next: 'task' })).status, 400);
});

test('edited trees reuse unchanged completed tasks including legacy snapshots after restart', async t => {
  const s=await setup(t), trace=path.join(s.dir,'trace');
  const a=blankNode({prompt:'A',env:{FAKE_NAME:'A',FAKE_TRACE:trace}});
  const b=blankNode({prompt:'B',order:1,dependsOn:[a.id],env:{FAKE_NAME:'B',FAKE_TRACE:trace}});
  let tree=await s.create([a,b]);
  const first=await s.request('/api/trees/'+tree.id+'/run','POST',{next:'task'});
  assert.equal(first.status,201);await waitFor(()=>s.state(first.data.id)?.status==='succeeded');
  delete s.app.store.data.runs[0].taskDefinitions;s.app.store.save();
  tree.nodes[1].prompt='B revised';tree=(await s.request('/api/trees/'+tree.id,'PUT',tree)).data;
  await s.restart();
  const apiState=(await s.request('/api/state')).data;
  assert.equal(require('../public/next-execution.js').executionProgress(tree,apiState.runs)[a.id].status,'succeeded');
  const second=await s.request('/api/trees/'+tree.id+'/run','POST',{next:'task'});
  assert.equal(second.status,201,JSON.stringify(second.data));await waitFor(()=>s.state(second.data.id)?.status==='succeeded');
  assert.equal(fs.readFileSync(trace,'utf8'),'A\nB\n');
  tree.nodes[0].criteria='new condition';tree=(await s.request('/api/trees/'+tree.id,'PUT',tree)).data;
  const progress=require('../public/next-execution.js').executionProgress(tree,(await s.request('/api/state')).data.runs);
  assert.equal(progress[a.id],undefined);assert.equal(progress[b.id],undefined);
});

test('manual labels persist on finished results, preserve AI evidence and block next tasks until completed', async t => {
 const s=await setup(t),a=blankNode({prompt:'A'}),b=blankNode({prompt:'B',order:1,dependsOn:[a.id]});
 const tree=await s.create([a,b]);
 const run=(await s.request('/api/trees/'+tree.id+'/run','POST',{next:'task'})).data;
 await waitFor(()=>s.state(run.id)?.status==='succeeded');const response=s.state(run.id).nodes[a.id].response;
 for(const outcome of ['error','unexpected','needs_review','completed']) {
  const r=await s.request('/api/runs/'+run.id+'/label','POST',{nodeId:a.id,outcome,note:'human checked'});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(s.state(run.id).nodes[a.id].outcome,outcome);
  assert.equal(s.state(run.id).nodes[a.id].response,response);
 }
 await s.restart();assert.equal(s.state(run.id).nodes[a.id].manualLabel.source,'user');assert.equal(s.state(run.id).nodes[a.id].labelHistory.length,4);
 const progress=require('../public/next-execution.js');assert.equal(progress.nextExecution(tree,progress.executionProgress(tree,(await s.request('/api/state')).data.runs)).task.id,b.id);
 assert.equal((await s.request('/api/runs/'+run.id+'/label','POST',{nodeId:a.id,outcome:'invalid'})).status,400);
});

test('manual labelling safely migrates an older idle review worker without rerunning the task',async t=>{
 const s=await setup(t), a=blankNode({prompt:'A'}), tree=await s.create([a],{completionMode:'manual'});
 const run=(await s.request('/api/trees/'+tree.id+'/run','POST',{next:'task'})).data;
 await waitFor(()=>s.state(run.id)?.status==='review');
 const old=s.state(run.id);delete old.manualLabelVersion;atomic(path.join(s.dir,'runs',run.id,'state.json'),old);
 const result=await s.request('/api/runs/'+run.id+'/label','POST',{nodeId:a.id,outcome:'completed'});
 assert.equal(result.status,200,JSON.stringify(result.data));assert(result.data.message);
 assert.equal(s.state(run.id).status,'succeeded');assert.equal(s.state(run.id).nodes[a.id].response,old.nodes[a.id].response);
});

test('API protects cross-origin writes and optimistic revisions', async t => {
  const s = await setup(t);
  assert.equal((await s.request('/api/trees', 'POST', {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await s.request('/api/trees', 'POST', {}, { 'X-Work-Tree-Token': '' })).status, 403);
  const tree = await s.create([blankNode({ prompt: 'hello' })]);
  const update = await s.request('/api/trees/' + tree.id, 'PUT', { ...tree, name: 'Changed' }); assert.equal(update.status, 200);
  assert.equal((await s.request('/api/trees/' + tree.id, 'PUT', tree)).status, 409);
  assert.equal((await s.request('/api/machines', 'POST', { name: 'bad', host: 'x;ls', port: 22, nodePath: 'node', codexPath: 'codex', claudePath: 'claude' })).status, 400);
  assert.throws(() => createApp({ dataDir: s.dir, port: 0 }), /起動中/);
});
test('detached runner continues after API closes, respects review gate, resumes in order', async t => {
  const s = await setup(t), trace = path.join(s.dir, 'trace');
  const a = blankNode({ title: 'A', prompt: 'first', order: 0, reviewRequired: true, env: { FAKE_NAME: 'A', FAKE_TRACE: trace } });
  const b = blankNode({ title: 'B', prompt: 'second', order: 1, tool: 'claude', dependsOn: [a.id], env: { FAKE_NAME: 'B', FAKE_TRACE: trace } });
  const tree = await s.create([a, b]); const start = await s.request('/api/trees/' + tree.id + '/run', 'POST', {}); assert.equal(start.status, 201);
  const run = start.data; assert.equal((await s.request('/api/trees/' + tree.id + '/run', 'POST', {})).status, 409);
  assert.equal((await s.request('/api/trees/' + tree.id, 'PUT', tree)).status, 409);
  await s.restart();
  const review = await waitFor(() => s.state(run.id)?.status === 'review' && s.state(run.id));
  assert.equal(review.currentNodeId, a.id); assert.equal(review.nodes[b.id].status, 'pending');
  await s.request('/api/runs/' + run.id + '/control', 'POST', { action: 'pause' }); await delay(600);
  assert.equal(s.state(run.id).status, 'review', 'pause must not hide the approval gate');
  await s.request('/api/runs/' + run.id + '/control', 'POST', { action: 'resume' }); await delay(600);
  assert.equal((await s.request('/api/runs/' + run.id + '/control', 'POST', { action: 'approve', nodeId: b.id })).status, 400);
  await s.request('/api/runs/' + run.id + '/control', 'POST', { action: 'approve', nodeId: a.id });
  await waitFor(() => s.state(run.id)?.status === 'succeeded');
  assert.equal(fs.readFileSync(trace, 'utf8'), 'A\nB\n'); assert.match(s.state(run.id).nodes[b.id].response, /完了/);
});
test('shared execution directory cannot run two trees concurrently', async t => {
  const s = await setup(t);
  const one = await s.create([blankNode({ prompt: 'one', env: { FAKE_DELAY: '1500' } })]);
  const two = await s.create([blankNode({ prompt: 'two' })]);
  const r = (await s.request('/api/trees/' + one.id + '/run', 'POST', {})).data;
  assert.equal((await s.request('/api/trees/' + two.id + '/run', 'POST', {})).status, 400);
  await waitFor(() => s.state(r.id)?.status === 'succeeded');
});
test('node execution includes transitive dependencies and ancestor prompts, without running siblings', async t => {
  const s = await setup(t), trace = path.join(s.dir, 'trace');
  const group = blankNode({ title: 'Context', kind: 'group', prompt: 'Shared instruction' });
  const a = blankNode({ title: 'A', prompt: 'first', order: 0, parentId: group.id, env: { FAKE_NAME: 'A', FAKE_TRACE: trace } });
  const b = blankNode({ title: 'B', prompt: 'second', order: 1, dependsOn: [a.id], env: { FAKE_NAME: 'B', FAKE_TRACE: trace } });
  const c = blankNode({ title: 'C', prompt: 'third', order: 2, dependsOn: [b.id], reviewRequired: true, env: { FAKE_NAME: 'C', FAKE_TRACE: trace } });
  const unrelated = blankNode({ title: 'Unrelated', prompt: '', order: 3 });
  const tree = await s.create([group, a, b, c, unrelated]);
  assert.equal((await s.request('/api/trees/' + tree.id + '/run', 'POST', { nodeId: 'missing' })).status, 400);
  assert.equal((await s.request('/api/trees/' + tree.id + '/run', 'POST', { nodeId: c.id, resume: true })).status, 400);
  const start = await s.request('/api/trees/' + tree.id + '/run', 'POST', { nodeId: c.id });
  assert.equal(start.status, 201, JSON.stringify(start.data));
  const run = start.data;
  assert.equal(run.kind, 'node'); assert.equal(run.nodeId, c.id);
  const snapshot = read(path.join(s.dir, 'runs', run.id, 'input.json')).tree;
  assert.deepEqual(snapshot.nodes.map(n => n.id), [group.id, a.id, b.id, c.id]);
  assert.equal(s.app.store.data.trees.find(t => t.id === tree.id).nodes.length, 5);
  const other = await s.create([blankNode({ prompt: 'conflicting task' })]);
  assert.equal((await s.request('/api/trees/' + other.id + '/run', 'POST', {})).status, 400);
  await waitFor(() => s.state(run.id)?.status === 'review');
  assert.equal(fs.readFileSync(trace, 'utf8'), 'A\nB\nC\n');
  assert.match(s.state(run.id).nodes[a.id].response, /Shared instruction/);
  assert.equal((await s.request('/api/trees/' + tree.id, 'PUT', tree)).status, 409);
  assert.equal((await s.request('/api/runs/' + run.id + '/control', 'POST', { action: 'approve', nodeId: c.id })).status, 200);
  await waitFor(() => s.state(run.id)?.status === 'succeeded');
  // A partial execution must never become the resume baseline of a full tree.
  assert.equal((await s.request('/api/trees/' + tree.id + '/run', 'POST', { resume: true })).status, 400);
});
test('SSH coordinator rejects tasks targeting the sleeping local PC', async t => {
  const s = await setup(t);
  const remote = (await s.request('/api/machines', 'POST', { name: 'SSH', host: 'test.invalid', port: 22, nodePath: 'node', codexPath: 'codex', claudePath: 'claude' })).data;
  const tree = await s.create([blankNode({ prompt: 'test' })], { runnerId: remote.id });
  const result = await s.request('/api/trees/' + tree.id + '/run', 'POST', {});
  assert.equal(result.status, 400); assert.match(result.data.error, /SSH 常駐実行/);
});
test('failed run resumes without repeating successful tasks', async t => {
  const s = await setup(t), trace = path.join(s.dir, 'trace');
  const a = blankNode({ title: 'A', prompt: 'first', order: 0, env: { FAKE_NAME: 'A', FAKE_TRACE: trace } });
  const b = blankNode({ title: 'B', prompt: 'second', order: 1, dependsOn: [a.id], env: { FAKE_NAME: 'B', FAKE_TRACE: trace, FAKE_FAIL_ONCE: path.join(s.dir, 'once') } });
  const tree = await s.create([a, b]); let r = (await s.request('/api/trees/' + tree.id + '/run', 'POST', {})).data;
  await waitFor(() => s.state(r.id)?.status === 'failed'); assert.equal(s.state(r.id).nodes[a.id].status, 'succeeded');
  r = (await s.request('/api/trees/' + tree.id + '/run', 'POST', { resume: true })).data;
  await waitFor(() => s.state(r.id)?.status === 'succeeded'); assert.equal(fs.readFileSync(trace, 'utf8'), 'A\nB\nB\n');
});
test('pause waits for current task, resume advances, stop kills active child', async t => {
  const s = await setup(t);
  const a = blankNode({ title: 'A', order: 0, prompt: 'one', env: { FAKE_DELAY: '1300' } }), b = blankNode({ title: 'B', order: 1, prompt: 'two', env: { FAKE_DELAY: '10000' } });
  const tree = await s.create([a, b]), r = (await s.request('/api/trees/' + tree.id + '/run', 'POST', {})).data;
  await waitFor(() => s.state(r.id)?.nodes[a.id]?.status === 'running');
  await s.request('/api/runs/' + r.id + '/control', 'POST', { action: 'pause' });
  await waitFor(() => s.state(r.id)?.status === 'paused'); assert.equal(s.state(r.id).nodes[a.id].status, 'succeeded'); assert.equal(s.state(r.id).nodes[b.id].status, 'pending');
  await s.request('/api/runs/' + r.id + '/control', 'POST', { action: 'resume' }); await waitFor(() => s.state(r.id)?.nodes[b.id]?.status === 'running');
  const stoppedAt = Date.now();
  const stop = await s.request('/api/runs/' + r.id + '/control', 'POST', { action: 'stop' }); assert.equal(stop.status, 200, JSON.stringify(stop.data)); await waitFor(() => s.state(r.id)?.status === 'cancelled');
  assert(Date.now() - stoppedAt < 5000, 'stop must actually terminate the child promptly');
  assert.equal(s.state(r.id).nodes[b.id].status, 'cancelled');
});
test('AI plan import validates output and is idempotent', async t => {
  const s = await setup(t), nid = id(), rid = id();
  const plan = { name: 'Generated', nodes: [{ id: 'a', title: 'Inspect', kind: 'task', prompt: 'Inspect files' }] };
  const inputTree = blankTree({ cwd: s.dir, nodes: [blankNode({ id: nid })] });
  const run = { id: rid, kind: 'plan', treeId: inputTree.id, treeRevision: 1, runner: { id: 'local', type: 'local' }, createdAt: new Date().toISOString() };
  s.app.store.data.runs.push(run); s.app.store.save();
  atomic(path.join(s.dir, 'runs', rid, 'input.json'), { tree: inputTree }); atomic(path.join(s.dir, 'runs', rid, 'state.json'), { status: 'succeeded', nodes: { [nid]: { status: 'succeeded', response: JSON.stringify(plan) } } });
  const first = await s.request('/api/runs/' + rid + '/import', 'POST', {}), second = await s.request('/api/runs/' + rid + '/import', 'POST', {});
  assert.equal(first.status, 201); assert.equal(second.data.id, first.data.id); assert.equal(first.data.cwd, s.dir);
});
test('AI generation endpoint runs a read-only planner then imports an editable tree', async t => {
  const s = await setup(t);
  const brief = { purpose: 'CSV を整理する', current: '未実装', flow: '調査、実装、検証', criteria: '変換を検証', constraints: '元データを保持' };
  const result = await s.request('/api/generate', 'POST', { tool: 'codex', machineId: 'local', cwd: s.dir, brief, prompt: 'CSV を整理するツールを計画する' });
  assert.equal(result.status, 201);
  const run = result.data;
  await waitFor(() => s.state(run.id)?.status === 'succeeded');
  const input = read(path.join(s.dir, 'runs', run.id, 'input.json'));
  assert.equal(input.tree.nodes[0].sandbox, 'read-only');
  assert.equal(input.tree.nodes[0].claudePermission, 'plan');
  const imported = await s.request('/api/runs/' + run.id + '/import', 'POST', {});
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  assert.equal(imported.data.name, 'AI Generated Fixture');
  assert.deepEqual(imported.data.brief, brief);
  assert.equal(imported.data.nodes[1].parentId, imported.data.nodes[0].id);
});
test('Orca SSH tree generation submits its prompt in background and preserves execution settings on import', async t => {
  const s=await setup(t);
  const orca={projectId:'project:test',hostId:'ssh:offline',worktreeId:'remote:/repo',path:'/remote/repo',notificationMode:'manual'};
  const settings={name:'SSH plan',tool:'codex',executionBackend:'orca',orca,cwd:'',cli:{codex:{model:'selected-model'}},attachments:[{name:'remote note',path:'/remote/note.md',kind:'file'}]};
  const result=await s.request('/api/generate','POST',{...settings,prompt:'CSV を検証するタスクを作成'});
  assert.equal(result.status,201,JSON.stringify(result.data)); assert.equal(result.data.executionBackend,'direct');
  await waitFor(()=>s.state(result.data.id)?.status==='succeeded');
  const input=read(path.join(s.dir,'runs',result.data.id,'input.json'));
  assert.equal(input.tree.runnerId,'local'); assert.equal(input.tree.cwd,process.cwd());
  assert.match(input.tree.nodes[0].prompt,/CSV を検証するタスクを作成/); assert.equal(input.tree.nodes[0].sandbox,'read-only');
  assert.equal(input.tree.cli.codex.model,'selected-model'); assert.equal(input.tree.orca,undefined);
  const imported=await s.request('/api/runs/'+result.data.id+'/import','POST',{});
  assert.equal(imported.status,201,JSON.stringify(imported.data));
  assert.equal(imported.data.executionBackend,'orca'); assert.deepEqual(imported.data.orca,orca);
  assert.deepEqual(imported.data.attachments,settings.attachments); assert.equal(imported.data.name,settings.name);
});
test('executor accepts literal prompts, reports nonzero exit and enforces timeout', async t => {
  const dir = fs.mkdtempSync(path.join(testRoot, 'executor-')), machine = { codexPath: fixture, claudePath: fixture };
  const c = { ...blankNode(), tool: 'codex', cwd: dir, timeoutMinutes: 1 };
  const r = await runAgent(c, machine, 'literal $(bad) `bad` ; & 日本語'); assert.match(r.response, /literal \$\(bad\)/);
  await assert.rejects(runAgent({ ...c, env: { FAKE_FAIL: '1' } }, machine, 'test'), /終了コード 2/);
  await assert.rejects(runAgent({ ...c, env: { FAKE_HOME_ERROR: '1' } }, machine, 'test'), /通常ユーザー/);
  const started = Date.now();
  await assert.rejects(runAgent({ ...c, timeoutMinutes: 0.002, env: { FAKE_DELAY: '10000' } }, machine, 'test'), /制限時間/);
  assert(Date.now() - started < 5000, 'timeout must terminate the child promptly');
});
test('CLI checks retain warnings on stderr even if version command exits successfully', async () => {
  const result = await capture(process.execPath, ['-e', 'console.log("codex-cli fixture"); console.error("Could not find home directory")'], '', 5000, { includeStderr: true });
  assert.match(result, /codex-cli fixture/); assert.match(result, /Could not find home directory/);
});
function script(source, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d); child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))); child.stdin.end(JSON.stringify(payload));
  });
}
test('remote deployment bundle runs independently and exposes durable status', async () => {
  // Exercise the exact uploaded code and detached worker with an isolated home;
  // SSH transport/network/authentication itself requires an actual remote host.
  const home = fs.mkdtempSync(path.join(testRoot, 'remote-')), rid = id(), mid = 'ssh-test';
  const env = { HOME: home, USERPROFILE: home }, node = blankNode({ prompt: 'remote task', cli: { codex: { effort: 'high' } }, attachments: [{ id: id(), name: 'remote.txt', kind: 'file', data: Buffer.from('remote attachment').toString('base64') }], env: { FAKE_DELAY: '150', FAKE_CAPTURE: path.join(home, 'capture.json') } });
  const tree = blankTree({ cwd: home, machineId: mid, runnerId: mid, nodes: [node] });
  const input = { id: rid, kind: 'tree', tree, runnerId: mid, machines: [{ id: mid, name: 'Remote fixture', type: 'ssh', codexPath: fixture, claudePath: fixture }] };
  const launched = await script(BOOTSTRAP, { id: rid, input, files: files() }, env); assert(launched.pid > 0);
  const result = await waitFor(async () => { const r = await script(ACCESS, { id: rid, log: true, events: true, after: 0 }, env); return r.state?.status === 'succeeded' && r; });
  assert.match(result.log, /実行終了: succeeded/); assert.match(result.state.nodes[node.id].response, /完了/);
  assert(result.feed.events.some(e => e.type === 'user')); assert(result.feed.events.some(e => e.type === 'result'));
  const captured = read(path.join(home, 'capture.json')); assert(captured.args.includes('model_reasoning_effort="high"')); assert.match(captured.prompt, /remote.txt/);
  await assert.rejects(script(BOOTSTRAP, { id: rid, input, files: files() }, env), /already exists/);
});

test('uploaded attachments and CLI settings persist across restart and reach the detached worker', async t => {
  const s = await setup(t);
  const uploaded = await s.request('/api/attachments', 'POST', { name: '仕様書.txt', data: Buffer.from('実装の要件').toString('base64') });
  assert.equal(uploaded.status, 201); assert.equal(uploaded.data.data, undefined);
  assert.equal((await s.request('/api/attachments', 'POST', { name: 'bad', data: '!' })).status, 400);
  const captureFile = path.join(s.dir, 'capture.json');
  const tree = await s.create([blankNode({ prompt: 'read attached', cli: { codex: { effort: 'high' } }, env: { FAKE_CAPTURE: captureFile } })], { cli: { codex: { model: 'tree-model' } }, attachments: [uploaded.data] });
  await s.restart();
  const run = (await s.request('/api/trees/' + tree.id + '/run', 'POST', {})).data;
  await waitFor(() => s.state(run.id)?.status === 'succeeded');
  const captured = read(captureFile); assert(captured.args.includes('tree-model')); assert(captured.args.includes('model_reasoning_effort="high"')); assert.match(captured.prompt, /仕様書/);
  const snapshot = read(path.join(s.dir, 'runs', run.id, 'input.json'));
  assert.equal(Buffer.from(snapshot.tree.attachments[0].data, 'base64').toString(), '実装の要件');
  const state = (await s.request('/api/state')).data;
  assert.equal(state.trees.find(t => t.id === tree.id).attachments[0].data, undefined);
});

test('planner forces planning permissions while import retains user CLI defaults and attachments', async t => {
  const s = await setup(t);
  const attached = (await s.request('/api/attachments', 'POST', { name: 'notes.txt', data: 'bm90ZXM=' })).data;
  const cli = { codex: { model: 'selected', effort: 'high', approval: 'auto-review', sandbox: 'workspace-write', mode: 'task' } };
  const started = await s.request('/api/generate', 'POST', { prompt: '日本語の計画', name: '指定した名前', description: '作成時の説明', timeoutMinutes: 42, cwd: s.dir, cli, attachments: [attached] });
  assert.equal(started.status, 201);
  const run = started.data;
  await waitFor(() => s.state(run.id)?.status === 'succeeded');
  const snapshot = read(path.join(s.dir, 'runs', run.id, 'input.json')).tree;
  const config = require('../lib/core.cjs').configFor(snapshot, snapshot.nodes[0]);
  const args = require('../lib/cli-options.cjs').cliArgs(config);
  assert(args.includes('read-only')); assert(!args.includes('--approve-for-me')); assert.equal(config.options.model, 'selected');
  const imported = await s.request('/api/runs/' + run.id + '/import', 'POST', {});
  assert.equal(imported.status, 201); assert.deepEqual(imported.data.cli, cli); assert.deepEqual(imported.data.attachments, [attached]);
  assert.equal(imported.data.name, '指定した名前'); assert.equal(imported.data.description, '作成時の説明'); assert.equal(imported.data.timeoutMinutes, 42);
  const catalog = await s.request('/api/cli-defaults'); assert.equal(catalog.status, 200); assert.equal(catalog.data.defaults.codex.approval, 'never');
});

test('chat emits live public events, persists them, and carries prior answers into follow-up', async t => {
  const s = await setup(t), capture = path.join(s.dir, 'chat-capture.json');
  const node = blankNode({ prompt: '最初の作業', env: { FAKE_EVENTS: '1', FAKE_DELAY: '600', FAKE_CAPTURE: capture } });
  const tree = await s.create([node]);
  const run = (await s.request('/api/trees/' + tree.id + '/run', 'POST', {})).data;
  const live = await waitFor(async () => { const r = await s.request('/api/runs/' + run.id + '/events'); return r.data.events.some(e => e.type === 'tool') && r.data; });
  assert(live.events.some(e => e.type === 'user' && e.text === node.prompt));
  assert.equal(s.state(run.id).status, 'running');
  await waitFor(() => s.state(run.id)?.status === 'succeeded'); await s.restart();
  const rest = (await s.request('/api/runs/' + run.id + '/events?after=' + live.cursor)).data;
  assert(rest.events.some(e => e.type === 'result'));
  const follow = await s.request('/api/trees/' + tree.id + '/chat', 'POST', { nodeId: node.id, message: '結果に検証を追加してください' });
  assert.equal(follow.status, 201); assert.equal(follow.data.kind, 'chat');
  assert.equal((await s.request('/api/trees/' + tree.id + '/chat', 'POST', { nodeId: node.id, message: '重複' })).status, 409);
  await waitFor(() => s.state(follow.data.id)?.status === 'succeeded');
  const prompt = read(capture).prompt; assert.match(prompt, /結果に検証を追加/); assert.match(prompt, /これまでの会話/); assert.match(prompt, /完了: test/);
  assert.equal(s.app.store.data.trees.find(t => t.id === tree.id).nodes[0].prompt, node.prompt);
  assert.equal((await s.request('/api/runs/' + run.id + '/events?after=-1')).status, 400);
});

test('Notion execution fetches remote plan, blocks offline launch and retries durable result delivery', async t => {
  const mock = require('./fixtures/notion-api.cjs').fixture();
  const { rich, plain } = require('../lib/notion.cjs');
  const s = await setup(t, { fetchImpl: mock.fetch, interval: 0 });
  const node = blankNode({ prompt: '初期依頼', env: { FAKE_CAPTURE: path.join(s.dir, 'notion-capture.json') } });
  const tree = await s.create([node]);
  await s.request('/api/notion', 'PUT', { sourceId: mock.source, token: 'fixture-secret' });
  assert.equal((await s.request('/api/trees/' + tree.id + '/notion-push', 'POST', {})).status, 200);
  mock.rows.find(r => plain(r.properties['WT Key']) === tree.id + ':' + node.id).properties.Prompt = rich('Notion から最新の作業');
  mock.offline = true;
  assert.equal((await s.request('/api/trees/' + tree.id + '/run', 'POST', {})).status, 400); assert.equal(s.app.store.data.runs.length, 0);
  mock.offline = false;
  const run = (await s.request('/api/trees/' + tree.id + '/run', 'POST', {})).data;
  await waitFor(() => s.state(run.id)?.status === 'succeeded');
  assert.match(read(path.join(s.dir, 'notion-capture.json')).prompt, /Notion から最新の作業/);
  assert(!JSON.stringify(read(path.join(s.dir, 'runs', run.id, 'input.json'))).includes('fixture-secret'));
  mock.offline = true; await s.app.notion.syncResults(s.app.store);
  assert.equal(s.app.notion.status().pending, 1); await s.restart(); mock.offline = false;
  for (const job of Object.values(s.app.notion.outbox)) job.retryAt = null;
  await s.app.notion.syncResults(s.app.store); assert.equal(s.app.notion.status().pending, 0);
  assert.equal(mock.rows.filter(r => r.properties.Kind.select.name === 'Result').length, 1);
  const pulled = await s.request('/api/trees/' + tree.id + '/notion-pull', 'POST', {}); assert.equal(pulled.status, 200); assert.match(pulled.data.notionContext[0].result, /完了/);
  assert(!JSON.stringify((await s.request('/api/notion')).data).includes('fixture-secret'));
});

test('local execution rejects missing directories before recording or dispatching a run', async t => {
  const s = await setup(t);
  const node = blankNode({ title: 'Invalid task', prompt: 'Do not execute' });
  const tree = await s.create([node], { cwd: path.join(s.dir, 'missing') });
  const result = await s.request('/api/trees/' + tree.id + '/run', 'POST', { nodeId: node.id });
  assert.equal(result.status, 400);
  assert.match(result.data.error, /作業ディレクトリが見つかりません: Invalid task/);
  assert.equal(s.app.store.data.runs.length, 0);
});
test('WSL node execution translates local Windows paths only in the execution snapshot', { skip: !require('../lib/local-path.cjs').isWSL || !/^\/mnt\/[a-z]\//i.test(testRoot) }, async t => {
  const s = await setup(t);
  const windowsCwd = s.dir[5].toUpperCase() + ':\\' + s.dir.slice(7).replaceAll('/', '\\');
  const node = blankNode({ title: 'Windows path', prompt: 'Fixture only', cwd: windowsCwd });
  const tree = await s.create([node], { cwd: windowsCwd });
  const result = await s.request('/api/trees/' + tree.id + '/run', 'POST', { nodeId: node.id });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  await waitFor(() => s.state(result.data.id)?.status === 'succeeded');
  const input = read(path.join(s.dir, 'runs', result.data.id, 'input.json'));
  assert.equal(input.tree.nodes[0].cwd, s.dir);
  assert.equal(s.app.store.data.trees.find(t => t.id === tree.id).nodes[0].cwd, windowsCwd);
});

for (const backend of ['direct','orca']) test('AI edit proposals persist, preview changes, reject stale application and preserve execution settings: '+backend, async t => {
  const s = await setup(t), a=blankNode({prompt:'first',cli:{codex:{model:'keep-model'}},env:{PRIVATE:'keep'}}), outside=blankNode({prompt:'outside',order:2});
  let tree=await s.create([a,outside], {executionBackend:backend});
  const generate=async()=>{
    const r=await s.request('/api/trees/'+tree.id+'/proposals','POST',{revision:tree.revision,scope:'branch',nodeId:a.id,request:'原因調査と再検証を追加'});
    assert.equal(r.status,201,JSON.stringify(r.data));
    return await waitFor(async()=>{const p=(await s.request('/api/state')).data.proposals.find(p=>p.id===r.data.id);if(p.status==='failed')throw Error(p.error);return p.status==='ready'&&p;});
  };
  const p=await generate(); assert.equal(p.changes.length,1); assert(!p.baseTree);
  assert.equal(s.app.store.data.trees.find(x=>x.id===tree.id).nodes[0].title,a.title,'generation must not edit the tree');
  await s.restart();
  const applied=await s.request('/api/proposals/'+p.id+'/apply','POST',{}); assert.equal(applied.status,200,JSON.stringify(applied.data));tree=applied.data.tree;
  assert.equal(tree.revision,2); const edited=tree.nodes.find(n=>n.id===a.id); assert.equal(edited.cli.codex.model,'keep-model');assert.equal(edited.env.PRIVATE,'keep');assert.deepEqual(tree.nodes.find(n=>n.id===outside.id),outside);
  const twice=await s.request('/api/proposals/'+p.id+'/apply','POST',{});assert.equal(twice.data.tree.revision,2,'apply is idempotent');
  const stale=await generate();
  tree=(await s.request('/api/trees/'+tree.id,'PUT',{...tree,name:'manual edit'})).data;
  assert.equal((await s.request('/api/proposals/'+stale.id+'/apply','POST',{})).status,400);
  assert.equal((await s.request('/api/proposals/'+stale.id+'/dismiss','POST',{})).status,200);
  const declined=(await s.request('/api/state')).data.proposals.find(p=>p.id===stale.id);assert.equal(declined.status,'dismissed');
});
test('failed TASK automatically gets one durable downstream proposal without changing the tree',async t=>{
  const s=await setup(t),a=blankNode({prompt:'fails',env:{FAKE_FAIL:'1'}}),b=blankNode({prompt:'next',dependsOn:[a.id],order:1});
  const tree=await s.create([a,b]),run=(await s.request('/api/trees/'+tree.id+'/run','POST',{})).data;
  await waitFor(()=>s.state(run.id)?.status==='failed');assert.equal(s.state(run.id).nodes[a.id].outcome,'error');assert.equal(s.state(run.id).nodes[b.id].status,'pending');
  const proposal=await waitFor(async()=>{const p=(await s.request('/api/state')).data.proposals.find(p=>p.sourceRunId===run.id);if(p?.status==='failed')throw Error(p.error);return p?.status==='ready'&&p;});
  assert.deepEqual(new Set(proposal.scopeIds),new Set([a.id,b.id]));
  assert.equal(s.app.store.data.trees.find(t=>t.id===tree.id).revision,1);
  await s.request('/api/proposals/'+proposal.id+'/dismiss','POST',{});await s.restart();await delay(1200);
  assert.equal((await s.request('/api/state')).data.proposals.filter(p=>p.sourceRunId===run.id).length,1);
});
