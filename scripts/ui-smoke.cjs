'use strict';
// Isolated browser checks; use WORK_TREE_PLAYWRIGHT for an external installation.
const { chromium, expect } = require(process.env.WORK_TREE_PLAYWRIGHT || '@playwright/test');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createApp } = require('../server.cjs');
const { blankTree, blankNode, read, atomic, ACTIVE, id } = require('../lib/core.cjs');
const root = path.resolve(__dirname, '..'), fixture = path.join(root, 'test/fixtures/fake-cli.cjs');
async function main() {
  fs.mkdirSync(path.join(root, '.test-data'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.test-data/layout-')), app = createApp({ dataDir: dir, port: 0 });
  let browser;
  try {
    const address = await app.listen(), base = 'http://127.0.0.1:' + address.port;
    const token = (await (await fetch(base + '/api/session')).json()).token;
    const api = async (url, method, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Work-Tree-Token': token }, body: JSON.stringify(body) });
      const v = await r.json(); assert(r.ok, JSON.stringify(v)); return v;
    };
    await api('/api/machines/local', 'PUT', { name: 'このマシン', codexPath: fixture, claudePath: fixture });
    const wp = blankNode({ kind: 'group', title: '現状を把握して、改善方針を決める' });
    const a = blankNode({ parentId: wp.id, title: '既存の検索処理を調査する', prompt: 'fixture only', cli: { codex: { profile: 'preserved' } }, env: { FAKE_CAPTURE: path.join(dir, 'actual.json') } });
    const b = blankNode({ parentId: wp.id, title: '誤回答の傾向を分類する', order: 1, dependsOn: [a.id], prompt: 'fixture only' });
    const c = blankNode({ parentId: wp.id, title: '評価用データを整理する', order: 2, dependsOn: [a.id], prompt: 'fixture only' });
    const wp2 = blankNode({ kind: 'group', title: '改善案を実装し、効果を検証する', order: 4 });
    const d = blankNode({ parentId: wp2.id, title: '検索処理を改善する', dependsOn: [b.id, c.id], prompt: 'fixture only' });
    const e = blankNode({ parentId: wp2.id, title: '精度を測定して結果をまとめる', order: 1, dependsOn: [d.id], prompt: 'fixture only' });
    const tree = await api('/api/trees', 'POST', blankTree({ name: '検索精度の改善', cwd: dir, cli: { codex: { model: 'inherited-model', effort: 'high' } }, nodes: [wp, a, b, c, wp2, d, e] }));
    const browserEnv = { ...process.env };
    // WSL's minimal Chromium image has no Japanese fonts. Use the local Windows
    // fonts for screenshots, without bundling or changing production assets.
    if (fs.existsSync('/mnt/c/Windows/Fonts/YuGothR.ttc')) {
      const fontConfig = path.join(dir, 'fonts.conf');
      fs.writeFileSync(fontConfig, '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/usr/share/fonts</dir><dir>/mnt/c/Windows/Fonts</dir><cachedir>' + dir + '/font-cache</cachedir></fontconfig>');
      browserEnv.FONTCONFIG_FILE = fontConfig;
    }
    browser = await chromium.launch({ headless: true, env: browserEnv, ...(process.env.WORK_TREE_BROWSER_CHANNEL ? { channel: process.env.WORK_TREE_BROWSER_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.locator('[data-tree="' + tree.id + '"]').click();
    await expect(page).toHaveTitle('TaskDesk');
    await expect(page.locator('[data-action="run-wp"]')).toHaveText('次WPを実行');
    await expect(page.locator('[data-action="run-selected"]')).toHaveText('次TASKを実行');
    await expect(page.locator('#next-execution')).toContainText(a.title);
    assert.equal(await page.locator('#selection-label').count(), 0);
    await expect(page.locator('.wp-panel')).toHaveCount(2);
    await expect(page.locator('#node-dialog')).not.toBeVisible();
    assert.equal(await page.locator('.sidebar,#chat-panel,#plan-list').count(), 0);
    assert((await page.locator('[data-node]').first().boundingBox()).height < 65, 'compact TASK cards');
    assert(!(await page.locator('[data-node]').allTextContents()).some(t => /Codex|Claude|依存/.test(t)));
    const treeBox = await page.locator('#tree-list').boundingBox(), headerBox = await page.locator('#project-header').boundingBox();
    assert(treeBox.y < headerBox.y, 'tree switcher is above the workspace');
    const bBox = await page.locator('[data-node="' + b.id + '"]').boundingBox(), cBox = await page.locator('[data-node="' + c.id + '"]').boundingBox();
    assert.equal(bBox.x, cBox.x, 'tasks share one column');
    assert(cBox.y >= bBox.y + bBox.height, 'dependency branches are stacked vertically');
    await page.screenshot({ path: path.join(dir, 'tree.png'), fullPage: true });
    await page.locator('[data-node="' + a.id + '"]').click();
    await expect(page.locator('#node-dialog')).toBeVisible();
    await expect(page.locator('[data-node-option="model"]')).toHaveValue('inherited-model');
    await expect(page.locator('[data-node-option="effort"]')).toHaveValue('high');
    const model = await page.locator('[data-node-option="model"] option').last().getAttribute('value');
    await page.locator('[data-node-option="model"]').selectOption(model);
    await page.locator('[data-node-option="effort"]').selectOption('medium');
    await page.locator('[data-node-option="approval"]').selectOption('auto-review');
    await page.locator('[data-field="machineId"]').selectOption('local');
    await api('/api/trees', 'POST', blankTree({ name: 'データ取り込みの自動化', nodes: [] }));
    await page.waitForTimeout(2300);
    await expect(page.locator('[data-node-option="effort"]')).toHaveValue('medium');
    await page.locator('[data-field="tool"]').selectOption('claude');
    await page.locator('[data-node-option="model"]').selectOption('sonnet');
    await page.locator('[data-node-option="permissionMode"]').selectOption('dontAsk');
    await page.locator('[data-field="tool"]').selectOption('codex');
    await expect(page.locator('[data-node-option="model"]')).toHaveValue(model);
    await expect(page.locator('[data-node-option="approval"]')).toHaveValue('auto-review');
    // Browser checks submit settings; native PTY behavior is tested by test:herdr.
    let requests = 0;
    await page.route('**/api/trees/*/run', async route => {
      requests++;
      assert.equal(route.request().postDataJSON().nodeId, a.id);
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'UI fixture: 起動の検証済み' }) });
    });
    await page.locator('[data-action="run-node"]').evaluate(b => { b.click(); b.click(); });
    await expect(page.locator('#node-error')).toContainText('UI fixture');
    assert.equal(requests, 1, 'double clicks must not launch twice');
    let savedTree = app.store.data.trees.find(t => t.id === tree.id), saved = savedTree.nodes.find(n => n.id === a.id);
    assert.equal(savedTree.executionBackend, undefined, 'running a task must preserve the selected backend');
    assert.equal(saved.cli.codex.model, model); assert.equal(saved.cli.codex.effort, 'medium');
    assert.equal(saved.cli.codex.approval, 'auto-review');
    assert.equal(saved.cli.codex.profile, 'preserved'); assert.equal(saved.cli.claude.model, 'sonnet');
    await page.screenshot({ path: path.join(dir, 'node.png') });
    await page.locator('#close-node').click();
    await page.locator('[data-action="edit-tree"]').click();
    await expect(page.locator('#node-dialog')).not.toBeVisible();
    await expect(page.locator('#inline-edit-tools')).toBeVisible();
    await page.locator('[data-tree-name]').fill('検索精度の改善・検証');
    await page.locator('[data-inline-field="title"][data-id="' + b.id + '"]').fill('誤回答の原因を特定する');
    // Actual drag moves a task between WP cards.
    // The single-column layout is taller; keep both ends visible for this native drag.
    await page.setViewportSize({ width:1365, height:1600 });
    await page.locator('[data-drag-id="' + c.id + '"]').dragTo(page.locator('.drop-zone[data-drop-parent="' + wp2.id + '"]'));
    await expect(page.locator('[data-drop-parent="' + wp2.id + '"] [data-inline-field="title"][data-id="' + c.id + '"]')).toBeVisible();
    await page.locator('.wp-heading [data-move-node="' + wp.id + '"][data-direction="1"]').click();
    assert.equal(await page.locator('.editable-wp').first().getAttribute('data-drop-node'), wp2.id);
    await expect(page.locator('.editable-wp').first().locator('.wp-index')).toHaveText('WP 01');
    await page.screenshot({ path: path.join(dir, 'editor.png'), fullPage: true });
    await page.locator('[data-action="edit-tree"]').click();
    await expect(page.locator('#inline-edit-tools')).not.toBeVisible();
    savedTree = app.store.data.trees.find(t => t.id === tree.id);
    assert.equal(savedTree.name, '検索精度の改善・検証');
    assert.equal(savedTree.nodes.find(n => n.id === b.id).title, '誤回答の原因を特定する');
    assert.equal(savedTree.nodes.find(n => n.id === c.id).parentId, wp2.id);
    await expect(page.locator('#inline-edit-tools')).not.toBeVisible();
    // Cancelling an edit restores the saved tree without opening a modal.
    await page.locator('[data-action="edit-tree"]').click();
    await page.locator('[data-inline-field="title"][data-id="' + b.id + '"]').fill('破棄する変更');
    await page.locator('[data-action="cancel-edit"]').click();
    await expect(page.locator('[data-node="' + b.id + '"]')).toContainText('誤回答の原因を特定する');
    await page.locator('[data-action="edit-tree"]').click();
    await page.locator('#inline-edit-tools [data-ai-edit]').click();
    await page.locator('#ai-scope').selectOption(b.id);
    await page.locator('#ai-request').fill('原因調査と再検証を明示する');
    await page.locator('[data-ai-generate]').click();
    await expect(page.locator('#manual-proposals [data-proposal-action="apply"]')).toBeVisible({timeout:15000});
    await page.locator('#manual-proposals summary').click();
    await expect(page.locator('#manual-proposals')).toContainText('変更前');
    await page.screenshot({path:path.join(dir,'ai-edit.png'),fullPage:true});
    await page.locator('#manual-proposals [data-proposal-action="apply"]').click();
    await expect(page.locator('[data-inline-field="title"][data-id="'+b.id+'"]')).toHaveValue('誤回答の原因を特定する（再検証）');
    await page.locator('[data-action="edit-tree"]').click();
    await page.locator('#new-tree').click();
    await expect(page.locator('#setting-backend')).toBeVisible();
    await page.locator('#setting-timeout').fill('42');
    for (const [key, value] of Object.entries({ purpose: '議事録を整理する', current: '資料が未整理', flow: '調査、分類、確認', criteria: '全資料を分類済み', constraints: '元データを保持' })) await page.locator('#brief-' + key).fill(value);
    await page.screenshot({ path: path.join(dir, 'create.png') });
    await page.locator('[data-modal-action="generate"]').click();
    await expect(page.locator('#project-header')).toContainText('AI Generated Fixture', { timeout: 15000 });
    assert.equal(await page.locator('#plan-list,[data-import]').count(), 0);
    assert.equal(app.store.data.trees[0].brief.purpose, '議事録を整理する');
    assert.equal(app.store.data.trees[0].timeoutMinutes, 42);
    assert.equal(app.store.data.trees[0].brief.constraints, '元データを保持');
    // Removing every node must not remove the editor's save action.
    const empty = await api('/api/trees', 'POST', blankTree({ name: '空のツリー', nodes: [] }));
    await expect(page.locator('[data-tree="' + empty.id + '"]')).toBeVisible({ timeout: 6000 });
    await page.locator('[data-tree="' + empty.id + '"]').click();
    await page.locator('[data-action="edit-tree"]').first().click();
    await page.locator('[data-tree-name]').fill('空のツリーの改名');
    await page.locator('[data-action="edit-tree"]').click();
    await expect(page.locator('#inline-edit-tools')).not.toBeVisible();
    assert.equal(app.store.data.trees.find(t => t.id === empty.id).name, '空のツリーの改名');
    await page.locator('[data-action="edit-tree"]').first().click();
    await page.locator('[data-action="add-wp"]').click();
    await expect(page.locator('.editable-wp')).toHaveCount(1);
    await page.locator('[data-add-to]').click();
    await expect(page.locator('.editable.tree-node')).toHaveCount(1);
    page.once('dialog', d => d.accept());
    await page.locator('.editable.tree-node [data-remove-node]').click();
    await expect(page.locator('.editable.tree-node')).toHaveCount(0);
    await page.locator('[data-action="edit-tree"]').click();
    await page.locator('[data-tree="' + tree.id + '"]').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
    await page.screenshot({ path: path.join(dir, 'mobile-tree.png'), fullPage: true });
    await page.locator('[data-node="' + a.id + '"]').click();
    const mobile = await page.locator('#node-dialog').boundingBox(), footer = await page.locator('#node-footer').boundingBox();
    assert(mobile.x >= 0 && mobile.x + mobile.width <= 390);
    assert(footer.y + footer.height <= 844 && footer.height > 0);
    await page.screenshot({ path: path.join(dir, 'mobile.png') });
    await page.locator('#close-node').click();
    // Exercise the completion dialog independently of an AI service.
    let showInteractive = true, confirmed = null;
    await page.route('**/api/state', async route => {
      const response = await route.fetch(), value = await response.json();
      const saved = value.trees.find(t => t.id === tree.id);
      if (showInteractive) value.runs.unshift({ id: 'ui-interactive', kind: 'node', treeId: tree.id, treeRevision: saved.revision, executionBackend: 'herdr', createdAt: new Date().toISOString(), state: { status: 'running', currentNodeId: a.id, nodes: { [a.id]: { status: 'running', interactive: { phase: 'ready' } } } } });
      await route.fulfill({ response, json: value });
    });
    await page.route('**/api/runs/ui-interactive/control', async route => {
      confirmed = route.request().postDataJSON(); showInteractive = false;
      await route.fulfill({ json: { ok: true } });
    });
    await page.locator('#project-header [data-complete-run]').click({ timeout: 6000 });
    await page.locator('[data-modal-action="complete"]').click();
    await expect(page.locator('#modal-error')).toContainText('結果の要約');
    await page.locator('#complete-outcome').selectOption('unexpected');
    await page.locator('#complete-response').fill('調査と検証を完了しました');
    await page.locator('[data-modal-action="complete"]').click();
    await expect(page.locator('#modal')).not.toBeVisible();
    assert.deepEqual(confirmed, { action: 'complete', nodeId: a.id, response: '調査と検証を完了しました', outcome: 'unexpected' });
    // A real failed fixture task creates an inline proposal under its card.
    await page.setViewportSize({width:1440,height:1000});
    const bad=blankNode({title:'失敗から見直すTASK',prompt:'fail',env:{FAKE_FAIL:'1'}});
    const failure=await api('/api/trees','POST',blankTree({name:'試行錯誤',cwd:dir,nodes:[bad]}));
    await api('/api/trees/'+failure.id+'/run','POST',{});
    await page.locator('[data-tree="'+failure.id+'"]').click({timeout:6000});
    const suggestion=page.locator('[data-task-proposals="'+bad.id+'"]');
    await expect(suggestion.locator('[data-proposal-action="apply"]')).toBeVisible({timeout:15000});
    await expect(page.locator('[data-node="'+bad.id+'"]')).toContainText('エラー');
    await page.screenshot({path:path.join(dir,'result-proposal.png'),fullPage:true});
    await suggestion.locator('[data-proposal-action="dismiss"]').click();
    await expect(suggestion).toContainText('見送りました');
    // A long canvas scrolls at both edges while dragging, and stops after drop.
    const longNodes=[];
    for(let i=0;i<16;i++){const wp=blankNode({kind:'group',title:'WP '+(i+1),order:i});longNodes.push(wp,blankNode({parentId:wp.id,title:'TASK '+(i+1),prompt:'test'}));}
    const longTree=await api('/api/trees','POST',blankTree({name:'スクロール検証',nodes:longNodes}));
    await page.locator('[data-tree="'+longTree.id+'"]').click({timeout:6000});
    await page.locator('[data-action="edit-tree"]').click();
    await page.evaluate(()=>window.scrollTo(0,0));
    const dt=await page.evaluateHandle(()=>new DataTransfer());
    await page.locator('[data-drag-id="'+longNodes[0].id+'"]').dispatchEvent('dragstart',{dataTransfer:dt,clientX:400,clientY:500});
    await page.evaluate(()=>document.dispatchEvent(new DragEvent('dragover',{bubbles:true,clientX:600,clientY:innerHeight-5})));
    await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(600);
    await page.evaluate(()=>document.dispatchEvent(new DragEvent('dragover',{bubbles:true,clientX:600,clientY:5})));
    await expect.poll(()=>page.evaluate(()=>scrollY)).toBeLessThan(80);
    await page.evaluate(()=>document.dispatchEvent(new DragEvent('dragover',{bubbles:true,clientX:600,clientY:innerHeight-5})));
    await expect.poll(()=>page.evaluate(()=>scrollY),{timeout:10000}).toBeGreaterThan(1800);
    const last=page.locator('.editable-wp').last(), box=await last.boundingBox();
    await last.dispatchEvent('drop',{dataTransfer:dt,clientX:box.x+30,clientY:box.y+box.height-5});
    assert.equal(await page.locator('.editable-wp').last().getAttribute('data-drop-node'),longNodes[0].id);
    const afterDrop=await page.evaluate(()=>scrollY);await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>scrollY),afterDrop);
    await page.locator('[data-action="edit-tree"]').click();
    assert.deepEqual(errors, []);
    console.log('UI passed: compact cards, settings and backend preservation, direct rename/drag/add/delete/cancel/save, AI scoped apply, automatic error proposals, outcome selection, WP ordering, drag autoscroll, mobile.\nArtifacts: ' + dir);
  } finally {
    await browser?.close();
    for (const run of app.store.data.runs) if (ACTIVE.has(app.store.state(run).status)) atomic(path.join(app.store.runDir(run.id), 'control.json'), { id: id(), action: 'stop' });
    await app.close();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
