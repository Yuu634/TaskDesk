'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fitPreviousResults}=require('../lib/prompt-budget.cjs');
const {launchInput}=require('../lib/orca-execution.cjs');
const {blankTree,blankNode,configFor}=require('../lib/core.cjs');
test('historical Japanese results fit the encoded Orca limit without trimming instructions or criteria',()=>{
 const node=blankNode({prompt:'今回の指示を保持する',criteria:'全条件を検証する'}),tree=blankTree({nodes:[node]}),config=configFor(tree,node);
 const previous=Array.from({length:12},(_,i)=>({task:'調査'+i,result:'日本語の長い実行結果😀'.repeat(1000)+'\n成果物: docs/result-'+i+'.md'}));
 const original=JSON.stringify(previous),build=p=>node.prompt+'\n'+node.criteria+'\n'+JSON.stringify(p);
 const validate=p=>launchInput(config,{path:'/repo',platform:'linux'},p);
 assert.throws(()=>validate(build(previous)),/大きすぎ/);
 const fitted=fitPreviousResults(previous,build,validate);
 assert(fitted.abbreviated);assert(fitted.prompt.includes(node.prompt));assert(fitted.prompt.includes(node.criteria));
 assert(fitted.prompt.includes('docs/result-11.md'));assert(validate(fitted.prompt).env.WORK_TREE_ORCA_INPUT.length<24000);
 assert.equal(JSON.stringify(previous),original);
 const small=fitPreviousResults([],build,validate);assert.equal(small.prompt,build([]));assert.equal(small.abbreviated,false);
});
test('invalid settings and oversized primary instructions still fail rather than silently truncating them',()=>{
 assert.throws(()=>fitPreviousResults([],()=> 'main',()=>{throw Error('invalid settings');}),/invalid settings/);
 assert.throws(()=>fitPreviousResults([],()=> 'main',()=>{throw Error('大きすぎます');}),/大きすぎ/);
});
