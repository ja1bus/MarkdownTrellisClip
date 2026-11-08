import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, fragmentHtml } from "./helpers.mjs";

const { window, renderer } = setup();
const html = (markdown) => fragmentHtml(window, renderer.renderMarkdown(markdown).fragment);

test("空の入力は空の断片になる", () => {
  const result = renderer.renderDocument("");
  assert.equal(result.fragment.childNodes.length, 0);
  assert.equal(result.fence, false);
});

test("日本語と GFM の代表的な構文を表示用の要素にする", () => {
  const out = html([
    "# 見出し", "", "本文と**太字**と*斜体*と~~取り消し~~。", "",
    "- 箇条書き", "1. 番号", "", "> 引用", "",
    "| 左 | 中央 |", "|:--|:-:|", "| a | b |", "",
    "- [x] 済み", "- [ ] 未了", "",
    "https://example.com と [リンク](https://example.org)", "",
    "`code`", "", "```js", "const x = 1;", "```", "", "---",
  ].join("\n"));
  for (const fragment of [
    "<h1>見出し</h1>", "<strong>太字</strong>", "<em>斜体</em>", "<del>取り消し</del>",
    "<ul>", "<ol>", "<blockquote>", "<table>", "<th align=\"center\">中央</th>",
    "<input checked=\"\" disabled=\"\" type=\"checkbox\">", "<input disabled=\"\" type=\"checkbox\">",
    "<a href=\"https://example.com\">", "<a href=\"https://example.org\">リンク</a>",
    "<code>code</code>", "<code class=\"language-js\">", "<hr>",
  ]) {
    assert.ok(out.includes(fragment), `${fragment} が含まれない: ${out}`);
  }
});

test("Frontmatter はプレビューから除外する", () => {
  const result = renderer.renderDocument("---\nsecret: x\n---\n# 本文");
  const out = fragmentHtml(window, result.fragment);
  assert.ok(!out.includes("secret"));
  assert.ok(out.includes("<h1>本文</h1>"));
});

test("全文フェンスは指定したときだけ外す", () => {
  const source = "```markdown\n# 中身\n```";
  const kept = renderer.renderDocument(source);
  assert.equal(kept.fence, true);
  assert.equal(kept.fenceApplied, false);
  assert.ok(fragmentHtml(window, kept.fragment).includes("<pre>"));
  const unwrapped = renderer.renderDocument(source, { unwrapFence: true });
  assert.equal(unwrapped.fenceApplied, true);
  assert.ok(fragmentHtml(window, unwrapped.fragment).includes("<h1>中身</h1>"));
});

test("script・イベント属性・危険なURL・style・iframe を残さない", () => {
  const result = renderer.renderMarkdown([
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<a href=\"javascript:alert(1)\">j</a> <a href=\"data:text/html,x\">d</a> <a href=\"vbscript:x\">v</a>",
    "<p style=\"background:url(https://evil.example/a)\" onclick=\"x()\">p</p>",
    "<iframe src=\"https://evil.example\"></iframe><object data=x></object><embed src=x>",
    "<style>body{}</style><link rel=stylesheet href=https://evil.example/a.css><meta http-equiv=refresh content=0>",
    "<form action=https://evil.example><input type=text name=q></form>",
    "<svg><script>alert(1)</script></svg><math><mi>x</mi></math>",
    "[md](javascript:alert(1))",
  ].join("\n\n"));
  const out = fragmentHtml(window, result.fragment);
  for (const bad of ["<script", "onerror", "onclick", "javascript:", "data:text", "vbscript", "style=", "<iframe", "<object", "<embed", "<style", "<link", "<meta", "<form", "type=\"text\"", "<svg", "<math", "evil.example"]) {
    assert.ok(!out.toLowerCase().includes(bad), `${bad} が残っている: ${out}`);
  }
  assert.ok(result.removedCount > 0);
});

test("画像は読み込まず代替テキストの表示に置き換えて数える", () => {
  const result = renderer.renderMarkdown("![構成図](https://example.com/a.png) <img src=\"file:///C:/x.png\" alt=\"ローカル\"> ![](b.png)");
  const out = fragmentHtml(window, result.fragment);
  assert.equal(result.imageCount, 3);
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("example.com/a.png"));
  assert.ok(!out.includes("file:"));
  assert.ok(out.includes(">構成図</span>"));
  assert.ok(out.includes(">ローカル</span>"));
  assert.ok(out.includes(">Image</span>"));
});

test("許可した生HTML（details・kbd など）は残し、class は言語指定だけ許す", () => {
  const out = html("<details open><summary>概要</summary>\n\n本文\n\n</details>\n\n<kbd>Ctrl</kbd> <span class=\"x\" id=\"y\">s</span>");
  assert.ok(out.includes("<details open=\"\">"));
  assert.ok(out.includes("<summary>概要</summary>"));
  assert.ok(out.includes("<kbd>Ctrl</kbd>"));
  assert.ok(out.includes("<span>s</span>"));
});

test("相対リンクは無効にし、http・https・mailto・ページ内リンクだけ残す", () => {
  const out = html("[a](other.md) [b](mailto:x@example.com) [c](#top) [d](HTTPS://EXAMPLE.COM)");
  assert.ok(out.includes("<a>a</a>"));
  assert.ok(out.includes("href=\"mailto:x@example.com\""));
  assert.ok(out.includes("href=\"#top\""));
  assert.ok(out.includes("href=\"HTTPS://EXAMPLE.COM\""));
});

test("選択範囲は独立した断片として変換し、全文フェンスは外さない", () => {
  const source = "```markdown\n# 見出し\n本文 **強調**\n```";
  const start = source.indexOf("本文");
  const result = renderer.renderSelection(source, start, start + "本文 **強調**".length);
  assert.equal(fragmentHtml(window, result.fragment), "<p>本文 <strong>強調</strong></p>\n");
  const whole = renderer.renderSelection(source, 0, source.length);
  assert.ok(fragmentHtml(window, whole.fragment).includes("<pre>"));
});

test("範囲外の参照リンク定義は補わない", () => {
  const source = "[参照][r] を見る\n\n[r]: https://example.com";
  const result = renderer.renderSelection(source, 0, "[参照][r] を見る".length);
  assert.ok(!fragmentHtml(window, result.fragment).includes("<a"));
});

test("不正・巨大な入力でも例外にしない", () => {
  const broken = "| a |\n|--\n**閉じない\n```\n未完のコード\n<div><span>\n" + "[".repeat(5000) + "\n" + "> ".repeat(500) + "x";
  assert.doesNotThrow(() => renderer.renderDocument(broken));
  const large = "## 節\n\n" + "日本語の段落です。**強調**と`code`。\n\n".repeat(20000);
  const started = Date.now();
  const result = renderer.renderDocument(large);
  assert.ok(result.fragment.childNodes.length > 1000);
  assert.ok(Date.now() - started < 20000);
});

test("解析前にイベント属性を取り除く（Console への CSP 違反の記録を減らす）", async () => {
  const { stripEventHandlers } = await import("../extension/core/render.js");
  const squeeze = (value) => value.replace(/\s+/gu, " ");
  assert.equal(squeeze(stripEventHandlers("<img src=x onerror=alert(1)>")), "<img src=x >");
  assert.equal(squeeze(stripEventHandlers("<details open ontoggle=\"a()\" ONCLICK='b'>")), "<details open >");
  assert.equal(stripEventHandlers("<p>本文の onerror=x はそのまま</p>"), "<p>本文の onerror=x はそのまま</p>");
  assert.equal(squeeze(stripEventHandlers("<svg/onload=alert(1)>")), "<svg >");
});

test("生HTMLを含まない文書では、除外の件数を 0 とする", () => {
  const result = renderer.renderDocument("# 見出し\n\n- [x] 項目\n\n| a |\n|--|\n| 1 |\n\n```js\nx\n```");
  assert.equal(result.removedCount, 0);
  assert.equal(result.imageCount, 0);
});
