# photo-reducer CLI デザイン

## 目的
既存写真ディレクトリを対象に、一定日時以降の画像だけを選ぶバッチ処理、監視（デーモン）モード、単一ファイルモードを提供し、縮小画像を別ディレクトリへ安全に出力するCLIを構築する。

## 技術スタック
- **Node.js + TypeScript**：型安全なCLIで堅牢性を確保。Next.js等のサーバフレームワークは不要。
- **commander**：オプションやサブコマンドの定義（`--source`/`--output`/`--rate`/`--since`/`--watch`/`--interval`/`--file`）。
- **sharp**：画像形式を自動判定しつつリサイズ・圧縮を実行。
- **fs-extra**：出力先ディレクトリの `ensureDir`、.photo-reducer 読み書きなど。
- **dayjs**（または標準 Date）：ISO8601 帯域の日時比較。
- **fast-glob**（もしくは `fs.promises.readdir` + 再帰）：画像のみを再帰的に列挙。
- **node:worker_threads** や `p-limit` などの並列制御は必要であれば追加。
- **`console` とログプレフィックス**：通常ログ/エラー/監視中の `[DEBUG]` ログを分けて出力。

## CLI モード
1. **バッチ（ディレクトリ処理）モード**
   - `--source`: 処理対象ディレクトリ（必須）。
   - `--output`: 縮小画像出力先（必須）。存在しなければ `fs-extra.ensureDir` で作成。
   - `--rate`: 縮小率（0<rate<=1、デフォルト0.9）。`sharp` の `resize`/`jpeg` などで適用。
   - `--max-output-width`: 出力画像の最大横幅（ピクセル）。指定時は縮小後の横幅が上限を超えないようにし、縦横比は維持する。
   - `--png-format`: 入力がPNGの場合の出力形式（png/webp/avif）。スクリーンショットは webp が有効なことが多い。
   - `--since`: 指定日時以降のみ処理（ISO 8601 または YYYY-M-D。YYYY-M-D はその日の 0:00 JST 以降）。
   - `--from-now`: 今この瞬間を基準に開始（`.photo-reducer` が無い初回はこれがデフォルト）。
   - `--since`/`--from-now` が未指定時は `.photo-reducer.lastProcessedAt` を基準にする（初回で `.photo-reducer` が無い場合は「今」を基準に `.photo-reducer` を作成する）。
   - `.photo-reducer` は source ディレクトリにだけ置き、`lastProcessedAt`・`lastRate` などの最低限情報のみを保持。
   - 出力が元ファイルより大きくなる場合は、縮小結果を採用せず元ファイルをそのまま出力する（サイズ増大防止）。

2. **監視（デーモン）モード**
   - `--watch` + `--interval <秒>`：指定間隔で再スキャンし、再帰的に新規ファイルを探す。
   - `--since` が明示されていればそれを優先。未指定なら `.photo-reducer.lastProcessedAt` を基準。
   - `--since` を指定していても、初回に処理が発生した場合は「次回以降の監視サイクルでは `since` を最新処理時刻へ進める」ことで、同じファイルを再処理し続けない。
   - 処理0件のサイクルはログ氾濫を避けるため、開始/0件完了ログを出さない（起動/終了ログ、処理が発生した場合のログは出す）。
   - エラー時は `[DEBUG]` プリフィックス付きで原因を出力し、プロセス継続。
   - 各サイクル終了後、**処理件数が1件以上の場合のみ** `lastProcessedAt` を更新し `.photo-reducer` を上書き（書き換え中は `.tmp` などで安全に）。

3. **単一ファイルモード（`--file`）**
   - 画像ファイルパスを直接指定すると、それだけを縮小し出力ディレクトリへ保存。
   - `.photo-reducer` は一切触らず、監視モード専用のメタファイルとみなす。
   - テスト目的で省略可能なオプション（`--rate`／出力先指定）を柔軟に受け付ける。

## 処理フロー
1. オプションを `commander` でパースし、必要なパラメータを集約（`validateRate()` などでバリデーション）。
2. `.photo-reducer` を読んで `lastProcessedAt` を取得（存在しなければデフォルト日時）。
3. 監視・バッチモードでは `fast-glob` で対象ファイルの一覧を作成し、`stat.mtime` や `since` を比較。
4. `sharp` で `resize({ width: ...})` や `toFormat()`、`jpeg({ quality })` もしくは `webp` へ変換し `output/<relative-path>` へ保存。
5. 成功時に元サイズ/新サイズとパスをログ。エラーは `try/catch` でキャッチして詳細表示。
6. 監視・バッチ終了後、`.photo-reducer` に `lastProcessedAt`（最新処理日時）・`lastRate` を JSON 形式で書き込み。

## その他考慮事項
- `.photo-reducer` の内容は `{"lastProcessedAt":"...","lastRate":0.9}` のみとし、ファイル数膨大でも軽量。
- 監視モードは `setInterval` で再スキャンする間、現状で `clearInterval` を明示的に扱う。
- 出力先ディレクトリが相対パスで指定された場合も、CLI 起動ディレクトリを基準として絶対パス化。
- テスト・内製利用時のログは `console.log` だけでなく、必要に応じて `ora` で進捗表示できる。
- すべての I/O 処理に `try/catch` を加え、失敗時には `process.exitCode = 1` を設定して CLI を終了。

ご確認後、実装やエラーハンドリングの詳細追加、監視間隔や `sharp` の最適化ルールを展開していきましょう。必要箇所があれば再度指示ください。

