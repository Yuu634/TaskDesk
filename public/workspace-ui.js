'use strict';
(() => {
  async function showNotion() {
    const s = await api('/api/notion'), link = draft && s.links[draft.id];
    modalKind = 'notion';
    modal('Notion 連携', 'ツリーの計画と作業結果を Notion に保持します',
      '<div class="notion-intro"><strong>' + (s.configured ? '認証設定あり' : '初回設定') + '</strong><p>Notion のコネクションに読み取り・追加・更新権限を付け、保存先ページに接続してください。トークンはこの PC のサーバー設定だけに保存されます。</p></div>' +
      '<label class="field">保存先の親ページ URL<input id="notion-parent" value="' + esc(s.parent) + '"></label><label class="field">認証トークン<input id="notion-token" type="password" autocomplete="new-password" placeholder="' + (s.configured ? '設定済み（変更時だけ入力）' : 'ntn_… またはサーバー環境変数 NOTION_TOKEN') + '"></label>' +
      '<label class="field">TaskDesk データソース ID<input id="notion-source" value="' + esc(s.sourceId) + '" placeholder="初回は空欄のままデータベースを作成"></label>' +
      '<div class="notion-actions"><button class="button" data-notion="configure">接続設定を保存</button><button class="button" data-notion="create" ' + (s.sourceId ? 'disabled' : '') + '>専用データベースを作成</button><button class="button" data-notion="verify">接続確認</button></div>' +
      '<div class="notion-tree"><h3>' + esc(draft?.name || 'ツリーを選択してください') + '</h3><p>' + (link ? (link.incomplete ? '保存未完了。再度保存してください。' : '連携済み · 実行前に最新の計画と過去の結果を取得') + '<br>データソース: ' + esc(link.sourceId) : '「ツリーを Notion に保存」で、このツリーの連携を開始します。') + '</p><p>共有内容: 名前・階層・プロンプト・完了条件・依存関係・結果。環境変数、MCP 設定、添付ファイル、認証情報は同期しません。</p><div class="notion-actions"><button class="button primary" data-notion="push" ' + (!draft || busy() ? 'disabled' : '') + '>ツリーを Notion に保存</button><button class="button" data-notion="pull" ' + (!link || busy() ? 'disabled' : '') + '>Notion から取得</button></div><label class="notion-replace"><input id="notion-discard" type="checkbox">取得時にローカルの計画変更を Notion の計画で置き換える</label></div>' +
      '<p class="muted">結果の同期待ち: ' + s.pending + ' 件。同期失敗時はローカルに保持して再試行します。SSH 常駐実行の結果は、このサーバーが接続されたときに同期します。</p>' + (s.error ? '<p class="error-text">' + esc(s.error) + '</p>' : ''), '<button class="button close-modal">閉じる</button>');
  }
  $('#notion-button').onclick = () => showNotion().catch(e => toast(e.message, true));
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-notion]'); if (!button || button.disabled) return;
    const action = button.dataset.notion;
    for (const b of document.querySelectorAll('[data-notion]')) b.disabled = true;
    try {
      if (['configure', 'create', 'verify'].includes(action)) {
        await api('/api/notion', 'PUT', { parent: $('#notion-parent').value.trim(), sourceId: $('#notion-source').value.trim(), token: $('#notion-token').value });
        $('#notion-token').value = '';
        if (action !== 'configure') await api('/api/notion/' + action, 'POST', {});
      } else {
        if (dirty) await save();
        await api('/api/trees/' + draft.id + '/notion-' + action, 'POST', { discardLocal: $('#notion-discard').checked });
        await refresh();
      }
      toast('Notion: ' + ({ configure: '設定を保存しました', create: 'データベースを作成しました', verify: '接続を確認しました', push: '計画を保存しました', pull: '計画と過去の結果を取得しました' }[action])); await showNotion();
    } catch (e) {
      const box = $('#modal-error'); if (box) { box.hidden = false; box.textContent = e.message; } else toast(e.message, true);
      for (const b of document.querySelectorAll('[data-notion]')) b.disabled = false;
    }
  });
})();
