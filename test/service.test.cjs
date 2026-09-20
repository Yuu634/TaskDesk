'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { verifyService } = require('../scripts/service.cjs');

test('service restart verifies PID, platform and data directory before signalling', () => {
  const dir = path.resolve('/tmp/work-tree-test'), record = { pid: 123, port: 4317 };
  const state = { server: { pid: 123, platform: process.platform, dataDir: dir } };
  assert.doesNotThrow(() => verifyService(record, state, dir));
  assert.throws(() => verifyService({ ...record, pid: 456 }, state, dir), /プロセスが一致/);
  assert.throws(() => verifyService(record, { server: { ...state.server, platform: 'other' } }, dir), /別の環境/);
  assert.throws(() => verifyService(record, state, path.resolve('/tmp/other')), /保存先が一致/);
});
