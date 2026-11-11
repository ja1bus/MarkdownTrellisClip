# MarkdownTrellis Clip

[English](README.en.md) | 日本語

MarkdownTrellis Clip は、AIの回答などからコピーしたMarkdownを一時的に貼り付けて、プレビューで確かめ、必要なら少し直して、Markdownのまま、またはTeamsやメールに貼れる書式付きテキストとしてコピーする Google Chrome の拡張機能です。画面は日本語と英語に対応しています。

このリポジトリは、一般公開している MarkdownTrellis Clip のソースコードです。

## 主な機能

- ツールバーのアイコンで作業用のタブを開き、Ctrl+V で貼り付け（文字だけを取り込む）。原文とプレビューを並べて表示
- 書式付きテキストの貼り付け（初期値はオフ。［⚙］→［貼り付けの設定…］でオン）: AIの回答などからコピーした書式付きテキスト（HTML）を、見出し・太字・リスト・表・リンク・コードの Markdown に変換して取り込む。書式のない文章や Markdown の原文はそのまま貼り付ける
- GitHub互換のMarkdown（GFM）で表示: 見出し、強調、リスト、チェックリスト、表、取り消し線、リンク、自動リンク、コード、引用、水平線
- 書式ボタン: 見出し、太字、斜体、取り消し線、リスト、チェックリスト、リンク、画像、表、インラインコード、コードブロック、引用、水平線（1回の操作は Ctrl+Z の1回で戻る）
- ［Markdownをコピー］（原文そのまま）、［書式付きコピー］（インラインCSSのHTMLと、描画後のテキスト）、［選択範囲を書式付きコピー］
- 回答全体を囲むコードフェンスの検出と、プレビュー・書式付きコピーだけでの外側の除外。Frontmatterはプレビューから除き、原文に残す
- 追加構文（アラート、脚注、数式〔文字のまま表示〕、コンテナ、ハイライト、Wikiリンク、定義リスト）と、その検出・既定値の保存
- 原文の .md ダウンロード、［クリア］で原文と元に戻す履歴を消去

入力した本文は作業タブのメモリの中だけで扱い、保存も外部への送信もしません。保存するのは設定（追加構文の既定値と、書式付きテキストの貼り付けのオン・オフ）だけです。権限は `storage`（設定の保存）だけで、Webサイトへのアクセス、コンテンツスクリプト、アクセス解析はありません。プレビューは DOMPurify の許可リストと拡張ページの CSP で、スクリプトの実行と外部の読み込みを防いでいます。

## 対応 OS と実行環境

- Google Chrome 120 以降（最新の安定版を推奨）。動作確認は Windows 11 で行っています。
- アカウント、ほかのソフトウェア、インターネット接続は不要です。

## インストール

正式な配布先は [Chrome ウェブストア](https://chromewebstore.google.com/detail/markdowntrellis-clip/igldgckfcgjoinkicilfpkcbfilpggoe)です（無料）。

- Web ページ: https://www.ja1bus.com/markdowntrellis-clip/

この GitHub リポジトリでは、パッケージ化した拡張機能（ZIP・CRX）は配布していません。

## 基本的な使い方

1. ツールバーのアイコンを押して、作業用のタブを開きます。
2. Markdownをコピーして、作業タブで Ctrl+V を押します。
3. 右のプレビューで確かめ、必要なら書式ボタンで直します。
4. ［書式付きコピー］で Teams やメールへ、［Markdownをコピー］で原文のまま貼り付けます。

詳しくは取扱説明書をご覧ください。

- 取扱説明書: https://www.ja1bus.com/markdowntrellis-clip/manual/

## ソースから読み込む・テストする

### 必要なもの

- Google Chrome 120 以降
- テスト・lint を実行する場合だけ [Node.js](https://nodejs.org/) 22 以降（確認済み: 26.13.0）と npm

### Chrome への読み込み

ビルドは不要です。chrome://extensions で「デベロッパー モード」をオンにし、「パッケージ化されていない拡張機能を読み込む」で `extension` フォルダ（`manifest.json` のあるフォルダ）を選びます。リポジトリのルートは選ばないでください（`node_modules` などが入るため）。

### テスト

リポジトリのルートで実行します。

```powershell
npm ci
npm run check   # 同梱ライブラリと node_modules の一致、lint、単体テスト
npm run e2e     # インストール済みの Chrome を一時プロファイル・画面なしで起動して確認（日本語・英語）
```

`npm run e2e` は画面なしの Chrome でも OS のクリップボードを使うため、実行中にクリップボードの内容が上書きされます。Chrome の場所が見つからないときは `node tools/e2e.mjs --chrome <chrome.exe のパス>` で指定します。

### 構成

| パス | 内容 |
|---|---|
| `extension/manifest.json` | Manifest V3 の定義（権限は `storage` だけ、CSP） |
| `extension/background.js` | service worker。アイコンのクリックで作業タブを開く |
| `extension/editor.html` / `editor.css` / `editor.js` | 作業画面（原文、書式ボタン、プレビュー、コピー、ダウンロード、クリア） |
| `extension/core/` | 画面に依存しない処理（Frontmatter・全文フェンス、変換と安全化、追加構文、書式付きコピー、書式操作、書式付きテキストの貼り付け） |
| `extension/settings.js` | 設定（追加構文の既定値、書式付きテキストの貼り付け）の保存（保存を扱うのはこのファイルだけ） |
| `extension/vendor/` / `extension/licenses/` | 同梱のライブラリ（marked、DOMPurify）とライセンス。`npm run vendor` で `node_modules` から複製する |
| `extension/_locales/` / `extension/icons/` | 表示言語（英語・日本語）とアイコン（`node tools/make-icons.mjs` で作成） |
| `tests/` | Node.js の単体テスト（`node:test`、jsdom） |
| `tools/` | lint、同梱ライブラリの複製、Chrome での確認、アイコンの作成 |

Chrome ウェブストアへの申請用の資料・ZIP と画像の作成スクリプトは、このリポジトリに含めていません。ソースのコメントは日本語です。

## ライセンス

[MIT License](LICENSE) で公開しています。

Copyright (c) 2026 ja1bus（© ja1bus）

同梱の第三者ライブラリについては [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) をご覧ください。

## 無保証

このソフトウェアは「現状のまま」提供され、明示・黙示を問わず、いかなる保証もありません。作者は、このソフトウェアの使用によって生じたいかなる損害についても責任を負いません（詳しくは [LICENSE](LICENSE) をご覧ください）。

## 関連リンク

- Web ページ: https://www.ja1bus.com/markdowntrellis-clip/
- 取扱説明書: https://www.ja1bus.com/markdowntrellis-clip/manual/
- プライバシーポリシー: https://www.ja1bus.com/markdowntrellis-clip/privacy/
- お問い合わせ: contact@ja1bus.com
