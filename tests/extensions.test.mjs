import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, fragmentHtml } from "./helpers.mjs";
import { detectFeatures, normalizeFeatures, maskCode, FEATURES, GITHUB_PRESET } from "../extension/core/extensions.js";

const { window, renderer } = setup();
const html = (markdown, features) => fragmentHtml(window, renderer.renderMarkdown(markdown, features).fragment);

test("部品を有効にしなければ、追加構文は文字のまま（GFM）", () => {
  const out = html("> [!NOTE]\n> 注意\n\n本文[^1] ==強調== [[ページ]] $x_1$\n\n[^1]: 注\n\n::: note\n中\n:::\n\n用語\n: 説明", []);
  for (const bad of ["markdown-alert", "footnote", "<mark>", "mtc-wikilink", "mtc-math", "mtc-container", "<dl>"]) {
    assert.ok(!out.includes(bad), `${bad} が出ている: ${out}`);
  }
});

test("alerts: 引用の先頭の [!NOTE] などを見出し付きの枠にする", () => {
  const out = html("> [!WARNING]\n> 気をつける\n\n> [!tip]\n> ヒント\n\n> [!NOTE] 同じ行に本文\n\n> 普通の引用", ["alerts"]);
  assert.ok(out.includes("<div class=\"markdown-alert markdown-alert-warning\"><p class=\"markdown-alert-title\">Warning</p>"), out);
  assert.ok(out.includes("気をつける"));
  assert.ok(!out.includes("[!WARNING]"));
  assert.ok(out.includes("markdown-alert-tip"));
  assert.ok(out.includes("[!NOTE] 同じ行に本文"), "同じ行に本文があるものは GitHub と同じく対象外");
  assert.ok(out.includes("<blockquote>\n<p>普通の引用</p>"));
});

test("footnotes: 参照を番号にし、注を末尾にまとめる。定義のない参照は文字のまま", () => {
  const out = html("一つ目[^a]と二つ目[^b]、もう一度[^a]、未定義[^x]。\n\n[^b]: 二つ目の**注**\n[^a]: 一つ目の注", ["footnotes"]);
  assert.ok(out.includes("<sup class=\"footnote-ref\"><a href=\"#mtc-fn-1\" id=\"mtc-fnref-1\">1</a></sup>"), out);
  assert.ok(out.includes("<a href=\"#mtc-fn-2\" id=\"mtc-fnref-2\">2</a>"));
  assert.ok(out.includes("[^x]"));
  assert.ok(out.includes("<section class=\"footnotes\">"));
  assert.ok(out.indexOf("一つ目の注") < out.indexOf("二つ目の"), "参照された順に並ばない");
  assert.ok(out.includes("<strong>注</strong>"));
  assert.ok(out.includes("<li id=\"mtc-fn-1\">"));
  assert.ok(!out.includes("[^b]:"));
});

test("footnotes: 2回目の変換に前回の注が残らない", () => {
  html("a[^1]\n\n[^1]: 前回", ["footnotes"]);
  const out = html("b", ["footnotes"]);
  assert.ok(!out.includes("前回") && !out.includes("footnotes"));
});

test("math: $$…$$ と $x$ を他の書式と区別して文字のまま表示し、金額は対象外", () => {
  const out = html("$$\na_1 * b_2 * c\n$$\n\n式 $x_1 * y_2*$ と 価格は $5 と $10 です。", ["math"]);
  assert.ok(out.includes("<div class=\"mtc-math mtc-math-display\">$$\na_1 * b_2 * c\n$$</div>"), out);
  assert.ok(out.includes("<span class=\"mtc-math\">$x_1 * y_2*$</span>"));
  assert.ok(out.includes("価格は $5 と $10 です"));
  assert.ok(!out.includes("<em>"));
});

test("containers: ::: name … ::: を枠にし、中のMarkdownを解釈する。入れ子と閉じない場合も扱う", () => {
  const out = html("::: warning\n**中身**\n\n:::: note\n内側\n::::\n:::\n\n後", ["containers"]);
  assert.ok(out.includes("<div class=\"mtc-container mtc-container-warning\">"), out);
  assert.ok(out.includes("<p class=\"mtc-container-title\">warning</p>"));
  assert.ok(out.includes("<strong>中身</strong>"));
  assert.ok(out.includes("mtc-container-note"));
  assert.ok(out.trim().endsWith("<p>後</p>"));
  assert.doesNotThrow(() => html("::: note\n閉じない", ["containers"]));
});

test("highlight: ==text== を mark にする", () => {
  assert.equal(html("これは==大事な**点**==です。a == b", ["highlight"]), "<p>これは<mark>大事な<strong>点</strong></mark>です。a == b</p>\n");
});

test("wikilinks: [[page]] と [[page|label]] をリンクの見た目にする（開かない）", () => {
  const out = html("[[設計メモ]] と [[docs/a.md|資料]]", ["wikilinks"]);
  assert.ok(out.includes("<span class=\"mtc-wikilink\" title=\"設計メモ\">設計メモ</span>"), out);
  assert.ok(out.includes("<span class=\"mtc-wikilink\" title=\"docs/a.md\">資料</span>"));
  assert.ok(!out.includes("href"));
});

test("deflists: 用語と : 説明 を定義リストにする", () => {
  const out = html("前の段落\n\nりんご\n: 赤い果物\n: 秋が旬\n\nみかん\n: **冬**の果物\n\n後の段落", ["deflists"]);
  assert.ok(out.includes("<dl>\n<dt>りんご</dt>\n<dd>赤い果物</dd>\n<dd>秋が旬</dd>\n<dt>みかん</dt>\n<dd><strong>冬</strong>の果物</dd>\n</dl>"), out);
  assert.ok(out.includes("<p>前の段落</p>") && out.includes("<p>後の段落</p>"));
});

test("追加構文の出力も許可リストで安全化する（同じ class を生HTMLで書いても実行されない）", () => {
  const source = "<div class=\"mtc-container evil\" onclick=\"x()\">a</div>\n\n[[<img src=x onerror=alert(1)>]] ==<script>alert(1)</script>==\n\n::: note onclick=x\n<iframe src=https://example.com></iframe>\n:::";
  const fragment = renderer.renderMarkdown(source, FEATURES).fragment;
  const elements = [...fragment.querySelectorAll("*")];
  // 要素として script・img・iframe がなく、どの要素にも on〜 属性がない（文字として表示される onerror=... は無害）
  assert.ok(!elements.some((el) => ["SCRIPT", "IMG", "IFRAME"].includes(el.nodeName)), fragmentHtml(window, fragment));
  assert.ok(!elements.some((el) => [...el.attributes].some((a) => /^on/iu.test(a.name))), fragmentHtml(window, fragment));
  assert.ok(!elements.some((el) => el.getAttribute("class") === "mtc-container evil"));
});

test("検出: コードの中は数えず、件数を返す。$x$ は数えない", () => {
  const counts = detectFeatures("> [!NOTE]\n> a\n\n本文[^1][^2]\n\n```\n[^3] ==x== [[y]]\n```\n\n`==z==` ==w==\n\n$$\nx\n$$\n\n価格 $5 と $x$\n\n::: tip\nb\n:::\n\n用語\n: 説明\n\n[[p]]");
  assert.deepEqual(counts, { alerts: 1, footnotes: 2, math: 1, containers: 1, highlight: 1, wikilinks: 1, deflists: 1 });
  assert.deepEqual(detectFeatures("# 普通の文書\n\n- a"), {});
});

test("部品の一覧を正規化し、GitHub互換は alerts と footnotes", () => {
  assert.deepEqual(normalizeFeatures(["math", "alerts", "unknown", 1, "math"]), ["alerts", "math"]);
  assert.deepEqual(normalizeFeatures(null), []);
  assert.deepEqual([...GITHUB_PRESET], ["alerts", "footnotes"]);
  assert.equal(maskCode("a `b` c").length, 7);
});

test("全文の変換で、有効な部品と検出の件数を返す", () => {
  const result = renderer.renderDocument("---\nt: 1\n---\n本文[^1]\n\n[^1]: 注", { features: ["footnotes"] });
  assert.deepEqual(result.detected, { footnotes: 2 });
  assert.ok(fragmentHtml(window, result.fragment).includes("footnotes"));
});
