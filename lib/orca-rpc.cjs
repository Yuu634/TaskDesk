'use strict';
// Run beside the desktop CLI (Windows Node when called from WSL). Input uses
// stdin so launch settings and environment never become shell arguments.
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input);
    const { RuntimeClient } = require(request.clientPath);
    const client = new RuntimeClient(undefined, 20000, null, null);
    const status = await client.getCliStatus();
    if (!status.result.runtime.reachable || status.result.runtime.runtimeId !== request.runtimeId) throw Error('Orca の接続または runtime が変わりました');
    // launchAgent is essential: a wrapper command alone does not register the
    // native agent provider, so terminal wait/send cannot observe its lifecycle.
    const result = await client.call('terminal.create', request.params);
    process.stdout.write(JSON.stringify(result));
  } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: { code: e.code, message: e.message } })); process.exitCode = 1; }
});
