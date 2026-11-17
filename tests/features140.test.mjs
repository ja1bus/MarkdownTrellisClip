// 1.4.0 の目次（仕様 §3.3）・チェックボックスの切り替え（§3.4）・イベント属性の前処理の修正（R1）。
// 試験表 docs/verification.md の 20261117-features-140 の T-22・T-24・T-26・T-41・T-42・T-46。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, fragmentHtml } from "./helpers.mjs";
import { headingList, toggleTaskEdit } from "../extension/core/anchors.js";
import { stripEventHandlers } from "../extension/core/render.js";
import { choosePaste, parseHtml } from "../extension/core/htmlpaste.js";
import { toClipboardPayload } from "../extension/core/richcopy.js";

const { window, renderer } = setup();
const anchorsOf = (source, opts = {}) => renderer.renderDocument(source, { anchors: true, ...opts }).anchors;
const F = "埋め草の段落です。".repeat(20);

test("F7: 目次は # と下線の見出しを上から順に、レベル付きで並べる（HTML の見出し・コードの中は除く）", () => {
  const DT = ["# 章1", "", F, "", "## 節1.1", "", F, "", "### 項1.1.1", "", "<h2>HTMLの見出し</h2>", "", "```md", "# コードの中", "```", "", "章2", "===", "", F, "", "## 節2.1", "", F].join("\n");
  const list = headingList(anchorsOf(DT));
  assert.deepEqual(list.map((item) => [item.level, item.text]), [[1, "章1"], [2, "節1.1"], [3, "項1.1.1"], [1, "章2"], [2, "節2.1"]]);
  const source = DT;
  const second = list[3].anchor;
  assert.equal(source.slice(second.start, second.start + 2), "章2");
});

test("F7: 目次の文字は表示どおりで空白を詰め、空の見出しは除く。上限で打ち切る", () => {
  const list = headingList(anchorsOf("## **太字** と `code` と [リンク](https://example.com)\n\n##   余分な   空白   ##\n\n#\n\n## 本物"));
  assert.deepEqual(list.map((item) => item.text), ["太字 と code と リンク", "余分な 空白", "本物"]);
  const many = Array.from({ length: 201 }, (_, i) => `## 見出し${i + 1}`).join("\n\n");
  const limited = headingList(anchorsOf(many));
  assert.equal(limited.length, 200);
  assert.equal(limited.at(-1).text, "見出し200");
  assert.equal(headingList(anchorsOf("<h1>HTMLだけ</h1>")).length, 0);
  assert.equal(headingList(anchorsOf("段落だけ")).length, 0);
});

test("F7: Frontmatter・全文フェンスの除外・引用やコンテナの中でも、見出しの原文の位置が正しい", () => {
  const front = "---\ntitle: x\n---\n# 本文の見出し";
  const [item] = headingList(anchorsOf(front));
  assert.equal(front.slice(item.anchor.start).startsWith("# 本文の見出し"), true);
  const fenced = "```markdown\n# 外側の中の見出し\n本文\n```";
  assert.equal(headingList(anchorsOf(fenced)).length, 0);
  const [inner] = headingList(anchorsOf(fenced, { unwrapFence: true }));
  assert.equal(fenced.slice(inner.anchor.start).startsWith("# 外側の中の見出し"), true);
  const quoted = headingList(anchorsOf("> # 引用の中\n\n::: note\n## 枠の中\n:::", { features: ["containers"] }));
  assert.deepEqual(quoted.map((item) => item.text), ["引用の中", "枠の中"]);
});

const DC = ["- [ ] 未完了", "- [x] 完了", "- [X] 大文字", "  - [ ] 子", "", "1. [ ] 番号", "", "<input type=\"checkbox\">", "", "> - [ ] 引用の中", "", "- [ ] 同じ", "- [ ] 同じ"].join("\n");

/** プレビューの n 番目のチェックボックスを押したときの切り替えの Edit。 */
function toggleAt(source, index, opts) {
  const result = renderer.renderDocument(source, { anchors: true, ...opts });
  const byElement = new Map(result.anchors.map((anchor) => [anchor.element, anchor]));
  const box = result.fragment.querySelectorAll("input[type='checkbox']")[index];
  const edit = toggleTaskEdit(source, byElement.get(box.closest("li")));
  return { edit, checked: box.hasAttribute("checked"), disabled: box.hasAttribute("disabled") };
}

const applied = (source, edit) => source.slice(0, edit.start) + edit.insert + source.slice(edit.end);

test("F8: チェックボックスに対応する原文の [ ] と [x] を切り替える（disabled は付けない）", () => {
  const expected = [
    ["- [ ] 未完了", "- [x] 未完了"],
    ["- [x] 完了", "- [ ] 完了"],
    ["- [X] 大文字", "- [ ] 大文字"],
    ["  - [ ] 子", "  - [x] 子"],
    ["1. [ ] 番号", "1. [x] 番号"],
  ];
  expected.forEach(([before, after], index) => {
    const { edit, checked, disabled } = toggleAt(DC, index);
    assert.equal(disabled, false);
    assert.equal(edit.checked, checked, `${before}: プレビューの状態と一致`);
    assert.equal(applied(DC, edit), DC.replace(before, after));
  });
  // 生の HTML の input、引用の中は対応しない
  assert.equal(toggleAt(DC, 5).edit, null);
  assert.equal(toggleAt(DC, 6).edit, null);
  // 同じ文字の項目は、押した方の行だけ
  const second = toggleAt(DC, 8).edit;
  assert.equal(applied(DC, second), DC.replace("- [ ] 同じ\n- [ ] 同じ", "- [ ] 同じ\n- [x] 同じ"));
});

test("F8: Frontmatter と全文フェンスの除外、コンテナの中でも正しい行を切り替える", () => {
  const source = "---\na: 1\n---\n```markdown\n- [ ] フェンスの中\n```";
  const { edit } = toggleAt(source, 0, { unwrapFence: true });
  assert.equal(applied(source, edit), source.replace("- [ ] フェンスの中", "- [x] フェンスの中"));
  const container = "::: note\n- [ ] 枠の中\n:::\n\n> [!NOTE]\n> - [ ] 注意の中";
  const all = ["alerts", "containers"];
  assert.equal(applied(container, toggleAt(container, 0, { features: all }).edit), container.replace("- [ ] 枠の中", "- [x] 枠の中"));
  assert.equal(toggleAt(container, 1, { features: all }).edit, null);
});

test("F8: 書式付きコピーはチェックボックスを今までどおり ☑・☐ にする", () => {
  const { html, text } = toClipboardPayload(renderer.renderDocument("- [x] 済み\n- [ ] 未").fragment);
  assert.match(text, /☑ 済み/u);
  assert.match(text, /☐ 未/u);
  assert.ok(!html.includes("<input"), html);
});

test("R1: 閉じない引用符のある HTML でも、前処理・描画・貼り付けの解析が速く終わる", () => {
  const X40 = `<div ${"x ".repeat(40)}"`;
  const timed = (fn) => {
    let worst = 0;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      fn();
      worst = Math.max(worst, performance.now() - started);
    }
    return worst;
  };
  assert.ok(timed(() => assert.equal(stripEventHandlers(X40), X40)) < 100);
  assert.ok(timed(() => renderer.renderDocument(`${X40}\n\n段落`)) < 100);
  const html = `${X40}<b>太字</b><p>本文</p>`;
  assert.ok(timed(() => choosePaste({ html, plain: "太字 本文" }, { DOMParser: window.DOMParser })) < 100);
  assert.ok(timed(() => parseHtml(html, window.DOMParser)) < 100);
  const big = `<div ${"x ".repeat(4000)}"`;
  assert.ok(timed(() => stripEventHandlers(big)) < 1000);
});

test("R1: on で始まる属性だけを除き、引用符の中の on…= は変えない（1.3.0 と同じ出力）", () => {
  const cases = [
    ["<p onclick=\"x\">a</p>", "<p  >a</p>"],
    ["<a title=\"x onclick=y\" href=\"#\">a</a>", "<a title=\"x onclick=y\" href=\"#\">a</a>"],
    ["<img src=x onerror=alert(1)>", "<img src=x  >"],
    ["<P ONCLICK='a'>", "<P  >"],
    ["<br onclick=x/>", "<br  >"],
    ["<input/onfocus=x>", "<input  >"],
    ["<p onclick>", "<p  >"],
    ["<p a=\"b\"onclick=\"c\">", "<p a=\"b\" >"],
    ["<svg><g onload=\"x\"/></svg>", "<svg><g  /></svg>"],
    ["a < b onclick=c", "a < b onclick=c"],
    ["<p\nonclick=\"x\"\n>", "<p  >"],
  ];
  for (const [input, output] of cases) {
    assert.equal(stripEventHandlers(input).replace(/ +/gu, " "), output.replace(/ +/gu, " "), input);
  }
  const out = fragmentHtml(window, renderer.renderMarkdown("<div onclick=\"a\" title=\"onclick=b\">x</div>").fragment);
  assert.ok(!/onclick="a"/u.test(out), out);
});

// ---- 2026-11-17 コードレビュー（docs/archive/code-review-20261117.md）の指摘の回帰確認 ----

test("レビュー R2: 項目の中の生 HTML の input は、タスクのチェックボックスとして扱わない", () => {
  const boxOf = (source) => {
    const result = renderer.renderDocument(source, { anchors: true });
    const boxes = [...result.fragment.querySelectorAll("input")];
    const items = result.anchors.filter((anchor) => anchor.type === "list_item");
    return { boxes, items };
  };
  for (const source of [
    "- [ ] task <input type=\"checkbox\">",
    "- [x] task <input type=\"checkbox\" checked>",
    "- [ ] task <input type=\"checkbox\" checked>",
    "- [ ] task\n\n  段落 <input type=\"checkbox\">",
  ]) {
    const { boxes, items } = boxOf(source);
    assert.equal(boxes.length, 2, source);
    assert.equal(items[0].checkbox, boxes[0], `${source}: タスクの box`);
    assert.notEqual(items[0].checkbox, boxes[1], `${source}: 生 HTML の box`);
  }
  // タスクでない項目の生 HTML の input、入れ子のタスクは自分の項目の box だけ
  assert.equal(boxOf("- <input type=\"checkbox\"> a").items[0].checkbox, null);
  const nested = boxOf("- [ ] 親 <input type=\"checkbox\">\n  - [x] 子");
  assert.equal(nested.items[0].checkbox, nested.boxes[0]);
  assert.equal(nested.items[1].checkbox, nested.boxes[2]);
  // 本文に目印に似たコメントを書いても box は増えない（乱数が違う）
  assert.equal(boxOf("- a <!--m00000000-b--><input type=\"checkbox\">").items[0].checkbox, null);
  // 目印は表示に残らない
  const html = fragmentHtml(window, renderer.renderDocument("- [ ] a\n\n<textarea>\n- [ ] b", { anchors: true }).fragment);
  assert.ok(!/m[0-9a-f]{8}-b/u.test(html), html);
});

test("レビュー R4: タグとして完成しない入力も、長さにおおむね比例する時間で前処理する", () => {
  const time = (input) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      stripEventHandlers(input);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  const patterns = [
    (n) => "<a".repeat(n),
    (n) => `<a${" x=\"<a\"".repeat(n)}`,
    (n) => `<a x="${"<a".repeat(n)}"`,
    (n) => "<a b".repeat(n),
    (n) => `${"<a".repeat(n)}<p onclick="x">ok</p>`,
  ];
  for (const make of patterns) {
    const small = time(make(16000));
    const large = time(make(64000));
    // 4倍の長さで、2乗なら16倍になる。線形なら4倍前後（測定のゆらぎを見込んで10倍未満、絶対時間も確認）
    assert.ok(large < Math.max(small * 10, 20), `${make(2)}: ${small.toFixed(1)}ms -> ${large.toFixed(1)}ms`);
    assert.ok(large < 300, `${make(2)}: ${large.toFixed(1)}ms`);
  }
  // 後ろの正常なタグのイベント属性は今までどおり除く
  assert.ok(!stripEventHandlers(`${"<a".repeat(1000)} <p onclick="x">ok</p>`).includes("onclick"));
  const t0 = performance.now();
  assert.equal(choosePaste({ html: "<a".repeat(64000), plain: "plain" }, { DOMParser: window.DOMParser }).kind, "plain");
  assert.ok(performance.now() - t0 < 1000);
});

test("T-47 (2): 閉じない引用符の属性が41・400・4,000個でも、前処理が指数的に遅くならない", () => {
  for (const [n, limit] of [[41, 100], [400, 100], [4000, 1000]]) {
    const input = `<div ${"x ".repeat(n)}"`;
    const started = performance.now();
    assert.equal(stripEventHandlers(input), input);
    const ms = performance.now() - started;
    assert.ok(ms < limit, `${n}: ${ms.toFixed(1)}ms`);
  }
});
