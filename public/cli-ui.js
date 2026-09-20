'use strict';
const CliUI = {
  catalog: { defaults: {}, models: {} }, attachments: [], pending: 0,
  async init() { this.catalog = await api('/api/cli-defaults'); },
  render(target = {}, tree = {}, node = false, selectedTool = 'codex') {
    this.attachments = structuredClone(target.attachments || []);
    const text = (tool, key, value, attrs = '') => '<input data-cli="' + tool + '" data-key="' + key + '" value="' + esc(value ?? '') + '" ' + attrs + '>';
    const select = (tool, key, value, values) => '<select data-cli="' + tool + '" data-key="' + key + '">' + options(values, value) + '</select>';
    const area = (tool, key, value, hint) => field(hint, '<textarea class="code" data-cli="' + tool + '" data-key="' + key + '" spellcheck="false">' + esc(value) + '</textarea>');
    return '<div class="cli-settings"><p class="muted">' + (node ? 'ツリーの既定値を継承します。変更する CLI の上書きを有効にしてください。' : 'CLI ごとの既定値です。各ノードで上書きできます。') + '</p>' + ['codex', 'claude'].map(tool => {
      const legacy = node && target.model ? { model: target.model } : {};
      if (node && tool === 'codex' && target.sandbox && target.sandbox !== 'workspace-write') legacy.sandbox = target.sandbox;
      if (node && tool === 'claude' && target.claudePermission && target.claudePermission !== 'acceptEdits') legacy.permissionMode = target.claudePermission;
      const c = { ...this.catalog.defaults[tool], ...tree.cli?.[tool], ...legacy, ...target.cli?.[tool] };
      const override = !node || Boolean(target.cli?.[tool]) || Object.keys(legacy).length > 0;
      const models = this.catalog.models[tool] || [];
      return '<details class="cli-panel" ' + (tool === selectedTool ? 'open' : '') + '><summary>' + toolName(tool) + ' の設定</summary>' +
        (node ? '<label class="checkbox-field"><input type="checkbox" data-cli-override="' + tool + '" ' + (override ? 'checked' : '') + '>このノードで上書きする</label>' : '') +
        '<fieldset data-cli-fields="' + tool + '" ' + (override ? '' : 'disabled') + '>' +
        field('モデル', text(tool, 'model', c.model, 'list="models-' + tool + '" placeholder="CLI の既定値"') + '<datalist id="models-' + tool + '">' + models.map(m => '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>').join('') + '</datalist>', (tool === 'codex' ? '候補はこのマシンの Codex キャッシュです。' : 'CLI のモデルエイリアスを選択できます。') + '直接入力も可能。実行先・アカウントで利用できるモデルを指定してください。') +
        field('思考量', select(tool, 'effort', c.effort, [['', 'CLI の既定値'], ...(tool === 'codex' ? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']).map(x => [x, x])]), '対応する思考量はモデルと CLI バージョンによって異なります。') +
        field('実行モード', select(tool, 'mode', c.mode, [['task', '通常実行'], ['plan', 'プランニング（計画・調査）'], ['goal', 'ゴール（完了条件まで反復）']])) +
        field('ゴールの最大実行回数', text(tool, 'goalMaxAttempts', c.goalMaxAttempts, 'type="number" min="1" max="20"'), 'TaskDesk が各回の結果を引き継いで継続します。ノードの完了条件が必要です。合計時間はツリーの制限時間内。') +
        (tool === 'codex' ?
          field('承認レベル', select(tool, 'approval', c.approval, [['never', '追加承認なし（権限外の操作を拒否）'], ['auto-review', 'Codex の自動承認レビュー']])) +
          field('ファイル・コマンドの実行範囲', select(tool, 'sandbox', c.sandbox, [['read-only', '読み取りのみ'], ['workspace-write', '作業フォルダ内の編集'], ['danger-full-access', '全アクセス（サンドボックスなし）']]), '自動承認レビューは「作業フォルダ内の編集」と組み合わせます。計画モードでは読み取りのみを優先します。') +
          field('Codex プロファイル', text(tool, 'profile', c.profile, 'placeholder="任意"')) +
          field('Web 検索', select(tool, 'webSearch', c.webSearch, [['', 'CLI の既定値'], ['disabled', '無効'], ['cached', 'キャッシュ'], ['live', 'ライブ']])) :
          field('承認レベル', select(tool, 'permissionMode', c.permissionMode, [['default', '標準'], ['acceptEdits', 'ファイル編集を許可'], ['plan', '計画のみ'], ['dontAsk', '事前許可済みの操作のみ'], ['auto', '自動判定'], ['bypassPermissions', '権限確認をスキップ']])) +
          area(tool, 'allowedTools', c.allowedTools.join('\n'), '事前に許可するツール（1 行に 1 つ）') + area(tool, 'disallowedTools', c.disallowedTools.join('\n'), '禁止するツール（1 行に 1 つ）')) +
        area(tool, 'addDirs', c.addDirs.join('\n'), '追加でアクセスを許可するディレクトリ（実行先のパス・1 行に 1 つ）') +
        '<details class="cli-advanced"><summary>MCP サーバー設定</summary>' +
        area(tool, 'mcpServers', JSON.stringify(c.mcpServers, null, 2), tool === 'codex' ? 'mcp_servers テーブルの内容（JSON）' : 'mcpServers の内容（JSON）') +
        '<p class="muted">例: ' + esc(tool === 'codex' ? '{"docs":{"url":"https://example.com/mcp"}}' : '{"docs":{"type":"http","url":"https://example.com/mcp"}}') + '</p>' +
        '<p class="muted">既存の CLI 設定を読み込み、ここで同名サーバーを上書きします。空の {} は既存設定を継承します。認証・コマンド・パスは実行先のものを使用。設定はローカルに平文保存されます。</p>' +
        (tool === 'claude' ? '<label class="checkbox-field"><input type="checkbox" data-cli="claude" data-key="strictMcp" ' + (c.strictMcp ? 'checked' : '') + '>この MCP 設定だけを使う（strict）</label>' : '<p class="muted">既存サーバーを無効化する例: {"serverName":{"enabled":false}}</p>') + '</details></fieldset></details>';
    }).join('') +
    '<div class="detail-box">非対話実行のため、途中の CLI 承認要求にこの画面から回答する機能はありません。必要な操作は承認レベル・許可ツールで設定してください。「実行後に人が確認」は別の機能です。MCP の外部操作はファイルのサンドボックスでは制限されません。</div>' +
    '<h3>添付ファイル</h3><p class="muted">アップロードは 1 ファイル 5 MB、実行全体 20 MB まで。SSH 実行先にも転送します。画像は Codex の画像入力、その他は AI が読む資料として渡します。Claude Code は Read 等で参照します。</p>' +
    '<input id="cli-upload" type="file" multiple aria-label="添付ファイルを選択"><div id="cli-attachments">' + this.attachmentList() + '</div>' +
    field('実行先にあるファイル（1 行に 1 パス）', '<textarea id="cli-paths" placeholder="docs/requirements.md">' + esc(this.attachments.filter(a => a.path).map(a => a.path).join('\n')) + '</textarea>', 'このパスのファイルは転送しません。ノードの作業ディレクトリからの相対パス、または実行マシン上の絶対パスです。') + '</div>';
  },
  attachmentList() { return this.attachments.filter(a => a.id).map(a => '<div class="attachment-item"><span>' + esc(a.name) + ' <small>' + Math.ceil(a.size / 1024) + ' KB</small></span><button class="button small" type="button" data-remove-attachment="' + a.id + '">削除</button></div>').join(''); },
  read() {
    if (this.pending) throw new Error('添付ファイルのアップロード完了を待ってください');
    const cli = {};
    for (const tool of ['codex', 'claude']) {
      const toggle = document.querySelector('[data-cli-override="' + tool + '"]');
      if (toggle && !toggle.checked) continue;
      const c = {};
      for (const input of document.querySelectorAll('[data-cli="' + tool + '"]')) {
        const key = input.dataset.key;
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (key === 'mcpServers') {
          try { value = JSON.parse(value); } catch { throw new Error(toolName(tool) + ' の MCP 設定が有効な JSON ではありません'); }
          if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('MCP 設定は JSON オブジェクトで入力してください');
        }
        if (['addDirs', 'allowedTools', 'disallowedTools'].includes(key)) value = value.split('\n').map(s => s.trim()).filter(Boolean);
        if (key === 'goalMaxAttempts') { value = Number(value); if (!Number.isInteger(value) || value < 1 || value > 20) throw new Error('ゴールの上限回数は 1〜20 回です'); }
        c[key] = value;
      }
      cli[tool] = c;
    }
    const paths = $('#cli-paths').value.split('\n').map(s => s.trim()).filter(Boolean).map(path => ({ path, kind: /\.(png|jpe?g|webp|gif)$/i.test(path) ? 'image' : 'file' }));
    const attachments = [...this.attachments.filter(a => a.id), ...paths];
    if (attachments.length > 20) throw new Error('添付は 20 個以内にしてください');
    return { cli, attachments };
  }
};
document.addEventListener('change', async event => {
  const input = event.target;
  if (input.dataset.cliOverride) document.querySelector('[data-cli-fields="' + input.dataset.cliOverride + '"]').disabled = !input.checked;
  if (input.id !== 'cli-upload') return;
  const attachmentTarget = CliUI.attachments;
  CliUI.pending++; input.disabled = true;
  try {
    for (const file of input.files) {
      if (file.size > 5 * 1024 * 1024) throw new Error(file.name + ': 添付は 5 MB 以内です');
      if (attachmentTarget.length >= 20) throw new Error('添付は 20 個以内にしてください');
      const encoded = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
      const item = await api('/api/attachments', 'POST', { name: file.name, data: encoded });
      attachmentTarget.push(item);
      if (CliUI.attachments === attachmentTarget && $('#cli-attachments')) $('#cli-attachments').innerHTML = CliUI.attachmentList();
    }
  } catch (e) { toast(e.message || 'ファイルの読み取りに失敗しました', true); }
  finally { CliUI.pending--; input.disabled = false; input.value = ''; }
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-remove-attachment]');
  if (!button) return;
  const index = CliUI.attachments.findIndex(a => a.id === button.dataset.removeAttachment);
  if (index >= 0) CliUI.attachments.splice(index, 1);
  $('#cli-attachments').innerHTML = CliUI.attachmentList();
});
