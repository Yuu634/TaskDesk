'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,expect}=require(process.env.WORK_TREE_PLAYWRIGHT || '@playwright/test');
const {createApp}=require('../server.cjs'),{blankTree,blankNode}=require('../lib/core.cjs');
async function main(){
 const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(root,'.test-data/mobile-input-'));
 const app=createApp({dataDir:dir,port:0}),address=await app.listen(),base='http://127.0.0.1:'+address.port;
 let browser;
 try{
  const token=(await(await fetch(base+'/api/session')).json()).token,node=blankNode({prompt:'元の指示'});
  const tree=await(await fetch(base+'/api/trees',{method:'POST',headers:{'Content-Type':'application/json','X-Work-Tree-Token':token},body:JSON.stringify(blankTree({name:'スマホ入力',nodes:[node]}))})).json();
  browser=await chromium.launch({headless:true,...(process.env.WORK_TREE_BROWSER_CHANNEL?{channel:process.env.WORK_TREE_BROWSER_CHANNEL}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let busy=false,tick=0;
  await page.route('**/api/state',async route=>{const r=await route.fetch(),s=await r.json();s.mobileTestTick=++tick;if(busy)s.runs.unshift({id:'mobile-test-run',kind:'node',treeId:tree.id,treeRevision:s.trees.find(t=>t.id===tree.id).revision,executionBackend:'direct',createdAt:new Date().toISOString(),state:{status:'running',currentNodeId:node.id,nodes:{[node.id]:{status:'running'}}}});await route.fulfill({json:s});});
  await page.goto(base);await page.locator('[data-tree="'+tree.id+'"]').tap();await page.locator('[data-node="'+node.id+'"]').tap();
  const prompt=page.locator('[data-field="prompt"]'),criteria=page.locator('[data-field="criteria"]');
  await expect(prompt).toHaveAttribute('inputmode','text');await expect(prompt).toHaveAttribute('virtualkeyboardpolicy','auto');
  await prompt.tap();await expect(prompt).toBeFocused();
  await prompt.fill('');await page.keyboard.insertText('日本語のプロンプト\nスマホから入力');
  await criteria.tap();await criteria.fill('');await page.keyboard.insertText('入力が保存される');
  await page.keyboard.press('Control+s');await expect(page.locator('#node-footer')).toContainText('設定は保存済み');
  const saved=(await(await fetch(base+'/api/state')).json()).trees.find(t=>t.id===tree.id).nodes[0];
  assert.equal(saved.prompt,'日本語のプロンプト\nスマホから入力');assert.equal(saved.criteria,'入力が保存される');
  await page.locator('#result-tab').tap();const extra=page.locator('#followup-prompt');
  await extra.tap();await extra.fill('日本語の変換中');await extra.dispatchEvent('compositionstart',{data:'にほんご'});
  await extra.evaluate(el=>{window.mobileEditor=el;el.setSelectionRange(3,3);});
  busy=true;const previous=tick;await expect.poll(()=>tick).toBeGreaterThan(previous+1);
  await expect(extra).toBeFocused();assert(await extra.evaluate(el=>el===window.mobileEditor));assert.equal(await extra.evaluate(el=>el.selectionStart),3);
  await extra.dispatchEvent('compositionend',{data:'日本語'});await expect(extra).toHaveValue('日本語の変換中');
  await page.setViewportSize({width:390,height:430});await extra.tap();
  await expect.poll(()=>page.locator('#node-dialog').evaluate(el=>el.getBoundingClientRect().bottom<=visualViewport.offsetTop+visualViewport.height)).toBe(true);
  assert.equal(await extra.evaluate(el=>getComputedStyle(el).fontSize),'16px');
  await page.screenshot({path:path.join(dir,'mobile-keyboard-viewport.png')});
  await page.locator('#close-node').tap();busy=false;
  await page.locator('#new-tree').tap();const purpose=page.locator('#brief-purpose');await purpose.tap();await page.keyboard.insertText('新しい計画');await expect(purpose).toHaveValue('新しい計画');await expect(purpose).toBeFocused();
  assert.deepEqual(errors,[]);console.log('Mobile input passed: touch focus, Japanese text, persistence, IME/focus during polling, reduced viewport, creation fields. Artifacts: '+dir);
 }finally{await browser?.close();await app.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
