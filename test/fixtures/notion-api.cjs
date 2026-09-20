'use strict';
const { SCHEMA, plain } = require('../../lib/notion.cjs');
const { randomUUID } = require('node:crypto');
function fixture() {
  const source = randomUUID(), database = randomUUID(), rows = [], blocks = new Map(), calls = [];
  let failAppendOnce = false, offline = false;
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  return { source, rows, blocks, calls, set offline(v) { offline = v; }, set failAppendOnce(v) { failAppendOnce = v; }, async fetch(url, options) {
    if (offline) throw new Error('offline');
    const u = new URL(url), endpoint = u.pathname.slice(4), b = options.body ? JSON.parse(options.body) : null;
    calls.push({ endpoint, body: b, method: options.method, headers: options.headers });
    if (endpoint === 'databases' && options.method === 'POST') return response({ id: database, data_sources: [{ id: source }] });
    if (endpoint === 'data_sources/' + source && options.method === 'GET') return response({ id: source, properties: Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, { type: Object.keys(v)[0] }])) });
    if (endpoint === 'data_sources/' + source + '/query') return response({ results: rows.filter(r => plain(r.properties.Tree) === b.filter.rich_text.equals), has_more: false });
    if (endpoint === 'pages' && options.method === 'POST') { const row = { id: randomUUID(), properties: b.properties, created_time: new Date().toISOString() }; rows.push(row); return response(row); }
    if (endpoint.startsWith('pages/') && options.method === 'PATCH') { const row = rows.find(r => r.id === endpoint.slice(6)); Object.assign(row.properties, b.properties); return response(row); }
    if (/^blocks\/[^/]+\/children$/.test(endpoint)) {
      const key = endpoint.split('/')[1];
      if (options.method === 'GET') return response({ results: blocks.get(key) || [], has_more: false });
      blocks.set(key, [...(blocks.get(key) || []), ...b.children]);
      if (failAppendOnce) { failAppendOnce = false; throw new Error('response lost after server append'); }
      return response({ results: b.children });
    }
    return response({ code: 'object_not_found' }, 404);
  } };
}
module.exports = { fixture };
