'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { blankNode, blankTree, configFor, validateTree } = require('../lib/core.cjs');
const { cliArgs, prepare, validateOptions } = require('../lib/cli-options.cjs');
const { upload, hydrate, metadata } = require('../lib/attachments.cjs');
const { runAgent } = require('../lib/executor.cjs');
const fixture = path.join(__dirname, 'fixtures/fake-cli.cjs');
const machine = { id: 'local', codexPath: fixture, claudePath: fixture };
const root = path.resolve(__dirname, '../.test-data'); fs.mkdirSync(root, { recursive: true });
function config(tool = 'codex', cli = {}, extras = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'cli-'));
  return configFor(blankTree({ tool, cwd: dir }), blankNode({ cli: { [tool]: cli }, ...extras }));
}
test('CLI inheritance preserves legacy nodes and independent per-tool overrides', () => {
  const n = blankNode({ model: 'legacy', sandbox: 'read-only' });
  const t = blankTree({ cli: { codex: { model: 'tree', effort: 'high' }, claude: { model: 'sonnet' } } });
  assert.equal(configFor(blankTree(), n).options.model, 'legacy');
  assert.equal(configFor(t, n).options.model, 'legacy');
  assert.equal(configFor(t, n).options.sandbox, 'read-only');
  n.cli = { codex: { model: 'node' } };
  assert.equal(configFor(t, n).options.effort, 'high');
  assert.equal(configFor(t, n).options.model, 'node');
  n.tool = 'claude'; n.model = ''; assert.equal(configFor(t, n).options.model, 'sonnet');
  validateTree(blankTree({ nodes: [n], cli: t.cli }), [machine]);
});
test('Codex arguments map effort, approval, model, profile, MCP and paths without shell parsing', () => {
  const c = config('codex', { model: 'literal$(model)', effort: 'ultra', profile: 'work', approval: 'auto-review', webSearch: 'live', addDirs: ['dir with spaces'], mcpServers: { docs: { command: 'node', args: ['a"b\\c'], env: { FOO: 'line\ntext' } } } });
  const args = cliArgs(c);
  for (const item of ['--approve-for-me', '--profile', 'work', 'literal$(model)', 'model_reasoning_effort="ultra"', 'web_search="live"', 'dir with spaces']) assert(args.includes(item), item);
  assert(args.some(a => a.startsWith('mcp_servers.docs={') && a.includes('"command" = "node"')));
  c.options.sandbox = 'danger-full-access'; assert.throws(() => cliArgs(c), /workspace-write/);
});
test('planning overrides broad permissions and additional writable directories', () => {
  for (const tool of ['codex', 'claude']) {
    const c = config(tool, tool === 'codex' ? { mode: 'plan', sandbox: 'danger-full-access', approval: 'auto-review', addDirs: ['other'] } : { mode: 'plan', permissionMode: 'bypassPermissions', addDirs: ['other'] });
    const args = cliArgs(c); assert(!args.includes('other')); assert(!args.includes('danger-full-access')); assert(!args.includes('--approve-for-me')); assert(!args.includes('bypassPermissions'));
    assert(args.includes(tool === 'codex' ? 'read-only' : 'plan'));
  }
});
test('Claude maps tool lists and strict MCP to one variadic option each', () => {
  const c = config('claude', { effort: 'max', allowedTools: ['Read', 'Bash(git diff *)'], disallowedTools: ['Write', 'Edit'], addDirs: ['one', 'two'], strictMcp: true });
  const p = prepare(c, 'test');
  try {
    const args = cliArgs(p.config);
    assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools')), ['Read', 'Bash(git diff *)']);
    assert(args.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(fs.readFileSync(p.config.mcpConfigPath, 'utf8')), { mcpServers: {} });
  } finally { p.cleanup(); }
  assert(!fs.existsSync(p.config.mcpConfigPath));
});
test('invalid configuration is rejected before execution', () => {
  for (const cli of [{ codex: { effort: 'invalid' } }, { claude: { goalMaxAttempts: 0 } }, { codex: { approval: 'on-request' } }, { claude: { allowedTools: ['--dangerously-skip-permissions'] } }, { codex: { mcpServers: { x: { command: null } } } }, { codex: { extraArgs: ['--bad'] } }]) assert.throws(() => validateOptions(cli));
});
test('uploads are stored by generated IDs, travel in snapshots, and become exact bytes', () => {
  const c = config(), binary = Buffer.from([0, 1, 2, 255, 128]);
  const a = upload(c.cwd, { name: '../../outside.png', data: binary.toString('base64') });
  assert(!fs.existsSync(path.join(c.cwd, 'outside.png')));
  const tree = hydrate(c.cwd, blankTree({ cwd: c.cwd, attachments: [a], nodes: [blankNode()] }));
  assert.equal(tree.attachments[0].data, binary.toString('base64'));
  assert.equal(metadata(tree).attachments[0].data, undefined);
  const p = prepare(configFor(tree, tree.nodes[0]), '資料');
  try { assert.deepEqual(fs.readFileSync(p.config.imagePaths[0]), binary); assert.match(p.prompt, /添付資料/); } finally { p.cleanup(); }
  assert(!fs.existsSync(p.config.imagePaths[0]));
  assert.throws(() => upload(c.cwd, { name: 'a', data: '!!!' }), /base64/);
  assert.throws(() => hydrate(c.cwd, blankTree({ attachments: [{ id: '../../outside' }] })), /ID/);
  assert.throws(() => validateTree(blankTree({ attachments: [{ ...a, data: 'eA==' }] }), [machine]), /アップロード/);
});
test('goal retries until verified completion, records progress and reuses previous result', async () => {
  const c = config('codex', { mode: 'goal', goalMaxAttempts: 3 }, { criteria: 'verified' });
  const count = path.join(c.cwd, 'counter'), capture = path.join(c.cwd, 'capture');
  c.env = { FAKE_GOAL_COUNTER: count, FAKE_CAPTURE: capture };
  const progress = []; const result = await runAgent(c, machine, 'build', { onProgress: p => progress.push(p.attempt) });
  assert.equal(result.attempts, 2); assert.deepEqual(progress, [1, 2]); assert.match(result.response, /verified 2/);
  const invoked = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.match(invoked.prompt, /attempt 1/); assert(invoked.args.includes('--output-schema'));
});

test('maximum size upload works without recursive regex overflow and excess is rejected', () => {
  const c = config(), bytes = Buffer.alloc(5 * 1024 * 1024, 255);
  const item = upload(c.cwd, { name: 'large.bin', data: bytes.toString('base64') });
  assert.equal(item.size, bytes.length);
  assert.throws(() => upload(c.cwd, { name: 'too-large.bin', data: Buffer.alloc(bytes.length + 1).toString('base64') }), /5 MB/);
  const args = cliArgs({ ...c, imagePaths: ['image with spaces.png'] });
  assert.deepEqual(args.slice(-4), ['--image', 'image with spaces.png', '--', '-']);
});
test('goal cannot report success after limit, invalid result or stop', async () => {
  const c = config('claude', { mode: 'goal', goalMaxAttempts: 2 }, { criteria: 'verified' });
  c.env = { FAKE_GOAL_COUNTER: path.join(c.cwd, 'counter'), FAKE_GOAL_AFTER: '9' };
  await assert.rejects(runAgent(c, machine, 'build'), /上限回数/);
  assert.equal(fs.readFileSync(c.env.FAKE_GOAL_COUNTER, 'utf8'), '2');
  await assert.rejects(runAgent({ ...c, env: { FAKE_RESPONSE: 'not json' } }, machine, 'build'), /JSON/);
  const controller = new AbortController();
  await assert.rejects(runAgent(c, machine, 'build', { signal: controller.signal, onProgress: () => controller.abort() }), /停止/);
});
