'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { handle, notify, activity, verifyJob, atomic, configNotify } = require('../lib/codex-notify.cjs');
const { transportFor } = require('../lib/notification-transport.cjs');
const { assessJob, judgeOutcome } = require('../lib/codex-notify.cjs');
const { assessInTerminal } = require('../lib/codex-notify.cjs');
test('startup prompt is a literal positional argument after configuration and acknowledgement', async t => {
  t.mock.method(os, 'userInfo', () => ({ username: 'fixture-user' }));
  const s = setup(), fixture = path.join(s.dir, 'config.cjs');
  fs.writeFileSync(fixture, "require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id)console.log(JSON.stringify({id:r.id,result:r.id===2?{config:{notify:[]}}:{}}));});");
  const cwd = fs.realpathSync(process.cwd());
  atomic(path.join(s.dir, 'context.json'), { ...s.c, hostname: os.hostname(), user: os.userInfo().username, cwd: process.platform === 'win32' ? cwd.toLowerCase() : cwd, startupPrompt: true });
  const prompt = '--help $(literal) `literal` 日本語\nsecond line';
  fs.writeFileSync(path.join(s.dir, 'work-prompt.txt'), prompt);
  atomic(path.join(s.dir, 'ack-ready.json'), { token: s.token });
  const args = await require('../lib/codex-notify.cjs').configure(s.dir, s.token, { command: process.execPath, prefix: [fixture] }, ['--sandbox', 'read-only'], process.env);
  assert.deepEqual(args.slice(-2), ['--', prompt]);
  assert.equal(args.filter(a => a === prompt).length, 1);
});

test('assessment request only queues a same-terminal handoff, and rejects stale/repeated foreign turns', async () => {
  const s = setup(); await notify(s.dir, s.token, s.raw); const feed = await s.request('collect');
  const job = { event: feed.events[0], fingerprint: feed.activity.fingerprint, criteria: '' };
  await s.request('assess', job); await s.request('assess', job);
  assert(fs.existsSync(path.join(s.dir, 'terminal-assessment.json')));
  assert.equal((await s.request('collect')).assessment, null);
  assert.equal(await assessInTerminal(s.dir, s.token, 0), true);
  assert.equal((await s.request('collect')).assessment.outcome, 'needs_review');
  await assert.rejects(s.request('assess', { ...job, fingerprint: 'stale' }), /変わり/);
});

for (const scenario of ['new-turn', 'cancelled', 'nonzero']) test('same-tab handoff never evaluates unsafe exit: ' + scenario, async () => {
  const s = setup(); await notify(s.dir, s.token, s.raw); const feed = await s.request('collect');
  await s.request('assess', { event: feed.events[0], fingerprint: feed.activity.fingerprint, criteria: '条件' });
  if (scenario === 'new-turn') fs.appendFileSync(s.file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'new' } }) + '\n');
  if (scenario === 'cancelled') await s.request('cancel');
  await assessInTerminal(s.dir, s.token, scenario === 'nonzero' ? 1 : 0);
  const result = (await s.request('collect')).assessment;
  assert.equal(result.outcome, 'needs_review'); assert.match(result.detail, /開始しませんでした/);
  assert(!fs.existsSync(path.join(s.dir, 'assessment-schema.json')));
});

test('AI completion requires exact coverage, evidence and successful optional verification', () => {
  const good = { criteria: [{ id: 1, status: 'met', evidence: 'file.js:12' }] };
  assert.equal(judgeOutcome(good, '条件'), 'completed');
  for (const bad of [null, { criteria: [] }, { criteria: [{ id: 2, status: 'met', evidence: 'x' }] }, { criteria: [{ id: 1, status: 'unknown', evidence: '不明' }] }, { criteria: [{ id: 1, status: 'met', evidence: '' }] }]) assert.equal(judgeOutcome(bad, '条件'), 'needs_review');
  assert.equal(judgeOutcome(good, ''), 'needs_review');
  assert.equal(judgeOutcome(good, '条件\n別条件'), 'needs_review');
  assert.equal(judgeOutcome(good, '条件', { outcome: 'unexpected' }), 'needs_review');
});

for (const scenario of ['met', 'unknown', 'unmet', 'malformed', 'failed', 'missing', 'verification-failed']) test('independent assessment: ' + scenario, async () => {
  const s = setup(); await notify(s.dir, s.token, s.raw);
  const feed = await s.request('collect');
  const fixture = path.join(s.dir, 'judge.cjs');
  fs.writeFileSync(fixture, `const fs=require('fs'); const args=process.argv.slice(2);
    if(args[0]==='app-server') { require('readline').createInterface({input:process.stdin}).on('line',line=>{ const r=JSON.parse(line); if(r.id) console.log(JSON.stringify({id:r.id,result:r.id===2?{config:{mcp_servers:{example:{}}}}:{}})); }); }
    else { let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{
      fs.writeFileSync(${JSON.stringify(path.join(s.dir, 'capture.json'))},JSON.stringify({args,input}));
      if(${JSON.stringify(scenario)}==='failed') return process.exit(1);
      fs.writeFileSync(args[args.indexOf('--output-last-message')+1], ${JSON.stringify(scenario === 'malformed' ? 'bad json' : JSON.stringify({ criteria: [{ id: 1, status: ['unknown', 'unmet'].includes(scenario) ? scenario : 'met', evidence: 'artifact.txt:1 を確認' }] }))});
    }); }`);
  const launch = JSON.parse(fs.readFileSync(path.join(s.dir, 'launch.json')));
  atomic(path.join(s.dir, 'launch.json'), { ...launch, resolved: { command: process.execPath, prefix: [fixture] } });
  await assessJob(s.dir, s.token, { event: feed.events[0], fingerprint: feed.activity.fingerprint, criteria: scenario === 'missing' ? '' : '成果物がある', prompt: '作業指示', ...(scenario === 'verification-failed' ? { verification: { autoComplete: true, command: 'node', args: ['-e', 'process.exit(1)'], timeoutSeconds: 5 } } : {}) });
  const result = (await s.request('collect')).assessment;
  assert.equal(result.outcome, scenario === 'met' ? 'completed' : 'needs_review');
  assert.equal(result.after.fingerprint, feed.activity.fingerprint);
  if (scenario !== 'missing') {
    const { args, input } = JSON.parse(fs.readFileSync(path.join(s.dir, 'capture.json')));
    assert(args.includes('read-only')); assert(args.includes('notify=[]')); assert(args.includes('mcp_servers.example.enabled=false'));
    assert(input.includes('作業指示')); assert(input.includes('普通の回答')); assert(input.includes('成果物がある'));
  }
});
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdesk-notify-')), token = crypto.randomBytes(24).toString('hex');
  const cwd = fs.realpathSync(dir), c = { dir, token, attemptId: crypto.randomUUID(), runId: 'run', nodeId: 'node', hostId: 'local', identityKey: 'identity', cwd: process.platform === 'win32' ? cwd.toLowerCase() : cwd };
  fs.mkdirSync(path.join(dir, 'events')); fs.mkdirSync(path.join(dir, 'sessions'));
  atomic(path.join(dir, 'context.json'), c); atomic(path.join(dir, 'launch.json'), { codexHome: dir, previousNotify: [], createdAt: Date.now() - 1000 });
  const file = path.join(dir, 'sessions', 'rollout-thread.jsonl');
  const rows = [ { type: 'session_meta', payload: { id: 'thread', cwd, source: 'cli', thread_source: 'user', timestamp: new Date().toISOString() } }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } }, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } } ];
  fs.writeFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  const raw = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'thread', 'turn-id': 'turn', cwd, 'last-assistant-message': '普通の回答', 'input-messages': ['prompt'] });
  return { dir, token, c, file, raw, request: (action, extra = {}) => handle({ action, dir, token, ...extra }) };
}
test('durable notification queue preserves plain answers, deduplicates and survives acknowledgement/re-read', async () => {
  const s = setup(); await notify(s.dir, s.token, s.raw); await notify(s.dir, s.token, s.raw);
  const first = await s.request('collect'); assert.equal(first.events.length, 1); assert.equal(first.events[0].response, '普通の回答');
  assert.equal(first.activity.completed, true);
  await s.request('ack', { keys: [first.events[0].key] });
  assert.deepEqual((await s.request('collect')).events, first.events);
  await assert.rejects(notify(s.dir, 'wrong', s.raw), /識別/);
  await assert.rejects(notify(s.dir, s.token, s.raw.replace('"cwd":', '"cwd":"/missing","ignored":')), /ENOENT|一致/);
});
test('missing turn IDs and new turns cannot pass the activity fence', async () => {
  const s = setup(); await notify(s.dir, s.token, s.raw); const event = (await s.request('collect')).events[0];
  assert.equal(activity(s.dir, s.c, { ...event, turnId: null }).supported, false);
  fs.appendFileSync(s.file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } }) + '\n');
  assert.equal(activity(s.dir, s.c, event).completed, false);
});
test('notifications from a child session do not replace the bound parent session', async () => {
  const s = setup(); await notify(s.dir, s.token, s.raw);
  await notify(s.dir, s.token, s.raw.replace('"thread-id":"thread"', '"thread-id":"child"'));
  const feed = await s.request('collect', { threadId: 'thread' });
  assert.equal(feed.events.length, 1); assert.equal(feed.events[0].threadId, 'thread'); assert.equal(feed.activity.completed, true);
});
for (const [code, outcome] of [[0, 'completed'], [1, 'unexpected']]) test('verification uses configured argv and records outcome ' + outcome, async () => {
  const s = setup(); await notify(s.dir, s.token, s.raw); const feed = await s.request('collect'), event = feed.events[0];
  await verifyJob(s.dir, s.token, { event, fingerprint: feed.activity.fingerprint, verification: { command: 'node', args: ['-e', 'process.exit(' + code + ')'], timeoutSeconds: 5 } });
  assert.equal((await s.request('collect')).verification.outcome, outcome);
});
test('turn changes during verification invalidate success', async () => {
  const s = setup(); await notify(s.dir, s.token, s.raw); const feed = await s.request('collect'), event = feed.events[0];
  const next = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'new' } }) + '\n';
  await verifyJob(s.dir, s.token, { event, fingerprint: feed.activity.fingerprint, verification: { command: 'node', args: ['-e', 'require("fs").appendFileSync(process.argv[1],process.argv[2])', s.file, next], timeoutSeconds: 5 } });
  assert.equal((await s.request('collect')).verification.outcome, null);
});
test('verification executable errors and timeouts are errors', async () => {
  for (const verification of [{ command: 'missing-taskdesk-executable-123', args: [], timeoutSeconds: 1 }, { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'], timeoutSeconds: 1 }]) {
    const s = setup(); await notify(s.dir, s.token, s.raw); const feed = await s.request('collect');
    await verifyJob(s.dir, s.token, { event: feed.events[0], fingerprint: feed.activity.fingerprint, verification });
    assert.equal((await s.request('collect')).verification.outcome, 'error');
  }
});
test('SSH collection requires an explicit registered mapping', () => {
  assert.equal(transportFor({ hostId: 'ssh:orca' }), null);
  assert.throws(() => transportFor({ hostId: 'ssh:orca', notificationMachineId: 'missing' }, []), /SSH/);
  const machine = { id: 'g15', type: 'ssh' };
  assert.deepEqual(transportFor({ hostId: 'ssh:orca', notificationMachineId: 'g15' }, [machine]), { type: 'ssh', machine });
});
test('existing notifier receives the original JSON and cannot erase the queue', async () => {
  const s = setup(), recorder = path.join(s.dir, 'recorder.cjs'), result = path.join(s.dir, 'prior.json');
  fs.writeFileSync(recorder, 'require("fs").writeFileSync(process.argv[2],process.argv[3]);process.exitCode=1;');
  atomic(path.join(s.dir, 'launch.json'), { previousNotify: [process.execPath, recorder, result], codexHome: s.dir });
  await notify(s.dir, s.token, s.raw);
  assert.equal(fs.readFileSync(result, 'utf8'), s.raw); assert.equal((await s.request('collect')).events.length, 1);
});
test('configured verification is cancelled without becoming a success', async () => {
  const s = setup(); await notify(s.dir, s.token, s.raw); const feed = await s.request('collect');
  await s.request('cancel');
  await verifyJob(s.dir, s.token, { event: feed.events[0], fingerprint: feed.activity.fingerprint, verification: { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'], timeoutSeconds: 5 } });
  assert.equal((await s.request('collect')).verification.outcome, 'error');
});
