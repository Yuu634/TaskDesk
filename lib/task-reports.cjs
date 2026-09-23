'use strict';
const path = require('node:path');
const { configFor } = require('./core.cjs');
function targetFor(tree,node) {
  const config=configFor(tree,node),orca=tree.executionBackend==='orca' ? config.orca : null;
  return {hostId:orca?.hostId || config.machineId,cwd:orca?.path || config.cwd,platform:orca?.platform};
}
function absolute(file,target) {
  const paths=target.platform==='win32' || /^[A-Za-z]:[\\/]/.test(target.cwd || '') ? path.win32 : path.posix;
  return paths.isAbsolute(file) ? file : target.cwd ? paths.join(target.cwd,file) : file;
}
function previousReport(tree,node,result) {
  if(result?.report) return result.report;
  const target=targetFor(tree,node),text=result?.workResponse || result?.response || '';
  // Older tasks already produced Markdown reports. Retain the path only, never
  // forward the terminal transcript or claim that we verified the remote file.
  const candidates=text.match(/(?:\/[\w.-]+)*\/?(?:docs|reports)\/[\w./-]+\.md\b/g) || [];
  const file=candidates.find(p=>/README\.md$/i.test(p)) || candidates.at(-1);
  return file ? {path:absolute(file,target),hostId:result?.machineId || target.hostId,status:'legacy-reference',verified:false} : null;
}
function createTaskPrompt(tree,node,states,runId,existingReport) {
  const target=targetFor(tree,node),report=existingReport || {path:absolute('.taskdesk/reports/'+tree.id+'/'+node.id+'/'+runId+'.md',target),hostId:target.hostId,status:'requested',verified:false};
  const refs=(node.dependsOn || []).map(id=>{
    const task=tree.nodes.find(n=>n.id===id),reference=task&&previousReport(tree,task,states[id]);
    return {task:task?.title || id,reportPath:reference?.path || null,hostId:reference?.hostId || null,
      availability:!reference ? '報告書パス未登録' : reference.hostId!==target.hostId ? '別マシンの資料。自動転送されません' : reference.status==='requested' ? '保存未確認。実在を確認し、なければ未解決として報告' : '同じマシン。実在と内容を確認して参照',verified:false};
  });
  const parents=[];let parent=node.parentId;
  while(parent){const p=tree.nodes.find(n=>n.id===parent);if(!p)break;parents.unshift(p.title+'\n'+p.prompt);parent=p.parentId;}
  const prompt=[
    '今回のTASK: '+node.title,node.prompt,
    '完了条件:\n'+(node.criteria || '指示した作業を実施し、結果を報告する'),
    '共通の背景・制約:\n'+[tree.description || '',...parents].filter(Boolean).join('\n\n'),
    '参照資料（依存先TASK名と成果報告書パス）:\n'+JSON.stringify(refs),
    '今回のTASKだけを実行してください。参照資料は必要なものだけ読み、実行先から読めないパスや未登録の資料を推測で補わないでください。必要な根拠が取得できない場合は未解決事項として報告してください。',
    '成果報告書の保存先:\n'+report.path,
    '親ディレクトリを必要に応じて作成し、Markdownの成果報告書を保存してください。TASK名・実施内容・成果物のパス・検証結果・完了条件ごとの達成状況と根拠・未解決事項を記載してください。修正した場合は同じ報告書を最新内容に更新してください。保存できない場合は理由を報告し、保存済みと主張しないでください。最終回答の末尾に、保存できた場合だけ TASKDESK_REPORT: '+report.path+' と1行で記載してください。'
  ].join('\n\n');
  return {prompt,report,refs};
}
function recordReport(report,text) {
  if(!report) return report;
  const marker=String(text || '').split('TASKDESK_REPORT:').at(1);
  return marker?.split(/\r?\n/).slice(0,6).join('').replace(/\s/g,'').startsWith(report.path.replace(/\s/g,'')) ? {...report,status:'reported',reportedAt:new Date().toISOString()} : report;
}
module.exports={createTaskPrompt,previousReport,recordReport};
