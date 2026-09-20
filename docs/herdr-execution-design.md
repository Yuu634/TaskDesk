# TaskDesk → herdr の対話実行

2026-09-20、herdr 0.9.1 / WSL の実ペインで検証。対象は TaskDesk と herdr が同じ WSL / Linux / macOS 環境で動くローカル実行。

## 起動と入力

1. サーバーでツリーの revision、依存関係、作業ディレクトリ、CLI 設定、実行ロックを検証する。
2. `herdr-bindings.json` のツリーに対応する Space とノード専用ペインを取得する。API から得た workspace ID、pane ID、terminal ID、所有トークンを照合する。
3. `cli-options.cjs` で継承とノード上書きを解決する。モデル・思考量・権限・MCP・添付を引数へ反映する。Codex は `exec`、Claude は `-p` を付けず対話モードで起動する。ゴール自動反復は対応せず、事前にエラーにする。
4. 引用済みの起動スクリプトを `pane run` で実行する。スクリプトは作業ディレクトリと環境変数を設定し、PID を保存して CLI に `exec` する。プロンプトをシェルコマンドに含めない。
5. PID と前面プロセスグループ、ペインの所有関係、Agent のツール種別を照合する。ネイティブ Agent が入力待ちになってから `agent prompt <paneId> <prompt>` で全文を一度だけ送信する。起動時の信頼確認・ログインは自動回答せず herdr での操作を待つ。
6. 送信前に intent を永続化する。起動や入力の応答が失われても自動再送しない。送信確認が必要な場合は UI にメッセージを表示する。

引数は配列として渡し、起動スクリプトの値はシェル引用する。herdr の通知環境は引き継ぎ、TaskDesk からネイティブ Agent の状態を偽装報告しない。カスタム CLI パスも使用できるが、herdr が対応ツールのネイティブ Agent として認識できる必要がある。すべての herdr コマンドで同じ明示的な `--session` を使う。

`agent prompt` のプロセス引数上限を超えないよう、依存結果・共通指示を含めた送信内容を UTF-8 で 96 KiB までとし、超過時は起動前にエラーにする。長い結果は要約して次へ渡す。

## 完了と結果

`idle` / `done` は入力待ちであり、タスクの完了を意味しない。対話中の質問・承認・追加指示は herdr のネイティブ画面で扱う。

TaskDesk で「結果を記録」を押し、完了・エラー・想定外結果のラベルと、成果物・検証結果の要約を入力する。API は対象 run / node と入力待ち状態を検証する。ワーカーでも送信先と現在の Agent 状態を照合してから要約と outcome を保存する。completed のみ後続 TASK へ進み、error / unexpected は run を failed にして後続を止める。従来の `reviewRequired` はこの人による確定が兼ねる。

`agent read --source recent-unwrapped --lines 200` で取得できる端末記録を `runs/<runId>/herdr/<nodeId>/terminal.txt` に保存する。これは補助記録であり、AI の最終回答を構造化抽出したものではない。取得に失敗しても確定済みの要約は保存する。

Web UI の計画作成状況・ログ一覧は表示しない。ワークツリー作成は生成終了後に自動で取り込み、タスクの実行はユーザー操作で開始する。

## 会話の保持・停止・再実行

- 完了後も対話 CLI と添付・MCP 設定ファイルを保持する。herdr で会話を続けられる。
- 新しい実行の際、前の会話がまだ前面にあれば新しいペインと binding を作成する。前の会話を閉じたり、別の設定で続行したりしない。シェルに戻っている所有ペインは再利用する。
- 停止・タイムアウトでは所有関係と PID を再照合し、その CLI のプロセスツリーだけを停止する。別プロセスに交代していれば停止しない。
- Web サーバー・ブラウザーを閉じても独立ワーカーと herdr ペインが動いていれば継続する。
- 非対話・SSH バックエンドは既存 API / TUI 用に残す。Web のタスク実行は herdr 対話方式に統一する。

## 表示名と対応情報

| TaskDesk | herdr | 表示名 |
| --- | --- | --- |
| タスクツリー | Space | ツリー名 |
| TASK | 専用タブ・ペイン・Agent | ノード名 |
| 管理画面 | Space 内の管理タブ | タスクツリー |
| WP | TaskDesk 内の親ノード | グループ名。Agent は起動しない |

名前を送信先の識別に使わない。Space は session / treeId、ペインは nodeId / binding ID と対応付ける。日本語の表示名は `pane report-metadata --display-agent` に設定し、Agent 内部名は `wt-` とランダム binding ID から作る英数字とする。改名は既存の所有 Space・ペインへ同期し、同期失敗は保存を取り消さず再試行する。

同名・80文字を超える名前は短縮IDを付けて区別する。制御文字を除去し、Unicode を壊さず省略する。Space / ペイン作成の応答が不明な場合は所有マーカーで照合し、確認できなければ自動再作成しない。

## 実装・検証

主要実装は `lib/herdr-bindings.cjs`、`lib/herdr-execution.cjs`、`lib/cli-options.cjs`、`lib/worker.cjs`、`server.cjs` と Web UI。旧 `herdr-agent.cjs` の非対話ブリッジはこの経路では使用しない。

`npm test` は設定継承、応答喪失時の一度だけの送信、所有関係の交代、起動承認待ち、手動完了、停止を検証する。`npm run test:herdr` は C コンパイラーで作成した Codex / Claude 名の対話フィクスチャを実ペインで動かし、モデル・思考量・承認引数、複数行の入力、依存結果、会話保持、再実行、停止を検証する。実際の AI サービスへのリクエストは含めない。

`scripts/ui-smoke.cjs` はブラウザーで直接改名・ドラッグ・追加・削除・保存・破棄、TASK の省スペース表示、ツリー作成、モバイル表示を確認する。

herdr の仕様はインストール済み `herdr --skill`、`agent prompt --help`、`agent get --help`、`pane process-info --help` を参照。

## 結果からの編集案

`lib/proposals.cjs` が保存済みの結果を検出し、失敗 TASK と推移的な依存先の編集案を計画専用 CLI で作成する。対象ツリーの revision・元の run / node・生成 run・変更差分・判断状態を database.json に保存する。案を確認するまでツリーは変更せず、再生成は明示操作のみとする。実行プロセスのエラーも outcome=error とする。

AI の出力は計画フィールドだけを許可する。既存 ID と実行設定を維持、新規 ID はサーバーで採番し、範囲外変更や不整合を拒否する。適用時にも revision、対象の最新結果、実行中でないことを照合する。Web は TASK の直下に案を表示し、適用／見送りを行う。
