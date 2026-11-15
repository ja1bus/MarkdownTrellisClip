// 編集欄とプレビューの位置の連動（仕様 §3.2）の対応表。試験表 docs/verification.md の T-01〜T-05・T-26。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, fragmentHtml } from "./helpers.mjs";
import { FEATURES, GITHUB_PRESET } from "../extension/core/extensions.js";
import { findAnchor, blockLineCount, lineOffsetInBlock, insertAnchors, createAnchorRequest } from "../extension/core/anchors.js";
import { Marked } from "../extension/vendor/marked.esm.js";

const { window, renderer } = setup();
const ALL = [...FEATURES];

const D1 = [
  "---", "title: 試験", "---", "# 見出し1", "",
  "段落Aの1行目", "段落Aの**2行目**", "段落Aの3行目", "段落Aの4行目", "",
  "- 項目1", "- 項目2", "  - 入れ子2-1", "  - 入れ子2-2", "- 項目3", "",
  "> 引用の段落1", ">", "> 引用の段落2", "",
  "| 列A | 列B |", "| --- | --- |", "| a1 | b1 |", "| a2 | b2 |", "| a3 | b3 |", "",
  "```js", "const x = 1;", "const y = 2;", "const z = 3;", "```", "",
  "---", "",
  "<details><summary>概要</summary>中身</details>", "",
  "$$", "E = mc^2", "$$", "",
  "::: note", "コンテナの段落", ":::", "",
  "用語", ": 説明", "",
  "> [!NOTE]", "> 注意の本文", "",
  "本文の脚注[^1]と[リンク](https://example.com)", "",
  "[^1]: 注の本文",
  ...Array.from({ length: 40 }, (_, i) => ["", `埋め草${i + 1}`]).flat(),
].join("\n");

const D2 = ["```markdown", "# 外側の中の見出し", "", "中の段落", "", ...Array.from({ length: 30 }, (_, i) => [`埋め草${i + 1}`, ""]).flat(), "```"].join("\n");
const D2b = ["---", "a: 1", "---", "```md", "## 見出しF", "", "段落F", "```"].join("\n");
const D2c = D2b.replace("a: 1\n---", "a: 1\n...");
const C1 = ["<!-- 利用者のコメント -->", "", "段落の途中<!-- 行内 -->コメント", "", "<!--mtc-anchor-0-0-->", "", "```html", "<!-- コードの中 -->", "```"].join("\n");
const C2 = ["<script>alert(1)</script>", "", "段落P", "", "<!-- 利用者のコメント -->", "", "段落Q"].join("\n");
const D3 = ["見出しS", "===", "", "* 星の項目", "\t- タブで字下げした入れ子", "", "> 遅延した", "続きの行", "", "    字下げのコード", "", "[ref]: https://example.com", "", "1) 番号の項目"].join("\n");

/** 位置 offset が何行目か（1始まり）。 */
const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

function anchorsOf(source, opts = {}) {
  const result = renderer.renderDocument(source, { features: ALL, ...opts, anchors: true });
  return { result, anchors: result.anchors };
}

/** 要素の対応の開始行（同じ要素の対応は1つ）。 */
function lineFor(source, anchors, element) {
  const found = anchors.filter((a) => a.element === element);
  assert.equal(found.length, 1, `${element?.outerHTML?.slice(0, 60)} の対応の数: ${found.length}`);
  return lineOf(source, found[0].start);
}

function hasComment(window, node) {
  const walker = window.document.createTreeWalker(node, window.NodeFilter.SHOW_COMMENT);
  return walker.nextNode() !== null;
}

test("T-01: D1 の各ブロックが原文の行に対応する", () => {
  const { result, anchors } = anchorsOf(D1);
  const f = result.fragment;
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(anchors[i - 1].start <= anchors[i].start, "start の昇順でない");
  }
  const at = (el) => lineFor(D1, anchors, el);
  const top = [...f.children];
  const ps = top.filter((el) => el.nodeName === "P");
  const ul = top.find((el) => el.nodeName === "UL");
  const items = [...ul.querySelectorAll(":scope > li")];
  const nested = [...ul.querySelectorAll("li li")];
  const quote = top.find((el) => el.nodeName === "BLOCKQUOTE");
  const table = top.find((el) => el.nodeName === "TABLE");
  const pre = top.find((el) => el.nodeName === "PRE");
  const math = top.find((el) => el.classList.contains("mtc-math-display"));
  const container = top.find((el) => el.classList.contains("mtc-container"));
  const alert = top.find((el) => el.classList.contains("markdown-alert"));
  const expected = [
    [top.find((el) => el.nodeName === "H1"), 4], [ps[0], 6], [ul, 11],
    [items[0], 11], [items[1], 12], [items[2], 15], [nested[0], 13], [nested[1], 14],
    [quote, 17], [quote.querySelectorAll("p")[0], 17], [quote.querySelectorAll("p")[1], 19],
    [table, 21], [pre, 27], [top.find((el) => el.nodeName === "HR"), 33], [top.find((el) => el.nodeName === "DETAILS"), 35],
    [math, 37], [container, 41], [container.querySelector("p:not(.mtc-container-title)"), 42],
    [top.find((el) => el.nodeName === "DL"), 45], [alert, 48],
    [ps.find((p) => p.textContent.startsWith("本文の脚注")), 51],
  ];
  for (const [element, line] of expected) {
    assert.ok(element, `要素がない（L${line}）`);
    assert.equal(at(element), line, `${element.nodeName} の行`);
  }
  for (let n = 1; n <= 40; n++) {
    const p = ps.find((el) => el.textContent === `埋め草${n}`);
    assert.equal(at(p), 53 + 2 * n, `埋め草${n}`);
  }
  // 範囲は塊の最後の行まで含み、次の塊の行を含まない
  for (const [element, last] of [[ps[0], 9], [table, 25], [pre, 31], [math, 39], [container, 43], [alert, 49]]) {
    const anchor = anchors.find((a) => a.element === element);
    const endLine = lineOf(D1, anchor.end - (D1[anchor.end - 1] === "\n" ? 1 : 0));
    assert.equal(endLine, last, `${element.nodeName} の範囲の終わり`);
  }
  for (const anchor of anchors) {
    const line = lineOf(D1, anchor.start);
    assert.ok(![1, 2, 3, 53].includes(line), `L${line} から始まる対応がある`);
    assert.ok(!anchor.element.closest("section.footnotes"), "脚注の一覧に対応がある");
  }
});

test("T-02: Frontmatter と全文フェンスの除外があってもずれない", () => {
  for (const source of [D2b, D2c]) {
    const { result, anchors } = anchorsOf(source, { unwrapFence: true });
    const f = result.fragment;
    assert.equal(lineFor(source, anchors, f.querySelector("h2")), 5);
    assert.equal(lineFor(source, anchors, f.querySelector("p")), 7);
    for (const anchor of anchors) {
      assert.ok(![1, 2, 3, 4, 8].includes(lineOf(source, anchor.start)));
    }
  }
  const { result, anchors } = anchorsOf(D2b, { unwrapFence: false });
  assert.equal(lineFor(D2b, anchors, result.fragment.querySelector("pre")), 4);
  const unwrapped = anchorsOf(D2, { unwrapFence: true });
  assert.equal(lineFor(D2, unwrapped.anchors, unwrapped.result.fragment.querySelector("h1")), 2);
});

const DANGEROUS = [
  "<img src=x onerror=alert(1)>", "<a href=\"javascript:alert(1)\">x</a>", "<iframe src=\"https://example.com\"></iframe>",
  "<svg><script>alert(1)</script></svg>", "<style>body{display:none}</style>\n\n本文", "<meta http-equiv=refresh content=0>\n\n本文",
  "<link rel=stylesheet href=https://example.com/a.css>\n\n本文", "<!-- c -->\n\n本文", "   \n\n本文", "\n\n\n# 見出し",
  "<textarea>\n\n# 閉じない\n\n- a", "<div>\n\n- 閉じない div の中\n\n> 引用", "<table><tr><td>\n\n段落\n\n</td></tr></table>",
  "<pre>\n\n# 中\n\n", "<title>\n\n# t", "<p onclick=\"x\">段落</p>\n\n![画像](https://example.com/a.png)",
];
const CORPUS = [D1, D2, D2b, C1, C2, D3, ...DANGEROUS,
  "a *b*\n**c** d", "::: tip\n```\n:::\n```\n:::", "用語\n: 説明[^n]\n\n[^n]: 注", "- [x] 済み\n- [ ] 未了\n  1. 入れ子\n\n     段落",
  "> - 引用の中のリスト\n>   続き\n> ```\n> code\n> ```", "| a |\n|--\n**閉じない\n```\n未完のコード\n<div><span>\n" + "[".repeat(200),
];

test("T-03・T-26: anchors の有無で表示の断片・件数が同じで、コメントが残らない", () => {
  for (const features of [[], [...GITHUB_PRESET], ALL]) {
    for (const source of CORPUS) {
      for (const unwrapFence of [false, true]) {
        const plain = renderer.renderDocument(source, { features, unwrapFence });
        const withAnchors = renderer.renderDocument(source, { features, unwrapFence, anchors: true });
        const label = `${JSON.stringify(source.slice(0, 40))} / ${features.join(",")} / ${unwrapFence}`;
        assert.equal(fragmentHtml(window, withAnchors.fragment), fragmentHtml(window, plain.fragment), label);
        assert.equal(withAnchors.removedCount, plain.removedCount, `除いた件数: ${label}`);
        assert.equal(withAnchors.imageCount, plain.imageCount, `画像の件数: ${label}`);
        assert.ok(!hasComment(window, withAnchors.fragment), `コメントが残る: ${label}`);
        assert.ok(!fragmentHtml(window, withAnchors.fragment).includes("mtc-anchor"), `目印が残る: ${label}`);
        assert.equal(plain.anchors, undefined);
        assert.ok(Array.isArray(withAnchors.anchors));
      }
    }
  }
});

test("T-04: コメントと安全化で消えるブロックの後の段落は、その段落の行だけに対応する", () => {
  {
    const { result, anchors } = anchorsOf(C1);
    const f = result.fragment;
    assert.ok(!hasComment(window, f));
    const p = f.querySelector("p");
    assert.equal(p.textContent, "段落の途中コメント");
    assert.equal(lineFor(C1, anchors, p), 3);
    const pre = f.querySelector("pre");
    assert.ok(pre.textContent.includes("<!-- コードの中 -->"));
    assert.equal(lineFor(C1, anchors, pre), 7);
  }
  {
    const { result, anchors } = anchorsOf(C2);
    const f = result.fragment;
    assert.equal(f.querySelector("script"), null);
    const [p, q] = f.querySelectorAll("p");
    assert.equal(lineFor(C2, anchors, p), 3);
    assert.equal(lineFor(C2, anchors, q), 7);
  }
});

test("T-05: raw がそのまま見つからない形（setext・タブの入れ子・遅延した引用・字下げのコード）", () => {
  const { result, anchors } = anchorsOf(D3);
  const f = result.fragment;
  for (let i = 1; i < anchors.length; i++) {
    assert.ok(anchors[i - 1].start <= anchors[i].start);
  }
  assert.equal(lineFor(D3, anchors, f.querySelector("h1")), 1);
  assert.equal(lineFor(D3, anchors, f.querySelector("ul > li")), 4);
  assert.equal(lineFor(D3, anchors, f.querySelector("li li")), 5);
  assert.equal(lineFor(D3, anchors, f.querySelector("blockquote")), 7);
  assert.equal(lineFor(D3, anchors, f.querySelector("blockquote p")), 7);
  assert.equal(lineFor(D3, anchors, f.querySelector("pre")), 10);
  assert.equal(lineFor(D3, anchors, f.querySelector("ol > li")), 14);
  assert.ok(anchors.every((a) => lineOf(D3, a.start) !== 12));
});

test("アラートの中の段落は [!NOTE] の次の行から（枠の先頭の行は枠に対応する）", () => {
  const { result, anchors } = anchorsOf(D1);
  const box = result.fragment.querySelector(".markdown-alert");
  const inner = box.querySelector("p:not(.markdown-alert-title)");
  assert.equal(lineFor(D1, anchors, box), 48);
  assert.equal(lineFor(D1, anchors, inner), 49);
  const offset48 = D1.split("\n").slice(0, 47).join("\n").length + 1;
  assert.equal(findAnchor(anchors, offset48).element, box);
});

test("/code-review 1: 引用ばかりの長い文書でも、対応表を作る時間が文字数に比例する程度に収まる", () => {
  const quoted = (count) => Array.from({ length: count }, (_, i) => `> p${i} 1行目の文\n> 2行目の文`).join("\n\n");
  // 目印を差し込む時間が、marked の解析より短いこと（直す前は約11万字で解析 26ms に対し 121ms。文字数の2乗で増えた）
  const big = quoted(5000);
  const marked = new Marked({ gfm: true });
  let lex = Infinity;
  let insert = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const tokens = marked.lexer(big);
    const t1 = performance.now();
    insertAnchors(tokens, createAnchorRequest(big, 0));
    const t2 = performance.now();
    lex = Math.min(lex, t1 - t0);
    insert = Math.min(insert, t2 - t1);
  }
  assert.ok(insert < lex, `目印の差し込み ${insert.toFixed(1)}ms / 解析 ${lex.toFixed(1)}ms（${big.length}字）`);
  // 引用の中の段落にも対応がある
  const { result, anchors } = anchorsOf(quoted(3));
  const ps = result.fragment.querySelectorAll("blockquote p");
  assert.equal(lineFor(quoted(3), anchors, ps[2]), 7);
});

test("/code-review 4: 余白のあるリストで項目と段落の範囲が同じときは、内側の段落を選ぶ", () => {
  const source = "1. one\n2. two\n\n   para";
  const { anchors } = anchorsOf(source);
  assert.equal(findAnchor(anchors, 0).element.nodeName, "P");
});

test("/code-review 5: HTML で書いた表は GFM の表として扱わない（type で区別する）", () => {
  const source = "<table>\n<tr>\n<td>a</td>\n</tr>\n<tr>\n<td>b</td>\n</tr>\n</table>\n\n| x |\n|---|\n| 1 |";
  const { result, anchors } = anchorsOf(source);
  const [html, gfm] = result.fragment.querySelectorAll("table");
  assert.equal(anchors.find((a) => a.element === html).type, "html");
  assert.equal(anchors.find((a) => a.element === gfm).type, "table");
});

test("findAnchor: 位置以下で最後に始まる塊、範囲の外なら含む塊、前に塊がなければ null", () => {
  const { anchors } = anchorsOf(D1);
  const offsetOfLine = (n) => D1.split("\n").slice(0, n - 1).join("\n").length + (n > 1 ? 1 : 0);
  const name = (offset) => findAnchor(anchors, offset)?.element ?? null;
  assert.equal(name(offsetOfLine(2)), null);
  assert.equal(name(offsetOfLine(5)).nodeName, "H1");
  assert.equal(name(offsetOfLine(10)).nodeName, "P");
  assert.equal(name(offsetOfLine(11)).nodeName, "LI");
  assert.equal(name(offsetOfLine(14) + 3).textContent, "入れ子2-2");
  assert.equal(name(offsetOfLine(18)).nodeName, "BLOCKQUOTE");
  assert.equal(name(offsetOfLine(53)).textContent.startsWith("本文の脚注"), true);
  const table = anchors.find((a) => a.element.nodeName === "TABLE");
  assert.equal(blockLineCount(D1, table), 5);
  assert.equal(lineOf(D1, lineOffsetInBlock(D1, table, 3)), 24);
  assert.equal(lineOf(D1, lineOffsetInBlock(D1, table, 99)), 25);
});
