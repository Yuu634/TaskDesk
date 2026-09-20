'use strict';
const fs = require('node:fs');
const catalog = {
  projects: [{ id: 'project:test', displayName: '同じリポジトリ' }],
  hosts: [{ id: 'local', kind: 'local', name: 'PC', platform: 'win32' }, { id: 'ssh:fixture', kind: 'ssh', name: 'g15', connected: true, platform: 'linux' }],
  worktrees: [
    { id: 'local-repo::C:/repo', projectId: 'project:test', hostId: 'local', path: 'C:/repo', identity: { key: 'wt2:local:1' }, displayName: 'main' },
    { id: 'ssh-repo::/mnt/repo', projectId: 'project:test', hostId: 'ssh:fixture', path: '/mnt/repo', identity: { key: 'wt2:ssh:1' }, displayName: 'main' }
  ], omittedHostIds: []
};
function respond(args, state, data = catalog, launch) {
  const [kind, action] = args, opt = key => args[args.indexOf(key) + 1];
  if (kind === 'status') return { runtime: { reachable: true, runtimeId: 'runtime-fixture' } };
  if (kind === 'project') return { projects: data.projects };
  if (kind === 'host') return { hosts: data.hosts };
  if (kind === 'worktree') return { worktrees: data.worktrees, hostScope: { omittedHostIds: data.omittedHostIds } };
  if (action === 'create') {
    const w = data.worktrees.find(w => 'identity:' + w.identity.key === opt('--worktree'));
    if (!w) throw Error('missing worktree');
    const tool = (launch || JSON.parse(opt('--launch-spec'))).agent;
    const terminal = { handle: 'term-' + Object.keys(state).length, incarnationId: 'incarnation-' + Object.keys(state).length, worktreeId: w.id, executionHostId: w.hostId, connected: true, writable: true, agentIdentity: tool };
    state[terminal.handle] = terminal; return { terminal };
  }
  const terminal = state[opt('--terminal')];
  if (!terminal) throw Error('missing terminal');
  if (action === 'show') return { terminal };
  if (action === 'wait') return { wait: { handle: terminal.handle, satisfied: true, status: 'idle' } };
  if (action === 'send') { terminal.prompt = opt('--text'); return { send: { handle: terminal.handle, accepted: true, prompt: { requestId: 'request-1', stages: ['input_accepted', 'turn_started'], provider: terminal.agentIdentity, processIncarnation: terminal.incarnationId } } }; }
  if (action === 'read') return { terminal: { tail: ['fixture transcript'] } };
  if (action === 'close') { terminal.connected = false; return { close: { ptyKilled: true } }; }
  if (action === 'switch') return { focus: { handle: terminal.handle } };
  throw Error('Unexpected command: ' + args.join(' '));
}
if (require.main === module) {
  const file = process.env.ORCA_FAKE_FILE, args = process.argv.slice(2), state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.appendFileSync(file + '.calls', JSON.stringify(args) + '\n');
  try {
    const result = respond(args, state);
    fs.writeFileSync(file, JSON.stringify(state));
    process.stdout.write(JSON.stringify({ ok: true, result, _meta: { runtimeId: args[0] === 'host' ? 'local' : 'runtime-fixture' } }));
  } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: { message: e.message, code: 'not_found' } })); process.exitCode = 1; }
}
module.exports = { catalog, respond };
