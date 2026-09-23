'use strict';
const { assert, now } = require('./core.cjs');
function labelResult(node, outcome, note = '') {
  assert(['completed','needs_review','error','unexpected'].includes(outcome), '結果ラベルが不正です');
  assert(typeof note === 'string' && note.length <= 6000, '判定メモは6000文字以内で入力してください');
  node.labelHistory ||= [];
  node.labelHistory.push({ outcome:node.outcome || null, status:node.status, confirmedByUser:!!node.confirmedByUser, manualLabel:node.manualLabel || null, savedAt:now() });
  node.outcome = outcome; node.resultStale = false;
  node.confirmedByUser = outcome === 'completed'; node.confirmedAt = outcome === 'completed' ? now() : null;
  node.manualLabel = { outcome, note, at:now(), source:'user' };
  node.status = outcome === 'completed' ? 'succeeded' : outcome === 'needs_review' ? 'review' : 'failed';
  node.error = null;
}
module.exports = { labelResult };
