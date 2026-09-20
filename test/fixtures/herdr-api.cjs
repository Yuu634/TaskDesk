'use strict';
// A read/report-only herdr stub used by the real bridge process in unit tests.
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.WORK_TREE_HERDR_FIXTURE, 'utf8'));
const args = process.argv.slice(4);
if (args[0] === 'pane' && args[1] === 'get') process.stdout.write(JSON.stringify({ result: { pane: state.pane } }));
else if (args[0] === 'pane' && ['report-agent', 'release-agent'].includes(args[1])) {
  fs.appendFileSync(process.env.WORK_TREE_HERDR_FIXTURE + '.calls', JSON.stringify(args) + '\n');
} else { console.error('Unsupported fixture command: ' + args.join(' ')); process.exitCode = 1; }
