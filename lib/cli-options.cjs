'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const DEFAULTS = {
  codex: { model: '', effort: '', mode: 'task', goalMaxAttempts: 3, approval: 'never', sandbox: 'workspace-write', profile: '', webSearch: '', addDirs: [], mcpServers: {} },
  claude: { model: '', effort: '', mode: 'task', goalMaxAttempts: 3, permissionMode: 'acceptEdits', addDirs: [], allowedTools: [], disallowedTools: [], mcpServers: {}, strictMcp: false }
};
const object = x => x && typeof x === 'object' && !Array.isArray(x);
function check(ok, msg) { if (!ok) throw new Error(msg); }
function validateOptions(value) {
  if (value === undefined) return;
  check(object(value), 'CLI 設定はオブジェクトで指定してください');
  for (const [tool, c] of Object.entries(value)) {
    check(Object.hasOwn(DEFAULTS, tool) && object(c), 'CLI 設定のツールが不正です');
    for (const key of Object.keys(c)) check(Object.hasOwn(DEFAULTS[tool], key), '未対応の CLI 設定: ' + key);
    for (const key of ['model', 'profile']) if (c[key] !== undefined) check(typeof c[key] === 'string' && c[key].length <= 200 && !/[\0\r\n]/.test(c[key]), key + ' が不正です');
    const enums = { mode: ['task', 'plan', 'goal'], effort: tool === 'codex' ? ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'], approval: ['never', 'auto-review'], sandbox: ['read-only', 'workspace-write', 'danger-full-access'], permissionMode: ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'], webSearch: ['', 'disabled', 'cached', 'live'] };
    for (const [key, values] of Object.entries(enums)) if (c[key] !== undefined) check(values.includes(c[key]), key + ' の値が不正です');
    if (c.goalMaxAttempts !== undefined) check(Number.isInteger(c.goalMaxAttempts) && c.goalMaxAttempts >= 1 && c.goalMaxAttempts <= 20, 'ゴールの上限回数は 1〜20 回です');
    if (c.strictMcp !== undefined) check(typeof c.strictMcp === 'boolean', 'strictMcp が不正です');
    for (const key of ['addDirs', 'allowedTools', 'disallowedTools']) if (c[key] !== undefined) check(Array.isArray(c[key]) && c[key].length <= 50 && c[key].every(v => typeof v === 'string' && v.trim() && !v.startsWith('-') && v.length <= 2000 && !/[\0\r\n]/.test(v)), key + ' は文字列の配列で指定してください（先頭の - は使用できません）');
    if (c.mcpServers !== undefined) {
      check(object(c.mcpServers) && Object.keys(c.mcpServers).length <= 30 && JSON.stringify(c.mcpServers).length <= 24000, 'MCP 設定が大きすぎるか不正です');
      for (const [name, server] of Object.entries(c.mcpServers)) {
        check(/^[a-zA-Z0-9_-]+$/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name) && object(server), 'MCP サーバー名・設定が不正です');
        // Each CLI validates its own server-specific fields; only this table is configurable.
        check(server.command === undefined || typeof server.command === 'string', 'MCP command が不正です');
        check(server.url === undefined || (typeof server.url === 'string' && /^https?:\/\//.test(server.url)), 'MCP URL は http(s) を指定してください');
        if (tool === 'claude') check(server.command || server.url, 'Claude MCP に command または url が必要です');
      }
      if (tool === 'codex') toml(c.mcpServers);
    }
  }
}
function effectiveOptions(tree, node, tool) {
  const legacy = node.model ? { model: node.model } : {};
  if (tool === 'codex' && node.sandbox && node.sandbox !== 'workspace-write') legacy.sandbox = node.sandbox;
  if (tool === 'claude' && node.claudePermission && node.claudePermission !== 'acceptEdits') legacy.permissionMode = node.claudePermission;
  return { ...DEFAULTS[tool], ...tree.cli?.[tool], ...legacy, ...node.cli?.[tool] };
}
function validateAttachments(list) {
  if (list === undefined) return;
  check(Array.isArray(list) && list.length <= 20, '添付は 20 個以内にしてください');
  for (const a of list) {
    check(object(a), '添付ファイルが不正です');
    if (a.id) check(/^[0-9a-f-]{36}$/.test(a.id) && typeof a.name === 'string' && a.name.length <= 240, '添付 ID・名前が不正です');
    else check(typeof a.path === 'string' && a.path.trim() && a.path.length <= 2000 && !/[\0\r\n]/.test(a.path), '添付パスが不正です');
    check(['file', 'image'].includes(a.kind), '添付種別が不正です');
    check(!Object.hasOwn(a, 'data'), '添付ファイルはアップロード API を使用してください');
  }
}
// JSON-compatible values serialized as TOML, with quoted keys at every level.
function toml(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value);
  if (Array.isArray(value)) return '[' + value.map(toml).join(', ') + ']';
  if (object(value)) return '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + ' = ' + toml(v)).join(', ') + '}';
  throw new Error('MCP 設定に null は使用できません');
}
function cliArgs(config, { interactive = false } = {}) {
  const c = config.options || effectiveOptions({}, config, config.tool), args = [];
  const planning = c.mode === 'plan';
  if (interactive) check(c.mode !== 'goal', '対話実行ではゴールの自動反復を使用できません。実行モードを通常実行に変更してください');
  if (config.tool === 'codex') {
    if (interactive) args.push('--no-alt-screen');
    else args.push('exec', '--json', '--color', 'never');
    if (c.profile) args.push('--profile', c.profile);
    if (!planning && c.approval === 'auto-review') {
      check(c.sandbox === 'workspace-write', 'Codex の自動承認レビューは workspace-write と組み合わせてください');
      args.push('--approve-for-me');
    } else args.push('--sandbox', planning ? 'read-only' : c.sandbox, '-c', 'approval_policy="never"');
    if (c.effort) args.push('-c', 'model_reasoning_effort=' + toml(c.effort));
    if (c.webSearch) args.push('-c', 'web_search=' + toml(c.webSearch));
    for (const [name, server] of Object.entries(c.mcpServers)) args.push('-c', 'mcp_servers.' + name + '=' + toml(server));
    for (const p of config.imagePaths || []) args.push('--image', p);
    if (config.goalSchemaPath && !interactive) args.push('--output-schema', config.goalSchemaPath);
  } else {
    if (!interactive) args.push('-p', '--output-format', 'stream-json', '--verbose');
    args.push('--permission-mode', planning ? 'plan' : c.permissionMode);
    if (c.effort) args.push('--effort', c.effort);
    if (config.mcpConfigPath) args.push('--mcp-config', config.mcpConfigPath);
    if (c.strictMcp) args.push('--strict-mcp-config');
    if (c.allowedTools.length) args.push('--allowedTools', ...c.allowedTools);
    if (c.disallowedTools.length) args.push('--disallowedTools', ...c.disallowedTools);
    if (config.goalSchemaPath && !interactive) args.push('--json-schema', JSON.stringify(GOAL_SCHEMA));
  }
  if (c.model) args.push('--model', c.model);
  const dirs = [...(planning ? [] : c.addDirs), ...(config.attachmentDir && config.tool === 'claude' ? [config.attachmentDir] : [])];
  if (config.tool === 'claude' && dirs.length) args.push('--add-dir', ...dirs);
  if (config.tool === 'codex') for (const dir of dirs) args.push('--add-dir', dir);
  if (config.tool === 'codex' && !interactive) args.push('--', '-');
  return args;
}
const GOAL_SCHEMA = { type: 'object', properties: { completed: { type: 'boolean' }, summary: { type: 'string' }, evidence: { type: 'string' }, nextSteps: { type: 'string' } }, required: ['completed', 'summary', 'evidence', 'nextSteps'], additionalProperties: false };
function prepare(config, prompt, { directory } = {}) {
  const dir = directory || fs.mkdtempSync(path.join(os.tmpdir(), 'work-tree-input-'));
  if (directory) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prepared = { ...config, options: config.options || effectiveOptions({}, config, config.tool), imagePaths: [] };
  try {
    const references = [];
    for (const [i, a] of (config.attachments || []).entries()) {
      let file;
      if (a.id) {
        check(typeof a.data === 'string', '添付データがありません: ' + a.name);
        const ext = path.extname(a.name).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12);
        file = path.join(dir, 'attachment-' + i + ext);
        fs.writeFileSync(file, Buffer.from(a.data, 'base64'), { mode: 0o600 });
      } else {
        file = path.resolve(config.cwd, a.path);
        check(fs.statSync(file).isFile(), '添付ファイルが見つかりません: ' + a.path);
      }
      if (a.kind === 'image' && config.tool === 'codex') prepared.imagePaths.push(file);
      references.push({ name: a.name || a.path, path: file, kind: a.kind });
    }
    if (references.length) prompt += '\n\n添付資料（必要なファイルを読み取って参照してください）:\n' + JSON.stringify(references);
    if (references.length) prepared.attachmentDir = dir;
    if (config.tool === 'claude' && (Object.keys(prepared.options.mcpServers).length || prepared.options.strictMcp)) {
      prepared.mcpConfigPath = path.join(dir, 'mcp.json');
      fs.writeFileSync(prepared.mcpConfigPath, JSON.stringify({ mcpServers: prepared.options.mcpServers }), { mode: 0o600 });
    }
    if (prepared.options.mode === 'goal') {
      prepared.goalSchemaPath = path.join(dir, 'goal-schema.json');
      fs.writeFileSync(prepared.goalSchemaPath, JSON.stringify(GOAL_SCHEMA));
    }
    if (prepared.options.mode === 'plan') prompt += '\n\n計画モード: 調査と計画の提示だけを行い、実装・ファイル変更・外部サービスへの変更は実行しないでください。';
    return { config: prepared, prompt, cleanup: () => { if (!directory) fs.rmSync(dir, { recursive: true, force: true }); } };
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
}
module.exports = { DEFAULTS, validateOptions, effectiveOptions, validateAttachments, cliArgs, prepare, toml, GOAL_SCHEMA };
