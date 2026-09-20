'use strict';
// Standalone: deployed to the selected host; no TaskDesk server dependencies.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(r => setTimeout(r, ms));
const check = (value, message) => { if (!value) throw Error(message); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function read(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
function atomic(file, value) { const tmp = file + '.' + crypto.randomUUID() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
function context(dir, token) { const c = read(path.join(dir, 'context.json')); check(c && c.token === token && c.dir === dir, '通知の実行識別が一致しません'); return c; }
function canonical(file) { const real = fs.realpathSync(file); return process.platform === 'win32' ? real.toLowerCase() : real; }

async function configNotify(resolved, args, env, cwd) {
  // Read effective config using the actual executable, profile and overrides.
  const configArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (['-c', '--config'].includes(args[i])) configArgs.push('-c', args[++i]);
    else if (args[i] === '--profile') configArgs.push('-c', 'profile=' + JSON.stringify(args[++i]));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, [...resolved.prefix, 'app-server', ...configArgs], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', size = 0, settled = false;
    const finish = (e, v) => { if (settled) return; settled = true; clearTimeout(timer); child.stdin.end(); child.kill(); e ? reject(e) : resolve(v); };
    const timer = setTimeout(() => finish(Error('Codex の通知設定を読み取れません。手動記録を選択してください')), 15000);
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    child.stdin.on('error', () => {}); child.stderr.resume(); child.stdout.setEncoding('utf8');
    child.on('error', e => finish(e)); child.on('exit', () => finish(Error('Codex の設定読み取りが終了しました')));
    child.stdout.on('data', data => {
      size += data.length; if (size > 8 * 1024 * 1024) return finish(Error('Codex 設定応答が大きすぎます'));
      buffer += data; let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const r = JSON.parse(line); if (r.error) return finish(Error('Codex config/read: ' + r.error.message));
          if (r.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'config/read', params: { includeLayers: false, cwd } }); }
          if (r.id === 2) {
            check(r.result?.config && typeof r.result.config === 'object', 'Codex 設定形式が未対応です');
            const notify = r.result.config.notify || [];
            check(Array.isArray(notify) && notify.every(x => typeof x === 'string' && !x.includes('\0')), '既存 notify 設定の形式が未対応です');
            finish(null, notify);
          }
        } catch (e) { finish(e); }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'taskdesk_notify', version: '0.3.0' } } });
  });
}

async function configure(dir, token, resolved, args, env) {
  const c = context(dir, token);
  check(c.hostname === os.hostname() && c.user === os.userInfo().username && c.cwd === canonical(process.cwd()), '通知回収先と Orca の実行先が一致しません');
  const previousNotify = await configNotify(resolved, args, env, process.cwd());
  check(!previousNotify.some(x => x === path.join(dir, 'notify.cjs')), '通知の循環呼び出しです');
  atomic(path.join(dir, 'launch.json'), { previousNotify, codexHome: env.CODEX_HOME || path.join(os.homedir(), '.codex'), createdAt: Date.now() });
  atomic(path.join(dir, 'ready.json'), { token, attemptId: c.attemptId, hostname: c.hostname });
  const end = Date.now() + 45000;
  while (!read(path.join(dir, 'ack-ready.json'))) { check(Date.now() < end, '通知経路の受領確認がありません。プロンプトは送信しません'); await delay(200); }
  check(read(path.join(dir, 'ack-ready.json')).token === token, '通知受領確認が一致しません');
  return [...args, '-c', 'notify=' + JSON.stringify([process.execPath, path.join(dir, 'notify.cjs'), 'notify', dir, token])];
}

async function notify(dir, token, raw) {
  const c = context(dir, token), launch = read(path.join(dir, 'launch.json'));
  check(typeof raw === 'string' && raw.length <= 1024 * 1024, '通知が大きすぎます');
  const n = JSON.parse(raw);
  if (n.type === 'agent-turn-complete') {
    check(typeof n['thread-id'] === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(n['thread-id']), 'セッション ID がありません');
    check(typeof n.cwd === 'string' && canonical(n.cwd) === c.cwd, '通知の作業ディレクトリが一致しません');
    const turnId = typeof n['turn-id'] === 'string' ? n['turn-id'] : null;
    const key = hash(JSON.stringify([c.attemptId, n['thread-id'], turnId || hash(raw), n.type]));
    const event = { key, token, runId: c.runId, nodeId: c.nodeId, attemptId: c.attemptId, hostId: c.hostId, identityKey: c.identityKey, threadId: n['thread-id'], turnId, type: n.type, receivedAt: Date.now(), response: String(n['last-assistant-message'] || '').slice(0, 60000), inputMessages: Array.isArray(n['input-messages']) ? n['input-messages'].filter(x => typeof x === 'string') : [] };
    const file = path.join(dir, 'events', key + '.json');
    if (!fs.existsSync(file)) atomic(file, event);
  }
  // Preserve the previous notifier. Its failure cannot erase our durable event.
  if (launch?.previousNotify?.length) await new Promise(resolve => {
    const [command, ...args] = launch.previousNotify;
    const child = spawn(command, [...args, raw], { shell: false, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
    child.on('error', () => { clearTimeout(timer); resolve(); }); child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function activity(dir, c, event) {
  // Fail closed for unsupported/missing rollout formats. Never pick "latest".
  const launch = read(path.join(dir, 'launch.json'));
  if (!launch || !event?.threadId) return { supported: false };
  try {
    const root = path.join(launch.codexHome, 'sessions');
    const matches = fs.readdirSync(root, { recursive: true }).filter(f => f.endsWith('-' + event.threadId + '.jsonl'));
    if (matches.length !== 1) return { supported: false };
    const file = path.join(root, matches[0]), stat = fs.statSync(file);
    if (stat.size > 32 * 1024 * 1024) return { supported: false };
    const source = fs.readFileSync(file, 'utf8');
    if (!source.endsWith('\n')) return { supported: false };
    const rows = source.trim().split('\n').map(line => JSON.parse(line));
    const meta = rows.find(r => r.type === 'session_meta')?.payload;
    if ((meta?.id || meta?.session_id) !== event.threadId || canonical(meta.cwd) !== c.cwd || Date.parse(meta.timestamp) < launch.createdAt - 10000) return { supported: false };
    if (meta.source !== 'cli' || meta.thread_source !== 'user') return { supported: false, rootSession: false };
    if (!event.turnId) return { supported: false, rootSession: true };
    let started = null, completed = null, invalid = false;
    for (const row of rows) if (row.type === 'event_msg') {
      const p = row.payload;
      if (p.type === 'task_started') { started = p.turn_id; completed = null; invalid = !started; }
      if (p.type === 'task_complete' && p.turn_id === started) completed = p.turn_id;
      if (p.type === 'turn_aborted' || p.type === 'error') invalid = true;
    }
    return { supported: !invalid && Boolean(started), rootSession: true, turnId: started, completed: completed === event.turnId && started === event.turnId, fingerprint: hash(source) };
  } catch { return { supported: false }; }
}

async function verifyJob(dir, token, job) {
  const c = context(dir, token), v = job.verification;
  let result = { key: job.event.key, outcome: 'error', detail: '', before: activity(dir, c, job.event) };
  if (!result.before.supported || !result.before.completed || result.before.fingerprint !== job.fingerprint) result = { ...result, outcome: null, detail: 'ターンの状態が変わりました' };
  else {
    result = { ...result, ...await new Promise(resolve => {
      let child, output = '', done = false;
      const finish = value => { if (done) return; done = true; clearTimeout(timer); clearInterval(monitor); resolve({ ...value, detail: output.slice(-12000) + (value.detail || '') }); };
      const kill = () => {
        if (!child?.pid) return;
        if (process.platform === 'win32') { const k = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); k.on('error', () => child.kill()); k.on('exit', code => { if (code !== 0) child.kill(); }); }
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
      };
      const timer = setTimeout(() => { kill(); finish({ outcome: 'error', detail: '\n検証がタイムアウトしました' }); }, v.timeoutSeconds * 1000);
      const monitor = setInterval(() => { if (read(path.join(dir, 'cancel.json'))) { kill(); finish({ outcome: 'error', detail: '\n検証を停止しました' }); } }, 200);
      try {
        child = spawn(v.command === 'node' ? process.execPath : v.command, v.args, { cwd: c.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', s => { output = (output + s).slice(-12000); }); child.stderr.on('data', s => { output = (output + s).slice(-12000); });
        child.on('error', e => finish({ outcome: 'error', detail: e.message }));
        child.on('exit', (code, signal) => finish({ outcome: signal ? 'error' : code === 0 ? 'completed' : 'unexpected', exitCode: code }));
      } catch (e) { finish({ outcome: 'error', detail: e.message }); }
    }) };
  }
  result.after = activity(dir, c, job.event);
  if (!result.after.supported || !result.after.completed || result.after.fingerprint !== result.before.fingerprint) { result.outcome = null; result.detail += '\n検証中にターンが変わったため確認待ちです'; }
  atomic(path.join(dir, 'verify-' + job.event.key + '.json'), result);
}

async function handle(p) {
  if (p.action === 'prepare') {
    check(/^[a-f0-9-]{36}$/.test(p.attemptId) && /^[a-f0-9]{48}$/.test(p.token), '通知識別情報が不正です');
    const dir = path.join(os.homedir(), '.taskdesk', 'notifications', p.attemptId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.mkdirSync(path.join(dir, 'events'), { mode: 0o700 });
    const c = { dir, token: p.token, attemptId: p.attemptId, runId: p.runId, nodeId: p.nodeId, hostId: p.hostId, identityKey: p.identityKey, cwd: canonical(p.cwd), hostname: os.hostname(), user: os.userInfo().username, node: process.execPath };
    atomic(path.join(dir, 'context.json'), c); fs.writeFileSync(path.join(dir, 'notify.cjs'), p.source, { mode: 0o600, flag: 'wx' });
    return c;
  }
  const c = context(p.dir, p.token), dir = c.dir;
  if (p.action === 'collect') {
    const ready = read(path.join(dir, 'ready.json'));
    if (ready?.token === c.token) atomic(path.join(dir, 'ack-ready.json'), { token: c.token });
    const files = fs.readdirSync(path.join(dir, 'events')).filter(f => /^[a-f0-9]{64}\.json$/.test(f));
    check(files.length <= 1000, '通知イベント数が上限を超えました');
    const events = files.map(f => read(path.join(dir, 'events', f))).filter(e => !p.threadId || e.threadId === p.threadId).sort((a, b) => a.receivedAt - b.receivedAt || a.key.localeCompare(b.key));
    if (!p.threadId) for (const event of events) event.rootSession = activity(dir, c, event).rootSession === true;
    const latest = events.at(-1);
    return { ready, events, activity: latest && activity(dir, c, latest), verification: latest && read(path.join(dir, 'verify-' + latest.key + '.json')), exit: read(path.join(dir, 'exit.json')) };
  }
  if (p.action === 'ack') { check(Array.isArray(p.keys) && p.keys.every(k => /^[a-f0-9]{64}$/.test(k)), '受領 ID が不正です'); atomic(path.join(dir, 'received.json'), { keys: p.keys }); return { ok: true }; }
  if (p.action === 'cancel') { atomic(path.join(dir, 'cancel.json'), { requestedAt: Date.now() }); return { ok: true }; }
  if (p.action === 'verify') {
    const file = path.join(dir, 'job-' + p.event.key + '.json');
    check(/^[a-f0-9]{64}$/.test(p.event.key) && p.event.token === c.token, '検証イベントが一致しません');
    check(!read(path.join(dir, 'cancel.json')), '検証は停止済みです');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(p), { mode: 0o600, flag: 'wx' });
      const child = spawn(process.execPath, [path.join(dir, 'notify.cjs'), 'verify', dir, c.token, file], { detached: true, windowsHide: true, stdio: 'ignore' }); child.on('error', e => atomic(path.join(dir, 'verify-' + p.event.key + '.json'), { key: p.event.key, outcome: 'error', detail: e.message })); child.unref();
    }
    return { ok: true };
  }
  throw Error('不正な通知操作です');
}
if (require.main === module) {
  const [action, dir, token, value] = process.argv.slice(2);
  (action === 'notify' ? notify(dir, token, value) : action === 'verify' ? verifyJob(dir, token, read(value)) : Promise.reject(Error('Unknown action'))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { handle, configure, notify, configNotify, activity, verifyJob, atomic };
