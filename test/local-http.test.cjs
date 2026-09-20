'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../server.cjs');
const { localRequestError } = require('../lib/local-http.cjs');

function request(overrides = {}) {
  return { method: 'GET', url: '/api/state', socket: { remoteAddress: '127.0.0.1', localPort: 4317 },
    rawHeaders: ['Host', 'localhost:4317'], headers: { host: 'localhost:4317' }, ...overrides };
}
test('local HTTP guard accepts localhost and rejects non-loopback peers even with forged headers', () => {
  assert.equal(localRequestError(request()), null);
  for (const remoteAddress of ['192.168.1.20', '10.0.0.5', '203.0.113.1', '::', undefined]) {
    assert(localRequestError(request({ socket: { remoteAddress, localPort: 4317 }, headers: { host: 'localhost:4317', 'x-forwarded-for': '127.0.0.1' } })));
  }
});
test('local HTTP guard checks exact host, actual port, duplicate Host and request target', () => {
  for (const host of ['evil.example:4317', 'localhost.evil.example:4317', 'localhost:4318', 'localhost', '0.0.0.0:4317', '127.0.0.1:65536']) {
    assert(localRequestError(request({ headers: { host } })));
  }
  assert(localRequestError(request({ rawHeaders: ['Host', 'localhost:4317', 'host', 'evil.example'] })));
  assert(localRequestError(request({ url: 'http://evil.example/api/state' })));
  assert(localRequestError(request({ url: '//evil.example/api/state' })));
  assert.equal(localRequestError(request({ headers: { host: '127.0.0.1:4317' } })), null);
});
test('local HTTP guard rejects cross-origin reads and writes, including other local ports', () => {
  for (const method of ['GET', 'POST']) {
    for (const origin of ['http://localhost:9000', 'https://evil.example', 'null', '']) {
      assert(localRequestError(request({ method, headers: { host: 'localhost:4317', origin } })));
    }
    for (const site of ['cross-site', 'same-site']) {
      assert(localRequestError(request({ method, headers: { host: 'localhost:4317', 'sec-fetch-site': site } })));
    }
  }
  assert.equal(localRequestError(request({ headers: { host: 'localhost:4317', origin: 'http://localhost:4317', 'sec-fetch-site': 'same-origin' } })), null);
});
test('only public entry-page navigation is allowed from external links', () => {
  const navigation = request({ url: '/', headers: { host: 'localhost:4317', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  assert.equal(localRequestError(navigation), null);
  assert(localRequestError({ ...navigation, url: '/api/session' }));
  assert(localRequestError({ ...navigation, method: 'POST' }));
});
test('server binds only to loopback and enforces the policy over actual HTTP', async t => {
  const root = path.resolve(__dirname, '../.test-data'); fs.mkdirSync(root, { recursive: true });
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(root, 'local-http-')), port: 0 });
  const address = await app.listen(); t.after(() => app.close());
  assert.equal(address.address, '127.0.0.1');
  function get(target, headers) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: address.port, path: target, headers }, res => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      }); req.on('error', reject);
    });
  }
  const host = 'localhost:' + address.port;
  const ok = await get('/api/state', { Host: host }); assert.equal(ok.status, 200);
  assert.equal(ok.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal((await get('/api/state', { Host: 'evil.example:' + address.port })).status, 403);
  assert.equal((await get('/api/session', { Host: host, Origin: 'http://localhost:9000' })).status, 403);
  assert.equal((await get('/api/state', { Host: host, 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await get('/', { Host: host, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' })).status, 200);
});
