'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), path=require('node:path'), fs=require('node:fs'), os=require('node:os');
const {executionEnv,resolveExecutable,capture}=require('../lib/executor.cjs');
test('CLI environment exposes the server Node directory without changing the parent environment',async()=>{
  const before=process.env.PATH;
  const env=executionEnv({PATH:path.join(os.tmpdir(),'missing-taskdesk-cli'),TASKDESK_PATH_TEST:'retained'});
  const key=Object.keys(env).find(k=>k.toUpperCase()==='PATH');
  assert.equal(env[key].split(path.delimiter)[0],path.dirname(process.execPath));
  assert.equal(env.TASKDESK_PATH_TEST,'retained'); assert.equal(process.env.PATH,before);
  assert.equal((await capture(process.execPath,['-e','process.stdout.write(process.env.TASKDESK_PATH_TEST)'],'',5000,{env})), 'retained');
});
test('a POSIX CLI shim finds Node with an initially missing runtime PATH', {skip:process.platform==='win32'},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'taskdesk-cli-path-'));
  try {
    const file=path.join(dir,'fixture-cli'); fs.writeFileSync(file,'#!/bin/sh\nexec node -e \'process.stdout.write("shim-ok")\'\n',{mode:0o700});
    const env=executionEnv({PATH:dir}), cmd=resolveExecutable('fixture-cli','codex',env);
    assert.equal(await capture(cmd.command,[],'',5000,{env}),'shim-ok');
    assert.equal(resolveExecutable(file,'codex',env).command,file);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
