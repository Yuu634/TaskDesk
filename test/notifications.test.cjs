'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { handle, notify, activity, verifyJob, atomic, configNotify } = require('../lib/codex-notify.cjs');
const { transportFor } = require('../lib/notification-transport.cjs');
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
