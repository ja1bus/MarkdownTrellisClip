# Third-party notices / 第三者ライブラリの表記

MarkdownTrellis Clip bundles the following third-party software in `extension/vendor/`. Each is used under its own license. The full license texts are in `extension/licenses/`.

MarkdownTrellis Clip は、次の第三者ソフトウェアを `extension/vendor/` に同梱しています。それぞれのライセンスに従います。ライセンスの全文は `extension/licenses/` にあります。

| Software | Version | License | Files |
|---|---|---|---|
| [marked](https://github.com/markedjs/marked) | 18.1.3 | MIT License (the license file also contains the original Markdown notice, BSD-style) | `extension/vendor/marked.esm.js`, `extension/licenses/marked-LICENSE.txt` |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.17 | Apache License 2.0 or Mozilla Public License 2.0 (used under the Apache License 2.0) | `extension/vendor/purify.es.mjs`, `extension/licenses/dompurify-LICENSE.txt` |
| [Turndown](https://github.com/mixmark-io/turndown) | 7.2.5 | MIT License | `extension/vendor/turndown.browser.es.js`, `extension/licenses/turndown-LICENSE.txt` |

The bundled files are copied from the npm packages without changes, except that the trailing source map reference line is removed (`npm run vendor`).

同梱のファイルは npm パッケージから複製したもので、末尾のソースマップ参照行を除いて変更していません（`npm run vendor`）。

Development dependencies (not bundled in the extension): jsdom (MIT License), used only by the tests.

開発用の依存（拡張機能には含めない）: jsdom（MIT License）。テストでだけ使います。
