'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LIMIT = 5 * 1024 * 1024;
function upload(root, value) {
  if (typeof value.name !== 'string' || !value.name || value.name.length > 240 || /[\0\r\n]/.test(value.name)) throw new Error('ファイル名が不正です');
  if (typeof value.data !== 'string' || value.data.length > Math.ceil(LIMIT / 3) * 4 || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error('添付ファイルは 5 MB 以内の base64 データで指定してください');
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.toString('base64') !== value.data) throw new Error('base64 データが不正です');
  if (bytes.length > LIMIT) throw new Error('添付ファイルは 5 MB 以内です');
  const item = { id: crypto.randomUUID(), name: value.name, size: bytes.length, kind: /\.(png|jpe?g|webp|gif)$/i.test(value.name) ? 'image' : 'file' };
  const dir = path.join(root, 'attachments'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, item.id + '.json'), JSON.stringify({ ...item, data: bytes.toString('base64') }), { mode: 0o600, flag: 'wx' });
  return item;
}
function hydrate(root, tree) {
  let size = 0;
  const resolve = list => (list || []).map(a => {
    if (!a.id) return a;
    if (!/^[0-9a-f-]{36}$/.test(a.id)) throw new Error('添付 ID が不正です');
    let file;
    try { file = JSON.parse(fs.readFileSync(path.join(root, 'attachments', a.id + '.json'), 'utf8')); }
    catch { throw new Error('添付ファイルが見つかりません。再度追加してください: ' + a.name); }
    size += file.size;
    if (size > 20 * 1024 * 1024) throw new Error('1 回の実行に含められる添付は合計 20 MB 以内です');
    return file;
  });
  return { ...tree, attachments: resolve(tree.attachments), nodes: tree.nodes.map(n => ({ ...n, attachments: resolve(n.attachments) })) };
}
function metadata(tree) {
  const clean = list => (list || []).map(({ data, ...a }) => a);
  return { ...tree, attachments: clean(tree.attachments), nodes: tree.nodes.map(n => ({ ...n, attachments: clean(n.attachments) })) };
}
module.exports = { upload, hydrate, metadata };
