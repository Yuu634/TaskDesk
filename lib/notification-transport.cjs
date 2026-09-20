'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { capture, remoteScript } = require('./executor.cjs');
const { isWSL } = require('./local-path.cjs');
const SOURCE = fs.readFileSync(path.join(__dirname, 'codex-notify.cjs'), 'utf8');
// Fixed code; configuration and source travel over stdin, never through a shell.
const BOOT = "let b='';process.stdin.on('data',s=>b+=s);process.stdin.on('end',async()=>{try{const p=JSON.parse(b);const m={exports:{}};new Function('require','module','exports',p.source)(require,m,m.exports);const r=await m.exports.handle(p);process.stdout.write(JSON.stringify(r))}catch(e){console.error(e.message);process.exitCode=1}})";
function transportFor(selection, machines = []) {
  if (selection.notificationMode === 'manual') return null;
  if (selection.hostId === 'local') {
    if (isWSL && selection.platform === 'win32') return { type: 'local', command: 'node.exe' };
    if (selection.platform && selection.platform !== process.platform) throw Error('Orca と TaskDesk のローカル OS が一致しません');
    return { type: 'local', command: process.execPath };
  }
  if (!selection.notificationMachineId) return null;
  const machine = machines.find(m => m.id === selection.notificationMachineId && m.type === 'ssh');
  if (!machine) throw Error('通知回収用の SSH 接続がありません');
  return { type: 'ssh', machine };
}
async function invoke(transport, request) {
  const p = { ...request, source: SOURCE };
  if (transport.type === 'ssh') return remoteScript(transport.machine, BOOT, p, 25000);
  return JSON.parse(await capture(transport.command, ['-e', BOOT], JSON.stringify(p), 25000));
}
async function prepare(selection, machines, ids) {
  const transport = transportFor(selection, machines);
  if (!transport) return null;
  const context = await invoke(transport, { action: 'prepare', ...ids, attemptId: crypto.randomUUID(), token: crypto.randomBytes(24).toString('hex'), cwd: selection.path, hostId: selection.hostId, identityKey: selection.identityKey });
  return { transport, context };
}
function request(prepared, action, payload = {}) { return invoke(prepared.transport, { action, dir: prepared.context.dir, token: prepared.context.token, ...payload }); }
module.exports = { transportFor, prepare, request, BOOT };
