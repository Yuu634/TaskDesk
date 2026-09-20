'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomic, read, blankTree, blankNode, id } = require('./core.cjs');
class Store {
  constructor(dir) {
    this.dir = dir; this.file = path.join(dir, 'database.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.data = read(this.file);
    if (!this.data) {
      const root = id(), design = id(), implement = id();
      const tree = blankTree({ name: 'はじめてのワークツリー', description: 'ノードを選んでプロンプトを編集し、実行設定から作業ディレクトリを指定してください。', nodes: [
        blankNode({ id: root, title: '小さなツールをつくる', kind: 'group', prompt: '既存のプロジェクトの構成と規約に従って作業する。' }),
        blankNode({ id: design, parentId: root, order: 0, title: '要件を整理する', prompt: '作業ディレクトリを調査し、改善できる小さな機能を一つ提案してください。実装計画を Markdown にまとめてください。', criteria: '対象の機能、変更箇所、確認方法が明確になっている', sandbox: 'read-only', claudePermission: 'plan', reviewRequired: true }),
        blankNode({ id: implement, parentId: root, order: 1, title: '機能を実装する', prompt: '先行タスクの実装計画に従って機能を実装してください。', dependsOn: [design], criteria: '計画した機能が動作する' }),
        blankNode({ parentId: root, order: 2, title: '動作を確認する', prompt: '実装した機能を検証し、結果と残っている課題を報告してください。', dependsOn: [implement], reviewRequired: true })
      ] });
      this.data = { version: 1, trees: [tree], machines: [{ id: 'local', name: 'このマシン', type: 'local', codexPath: 'codex', claudePath: 'claude' }], runs: [] }; this.save();
    }
  }
  save() { atomic(this.file, this.data); }
  runDir(runId) { return path.join(this.dir, 'runs', runId); }
  state(run) { return read(path.join(this.runDir(run.id), 'state.json'), { id: run.id, status: 'starting', nodes: {}, currentNodeId: null, nextNodeId: null }); }
}
module.exports = { Store };
