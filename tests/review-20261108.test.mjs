// 2026-11-08 のコードレビュー（docs/archive/code-review-20261108.md）の再現入力による回帰テスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, fragmentHtml } from "./helpers.mjs";
import { toClipboardPayload } from "../extension/core/richcopy.js";
import { formatEdit, applyEdit } from "../extension/core/formatter.js";
import { stripEventHandlers } from "../extension/core/render.js";
import { usesOutsideDefinitions } from "../extension/core/extensions.js";

const { window, renderer } = setup();
const copy = (source, features = []) => toClipboardPayload(renderer.renderDocument(source, { features }).fragment);
const html = (markdown, features) => fragmentHtml(window, renderer.renderMarkdown(markdown, features).fragment);

test("R1: 段落の中で書式の間にある改行は、プレーンテキストで空白1文字になる", () => {
  assert.equal(copy("a *b*\n**c** d").text, "a b c d");
  assert.equal(copy("[リンク](https://example.com)\n`code` と").text, "リンク code と");
  // ブロックの間の改行は増やさない
  assert.equal(copy("# 見出し\n\n段落\n\n- a\n- b").text, "見出し\n\n段落\n\n- a\n- b");
});

test("R2: コードの空白・空行と、表の末尾の空セルを保つ", () => {
  assert.equal(copy("```\na  \n\n\nb\n   \nc\n```").text, "a  \n\n\nb\n   \nc");
  assert.equal(copy("| A | B |\n|---|---|\n| x | |").text, "A\tB\nx\t");
  assert.equal(copy("前\n\n```\nx\n```\n\n後").text, "前\n\nx\n\n後");
});

test("R3: コンテナの中のコード例にある ::: で閉じない", () => {
  for (const fence of ["```", "~~~", "````"]) {
    const out = html(`::: note\n${fence}\n:::\n::: tip\n${fence}\nAFTER\n:::\nOUTSIDE`, ["containers"]);
    const box = out.slice(0, out.lastIndexOf("</div>"));
    assert.ok(box.includes("<pre><code>:::\n::: tip\n</code></pre>"), `${fence}: ${out}`);
    assert.ok(box.includes("<p>AFTER</p>"), `${fence}: AFTER がコンテナの外: ${out}`);
    assert.ok(out.trim().endsWith("<p>OUTSIDE</p>"), `${fence}: OUTSIDE がコンテナの中: ${out}`);
  }
});

test("R4: 定義リストの中の脚注は、後ろにある定義でも解決する", () => {
  const out = html("Term[^b]\n: ref[^a]\n\n[^a]: note\n[^b]: 用語の注", ["footnotes", "deflists"]);
  assert.ok(out.includes("<dd>ref<sup class=\"footnote-ref\">"), out);
  assert.ok(out.includes("<dt>Term<sup class=\"footnote-ref\">"), out);
  assert.ok(out.includes("note") && out.includes("用語の注") && out.includes("class=\"footnotes\""), out);
  // 脚注の本文に別の脚注を書いても壊れない
  assert.doesNotThrow(() => html("a[^1]\n\n[^1]: 注[^2]\n[^2]: 注の注", ["footnotes"]));
});

test("R5: 代替テキストや title の中の on〜= は変えず、本物のイベント属性だけを除く", () => {
  const result = renderer.renderMarkdown("![text onload=hello world](https://example.com/x.png) [l](https://example.com \"a onclick=b\")");
  const out = fragmentHtml(window, result.fragment);
  assert.ok(out.includes("data-alt=\"text onload=hello world\""), out);
  assert.ok(out.includes("title=\"a onclick=b\""), out);
  assert.equal(copy("![text onload=hello world](https://example.com/x.png)").text, "text onload=hello world");
  const squeeze = (v) => v.replace(/\s+/gu, " ");
  assert.equal(squeeze(stripEventHandlers("<img alt=\"x onerror=y\" onerror=\"z()\" src=a>")), "<img alt=\"x onerror=y\" src=a>");
  assert.equal(squeeze(stripEventHandlers("<svg/onload=alert(1)>")), "<svg >");
  assert.equal(squeeze(stripEventHandlers("<a title='on' ONCLICK=go href=\"x\">")), "<a title='on' href=\"x\">");
});

test("R6: バッククォートを含む文字のインラインコードは、もう一度押すと元に戻る", () => {
  // 選んだ文字が既にコード（`x`）なら、1回目で外れて2回目で戻る
  for (const original of ["a`b", "a``b", "`x`"]) {
    const text = `前 ${original} 後`;
    const start = 2;
    const first = formatEdit("code", text, start, start + original.length);
    const once = applyEdit(text, first);
    if (original !== "`x`") {
      assert.equal(once.slice(first.selStart, first.selEnd), original);
    }
    const second = formatEdit("code", once, first.selStart, first.selEnd);
    assert.equal(applyEdit(once, second), text, `${original}: ${once}`);
  }
});

test("R7: 変換後に何も残らない場合を判定できる（Frontmatter だけ・除外されるHTMLだけ）", () => {
  assert.equal(copy("---\ntitle: hi\n---").text, "");
  assert.equal(copy("<script>x()</script>").text, "");
  // 水平線・チェックボックスは内容として残る
  assert.notEqual(copy("---").text, "");
  assert.notEqual(copy("- [ ]").text.trim(), "");
});

test("R8: 範囲外の定義を使う参照（完全・省略・短縮・脚注）を見つけ、コードの中は見ない", () => {
  const doc = "本文 [docs][] と [docs] と [go][docs] と [^1]\n\n`[docs]` [未定義]\n\n[docs]: https://example.com\n[^1]: 注";
  const at = (part) => [doc.indexOf(part), doc.indexOf(part) + part.length];
  for (const part of ["[docs][]", "[docs] と", "[go][docs]"]) {
    assert.equal(usesOutsideDefinitions(doc, ...at(part), []), true, part);
  }
  assert.equal(usesOutsideDefinitions(doc, ...at("[^1]"), []), false, "脚注が無効なら見ない");
  assert.equal(usesOutsideDefinitions(doc, ...at("[^1]"), ["footnotes"]), true);
  assert.equal(usesOutsideDefinitions(doc, ...at("`[docs]` [未定義]"), []), false, "コードと未定義の [] は対象外");
  assert.equal(usesOutsideDefinitions(doc, 0, doc.length, ["footnotes"]), false, "定義も選択していれば通知しない");
});

test("R10: [!NOTE] の同じ行に書式付きの本文があればアラートにしない", () => {
  assert.ok(!html("> [!NOTE]**same line**", ["alerts"]).includes("markdown-alert"));
  assert.ok(!html("> [!NOTE] *same*", ["alerts"]).includes("markdown-alert"));
  assert.ok(html("> [!NOTE]\n> **next line**", ["alerts"]).includes("markdown-alert-note"));
  assert.ok(html("> [!NOTE]", ["alerts"]).includes("markdown-alert-note"));
});
