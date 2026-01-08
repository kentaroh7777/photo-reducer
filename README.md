# photo-reducer
スマホの写真やスクリーンショットのファイルサイズをスリム化するCLIです。

## ドキュメント
- 設計書: `doc/design/photo-reducer-design.md` に機能・モード・`.photo-reducer` の振る舞いをまとめています。

## 使い方
1. `pnpm install` で依存を解決
2. `pnpm run build` で TypeScript をコンパイル
3. `pnpm run start -- --source <元ディレクトリ> --output <出力ディレクトリ>` でバッチ処理

### オプションの一部
- `--rate`: 縮小率（0<rate<=1、デフォルト0.9）
- `--since`: 指定日時以降のファイルのみ処理（`ISO 8601` または `YYYY-M-D`。`YYYY-M-D` は **その日の 0:00 JST 以降**）
- `--from-now`: 今この瞬間を基準に開始（`.photo-reducer` が無い初回はこれがデフォルト）
- `--max-output-width`: 出力画像の最大横幅（ピクセル）。指定した場合、縮小後の横幅が上限を超えないようにします（縦横比維持）。
- `--png-format`: 入力がPNGの場合の出力形式（`png`/`webp`/`avif`）。スクリーンショットは `webp` が有効なことが多いです。
- `--watch --interval <秒>`: 監視モード（`.photo-reducer` を更新）
- `--file <ファイルパス>`: 単一ファイルを処理（`.photo-reducer` は触らない）

### 開発用
- `pnpm run dev -- --source <dir> --output <dir>` で ts-node 実行

## 出力される `.photo-reducer`
監視・バッチモードでは、処理元ディレクトリごとに `.photo-reducer` が生成され、`lastProcessedAt` と `lastRate` を保持しています（単一ファイル処理では更新されません）。
