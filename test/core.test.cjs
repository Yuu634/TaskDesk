'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { blankNode, blankTree, validateTree, validateMachine, orderedTasks, nextTask, parsePlan } = require('../lib/core.cjs');
const { shellQuote, sshArgs, buildCommand, runtimeProfile, cliErrorMessage } = require('../lib/executor.cjs');
const path = require('node:path');
test('Windows atomic saves retry transient sharing violations without losing the previous snapshot', { skip: process.platform !== 'win32' }, t => {
  const fs = require('node:fs'), { atomic, read } = require('../lib/core.cjs');
  const root = path.resolve(__dirname, '../.test-data'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'atomic-')), target = path.join(dir, 'state.json');
  atomic(target, { value: 'before' });
  const rename = fs.renameSync; let calls = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === target && calls++ < 2) { assert.equal(read(target).value, 'before'); const error = new Error('sharing violation'); error.code = 'EPERM'; throw error; }
    return rename(from, to);
  });
  atomic(target, { value: 'after' }); assert.equal(calls, 3); assert.equal(read(target).value, 'after');
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0);
});
const local = { id: 'local', name: 'local', type: 'local', codexPath: path.join(__dirname, 'fixtures/fake-cli.cjs'), claudePath: path.join(__dirname, 'fixtures/fake-cli.cjs') };
test('runtime profile validates the OS identity without substituting environment paths', () => {
  assert.deepEqual(runtimeProfile(() => ({ username: 'normal-user', homedir: 'C:\\Users\\normal-user' })), { ok: true, username: 'normal-user', homedir: 'C:\\Users\\normal-user' });
  const broken = runtimeProfile(() => { throw new Error('uv_os_get_passwd returned ENOMEM'); });
  assert.equal(broken.ok, false); assert.equal(broken.homedir, null); assert.match(broken.error, /通常ユーザー/);
});
test('home lookup failure explains how to restart without hiding the underlying error', () => {
  const message = cliErrorMessage('Error finding codex home: Could not find home directory');
  assert.match(message, /通常ユーザー/); assert.match(message, /codex login status/); assert.match(message, /Could not find home directory/);
  assert.equal(cliErrorMessage('unrelated failure'), 'unrelated failure');
});
test('hierarchy order and dependencies are independent', () => {
  const group = blankNode({ kind: 'group' }), a = blankNode({ parentId: group.id, title: 'A', order: 1 }), b = blankNode({ title: 'B', order: 0, dependsOn: [a.id] });
  const tree = blankTree({ nodes: [b, group, a] }); validateTree(tree, [local]);
  assert.equal(nextTask(tree, {}).id, a.id);
  assert.equal(nextTask(tree, { [a.id]: { status: 'running' } }), null);
  assert.equal(nextTask(tree, { [a.id]: { status: 'running' } }, true).id, b.id);
  assert.equal(nextTask(tree, { [a.id]: { status: 'succeeded' } }).id, b.id);
  assert.equal(orderedTasks(tree).length, 2);
});
test('invalid parenting, dependency cycles and missing machines are rejected', () => {
  const a = blankNode({ kind: 'group' }), b = blankNode({ kind: 'group', parentId: a.id }); a.parentId = b.id;
  assert.throws(() => validateTree(blankTree({ nodes: [a, b] }), [local]), /循環/);
  const x = blankNode(), y = blankNode({ dependsOn: [x.id] }); x.dependsOn = [y.id];
  assert.throws(() => validateTree(blankTree({ nodes: [x, y] }), [local]), /循環/);
  assert.throws(() => validateTree(blankTree({ machineId: 'missing' }), [local]), /マシン/);
  const parent = blankNode(), child = blankNode({ parentId: parent.id });
  assert.throws(() => validateTree(blankTree({ nodes: [parent, child] }), [local]), /グループ/);
});
test('AI plans receive new stable IDs and only editable plan fields', () => {
  const plan = parsePlan(JSON.stringify({ name: 'Plan', nodes: [{ id: 'g', title: 'Group', kind: 'group' }, { id: 'a', title: 'A', kind: 'task', parentId: 'g', prompt: 'one', machineId: 'hostile', env: { TOKEN: 'bad' } }, { id: 'b', title: 'B', kind: 'task', dependsOn: ['a'] }] }));
  assert.notEqual(plan.nodes[0].id, 'g'); assert.equal(plan.nodes[1].parentId, plan.nodes[0].id); assert.equal(plan.nodes[2].dependsOn[0], plan.nodes[1].id);
  assert.equal(plan.nodes[1].machineId, ''); assert.deepEqual(plan.nodes[1].env, {}); validateTree(blankTree(plan), [local]);
  assert.throws(() => parsePlan('{bad'), /JSON/);
  assert.throws(() => parsePlan(JSON.stringify({ nodes: [{ id: 'a', dependsOn: ['missing'] }] })), /依存先/);
});
test('SSH fields reject option and shell injection; prompts never enter a shell', () => {
  const m = { ...local, id: 'remote', type: 'ssh', host: 'user@host', port: 22, nodePath: '/usr/bin/node' };
  validateMachine(m);
  for (const host of ['-oProxyCommand=x', 'host;echo x', 'host\ncmd', 'host $(echo x)']) assert.throws(() => validateMachine({ ...m, host }));
  const args = sshArgs(m, 'fixed command'); assert(args.includes('StrictHostKeyChecking=yes')); assert(args.includes('BatchMode=yes'));
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  const cmd = buildCommand({ ...blankNode(), tool: 'codex', model: 'literal$(model)' }, local);
  assert(cmd.args.includes('literal$(model)')); assert.equal(cmd.command, process.execPath); assert(!cmd.args.includes('--dangerously-bypass-approvals-and-sandbox'));
});
