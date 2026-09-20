'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {blankTree,blankNode}=require('../lib/core.cjs');
const insertion=require('../lib/task-insertion.cjs');
const {Proposals}=require('../lib/proposals.cjs');
function fixture(){
  const group=blankNode({kind:'group'}), a=blankNode({parentId:group.id,order:0,prompt:'現在の作業'}), b=blankNode({parentId:group.id,order:1,prompt:'次の作業'});
  const tree=blankTree({nodes:[group,a,b],cwd:process.cwd()});
  const p={baseTree:tree,anchorId:a.id,request:'- 調査\n- 検証'};
  const output=JSON.stringify({summary:'不足を補完',tasks:[{title:'調査',prompt:'原因を調査する',criteria:'原因が特定される'},{title:'検証',prompt:'修正を検証する',criteria:'検証が成功する'}]});
  return {tree,a,b,p,output,machines:[{id:'local',type:'local'}]};
}
test('generated tasks fill the gap in order and preserve existing settings and next task',()=>{
  const {tree,a,b,p,output,machines}=fixture();
  const parsed=insertion.parse(output,p,machines), next=insertion.insert(tree,a.id,parsed.nodes);
  const siblings=next.nodes.filter(n=>n.parentId===a.parentId).sort((a,b)=>a.order-b.order);
  assert.deepEqual(siblings.map(n=>n.title),[a.title,'調査','検証',b.title]);
  assert.deepEqual(siblings[1].dependsOn,[a.id]); assert.deepEqual(siblings[2].dependsOn,[siblings[1].id]);
  assert.deepEqual({...siblings[3],order:b.order},b); assert.equal(tree.nodes.length,3);
  assert.match(insertion.instruction(p),/次の作業/);
  assert.throws(()=>insertion.parse(JSON.stringify({summary:'bad',tasks:[{title:'x',prompt:'y',criteria:'z',cwd:'/tmp'}]}),p,machines),/実行設定/);
  assert.throws(()=>insertion.parse('{"summary":"bad","tasks":[]}',p,machines),/形式/);
});
test('generation auto-applies once in the background without Orca and refuses a changed revision',async()=>{
  for(const stale of [false,true]) {
    const {tree,a,output,machines}=fixture(); tree.executionBackend='orca'; tree.orca={projectId:'project:test',worktreeId:'worktree:test',hostId:'local',path:process.cwd()};
    const states=new Map(), store={data:{trees:[tree],runs:[],machines},save(){},state:r=>states.get(r.id)};
    const proposals=new Proposals(store,async(planner,kind)=>{
      assert.equal(kind,'plan'); assert.equal(planner.executionBackend,'direct'); assert.equal(planner.orca,undefined); assert.equal(planner.runnerId,'local'); assert.equal(planner.cwd,process.cwd());
      assert.equal(planner.nodes[0].sandbox,'read-only'); assert.match(planner.nodes[0].prompt,/次の作業/);
      const run={id:'generation'}; store.data.runs.push(run); states.set(run.id,{status:'succeeded',nodes:{plan:{response:output}}}); return run;
    },r=>states.get(r.id),()=>{},()=>{});
    await proposals.create(tree,{revision:tree.revision,scope:'insert',nodeId:a.id,request:'- 調査\n- 検証'});
    if(stale) tree.revision++;
    await proposals.tick(); await proposals.tick();
    assert.equal(proposals.list[0].status,stale?'failed':'applied',proposals.list[0].error);
    assert.equal(store.data.trees[0].nodes.length,stale?3:5);
  }
});
