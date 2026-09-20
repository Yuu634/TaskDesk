'use strict';

// Keep the bind address fixed: HOST and proxy headers must never widen access.
const BIND_ADDRESS = '127.0.0.1';
const localUrl = port => 'http://localhost:' + port;

function localRequestError(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    return 'この PC 内からの接続だけを許可しています';
  }
  const raw = req.rawHeaders || [];
  if (raw.filter((_, i) => i % 2 === 0 && raw[i].toLowerCase() === 'host').length !== 1) {
    return 'Host ヘッダーが不正です';
  }
  const host = req.headers.host || '';
  const match = /^(localhost|127\.0\.0\.1)(?::([1-9]\d{0,4}))?$/.exec(host);
  if (!match || Number(match[2] || 80) !== req.socket.localPort) {
    return 'このサーバーの localhost アドレスでアクセスしてください';
  }
  if (!req.url.startsWith('/') || req.url.startsWith('//')) return 'リクエスト URL が不正です';
  if (req.headers.origin !== undefined && req.headers.origin !== 'http://' + host) {
    return '別のサイトやポートからのアクセスは許可されていません';
  }
  const site = req.headers['sec-fetch-site'];
  // Opening the public entry page via a link is fine. API responses and embedded
  // resources cannot be read from another origin, including another local port.
  const entryNavigation = req.method === 'GET' && req.url === '/' &&
    req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
  if (site !== undefined && !['same-origin', 'none'].includes(site) && !entryNavigation) {
    return '外部ページからのアクセスは許可されていません';
  }
  return null;
}

module.exports = { BIND_ADDRESS, localUrl, localRequestError };
