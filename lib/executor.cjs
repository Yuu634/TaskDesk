'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { cliArgs, prepare } = require('./cli-options.cjs');

function runtimeProfile(userInfo = () => os.userInfo()) {
  try {
    const info = userInfo();
    if (!info.username || !info.homedir) throw new Error('Profile unavailable');
    return { ok: true, username: info.username, homedir: info.homedir };
  } catch {
    return { ok: false, username: null, homedir: null, error: 'OS のユーザープロファイルを取得できません。TaskDesk を、Codex にログインした通常ユーザーの PowerShell / ターミナルから起動し直してください。Codex の制限付き実行環境から起動したサーバーでは AI CLI を利用できない場合があります。' };
  }
}
function assertRuntimeProfile() {
  const result = runtimeProfile();
  if (!result.ok) throw new Error(result.error);
  return result;
}
function cliErrorMessage(message) {
  if (/Could not find home directory|Error finding codex home/i.test(message)) {
    return 'Codex が実行ユーザーのホームディレクトリを取得できません。TaskDesk を通常ユーザーの PowerShell / ターミナルで起動し直し、同じユーザーで codex login status を確認してください。別ユーザーの HOME や CODEX_HOME を指定する方法では修復しません。\n\nCLI の出力:\n' + message;
  }
  return message;
}

function resolveExecutable(command, tool, env = process.env) {
  if (/\.[cm]?js$/i.test(command)) return { command: process.execPath, prefix: [path.resolve(command)] };
  const explicit = /[/\\]/.test(command);
  const dirs = explicit ? [''] : (env.PATH || env.Path || '').split(path.delimiter).concat(process.platform === 'win32' && env.APPDATA ? [path.join(env.APPDATA, 'npm')] : []);
  for (const dir of dirs) {
    const base = explicit ? command : path.join(dir, command);
    const names = process.platform === 'win32' ? [base + '.exe', base] : [base];
    for (const candidate of names) {
      try {
        if (fs.statSync(candidate).isFile() && !/\.(cmd|bat|ps1)$/i.test(candidate)) {
          if (process.platform !== 'win32' || /\.exe$/i.test(candidate)) return { command: candidate, prefix: [] };
        }
      } catch {}
    }
    // npm's Windows shims require cmd.exe. Resolve their JS entry instead so prompt,
    // model and environment values never pass through shell interpolation.
    if (process.platform === 'win32') {
      const entry = tool === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : ['@anthropic-ai', 'claude-code', 'cli.js'];
      const js = path.join(path.dirname(base), 'node_modules', ...entry);
      if (fs.existsSync(js)) return { command: process.execPath, prefix: [js] };
    }
  }
  throw new Error(command + ' が見つかりません。実行マシンで CLI のインストール・ログインを行い、必要ならマシン設定に絶対パスを指定してください');
}
function buildCommand(config, machine) {
  const env = { ...process.env, ...config.env };
  if (!Object.hasOwn(config.env || {}, 'NOTION_TOKEN')) delete env.NOTION_TOKEN;
  const resolved = resolveExecutable(config.tool === 'codex' ? machine.codexPath : machine.claudePath, config.tool, env);
  const args = cliArgs(config);
  return { command: resolved.command, args: resolved.prefix.concat(args), env };
}
function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(); } catch {} });
    killer.on('close', code => { if (code !== 0) { try { child.kill(); } catch {} } });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000);
    timer.unref();
  }
}
async function runAgent(config, machine, prompt, hooks = {}) {
  const prepared = prepare(config, prompt);
  try {
    const c = prepared.config;
    if (c.options.mode !== 'goal') return await runOnce(c, machine, prepared.prompt, hooks);
    if (!config.criteria?.trim()) throw new Error('ゴールモードには完了条件を入力してください');
    const deadline = Date.now() + config.timeoutMinutes * 60000;
    let previous = '';
    for (let attempt = 1; attempt <= c.options.goalMaxAttempts; attempt++) {
      if (hooks.signal?.aborted) throw new Error('実行を停止しました');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('ゴール実行の制限時間を超えました');
      hooks.onLog?.('ゴール確認: ' + attempt + '/' + c.options.goalMaxAttempts);
      hooks.onProgress?.({ attempt, maxAttempts: c.options.goalMaxAttempts });
      const goalPrompt = prepared.prompt + '\n\nゴールモード。完了条件: ' + config.criteria + '\n実作業と検証を進めてください。最終回答は JSON {"completed":boolean,"summary":string,"evidence":string,"nextSteps":string}。完了条件を全て満たし、検証根拠を示せる場合だけ completed=true。未達成なら次の作業を記述。\n前回の結果（ファイルの変更は保持されています）:\n' + previous;
      const result = await runOnce({ ...c, timeoutMinutes: remaining / 60000 }, machine, goalPrompt, hooks);
      previous = result.response;
      let status;
      try { status = JSON.parse(previous); } catch { throw new Error('ゴールの完了判定が JSON ではありません:\n' + previous); }
      if (!status || typeof status.completed !== 'boolean' || ['summary', 'evidence', 'nextSteps'].some(k => typeof status[k] !== 'string')) throw new Error('ゴールの完了判定が不正です:\n' + previous);
      if (status.completed && status.evidence.trim()) return { ...result, response: status.summary + '\n\n検証根拠:\n' + status.evidence, attempts: attempt };
    }
    throw new Error('ゴールは上限回数内に完了しませんでした。成果物と次の作業を確認してください。\n' + previous);
  } finally { prepared.cleanup(); }
}
function runOnce(config, machine, prompt, { onLog = () => {}, onEvent = () => {}, onLaunch = () => {}, signal } = {}) {
  const attemptId = require('node:crypto').randomUUID();
  return new Promise((resolve, reject) => {
    let cmd;
    try {
      if (!config.cwd || !fs.statSync(config.cwd).isDirectory()) throw new Error('作業ディレクトリを確認してください: ' + config.cwd);
      cmd = buildCommand(config, machine);
    } catch (e) { reject(e); return; }
    if (signal?.aborted) { reject(new Error('実行を停止しました')); return; }
    const child = spawn(cmd.command, cmd.args, { cwd: config.cwd, env: cmd.env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', response = '', errorTail = '', agentError = '', interrupted = '', done = false, captured = false;
    const LIMIT = 2 * 1024 * 1024;
    function line(s) {
      if (!s.trim()) return;
      onLog(s.slice(0, 16000));
      try {
        const event = JSON.parse(s);
        for (const message of require('./events.cjs').normalize(event)) onEvent({ ...message, itemId: message.itemId ? attemptId + ':' + message.itemId : undefined });
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') { response = event.item.text || ''; captured = true; }
        if (event.type === 'result') {
          response = event.structured_output ? JSON.stringify(event.structured_output) : event.result || ''; captured = true;
          if (event.is_error) agentError = response || 'Claude Code がエラーを返しました';
        }
        if (event.type === 'turn.failed') agentError = event.error?.message || 'Codex の実行に失敗しました';
      } catch {}
    }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => {
      buffer += text;
      let i; while ((i = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
      if (buffer.length > LIMIT) { interrupted = 'AI の出力が上限を超えました'; killTree(child); }
    });
    child.stderr.on('data', text => { errorTail = (errorTail + text).slice(-12000); onLog(text.slice(-16000)); });
    function abort() { interrupted = '実行を停止しました'; killTree(child); }
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { interrupted = 'タスクの制限時間を超えました'; killTree(child); }, config.timeoutMinutes * 60000);
    function finish(error, code) {
      if (done) return; done = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      if (buffer) line(buffer);
      if (error || interrupted || agentError || code !== 0) reject(new Error(cliErrorMessage(interrupted || agentError || error?.message || 'CLI が終了コード ' + code + ' で終了しました\n' + errorTail)));
      else if (!captured) reject(new Error('CLI の最終結果がありません。対応する CLI バージョンとログを確認してください'));
      else resolve({ response: response.slice(-LIMIT), exitCode: code });
    }
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, code));
    child.stdin.on('error', () => {});
    // Launch with the resolved node settings first, then deliver the prompt to
    // that process. Report the command from the same argv used by spawn.
    child.once('spawn', () => {
      try {
        const args = cmd.args.map(arg => arg.startsWith('mcp_servers.') ? arg.split('=')[0] + '=<設定済み>' : arg);
        onLaunch({ command: cmd.command, args, cwd: config.cwd });
        child.stdin.end(prompt);
      } catch (e) { interrupted = e.message; killTree(child); }
    });
  });
}
function capture(command, args, input, timeout = 20000, { includeStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('接続がタイムアウトしました')); }, timeout);
    function finish(error) { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(includeStderr ? out + err : out); }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', s => { out += s; if (out.length > 8 * 1024 * 1024) { child.kill(); finish(new Error('応答サイズが上限を超えました')); } });
    child.stderr.on('data', s => { err = (err + s).slice(-8000); });
    child.on('error', finish); child.on('close', code => finish(code === 0 ? null : new Error(err || 'プロセスが終了しました: ' + code)));
    child.stdin.on('error', () => {}); child.stdin.end(input || '');
  });
}
function shellQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function sshArgs(machine, remoteCommand) {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-p', String(machine.port), machine.host, remoteCommand];
}
async function remoteScript(machine, source, payload, timeout) {
  const command = shellQuote(machine.nodePath) + ' -e ' + shellQuote(source);
  const output = await capture('ssh', sshArgs(machine, command), JSON.stringify(payload), timeout);
  try { return JSON.parse(output); } catch { throw new Error('SSH から JSON 応答を受信できませんでした。非対話シェルの起動メッセージと Node.js の設定を確認してください'); }
}
async function probe(machine) {
  if (machine.type === 'ssh') return remoteScript(machine, PROBE, { codexPath: machine.codexPath, claudePath: machine.claudePath }, 30000);
  const result = { hostname: os.hostname(), platform: process.platform, node: process.version, runtime: runtimeProfile(), tools: {} };
  for (const tool of ['codex', 'claude']) {
    try {
      const cmd = resolveExecutable(machine[tool + 'Path'], tool);
      const output = (await capture(cmd.command, cmd.prefix.concat('--version'), '', 15000, { includeStderr: true })).trim();
      if (/Could not find home directory|Error finding codex home/i.test(output)) throw new Error(cliErrorMessage(output));
      result.tools[tool] = output;
    } catch (e) { result.tools[tool] = '利用不可: ' + cliErrorMessage(e.message); }
  }
  return result;
}
const PROBE = "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const p=JSON.parse(s),r={hostname:require('os').hostname(),platform:process.platform,node:process.version,tools:{}};for(const t of ['codex','claude']){try{r.tools[t]=require('child_process').execFileSync(p[t+'Path'],['--version'],{encoding:'utf8',timeout:10000}).trim()}catch(e){r.tools[t]='未検出: '+e.message}}process.stdout.write(JSON.stringify(r))});";
module.exports = { runtimeProfile, assertRuntimeProfile, cliErrorMessage, resolveExecutable, buildCommand, runAgent, killTree, capture, shellQuote, sshArgs, remoteScript, probe };
