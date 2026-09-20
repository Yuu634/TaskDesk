'use strict';
const fs = require('node:fs');
if (process.env.FAKE_HOME_ERROR === '1') { console.error('Error finding codex home: Could not find home directory'); process.exit(1); }
if (process.argv.includes('--version')) { console.log('fixture-cli 1.0.0'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', s => prompt += s);
process.stdin.on('end', () => {
  if (process.env.FAKE_CAPTURE) fs.writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), prompt }));
  const name = process.env.FAKE_NAME || 'test';
  if (process.env.FAKE_TRACE) fs.appendFileSync(process.env.FAKE_TRACE, name + '\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }));
  if (process.env.FAKE_EVENTS) {
    console.log(JSON.stringify({ type: 'item.started', item: { id: 'command_1', type: 'command_execution', command: 'fixture check', status: 'in_progress' } }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'command_1', type: 'command_execution', command: 'fixture check', aggregated_output: '確認済み', status: 'completed', exit_code: 0 } }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'message_1', type: 'agent_message', text: '作業を進めています' } }));
  }
  setTimeout(() => {
    if (process.env.FAKE_FAIL_ONCE && !fs.existsSync(process.env.FAKE_FAIL_ONCE)) {
      fs.writeFileSync(process.env.FAKE_FAIL_ONCE, 'failed'); console.error('intentional fixture failure'); process.exit(2);
    }
    if (process.env.FAKE_FAIL === '1') { console.error('intentional fixture failure'); process.exit(2); }
    const plan = { name: 'AI Generated Fixture', nodes: [{ id: 'g', title: '計画', kind: 'group' }, { id: 'a', title: '調査', kind: 'task', parentId: 'g', prompt: '調査を行う', criteria: '調査結果をまとめる', dependsOn: [] }] };
    let text = process.env.FAKE_RESPONSE || (prompt.startsWith('あなたは作業計画の設計者です。') ? JSON.stringify(plan) : '完了: ' + name + '\n' + prompt.slice(0, 120));
    if (prompt.startsWith('あなたはタスク計画者です。')) text = JSON.stringify({summary:'後続 TASK の前に検証を補完',tasks:[{title:'追加検証',prompt:'追加の検証を実施',criteria:'追加検証が成功する'},{title:'エラー表示確認',prompt:'エラー時の表示も確認する',criteria:'エラー表示を確認できる'}]});
    if (prompt.startsWith('あなたはタスクツリーの編集者です。')) {
      const context = JSON.parse(prompt.split('編集コンテキスト JSON:\n')[1].split('\n')[0]);
      const nodes = context.tree.nodes.filter(n => context.editableIds.includes(n.id));
      const target = nodes.find(n => n.kind === 'task') || nodes[0];
      if (target) { target.title += '（再検証）'; target.prompt += '\n原因を調査し、修正後に再検証する。'; }
      else nodes.push({ id:'new_task', kind:'task', title:'調査する', parentId:null, order:0, prompt:'調査する', criteria:'調査済み', dependsOn:[] });
      text = JSON.stringify({ summary:'原因調査と再検証を明示します。', nodes });
    }
    if (process.env.FAKE_GOAL_COUNTER) {
      const counter = process.env.FAKE_GOAL_COUNTER;
      const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
      fs.writeFileSync(counter, String(count));
      text = JSON.stringify({ completed: count >= Number(process.env.FAKE_GOAL_AFTER || 2), summary: 'attempt ' + count, evidence: 'verified ' + count, nextSteps: 'continue' });
    }
    if (process.argv.includes('exec')) console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
    else console.log(JSON.stringify({ type: 'result', is_error: false, result: text }));
  }, Number(process.env.FAKE_DELAY || 80));
});
