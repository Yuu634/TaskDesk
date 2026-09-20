'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { blankTree, blankNode, atomic, read, configFor, validateTree } = require('../lib/core.cjs');
const { label, runInHerdr, verifyPane } = require('../lib/herdr-execution.cjs');
const { HerdrBindings } = require('../lib/herdr-bindings.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wt-herdr-'));

function fakeHerdr() {
  const spaces = [], panes = [], tabs = [], calls = []; let serial = 0;
  const invoke = async (_target, args) => {
    calls.push(args); const [kind, action, key] = args;
    const opt = name => args[args.indexOf(name) + 1];
    const tokenPatch = tokens => { args.forEach((s, i) => { if (s === '--token') { const [key, ...value] = args[i + 1].split('='); tokens[key] = value.join('='); } }); };
    if (kind === 'workspace' && action === 'list') return { workspaces: structuredClone(spaces) };
    if (kind === 'workspace' && action === 'create') {
      const workspace = { workspace_id: 'w' + ++serial, label: opt('--label'), tokens: {} }; spaces.push(workspace);
      const tab = { tab_id: workspace.workspace_id + ':t' + ++serial }, pane = { pane_id: workspace.workspace_id + ':p' + ++serial, workspace_id: workspace.workspace_id, terminal_id: 'term' + serial, tokens: {} }; tabs.push(tab); panes.push(pane);
      return { workspace, tab, root_pane: pane };
    }
    if (kind === 'workspace') {
      const space = spaces.find(w => w.workspace_id === key); if (!space) throw Error('missing workspace');
      if (action === 'report-metadata') tokenPatch(space.tokens);
      if (action === 'rename') space.label = args[3];
      return { workspace: structuredClone(space) };
    }
    if (kind === 'tab' && action === 'create') {
      const tab = { tab_id: opt('--workspace') + ':t' + ++serial }, pane = { pane_id: opt('--workspace') + ':p' + ++serial, workspace_id: opt('--workspace'), terminal_id: 'term' + serial, tokens: {} };
      tabs.push(tab); panes.push(pane); return { tab, root_pane: pane };
    }
    if (kind === 'tab' && action === 'rename') return {};
    if (kind === 'pane' && action === 'list') return { panes: structuredClone(panes.filter(p => p.workspace_id === opt('--workspace'))) };
    if (kind === 'pane' && action === 'process-info') return { process_info: { shell_pid: 123, foreground_process_group_id: 123 } };
    const pane = panes.find(p => p.pane_id === key); if (!pane) throw Error('missing pane');
    if (action === 'report-metadata') { tokenPatch(pane.tokens); if (args.includes('--display-agent')) pane.display_agent = opt('--display-agent'); }
    if (action === 'rename') pane.label = args[3];
    return { pane: structuredClone(pane) };
  };
  return { spaces, panes, calls, invoke };
}

test('Japanese display labels disambiguate duplicates and truncation without splitting surrogate pairs', () => {
  const list = [{ id: 'a', title: '設計' }, { id: 'b', title: '設計' }];
  assert.equal(label('日本語 ノード', 'a'), '日本語 ノード');
  assert.notEqual(label('設計', 'a', list), label('設計', 'b', list));
  const name = label('😀'.repeat(100), 'a'); assert.equal(Array.from(name).length, 80); assert(!name.includes('\ufffd'));
  assert.equal(label('a\x1bb\n', 'a'), 'ab');
});
test('bindings serialize concurrent creation, survive restart and synchronize renames by ID', async () => {
  const dir = temp(), fake = fakeHerdr(), manager = new HerdrBindings(dir, fake.invoke);
  const a = blankNode({ title: '同じ名前' }), b = blankNode({ title: '同じ名前' });
  const tree = blankTree({ name: '日本語のツリー', nodes: [a, b] });
  const [one, two] = await Promise.all([manager.prepare(tree, tree, [tree]), manager.prepare(tree, tree, [tree])]);
  assert.equal(fake.spaces.length, 1); assert.equal(fake.panes.length, 3);
  assert.equal(one.nodes[a.id].paneId, two.nodes[a.id].paneId);
  assert.notEqual(fake.panes[1].display_agent, fake.panes[2].display_agent);
  const restarted = new HerdrBindings(dir, fake.invoke);
  const renamed = { ...tree, revision: 2, name: '新しいツリー名', nodes: [{ ...a, title: '新しいノード名' }, b] };
  await restarted.sync(renamed, [renamed]);
  assert.equal(fake.spaces[0].label, renamed.name);
  assert.equal(fake.panes[1].display_agent, renamed.nodes[0].title);
  assert.equal(restarted.entry(renamed).nodes[a.id].agentAlias, one.nodes[a.id].agentAlias);
  assert.match(one.nodes[a.id].agentAlias, /^[a-z][a-z0-9_-]{0,31}$/);
  fake.panes[1].tokens.wt_owner = 'another-app';
  await assert.rejects(restarted.prepare(renamed, renamed, [renamed]), /所有関係/);
  assert.equal(fake.panes.length, 3, 'must not silently replace a foreign pane');
});
test('uncertain workspace creation never replays the mutation', async () => {
  const fake = fakeHerdr(), tree = blankTree({ nodes: [blankNode()] });
  const invoke = async (target, args) => { const result = await fake.invoke(target, args); if (args[0] === 'workspace' && args[1] === 'create') throw Error('lost acknowledgement'); return result; };
  const manager = new HerdrBindings(temp(), invoke);
  await assert.rejects(manager.prepare(tree, tree, [tree]), /lost acknowledgement/);
  await assert.rejects(manager.prepare(tree, tree, [tree]), /作成結果が不明/);
  assert.equal(fake.spaces.length, 1);
});
test('tree execution settings reject unsupported backend and unsafe session names', () => {
  const machines = [{ id: 'local' }];
  assert.throws(() => validateTree(blankTree({ executionBackend: 'unknown' }), machines), /実行先/);
  assert.throws(() => validateTree(blankTree({ herdrSession: 'x;bad' }), machines), /セッション/);
});

function interactiveSetup(t, tool = 'codex', options = {}) {
  const dir = temp(), node = blankNode({ title: '日本語ノード', tool, cli: { [tool]: { model: 'node-model', effort: 'medium', ...(tool === 'codex' ? { approval: 'auto-review' } : { permissionMode: 'dontAsk' }) } } });
  const tree = blankTree({ cwd: dir, cli: { [tool]: { model: 'tree-model', effort: 'high' } }, nodes: [node] });
  const binding = { bindingId: 'b1', owner: 'owner', workspaceId: 'w1', paneId: 'w1:p2', terminalId: 'term1', agentAlias: 'wt-test' };
  const pane = { pane_id: binding.paneId, workspace_id: binding.workspaceId, terminal_id: binding.terminalId, tokens: { wt_owner: binding.owner, wt_binding: binding.bindingId } };
  let status = options.blocked ? 'blocked' : 'idle', launched = false, submitted = false, launches = 0, prompts = 0, stopped = 0, transcriptReads = 0, script = '', sentPrompt = '', changedPid = false;
  const invoke = async (_target, args) => {
    const [kind, action] = args;
    if (kind === 'pane' && action === 'get') return { pane: { ...pane, agent: launched ? tool : null } };
    if (kind === 'pane' && action === 'process-info') return { process_info: { shell_pid: 123, foreground_process_group_id: launched ? changedPid ? 456 : 987654 : 123 } };
    if (kind === 'pane' && action === 'run') {
      launches++; launched = true;
      const runDir = path.join(dir,'herdr',node.id);
      script = fs.readFileSync(path.join(runDir,'launch.sh'),'utf8');
      fs.writeFileSync(path.join(runDir,'process.pid'),'987654');
      if (options.loseLaunch) throw Error('launch acknowledgement lost'); return {};
    }
    if (kind === 'agent' && action === 'get') return { agent: { agent: tool, pane_id: binding.paneId, terminal_id: binding.terminalId, agent_status: status } };
    if (kind === 'agent' && action === 'rename') return {};
    if (kind === 'agent' && action === 'prompt') { prompts++; submitted = true; sentPrompt = args[3]; status = 'working'; if (options.losePrompt) throw Error('prompt acknowledgement lost'); return {}; }
    if (kind === 'agent' && action === 'read') { transcriptReads++; return { text: '端末の会話記録（要約とは別）' }; }
    throw Error('Unexpected call ' + args.join(' '));
  };
  const controller = new AbortController(); t.after(() => controller.abort());
  return { dir, node, pane, controller, context: { target: {}, nodes: { [node.id]: binding }, runDir: dir, runId: 'run1', invoke, pollMs: 10, terminate: async () => stopped++ }, config: configFor(tree,node), machine: { codexPath: path.join(__dirname,'fixtures/fake-cli.cjs'), claudePath: path.join(__dirname,'fixtures/fake-cli.cjs') },
    get prompts() { return prompts; }, get launches() { return launches; }, get script() { return script; }, get sentPrompt() { return sentPrompt; }, get stopped() { return stopped; }, get transcriptReads() { return transcriptReads; },
    status(value) { status = value; }, changePid() { changedPid = true; },
    complete(response = '検証済みの結果') { atomic(path.join(dir,'control.json'), { id: String(Date.now()), action: 'complete', nodeId: node.id, response }); }
  };
}
async function until(fn) { const end = Date.now()+3000; while (!fn()) { if (Date.now()>end) throw Error('timed out'); await delay(10); } }
for (const tool of ['codex','claude']) test('native ' + tool + ' receives effective settings and prompt, waits for explicit completion, leaves session open', async t => {
  const s = interactiveSetup(t,tool,{ loseLaunch:true, losePrompt:true }), phases = [], events = [];
  let settled = false;
  const running = runInHerdr(s.context,s.config,s.machine,'Literal $(never) 日本語\n複数行',{ signal:s.controller.signal, onInteractive:v=>phases.push(v), onEvent:e=>events.push(e) }).then(r=>{ settled=true; return r; });
  await until(()=>s.prompts === 1); s.status('idle'); await until(()=>phases.at(-1)?.phase === 'ready');
  assert.equal(settled,false,'idle must never automatically finish a task');
  assert.equal(s.launches,1); assert.equal(s.prompts,1); assert.equal(s.sentPrompt,'Literal $(never) 日本語\n複数行');
  assert.match(s.script, /node-model/); assert(!s.script.includes('tree-model'));
  assert(!s.script.includes("'exec'")); assert(!s.script.includes("'-p'")); assert(!s.script.includes('stream-json'));
  if(tool==='codex'){ assert(s.script.includes('--approve-for-me')); assert(s.script.includes('model_reasoning_effort="medium"')); }
  else { assert(s.script.includes("'--effort' 'medium'")); assert(s.script.includes("'--permission-mode' 'dontAsk'")); }
  assert.match(phases.at(-1).message,/自動再送/);
  s.complete(); const result = await running;
  assert.equal(result.response,'検証済みの結果'); assert.equal(result.confirmedByUser,true); assert.equal(s.stopped,0); assert.equal(s.transcriptReads,1);
  assert.equal(fs.readFileSync(path.join(s.dir,'herdr',s.node.id,'terminal.txt'),'utf8'),'端末の会話記録（要約とは別）');
  await assert.rejects(runInHerdr(s.context,s.config,s.machine,'again'),/送信済み/);
});
test('startup approvals are not answered or bypassed, and cancellation only stops the owned CLI', async t => {
  const s = interactiveSetup(t,'codex',{blocked:true}), phases=[];
  const running=runInHerdr(s.context,s.config,s.machine,'task',{signal:s.controller.signal,onInteractive:v=>phases.push(v)});
  const rejection=assert.rejects(running,/停止/);
  await until(()=>phases.at(-1)?.phase==='startup-blocked'); assert.equal(s.prompts,0);
  s.status('idle'); await until(()=>s.prompts===1);
  s.controller.abort(); await rejection; assert.equal(s.stopped,1);
});
test('foreign pane or changed foreground process never receives a prompt or stop', async t => {
  const s=interactiveSetup(t,'codex',{blocked:true});
  s.pane.tokens.wt_owner='foreign';
  await assert.rejects(runInHerdr(s.context,s.config,s.machine,'task'),/所有関係/); assert.equal(s.launches,0);
  s.pane.tokens.wt_owner='owner'; const phases=[];
  const running=runInHerdr(s.context,s.config,s.machine,'task',{signal:s.controller.signal,onInteractive:v=>phases.push(v)});
  const rejection=assert.rejects(running,/プロセスが変わりました/);
  await until(()=>phases.at(-1)?.phase==='startup-blocked'); s.changePid(); await rejection;
  assert.equal(s.prompts,0); assert.equal(s.stopped,0);
});
test('completion requests while working do not end interactive execution', async t => {
  const s=interactiveSetup(t), phases=[];
  const running=runInHerdr(s.context,s.config,s.machine,'task',{signal:s.controller.signal,onInteractive:v=>phases.push(v)});
  await until(()=>s.prompts===1); s.complete('too early'); await until(()=>phases.some(v=>v.message?.includes('入力待ち')));
  s.status('idle'); await until(()=>phases.at(-1)?.phase==='ready');
  s.complete('確認済み'); assert.equal((await running).response,'確認済み');
});
test('oversized interactive prompts fail before launch instead of leaving an unsent conversation', async t => {
  const s = interactiveSetup(t);
  await assert.rejects(runInHerdr(s.context, s.config, s.machine, '日本語'.repeat(15000)), /96 KiB/);
  assert.equal(s.launches, 0); assert.equal(s.prompts, 0);
});
