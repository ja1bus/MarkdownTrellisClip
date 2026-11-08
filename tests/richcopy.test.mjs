import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";
import { toClipboardPayload } from "../extension/core/richcopy.js";

const { renderer } = setup();
const copy = (source, opts) => toClipboardPayload(renderer.renderDocument(source, opts).fragment);

test("表・コード・引用にインラインCSSを付け、class を残さない", () => {
  const { html } = copy("| A | B |\n|:-:|--:|\n| 1 | 2 |\n\n```js\nlet a = 1;\n```\n\n> 引用\n\n`inline`");
  assert.match(html, /<table style="border-collapse:collapse;">/u);
  assert.match(html, /<th style="border:1px solid #999;[^"]*text-align:center;">A<\/th>/u);
  assert.match(html, /<td style="[^"]*text-align:right;">2<\/td>/u);
  assert.match(html, /<pre style="background:#f5f5f5;[^"]*"><code style="font-family:Consolas[^"]*">let a = 1;\n<\/code><\/pre>/u);
  assert.match(html, /<blockquote style="border-left:4px solid #ccc;/u);
  assert.match(html, /<code style="font-family:Consolas,'Courier New',monospace;background:#f2f2f2;padding:0 3px;">inline<\/code>/u);
  assert.ok(!html.includes("class="));
});

test("チェックボックスを ☑・☐ の文字にする", () => {
  const { html, text } = copy("- [x] 済み\n- [ ] 未了");
  assert.ok(!html.includes("<input"));
  assert.ok(html.includes("☑ 済み") && html.includes("☐ 未了"));
  assert.equal(text, "- ☑ 済み\n- ☐ 未了");
});

test("details は summary を太字の段落にして本文を展開する", () => {
  const { html, text } = copy("<details><summary>詳細</summary>\n\n隠れた本文\n\n</details>");
  assert.ok(!html.includes("<details") && !html.includes("<summary"));
  assert.ok(html.includes("<p><strong>詳細</strong></p>"));
  assert.ok(html.includes("<p>隠れた本文</p>"));
  assert.equal(text, "詳細\n\n隠れた本文");
});

test("画像は代替テキストにし、数を返す", () => {
  const { html, text, imageCount } = copy("前 ![構成図](https://example.com/a.png) 後 ![](x.png)");
  assert.equal(imageCount, 2);
  assert.ok(!html.includes("<img") && !html.includes("example.com"));
  assert.equal(text, "前 構成図 後");
});

test("Frontmatter を除外し、全文フェンスは指定したときだけ外す", () => {
  const source = "---\ntitle: x\n---\n```markdown\n# 見出し\n```";
  assert.ok(!copy(source).text.includes("title"));
  assert.ok(copy(source).html.includes("<pre"));
  const unwrapped = copy(source, { unwrapFence: true });
  assert.ok(unwrapped.html.includes("<h1>見出し</h1>"));
  assert.equal(unwrapped.text, "見出し");
});

test("プレーンテキストは描画後の内容に対応する", () => {
  const { text } = copy([
    "# 題名", "", "段落の**強調**と[リンク](https://example.com)。", "",
    "- 項目1", "  - 入れ子", "- 項目2", "", "3. 三", "4. 四", "",
    "| 列1 | 列2 |", "| --- | --- |", "| a | b |", "", "```", "  インデント保持", "```", "", "---", "", "最後",
  ].join("\n"));
  assert.equal(text, [
    "題名", "", "段落の強調とリンク。", "",
    "- 項目1", "  - 入れ子", "- 項目2", "", "3. 三", "4. 四", "",
    "列1\t列2", "a\tb", "", "  インデント保持", "", "---", "", "最後",
  ].join("\n"));
});

test("リンクは安全な href だけを持ち、HTML の特殊文字はエスケープする", () => {
  const { html } = copy("[a&b](https://example.com/?q=1&r=2 \"t<\") <b>x</b> 1 < 2");
  assert.ok(html.includes("<a href=\"https://example.com/?q=1&amp;r=2\" title=\"t&lt;\">a&amp;b</a>"));
  assert.ok(html.includes("1 &lt; 2"));
});

test("空の入力は空のペイロードになる", () => {
  const payload = copy("");
  assert.equal(payload.html, "");
  assert.equal(payload.text, "");
});

test("追加構文: アラート・コンテナ・ハイライト・数式・定義リストにインラインCSSを付ける", () => {
  const source = "> [!WARNING]\n> 注意\n\n::: note\n中身\n:::\n\n==大事== と $x_1$\n\n用語\n: 説明";
  const { html, text } = toClipboardPayload(renderer.renderDocument(source, { features: ["alerts", "containers", "highlight", "math", "deflists"] }).fragment);
  assert.match(html, /<div style="border-left:4px solid #9a6700;[^"]*"><p style="font-weight:bold;color:#9a6700;[^"]*">Warning<\/p>/u);
  assert.match(html, /<div style="border:1px solid #ccc;[^"]*">\s*<p style="font-weight:bold;[^"]*">note<\/p>/u);
  assert.ok(html.includes("<mark style=\"background:#fff3a3;\">大事</mark>"));
  assert.match(html, /<span style="font-family:Consolas[^"]*">\$x_1\$<\/span>/u);
  assert.match(html, /<dl>\s*<dt style="font-weight:bold;">用語<\/dt>\s*<dd style="margin:0 0 4px 24px;">説明<\/dd>\s*<\/dl>/u);
  assert.ok(!html.includes("class="));
  assert.equal(text, "Warning\n注意\n\nnote\n中身\n\n大事 と $x_1$\n\n用語\n  説明");
});

test("追加構文: 脚注は番号を残して戻りリンクを除き、Wikiリンクは文字にする", () => {
  const { html, text } = toClipboardPayload(renderer.renderDocument("本文[^1]と[[ページ|資料]]\n\n[^1]: 注の内容", { features: ["footnotes", "wikilinks"] }).fragment);
  assert.ok(html.includes("本文<sup>1</sup>と資料"), html);
  assert.ok(!html.includes("↩") && !html.includes("href=\"#") && !html.includes("<section"));
  assert.ok(html.includes("<li>注の内容 </li>") || html.includes("<li>注の内容</li>"), html);
  assert.equal(text, "本文[1]と資料\n\n---\n\n1. 注の内容");
});
