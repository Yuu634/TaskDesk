'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { blankTree, blankNode } = require('../lib/core.cjs');
const { scopeIds, parseProposal, planNode } = require('../lib/proposals.cjs');
function fixture() {
 const wp=blankNode({kind:'group'}), a=blankNode({parentId:wp.id, prompt:'first', cli:{codex:{model:'selected'}},env:{SECRET:'retained'}}), b=blankNode({parentId:wp.id,prompt:'next',dependsOn:[a.id]}), other=blankNode({prompt:'untouched'});
 const tree=blankTree({nodes:[wp,a,b,other]});
 return {tree,wp,a,b,other,p:{baseTree:tree,scope:'branch',scopeIds:[a.id,b.id]},machines:[{id:'local'}]};
}
test('AI scope follows WP descendants or transitive task dependents',()=>{
 const {tree,wp,a,b}=fixture();
 assert.deepEqual(scopeIds(tree,'branch',wp.id),[wp.id,a.id,b.id]);
 assert.deepEqual(scopeIds(tree,'downstream',a.id),[a.id,b.id]);
 assert.throws(()=>scopeIds(tree,'branch','missing'),/見つかりません/);
});
test('AI patches preserve stable IDs, assign new IDs and leave execution settings outside the patch',()=>{
 const {p,a,b,machines}=fixture();
 const nodes=[{...planNode(a),title:'変更済み'},planNode(b),{...planNode(b),id:'new_check',title:'再検証',dependsOn:[b.id]}];
 const result=parseProposal(JSON.stringify({summary:'修正と再検証',nodes}),p,machines);
 assert.equal(result.nodes[0].id,a.id); assert(!result.nodes[2].id.startsWith('new_')); assert.equal(result.nodes[2].dependsOn[0],b.id);
 assert.equal(result.changes.length,2); assert(!JSON.stringify(result).includes('SECRET'));
 assert.throws(()=>parseProposal(JSON.stringify({summary:'bad',nodes:[{...planNode(a),env:{SECRET:'replace'}},planNode(b)]}),p,machines),/実行設定/);
});
test('AI scope enforcement rejects external edits, dangling references, cycles and deletion of the result task',()=>{
 const {p,a,b,other,machines}=fixture(), parse=nodes=>parseProposal(JSON.stringify({summary:'test',nodes}),p,machines);
 assert.throws(()=>parse([planNode(other)]),/範囲外/);
 assert.throws(()=>parse([planNode(b)]),/依存先/);
 assert.throws(()=>parse([{...planNode(a),dependsOn:[b.id]},planNode(b)]),/循環/);
 assert.throws(()=>parse([{...planNode(a),parentId:other.id},planNode(b)]),/範囲外/);
 p.sourceNodeId=a.id;
 assert.throws(()=>parse([{...planNode(b),dependsOn:[]}]),/削除・WP 化/);
});
