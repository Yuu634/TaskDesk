'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { atomic, read, assert, now, blankNode, validateTree, ACTIVE } = require('./core.cjs');
const DEFAULT_PAGE = 'https://app.notion.com/p/2283f4d871584f79b4f1f3be02f77334?p=3dfc4f28d28480f9b020c1f92d5c2314&pm=s';
const SCHEMA = { Name: { title: {} }, 'WT Key': { rich_text: {} }, Tree: { rich_text: {} }, Kind: { select: {} }, Parent: { rich_text: {} }, Order: { number: {} }, Prompt: { rich_text: {} }, Criteria: { rich_text: {} }, Dependencies: { rich_text: {} }, State: { rich_text: {} }, Result: { rich_text: {} }, Removed: { checkbox: {} } };
function notionId(value) {
  let candidate = String(value || '').trim();
  if (/^https?:/i.test(candidate)) {
    const u = new URL(candidate); assert(u.protocol === 'https:' && /(^|\.)notion\.(so|com)$/.test(u.hostname), 'Notion の URL を指定してください');
    candidate = u.searchParams.get('p') || u.pathname.split('/').filter(Boolean).at(-1) || '';
  }
  const match = candidate.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  assert(match, 'Notion のページ／データソース ID が不正です');
  return match[1].replace(/-/g, '').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}
function chunks(text, size = 1800) { const chars = Array.from(String(text || '')); const out = []; for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join('')); return out; }
const rich = value => ({ rich_text: chunks(value).map(content => ({ type: 'text', text: { content } })) });
const plain = prop => (prop?.rich_text || prop?.title || []).map(t => t.plain_text ?? t.text?.content ?? '').join('');
function plan(tree) { return { name: tree.name, description: tree.description || '', nodes: tree.nodes.map(n => ({ id: n.id, title: n.title, kind: n.kind, parentId: n.parentId || null, order: n.order, prompt: n.prompt || '', criteria: n.criteria || '', dependsOn: [...n.dependsOn].sort() })).sort((a, b) => a.id.localeCompare(b.id)) }; }
const hash = tree => crypto.createHash('sha256').update(JSON.stringify(plan(tree))).digest('hex');
class Notion {
  constructor(dir, { fetchImpl = fetch, interval = 350 } = {}) {
    this.dir = dir; this.fetch = fetchImpl; this.interval = interval; this.tail = Promise.resolve(); this.nextRequest = 0;
    this.settings = read(path.join(dir, 'notion-settings.json'), { parent: DEFAULT_PAGE, sourceId: '' });
    this.links = read(path.join(dir, 'notion-links.json'), {});
    this.outbox = read(path.join(dir, 'notion-outbox.json'), {});
    this.busy = false; this.lastError = null;
  }
  persist() { atomic(path.join(this.dir, 'notion-links.json'), this.links); atomic(path.join(this.dir, 'notion-outbox.json'), this.outbox); }
  status() { return { parent: this.settings.parent, sourceId: this.settings.sourceId, databaseUrl: this.settings.databaseUrl || '', configured: Boolean(this.settings.token || process.env.NOTION_TOKEN), tokenSource: this.settings.token ? 'local' : process.env.NOTION_TOKEN ? 'environment' : '', links: this.links, pending: Object.values(this.outbox).filter(j => !j.done).length, error: this.lastError }; }
  configure(data) {
    assert(!this.busy, 'Notion の同期が完了してから設定を変更してください');
    const next = { ...this.settings };
    if (data.parent !== undefined) { notionId(data.parent); next.parent = data.parent; }
    if (data.sourceId !== undefined) next.sourceId = data.sourceId ? notionId(data.sourceId) : '';
    if (data.token) { assert(typeof data.token === 'string' && data.token.length < 1000 && !/[\r\n]/.test(data.token), '認証トークンが不正です'); next.token = data.token.trim(); }
    if (data.clearToken) delete next.token;
    this.settings = next; atomic(path.join(this.dir, 'notion-settings.json'), next); return this.status();
  }
  async exclusive(fn) {
    assert(!this.busy, 'Notion は同期中です。完了後に再試行してください'); this.busy = true;
    try { const result = await fn(); this.lastError = null; return result; }
    catch (e) { this.lastError = e.message; throw e; }
    finally { this.busy = false; }
  }
  async request(endpoint, method = 'GET', body) {
    const operation = async () => {
      const token = this.settings.token || process.env.NOTION_TOKEN; assert(token, 'Notion 連携画面で認証トークンを設定してください');
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(r => setTimeout(r, Math.max(0, this.nextRequest - Date.now())));
        this.nextRequest = Date.now() + this.interval;
        let response;
        try { response = await this.fetch('https://api.notion.com/v1/' + endpoint, { method, redirect: 'error', headers: { Authorization: 'Bearer ' + token, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) }); }
        catch { throw new Error('Notion に接続できませんでした。接続設定とネットワークを確認してください'); }
        if (response.status === 429 && attempt < 2) { this.nextRequest = Date.now() + Math.min(60000, Math.max(1000, Number(response.headers.get('retry-after') || 1) * 1000)); continue; }
        const result = await response.json();
        // Do not expose upstream request details or credentials in API errors.
        assert(response.ok, 'Notion API ' + response.status + ' (' + String(result.code || 'error').replace(/[^a-z_]/g, '').slice(0, 60) + ')。ページの接続共有と読み取り・追加・更新権限を確認してください');
        return result;
      }
    };
    const result = this.tail.then(operation, operation); this.tail = result.catch(() => {}); return result;
  }
  async verify(source = this.settings.sourceId) {
    assert(source, 'データソース ID を設定するか、保存用データベースを作成してください');
    const ds = await this.request('data_sources/' + notionId(source));
    for (const [key, type] of Object.entries(SCHEMA)) assert(ds.properties?.[key]?.type === Object.keys(type)[0], 'TaskDesk 用の列が不足、または型が異なります: ' + key + '。専用データベースを作成してください');
    return ds;
  }
  async createDatabase() {
    assert(!this.settings.sourceId, 'データソースは設定済みです');
    // Recover a previous successful creation whose response was lost.
    const parent = notionId(this.settings.parent), children = await this.list('blocks/' + parent + '/children');
    const existing = children.filter(b => b.type === 'child_database' && b.child_database.title === 'TaskDesk');
    assert(existing.length <= 1, 'TaskDesk データベースが複数あります。データソース ID を指定してください');
    const db = existing.length ? await this.request('databases/' + existing[0].id) : await this.request('databases', 'POST', { parent: { type: 'page_id', page_id: parent }, title: [{ text: { content: 'TaskDesk' } }], initial_data_source: { properties: SCHEMA } });
    const source = db.data_sources?.[0]?.id; assert(source, '作成されたデータソースを取得できません'); await this.verify(source);
    this.settings.sourceId = source; this.settings.databaseUrl = db.url || 'https://www.notion.so/' + db.id.replace(/-/g, ''); atomic(path.join(this.dir, 'notion-settings.json'), this.settings); return this.status();
  }
  async list(endpoint, query) {
    let cursor, all = [];
    do {
      const result = query ? await this.request(endpoint, 'POST', { ...query, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }) : await this.request(endpoint + '?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''));
      all.push(...result.results); cursor = result.has_more ? result.next_cursor : null;
      assert(all.length <= 10000, 'Notion の取得件数が上限を超えました');
    } while (cursor);
    return all;
  }
  rows(source, treeId) { return this.list('data_sources/' + notionId(source) + '/query', { filter: { property: 'Tree', rich_text: { equals: treeId } } }); }
  decode(tree, rows) {
    const live = rows.filter(r => !r.properties.Removed?.checkbox), headers = live.filter(r => r.properties.Kind?.select?.name === 'Tree');
    assert(headers.length === 1, 'Notion のツリー行が存在しないか重複しています');
    const header = headers[0].properties;
    const nodes = live.filter(r => ['Task', 'Group'].includes(r.properties.Kind?.select?.name)).map(r => {
      const p = r.properties, id = plain(p['WT Key']).slice((tree.id + ':').length);
      assert(plain(p['WT Key']) === tree.id + ':' + id, 'Notion のノードキーが不正です');
      return { ...blankNode(), ...tree.nodes.find(n => n.id === id), id, title: plain(p.Name), kind: p.Kind.select.name === 'Group' ? 'group' : 'task', parentId: plain(p.Parent) || null, order: p.Order?.number ?? 0, prompt: plain(p.Prompt), criteria: plain(p.Criteria), dependsOn: plain(p.Dependencies).split(/\s*,\s*/).filter(Boolean) };
    });
    return { ...tree, name: plain(header.Name), description: plain(header.Prompt), nodes };
  }
  async upsert(source, rows, key, properties) {
    const found = rows.filter(r => plain(r.properties['WT Key']) === key); assert(found.length <= 1, 'Notion の WT Key が重複しています: ' + key);
    const page = found.length ? await this.request('pages/' + found[0].id, 'PATCH', { properties }) : await this.request('pages', 'POST', { parent: { type: 'data_source_id', data_source_id: source }, properties });
    if (!found.length) rows.push(page); return page;
  }
  async push(tree) {
    const link = this.links[tree.id], source = link?.sourceId || this.settings.sourceId; await this.verify(source);
    const rows = await this.rows(source, tree.id);
    if (link?.hash && !link.incomplete) assert(hash(this.decode(tree, rows)) === link.hash, 'Notion 側に変更があります。「Notion から取得」で確認してから保存してください');
    this.links[tree.id] = { ...link, sourceId: source, incomplete: true }; this.persist();
    const entries = [{ id: 'tree', title: tree.name, kind: 'Tree', prompt: tree.description }, ...tree.nodes.map(n => ({ ...n, kind: n.kind === 'group' ? 'Group' : 'Task' }))];
    for (const n of entries) {
      const key = tree.id + ':' + n.id;
      await this.upsert(source, rows, key, { Name: { title: rich(n.title).rich_text }, 'WT Key': rich(key), Tree: rich(tree.id), Kind: { select: { name: n.kind } }, Parent: rich(n.parentId), Order: { number: n.order || 0 }, Prompt: rich(n.prompt), Criteria: rich(n.criteria), Dependencies: rich((n.dependsOn || []).join(',')), Removed: { checkbox: false } });
    }
    const keys = new Set(entries.map(n => tree.id + ':' + n.id));
    for (const row of rows) if (['Tree', 'Group', 'Task'].includes(row.properties.Kind?.select?.name) && !keys.has(plain(row.properties['WT Key']))) await this.request('pages/' + row.id, 'PATCH', { properties: { Removed: { checkbox: true } } });
    this.links[tree.id] = { sourceId: source, hash: hash(tree), syncedAt: now(), incomplete: false }; this.persist(); return this.status();
  }
  async pull(tree, machines, discardLocal = false) {
    const link = this.links[tree.id]; if (!link) return tree;
    assert(!link.incomplete, 'Notion への保存が未完了です。「ツリーを Notion に保存」を再実行してください');
    assert(discardLocal || hash(tree) === link.hash, 'ローカルの計画が変更されています。先に Notion に保存するか、取得時にローカル計画の置き換えを選択してください');
    const rows = await this.rows(link.sourceId, tree.id), next = this.decode(tree, rows); validateTree(next, machines);
    next.notionContext = rows.filter(r => r.properties.Kind?.select?.name === 'Result' && !r.properties.Removed?.checkbox).sort((a, b) => b.created_time.localeCompare(a.created_time)).slice(0, 12).map(r => ({ task: plain(r.properties.Name), result: plain(r.properties.Result), status: plain(r.properties.State) }));
    if (hash(next) !== hash(tree)) { next.revision++; next.updatedAt = now(); }
    this.links[tree.id] = { ...link, hash: hash(next), syncedAt: now() }; this.persist(); return next;
  }
  async saveResult(job) {
    const rows = await this.rows(job.sourceId, job.treeId), key = 'result:' + job.runId + ':' + job.nodeId;
    const properties = { Name: { title: rich(job.title).rich_text }, 'WT Key': rich(key), Tree: rich(job.treeId), Kind: { select: { name: 'Result' } }, State: rich(job.status), Result: rich(job.text.slice(-12000)), Removed: { checkbox: false } };
    const page = await this.upsert(job.sourceId, rows, key, properties);
    const content = chunks(job.text).map(text => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(text).rich_text } }));
    const existing = await this.list('blocks/' + page.id + '/children');
    // Prefix reconciliation makes retries safe after an ambiguous append response.
    assert(existing.length <= content.length && existing.every((b, i) => plain({ rich_text: b.paragraph?.rich_text }) === plain({ rich_text: content[i].paragraph.rich_text })), 'Notion の結果本文が編集されています。ローカルの結果は保持されています');
    for (let i = existing.length; i < content.length; i += 50) await this.request('blocks/' + page.id + '/children', 'PATCH', { children: content.slice(i, i + 50) });
  }
  async syncResults(store) {
    if (this.busy) return;
    for (const run of store.data.runs) {
      if (!run.notionSource) continue;
      const state = store.state(run), snapshot = read(path.join(store.runDir(run.id), 'input.json'))?.tree;
      for (const [nodeId, result] of Object.entries(state.nodes || {})) {
        if (!['succeeded', 'failed', 'cancelled'].includes(result.status) || result.reused) continue;
        const key = run.id + ':' + nodeId; if (this.outbox[key]) continue;
        const node = snapshot?.nodes.find(n => n.id === nodeId);
        this.outbox[key] = { sourceId: run.notionSource, treeId: run.treeId, runId: run.id, nodeId, title: node?.title || nodeId, status: result.status, text: '実行: ' + run.id + '\nタスク: ' + (node?.title || nodeId) + '\n日時: ' + (result.finishedAt || state.finishedAt || '') + '\n\n依頼:\n' + (node?.chatMessage || node?.prompt || '') + '\n\n結果:\n' + (result.response || '') + (result.error ? '\n\nエラー:\n' + result.error : ''), attempts: 0 };
      }
    }
    this.persist();
    const job = Object.values(this.outbox).find(j => !j.done && (!j.retryAt || Date.parse(j.retryAt) <= Date.now())); if (!job) return;
    try { await this.exclusive(async () => { await this.saveResult(job); job.done = true; job.syncedAt = now(); delete job.text; delete job.error; }); }
    catch (e) { job.attempts++; job.error = e.message; job.retryAt = new Date(Date.now() + Math.min(300000, 10000 * 2 ** Math.min(job.attempts, 5))).toISOString(); }
    finally { this.persist(); }
  }
}
module.exports = { Notion, notionId, plan, hash, rich, plain, SCHEMA, DEFAULT_PAGE };
