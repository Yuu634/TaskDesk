'use strict';
const { submittedPrompt } = require('../lib/orca-execution.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { blankTree, blankNode, configFor, validateTree, atomic, read, ACTIVE } = require('../lib/core.cjs');
const { discover, resolveTarget, prepareTree } = require('../lib/orca.cjs');
const { launchInput, runInOrca } = require('../lib/orca-execution.cjs');
const { catalog, respond } = require('./fixtures/fake-orca.cjs');
const { createApp } = require('../server.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
function judgeFixture(prepared, action, c, outcome = 'completed') {
  const child = { ...c, token: 'judge-token', attemptId: 'judge-attempt', dir: '/fixture' };
  if (action === 'prepare-pane') return { context: child, prompt: 'judge prompt' };
  if (prepared.context.token !== child.token) return null;
  return { ready: true, events: [{ ...child, rootSession: true, threadId: 'judge-thread', turnId: 'judge-turn', response: JSON.stringify({ criteria: [{ id: 1, status: outcome === 'completed' ? 'met' : 'unknown', evidence: 'fixture evidence' }] }), inputMessages: ['judge prompt'] }], activity: { supported: true, completed: true, turnId: 'judge-turn', fingerprint: 'judge-fingerprint' } };
}
test('prompt matching tolerates only leading terminal colour replies', () => {
  assert.equal(submittedPrompt(']10;rgb:ffff/ffff/ffff\\]11;rgb:2828/2c2c/3434\\prompt'), 'prompt');
  assert.equal(submittedPrompt('\x1b]10;rgb:ffff/ffff/ffff\x1b\\prompt'), 'prompt');
  assert.equal(submittedPrompt('other prompt'), 'other prompt');
  assert.equal(submittedPrompt('title: prompt'), 'title: prompt');
  assert.equal(submittedPrompt(']10;not-a-colour\\prompt'), ']10;not-a-colour\\prompt');
});
const selection = i => { const w = catalog.worktrees[i]; return { projectId: w.projectId, hostId: w.hostId, worktreeId: w.id, identityKey: w.identity.key, notificationMode: 'manual' }; };
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'work-tree-orca-test-'));
async function until(fn, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { const r = await fn(); if (r) return r; await delay(20); } throw Error('Test timed out'); }
function setup(t, tool = 'codex', behavior = {}) {
  const dir = temp(), state = {}, calls = [], data = structuredClone(catalog);
  const node = blankNode({ tool, prompt: '日本語の指示', cli: { [tool]: { model: 'node-model', effort: 'high' } } });
  const tree = blankTree({ executionBackend: 'orca', orca: selection(1), nodes: [node] });
  const controller = new AbortController(); t.after(() => controller.abort());
  const invoke = async (target, args, launch) => {
    calls.push(args);
    let result = respond(args, state, data, launch);
    if (behavior.modify) result = await behavior.modify(args, result, state);
    return structuredClone(result);
  };
  const context = { target: { runtimeId: 'runtime-fixture' }, nodes: { [node.id]: resolveTarget(tree.orca, data) }, runDir: dir, runId: 'test-run', pollMs: 5, invoke };
  return { dir, state, calls, data, node, tree, context, config: configFor(tree, node), controller };
}
test('Orca target inheritance uses project, host and identity together; stale and disconnected targets fail', async t => {
  const s = setup(t), local = blankNode({ orca: selection(0) }); s.tree.nodes.push(local);
  validateTree(s.tree, [{ id: 'local' }]);
  const prepared = await prepareTree(s.tree, {}, s.context.invoke);
  assert.equal(prepared.nodes[s.node.id].path, '/mnt/repo');
  assert.equal(prepared.nodes[local.id].path, 'C:/repo');
  assert.throws(() => resolveTarget({ ...selection(0), hostId: 'ssh:fixture' }, catalog), /所属/);
  assert.throws(() => resolveTarget({ ...selection(1), identityKey: 'replaced' }, catalog), /所属/);
  s.data.hosts[1].connected = false;
  await assert.rejects(prepareTree(s.tree, {}, s.context.invoke), /未接続/);
  assert(!s.calls.some(a => a[1] === 'create'));
});
for (const tool of ['codex', 'claude']) test(tool + ' routes to SSH, sends literal prompt once and only completes after explicit review', async t => {
  const s = setup(t, tool), phases = [], prompt = 'Literal $(never) `no` 日本語\n複数行'; let settled = false;
  const pending = runInOrca(s.context, s.config, prompt, { signal: s.controller.signal, onInteractive: v => phases.push(v) }).then(value => { settled = true; return value; });
  await until(() => phases.at(-1)?.phase === 'ready');
  assert.equal(settled, false);
  const sends = s.calls.filter(a => a[1] === 'send'); assert.equal(sends.length, 1); assert.equal(sends[0][sends[0].indexOf('--text') + 1], prompt);
  assert.equal(phases.at(-1).hostId, 'ssh:fixture');
  atomic(path.join(s.dir, 'control.json'), { id: 'complete', action: 'complete', nodeId: s.node.id, response: '検証完了' });
  assert.equal((await pending).response, '検証完了');
  assert(!s.calls.some(a => a[1] === 'close'));
  await assert.rejects(runInOrca(s.context, s.config, prompt), /起動済み/);
});
test('startup argument delivery works without Orca agent identity and never types the work prompt', async t => {
  const s = setup(t, 'codex', { modify(args, result) { if (args[1] === 'show') delete result.terminal.agentIdentity; return result; } });
  const c = { token: 'token', attemptId: 'attempt', runId: 'test-run', nodeId: s.node.id, hostId: 'ssh:fixture', identityKey: 'wt2:ssh:1', startupPrompt: true };
  const event = { ...c, rootSession: true, key: 'c'.repeat(64), threadId: 'thread', turnId: 'turn', response: 'done', inputMessages: ['literal prompt'] };
  let assessed = false;
  s.context.notifications = { prepare: async (_, __, ids) => { assert.equal(ids.prompt, 'literal prompt'); return { context: c }; }, request: async (_, action) => {
    const judge = judgeFixture(_, action, c); if (judge) return judge;
    if (action === 'assess') assessed = true;
    return { ready: true, started: { token: c.token, pid: 123 }, events: [event], activity: { supported: true, completed: true, turnId: 'turn', fingerprint: 'stable' }, assessment: assessed ? { key: event.key, outcome: 'completed', detail: 'evidence', after: { fingerprint: 'stable' } } : null };
  } };
  s.config.criteria = '条件';
  const result = await runInOrca(s.context, s.config, 'literal prompt');
  assert.equal(result.outcome, 'completed');
  const sends = s.calls.filter(a => a[1] === 'send');
  assert.equal(sends.length, 0); assert.equal(s.calls.filter(a => a[1] === 'split').length, 1);
});

for (const outcome of ['completed', 'needs_review']) test('Orca automatically records final result: ' + outcome, async t => {
  const s = setup(t), c = { token: 'token', attemptId: 'attempt', runId: 'test-run', nodeId: s.node.id, hostId: 'ssh:fixture', identityKey: 'wt2:ssh:1' };
  const event = { ...c, rootSession: true, key: 'a'.repeat(64), threadId: 'thread', turnId: 'turn', response: 'verified result', inputMessages: ['fixture prompt'] };
  let verifyCount = 0;
  s.context.notifications = { prepare: async () => ({ context: c }), request: async (_, action) => {
    const judge = judgeFixture(_, action, c, outcome); if (judge) { if (action === 'prepare-pane') verifyCount++; return judge; }
    if (action === 'assess') { verifyCount++; return {}; }
    if (action === 'ack') return {};
    return { ready: true, events: s.calls.some(a => a[1] === 'send') ? [event, event] : [], activity: { supported: true, completed: true, turnId: 'turn', fingerprint: 'stable' }, assessment: verifyCount ? { key: event.key, outcome, detail: 'checks', after: { fingerprint: 'stable' } } : null };
  } };
  s.config.criteria = '結果を確認できる';
  const result = await runInOrca(s.context, s.config, 'fixture prompt');
  assert.equal(result.outcome, outcome); assert.equal(result.automatic, true);
  assert.match(result.response, /verified result/); assert.equal(verifyCount, 1);
  const sends = s.calls.filter(a => a[1] === 'send');
  assert.equal(sends.length, 1); assert.equal(s.calls.filter(a => a[1] === 'split').length, 1);
  assert.equal(s.calls.filter(a => a[1] === 'create').length, 1);
  assert(!s.calls.some(a => a[1] === 'close'));
});

for (const scenario of ['resumed-work', 'lost-split', 'reassess']) test('split assessment: ' + scenario, async t => {
  const s = setup(t, 'codex', { modify(args, result) { if (scenario === 'lost-split' && args[1] === 'split') throw Error('split acknowledgement lost'); return result; } });
  const c = { token: 'token', attemptId: 'attempt', runId: 'test-run', nodeId: s.node.id, hostId: 'ssh:fixture', identityKey: 'wt2:ssh:1' };
  const event = { ...c, rootSession: true, key: 'd'.repeat(64), threadId: 'thread', turnId: 'turn', response: 'work result', inputMessages: ['prompt'] };
  let childSeen = false;
  s.config.criteria = '条件';
  s.context.notifications = { prepare: async () => ({ context: c }), request: async (prepared, action) => {
    const judge = judgeFixture(prepared, action, c); if (judge) { if (action === 'collect') childSeen = true; return judge; }
    return { ready: true, events: [event], activity: { supported: true, completed: !(scenario === 'resumed-work' && childSeen), turnId: 'turn', fingerprint: 'stable' } };
  } };
  const result = await runInOrca(s.context, s.config, 'prompt');
  assert.equal(result.outcome, scenario === 'reassess' ? 'completed' : 'needs_review');
  assert.equal(s.calls.filter(a => a[1] === 'split').length, 1);
  assert(!s.calls.some(a => a.includes('/exit') || a[1] === 'close'));
  if (scenario === 'reassess') {
    const dir = temp();
    const second = await runInOrca({ ...s.context, runDir: dir, reassessment: result.reassessment }, s.config, 'unused');
    assert.equal(second.outcome, 'completed'); assert.equal(s.calls.filter(a => a[1] === 'split').length, 2);
    assert.equal(s.calls.filter(a => a[1] === 'send').length, 1); assert.equal(s.calls.filter(a => a[1] === 'create').length, 1);
  }
});

for (const scenario of ['missing-turn', 'new-turn', 'wrong-task', 'wrong-thread']) test('notification does not falsely complete: ' + scenario, async t => {
  const s = setup(t), c = { token: 'token', attemptId: 'attempt', runId: 'test-run', nodeId: s.node.id, hostId: 'ssh:fixture', identityKey: 'wt2:ssh:1' };
  const event = { ...c, rootSession: true, key: 'b'.repeat(64), threadId: 'thread', turnId: 'turn', response: 'Please clarify the requirement', inputMessages: ['prompt'] };
  if (scenario === 'wrong-task') event.nodeId = 'foreign';
  if (scenario === 'wrong-thread') event.inputMessages = ['some other prompt'];
  let lost = false, recovered = false, verified = false, settled = false;
  s.context.notifications = { prepare: async () => ({ context: c }), request: async (_, action) => {
    if (action === 'assess') { verified = true; return {}; }
    if (action !== 'collect') return {};
    const submitted = s.calls.some(a => a[1] === 'send');
    if (scenario === 'reconnect' && submitted && !lost) { lost = true; throw Error('Connection lost'); }
    if (lost) recovered = true;
    return { ready: true, events: submitted ? [event] : [], activity: { supported: scenario !== 'missing-turn', completed: scenario !== 'new-turn', turnId: scenario === 'new-turn' ? 'new' : 'turn', fingerprint: 'stable' } };
  } };
  if (!['no-verification', 'reconnect'].includes(scenario)) s.config.verification = { autoComplete: true };
  const phases = [];
  const pending = runInOrca(s.context, s.config, 'prompt', { signal: s.controller.signal, onInteractive: v => phases.push(v) }).then(r => { settled = true; return r; });
  await until(() => ['wrong-task', 'wrong-thread'].includes(scenario) ? phases.some(p => p.phase === 'ready') : phases.some(p => p.phase === 'confirmation'));
  await delay(30); assert.equal(settled, false); assert.equal(verified, false);
  if (scenario === 'reconnect') { assert(recovered); assert(phases.some(p => p.phase === 'reconnecting')); }
  atomic(path.join(s.dir, 'control.json'), { id: 'manual', action: 'complete', nodeId: s.node.id, response: 'manually reviewed' });
  assert.equal((await pending).confirmedByUser, true);
  assert.equal(s.calls.filter(a => a[1] === 'send').length, 1);
});

test('ambiguous delivery never resends or closes the conversation, and persists receipt', async t => {
  const s = setup(t, 'codex', { modify(args, result) { if (args[1] === 'send') { result.send.prompt.stages = ['input_accepted']; } return result; } });
  await assert.rejects(runInOrca(s.context, s.config, 'prompt'), /送信結果が不明/);
  const dispatch = read(path.join(s.dir, 'orca', s.node.id, 'dispatch.json'));
  assert.equal(dispatch.status, 'uncertain'); assert.equal(dispatch.receipt.requestId, 'request-1');
  assert.equal(s.calls.filter(a => a[1] === 'send').length, 1); assert(!s.calls.some(a => a[1] === 'close'));
});
test('lost create acknowledgement is never replayed', async t => {
  const s = setup(t, 'codex', { modify(args, result) { if (args[1] === 'create') throw Error('lost acknowledgement'); return result; } });
  await assert.rejects(runInOrca(s.context, s.config, 'prompt'), /lost acknowledgement/);
  await assert.rejects(runInOrca(s.context, s.config, 'prompt'), /起動済み/);
  assert.equal(s.calls.filter(a => a[1] === 'create').length, 1);
});
test('cancel closes only the created terminal; a replaced incarnation is never closed', async t => {
  for (const replace of [false, true]) {
    const s = setup(t), phases = [];
    const pending = runInOrca(s.context, s.config, 'prompt', { signal: s.controller.signal, onInteractive: v => phases.push(v) });
    const rejected = assert.rejects(pending, /停止|識別/);
    await until(() => phases.at(-1)?.phase === 'ready');
    if (replace) Object.values(s.state)[0].incarnationId = 'foreign';
    s.controller.abort(); await rejected;
    assert.equal(s.calls.filter(a => a[1] === 'close').length, replace ? 0 : 1);
  }
});
test('blocked startup does not receive a prompt; oversized prompts and uploads fail before creating a terminal', async t => {
  const s = setup(t, 'codex', { modify(args, result) { if (args[1] === 'wait') result.wait = { ...result.wait, satisfied: false, blockedReason: 'permission' }; return result; } });
  const phases = [], pending = runInOrca(s.context, s.config, 'prompt', { signal: s.controller.signal, onInteractive: v => phases.push(v) });
  const rejected = assert.rejects(pending, /停止/);
  await until(() => phases.at(-1)?.phase === 'startup-blocked'); assert(!s.calls.some(a => a[1] === 'send')); s.controller.abort(); await rejected;
  const fresh = setup(t);
  await assert.rejects(runInOrca(fresh.context, fresh.config, 'x'.repeat(24000)), /24000/);
  await assert.rejects(runInOrca(fresh.context, { ...fresh.config, attachments: [{ id: 'upload' }] }, 'prompt'), /アップロード/);
  assert(!fresh.calls.some(a => a[1] === 'create'));
});
test('target bootstrap preserves argv, environment, target cwd and MCP without shell evaluation', t => {
  const s = setup(t, 'claude'), output = path.join(s.dir, 'capture.json'), fixture = path.join(s.dir, 'capture.cjs');
  fs.writeFileSync(fixture, "const fs=require('fs');const args=process.argv.slice(2);fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args,cwd:process.cwd(),literal:process.env.LITERAL,mcp:JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config')+1],'utf8'))}));");
  s.config.env = { CAPTURE: output, LITERAL: '$(never) `no` "日本語"' };
  s.config.options.mcpServers = { example: { command: 'echo', args: ['$(literal)'] } };
  s.config.attachments = [{ path: '資料.txt', kind: 'file' }];
  const input = launchInput(s.config, { path: s.dir, platform: process.platform, executable: fixture }, 'prompt');
  const source = Buffer.from(input.command.match(/Buffer.from\('([^']+)'/)[1], 'base64').toString();
  execFileSync(process.execPath, ['-e', source], { timeout: 10000, env: { ...process.env, ...input.env } });
  const actual = read(output); assert.equal(actual.cwd, s.dir); assert.equal(actual.literal, s.config.env.LITERAL);
  assert(actual.args.includes('node-model')); assert(actual.args.includes('high')); assert.deepEqual(actual.mcp.mcpServers, s.config.options.mcpServers);
  assert(input.prompt.includes('資料.txt'));
});
test('HTTP discovery, detached worker, concurrency guard, focus and completion use Orca without a local cwd', async t => {
  const dir = temp(), previous = { ORCA_BIN: process.env.ORCA_BIN, ORCA_FAKE_FILE: process.env.ORCA_FAKE_FILE, ORCA_FAKE_RESULT: process.env.ORCA_FAKE_RESULT };
  process.env.ORCA_BIN = path.join(__dirname, 'fixtures', 'fake-orca.cjs'); process.env.ORCA_FAKE_FILE = path.join(dir, 'terminals.json');
  const app = createApp({ dataDir: path.join(dir, 'data'), port: 0 });
  const address = await app.listen(), base = 'http://127.0.0.1:' + address.port, token = (await (await fetch(base + '/api/session')).json()).token;
  const request = async (url, method = 'GET', body) => { const r = await fetch(base + url, { method, headers: { 'X-Work-Tree-Token': token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, value: await r.json() }; };
  t.after(async () => { for (const run of app.store.data.runs) if (ACTIVE.has(app.store.state(run).status)) atomic(path.join(app.store.runDir(run.id), 'control.json'), { id: 'stop', action: 'stop' }); await app.close(); for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  assert.equal((await request('/api/orca/targets')).value.worktrees.length, 2);
  const a = blankNode({ prompt: 'fixture only' }), b = blankNode({ prompt: 'local follow-up', order: 1, dependsOn: [a.id], orca: selection(0) });
  const tree = blankTree({ executionBackend: 'orca', orca: selection(1), nodes: [a, b] });
  const one = (await request('/api/trees', 'POST', tree)).value, two = (await request('/api/trees', 'POST', tree)).value;
  const starts = await Promise.all([one, two].map(t => request('/api/trees/' + t.id + '/run', 'POST', {})));
  assert.deepEqual(starts.map(r => r.status).sort(), [201, 400]);
  const run = starts.find(r => r.status === 201).value;
  await until(() => app.store.state(run).nodes?.[a.id]?.interactive?.phase === 'ready');
  assert.equal((await request('/api/orca/focus', 'POST', { runId: run.id, nodeId: a.id })).status, 200);
  assert.equal((await request('/api/runs/' + run.id + '/control', 'POST', { action: 'complete', nodeId: a.id, response: 'done' })).status, 200);
  await until(() => app.store.state(run).nodes?.[b.id]?.interactive?.phase === 'ready');
  assert.equal(app.store.state(run).nodes[a.id].status, 'succeeded');
  assert.equal(app.store.state(run).nodes[b.id].machineId, 'local');
  const sends = fs.readFileSync(process.env.ORCA_FAKE_FILE + '.calls', 'utf8').trim().split('\n').map(s => JSON.parse(s)).filter(args => args[1] === 'send');
  assert.equal(sends.length, 2); assert(sends[1][sends[1].indexOf('--text') + 1].includes('done'));
  assert.equal((await request('/api/runs/' + run.id + '/control', 'POST', { action: 'complete', nodeId: b.id, response: 'local done' })).status, 200);
  await until(() => app.store.state(run).status === 'succeeded');
  assert.equal(app.store.state(run).nodes[a.id].machineId, 'ssh:fixture');
  assert.equal(run.executionBackend, 'orca'); assert.equal(run.resultSuggestions, undefined);
  const plan = await request('/api/generate', 'POST', { prompt: 'fixture plan', name: 'Created on g15', executionBackend: 'orca', orca: selection(1), timeoutMinutes: 37 });
  assert.equal(plan.status, 201, JSON.stringify(plan.value));
  await until(() => Object.values(app.store.state(plan.value).nodes || {}).some(n => n.interactive?.phase === 'ready'));
  const planNode = app.store.state(plan.value).currentNodeId;
  await request('/api/runs/' + plan.value.id + '/control', 'POST', { action: 'complete', nodeId: planNode, response: JSON.stringify({ name: 'Plan', nodes: [{ id: 'task', kind: 'task', title: 'Task', prompt: 'fixture' }] }) });
  await until(() => app.store.state(plan.value).status === 'succeeded');
  const imported = await request('/api/runs/' + plan.value.id + '/import', 'POST', {});
  assert.equal(imported.status, 201, JSON.stringify(imported.value));
  assert.equal(imported.value.name, 'Created on g15'); assert.equal(imported.value.timeoutMinutes, 37);
  assert.equal(imported.value.executionBackend, 'orca'); assert.equal(imported.value.orca.hostId, 'ssh:fixture');
  const autoRun = await request('/api/trees/' + imported.value.id + '/run', 'POST', { next: 'task' });
  assert.equal(autoRun.status, 201, JSON.stringify(autoRun.value));
  await until(() => app.store.state(autoRun.value).nodes[imported.value.nodes[0].id]?.interactive?.phase === 'ready');
  await request('/api/runs/' + autoRun.value.id + '/control', 'POST', { action: 'complete', nodeId: imported.value.nodes[0].id, response: 'manual completion' });
  await until(() => app.store.state(autoRun.value).status === 'succeeded');
  assert.equal(app.store.state(autoRun.value).nodes[imported.value.nodes[0].id].outcome, 'completed');
});
