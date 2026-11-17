import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEdit, applyEdit, continueList, indentList, linkPaste } from "../extension/core/formatter.js";

/** "|" をカーソル、"[" "]" を選択範囲として書いた文字列で操作を試す。 */
function run(command, marked) {
  const { text, start, end } = parse(marked);
  const edit = formatEdit(command, text, start, end, { tableHeaders: ["列1", "列2"] });
  if (edit === null) {
    return null;
  }
  const result = applyEdit(text, edit);
  return show(result, edit.selStart, edit.selEnd);
}

function parse(marked) {
  const caret = marked.indexOf("|");
  if (caret >= 0 && !marked.includes("[") ) {
    return { text: marked.replace("|", ""), start: caret, end: caret };
  }
  const start = marked.indexOf("[");
  const text = marked.replace("[", "");
  const end = text.indexOf("]");
  return { text: text.replace("]", ""), start, end };
}

function show(text, start, end) {
  if (start === end) {
    return text.slice(0, start) + "|" + text.slice(start);
  }
  return text.slice(0, start) + "[" + text.slice(start, end) + "]" + text.slice(end);
}

test("太字: 選択を囲み、もう一度で外す。前後の空白は外に残す", () => {
  assert.equal(run("bold", "これは[ 重要 ]です"), "これは **[重要]** です");
  assert.equal(run("bold", "これは **[重要]** です"), "これは [重要] です");
  assert.equal(run("bold", "これは [**重要**] です"), "これは [重要] です");
});

test("太字: 未選択なら記号を入れて間にカーソル、空の囲みでもう一度押すと外す", () => {
  assert.equal(run("bold", "あ|い"), "あ**|**い");
  assert.equal(run("bold", "あ**|**い"), "あ|い");
});

test("太字: 複数行は行ごとに囲み、空行は飛ばす", () => {
  assert.equal(run("bold", "[一\n\n二]"), "[**一**\n\n**二**]");
});

test("見出し: 行全体に付け、同じレベルで外し、別レベルに置き換える", () => {
  assert.equal(run("h2", "タイ|トル"), "## タイ|トル");
  assert.equal(run("h2", "## タイ|トル"), "タイ|トル");
  assert.equal(run("h1", "### タイ|トル"), "# タイ|トル");
  assert.equal(run("h3", "[一\n二]"), "[### 一\n### 二]");
});

test("箇条書き・番号付き・チェックリスト: 付ける、外す、種類を替える", () => {
  assert.equal(run("bullet", "[a\nb]"), "[- a\n- b]");
  assert.equal(run("bullet", "[- a\n- b]"), "[a\nb]");
  assert.equal(run("ordered", "[a\n\nb]"), "[1. a\n\n2. b]");
  assert.equal(run("task", "[- a\n1. b]"), "[- [ ] a\n- [ ] b]");
  const tasks = "- [ ] a\n- [x] b";
  assert.equal(applyEdit(tasks, formatEdit("task", tasks, 0, tasks.length)), "a\nb");
  assert.equal(run("bullet", "  ネ|スト"), "  - ネ|スト");
});

test("番号付き: すぐ上の行が同じ字下げの番号付きなら続きの番号にする", () => {
  assert.equal(run("ordered", "1. a\n2. b\n[c\nd]"), "1. a\n2. b\n[3. c\n4. d]");
});

test("選択の終わりが行頭なら、その行は対象にしない", () => {
  assert.equal(run("bullet", "[a\n]b"), "[- a]\nb");
});

test("リンク: 文字を選べばURL部分を選択、URLを選べば文字の位置にカーソル", () => {
  assert.equal(run("link", "見る[資料]を"), "見る[資料]([https://])を");
  assert.equal(run("link", "[https://example.com]"), "[|](https://example.com)");
  assert.equal(run("link", "あ|"), "あ[|](https://)");
});

test("インラインコード: 囲みと解除、中のバッククォートには長い区切りを使う", () => {
  assert.equal(run("code", "実行 [npm test] する"), "実行 `[npm test]` する");
  assert.equal(run("code", "実行 [`npm test`] する"), "実行 [npm test] する");
  assert.equal(run("code", "[a`b]"), "`` [a`b] ``");
  assert.equal(run("code", "x|y"), "x`|`y");
});

test("コードブロック: 選択した行を囲み、もう一度で外す", () => {
  assert.equal(run("codeblock", "前\n[a\nb]\n後"), "前\n```\n[a\nb]\n```\n後");
  assert.equal(run("codeblock", "[```\na\n```]"), "[a]");
  assert.equal(run("codeblock", "[x\n```\ny]"), "````\n[x\n```\ny]\n````");
});

test("コードブロック: 未選択なら空行に挿入、文字のある行では次の行に挿入", () => {
  assert.equal(run("codeblock", "|"), "```\n|\n```");
  assert.equal(run("codeblock", "文|章"), "文章\n```\n|\n```");
});

test("表: 文字のある行の後に空行を空けて挿入し、最初の見出しを選択する", () => {
  assert.equal(run("table", "本文|"), "本文\n\n| [列1] | 列2 |\n| --- | --- |\n|  |  |");
  assert.equal(run("table", "|"), "| [列1] | 列2 |\n| --- | --- |\n|  |  |");
  assert.equal(run("table", "前\n|\n後"), "前\n\n| [列1] | 列2 |\n| --- | --- |\n|  |  |\n\n後");
});

test("置き換え範囲は変わった部分だけに縮める", () => {
  const text = "a\nbbbb\nc";
  const edit = formatEdit("h1", text, 3, 3);
  assert.deepEqual([edit.start, edit.end, edit.insert], [2, 2, "# "]);
});

test("未知の操作は何もしない", () => {
  assert.equal(formatEdit("unknown", "a", 0, 0), null);
});

test("斜体: * で囲み、太字の ** とは区別する", () => {
  assert.equal(run("italic", "これは[大事]です"), "これは*[大事]*です");
  assert.equal(run("italic", "これは*[大事]*です"), "これは[大事]です");
  assert.equal(run("italic", "これは**[大事]**です"), "これは***[大事]***です");
  assert.equal(run("bold", "これは***[大事]***です"), "これは*[大事]*です");
  assert.equal(run("italic", "**|**"), "***|***");
});

test("取り消し線: ~~ で囲み、もう一度で外す", () => {
  assert.equal(run("strike", "[古い]手順"), "~~[古い]~~手順");
  assert.equal(run("strike", "~~[古い]~~手順"), "[古い]手順");
});

test("引用: 行頭に > を付け、全行に付いていれば外す", () => {
  assert.equal(run("quote", "[一\n\n二]"), "[> 一\n\n> 二]");
  assert.equal(run("quote", "[> 一\n>二]"), "[一\n二]");
});

test("画像: リンクと同じ要領で ![ ] を挿入する", () => {
  assert.equal(run("image", "あ|"), "あ![|](https://)");
  assert.equal(run("image", "[構成図]"), "![構成図]([https://])");
  assert.equal(run("image", "[https://example.com/a.png]"), "![|](https://example.com/a.png)");
});

test("水平線: 独立した行に置き、前の行の文字を見出しにしない", () => {
  assert.equal(run("hr", "本文|"), "本文\n\n---|");
  assert.equal(run("hr", "前\n|\n後"), "前\n\n---|\n\n後");
  assert.equal(run("hr", "|"), "---|");
});

// ---- 1.4.0: Enter・Tab（仕様 §2.2）、見出しのシフト、URL の貼り付け ----

/** "‸" をカーソル、"«" "»" を選択として書いた文字列。 */
function at(marked) {
  const caret = marked.indexOf("‸");
  if (caret >= 0) {
    return { text: marked.replace("‸", ""), start: caret, end: caret };
  }
  const start = marked.indexOf("«");
  const text = marked.replace("«", "");
  const end = text.indexOf("»");
  return { text: text.replace("»", ""), start, end };
}

function shown(text, edit) {
  const result = applyEdit(text, edit);
  if (edit.selStart === edit.selEnd) {
    return result.slice(0, edit.selStart) + "‸" + result.slice(edit.selStart);
  }
  return result.slice(0, edit.selStart) + "«" + result.slice(edit.selStart, edit.selEnd) + "»" + result.slice(edit.selEnd);
}

function enter(marked) {
  const { text, start, end } = at(marked);
  const edit = continueList(text, start, end);
  return edit && shown(text, edit);
}

function tab(marked, outdent = false) {
  const { text, start, end } = at(marked);
  const edit = indentList(text, start, end, outdent);
  return edit && shown(text, edit);
}

test("F1: Enter で箇条書き・番号付き・チェックリスト・引用の記号を続ける", () => {
  assert.equal(enter("- 項目A‸"), "- 項目A\n- ‸");
  assert.equal(enter("* 項目B‸"), "* 項目B\n* ‸");
  assert.equal(enter("+ 項目C‸"), "+ 項目C\n+ ‸");
  assert.equal(enter("1. 番号‸"), "1. 番号\n2. ‸");
  assert.equal(enter("9) 番号‸"), "9) 番号\n10) ‸");
  assert.equal(enter("- [x] 済み‸"), "- [x] 済み\n- [ ] ‸");
  assert.equal(enter("- [ ] 未‸"), "- [ ] 未\n- [ ] ‸");
  assert.equal(enter("> 引用‸"), "> 引用\n> ‸");
  assert.equal(enter("> - 引用のリスト‸"), "> - 引用のリスト\n> - ‸");
  assert.equal(enter("> > a‸"), "> > a\n> > ‸");
  assert.equal(enter("  - 入れ子‸"), "  - 入れ子\n  - ‸");
  assert.equal(enter("- 前半‸後半"), "- 前半\n- ‸後半");
  assert.equal(enter("1.  a‸"), "1.  a\n2.  ‸");
  assert.equal(enter("-\ta‸"), "-\ta\n-\t‸");
  assert.equal(enter("\t- a‸"), "\t- a\n\t- ‸");
  assert.equal(enter("1. a‸\n2. b"), "1. a\n2. ‸\n2. b");
});

test("F1: 記号だけの行の Enter は記号を消して空行にする", () => {
  assert.equal(enter("- 項目\n- ‸"), "- 項目\n‸");
  assert.equal(enter("1. a\n2. ‸"), "1. a\n‸");
  assert.equal(enter("- [ ] ‸"), "‸");
  assert.equal(enter("> ‸"), "‸");
  assert.equal(enter("  - ‸"), "‸");
  assert.equal(enter("-    ‸"), "‸");
  assert.equal(enter("- a\n- ‸\n- c"), "- a\n‸\n- c");
});

test("F1: 範囲の選択・記号の途中・リストでない行・水平線では Enter に介入しない", () => {
  assert.equal(enter("- «項目»"), null);
  assert.equal(enter("段落‸"), null);
  assert.equal(enter("  字下げの段落‸"), null);
  assert.equal(enter("‸- a"), null);
  assert.equal(enter("-‸ a"), null);
  assert.equal(enter("- [‸x] a"), null);
  assert.equal(enter("* * *‸"), null);
  assert.equal(enter("- - -‸"), null);
  assert.equal(enter("-abc‸"), null);
  // 記号の後ろに空白がない行（下線の見出しの「-」・「1.」だけ）は、消さずに標準の改行に任せる
  assert.equal(enter("見出し\n-‸"), null);
  assert.equal(enter("1.‸"), null);
  assert.equal(enter("*‸"), null);
});

test("F1: Tab は直前の同じ字下げの項目の記号の幅だけ字下げする", () => {
  assert.equal(tab("- a\n- b‸"), "- a\n  - b‸");
  assert.equal(tab("1. a\n2. b‸"), "1. a\n   2. b‸");
  assert.equal(tab("10. a\n11. b‸"), "10. a\n    11. b‸");
  assert.equal(tab("- [ ] a\n- [ ] b‸"), "- [ ] a\n  - [ ] b‸");
  assert.equal(tab("- a‸"), "  - a‸");
  assert.equal(tab("1. a‸"), "   1. a‸");
  assert.equal(tab("- a\n  続き\n\n- b‸"), "- a\n  続き\n\n  - b‸");
  assert.equal(tab("10. a\n- b‸"), "10. a\n    - b‸");
  assert.equal(tab("- x\n- ab‸c"), "- x\n  - ab‸c");
  // 選択した行をすべて同じ量だけ字下げし、空行は変えない
  assert.equal(tab("- a\n«- b\n\n- c»"), "- a\n«  - b\n\n  - c»");
});

test("F1: Shift+Tab は親の位置まで戻す。字下げがなければ何も変えずにキーを受け取る", () => {
  assert.equal(tab("- a\n  - b‸", true), "- a\n- b‸");
  assert.equal(tab("1. a\n   - b‸", true), "1. a\n- b‸");
  assert.equal(tab("- a\n  - b\n    - c‸", true), "- a\n  - b\n  - c‸");
  assert.equal(tab("   - a‸", true), "- a‸");
  assert.equal(tab("- a\n\t- b‸", true), "- a\n- b‸");
  assert.equal(tab("- p\n«    - a\n  - b»", true), "- p\n«- a\n- b»");
  const { text, start, end } = at("- a‸");
  const edit = indentList(text, start, end, true);
  assert.ok(edit && edit.start === edit.end && edit.insert === "", "字下げがない項目は変えない Edit");
});

test("F1: リストでない行を含むと Tab・Shift+Tab に介入しない", () => {
  assert.equal(tab("段落‸"), null);
  assert.equal(tab("段落‸", true), null);
  assert.equal(tab("«- a\n段落\n- b»"), null);
  assert.equal(tab("> - a‸"), null);
});

function shift(marked, command) {
  const { text, start, end } = at(marked);
  const edit = formatEdit(command, text, start, end);
  return edit && shown(text, edit);
}

test("F2: 見出しを1段下げる・上げる（未選択なら文書全体。Frontmatter・コードの中・下線の見出しは変えない）", () => {
  const doc = [
    "---", "# yamlコメント", "---", "# 見出し1", "## 見出し2", "##### 見出し5", "###### 見出し6", "#ハッシュ",
    "本文の # は行頭でない‸", "   ## 字下げ3", "", "```md", "# コードの中", "```", "", "~~~", "## チルダの中", "~~~", "", "見出しS", "===",
  ].join("\n");
  const down = shift(doc, "headingDown");
  assert.equal(down, doc.replace("# 見出し1", "## 見出し1").replace("## 見出し2", "### 見出し2").replace("##### 見出し5", "###### 見出し5").replace("   ## 字下げ3", "   ### 字下げ3"));
  const up = shift(doc, "headingUp");
  assert.equal(up, doc.replace("## 見出し2", "# 見出し2").replace("##### 見出し5", "#### 見出し5").replace("###### 見出し6", "##### 見出し6").replace("   ## 字下げ3", "   # 字下げ3"));
});

test("F2: 範囲を選択していればその行だけ。選択の文字の位置を保つ。変わる見出しがなければ null", () => {
  assert.equal(shift("# A\n# «B»\n# C", "headingDown"), "# A\n## «B»\n# C");
  assert.equal(shift("«# A\n# B\n»# C", "headingDown"), "«## A\n## B\n»# C");
  assert.equal(shift("#\n本文‸", "headingDown"), "##\n本文‸");
  assert.equal(shift("段落\n- 項目‸", "headingDown"), null);
  assert.equal(shift("段落\n- 項目‸", "headingUp"), null);
  assert.equal(shift("```markdown\n# 外\n## 中\n```‸", "headingDown"), null);
  // 1回の置き換えは、変わる範囲だけに縮める
  const text = "あ\n# A\nい\n# B\nう";
  const edit = formatEdit("headingDown", text, 0, 0);
  assert.equal(applyEdit(text, edit), "あ\n## A\nい\n## B\nう");
  assert.ok(edit.start >= 2 && edit.end <= 10, `変わる範囲だけ: ${JSON.stringify(edit)}`);
});

function pasteUrl(marked, clip) {
  const { text, start, end } = at(marked);
  const edit = linkPaste(text, start, end, clip);
  return edit && shown(text, edit);
}

test("F3: 文字を選んで URL を貼り付けると [文字](URL) にする", () => {
  assert.equal(pasteUrl("リンク先の«説明»", "https://example.com/a?b=1"), "リンク先の[説明](https://example.com/a?b=1)‸");
  assert.equal(pasteUrl("リンク先の«説明»", "http://example.com/"), "リンク先の[説明](http://example.com/)‸");
  assert.equal(pasteUrl("リンク先の«説明»", "mailto:user@example.com"), "リンク先の[説明](mailto:user@example.com)‸");
  assert.equal(pasteUrl("リンク先の«説明»", "  https://example.com/x \n"), "リンク先の[説明](https://example.com/x)‸");
  assert.equal(pasteUrl("前« 説明 »後", "https://example.com"), "前 [説明](https://example.com)‸ 後");
  assert.equal(pasteUrl("前 «説明» 後", "HTTPS://EXAMPLE.COM"), "前 [説明](HTTPS://EXAMPLE.COM)‸ 後");
  assert.equal(pasteUrl("前 «説明» 後", "https://example.com/日本語"), "前 [説明](https://example.com/日本語)‸ 後");
});

test("F3: URL でない・選択が URL・改行を含む・未選択・空白だけなら通常の貼り付け", () => {
  assert.equal(pasteUrl("前 «説明» 後", "example.com"), null);
  assert.equal(pasteUrl("前 «説明» 後", "ftp://example.com"), null);
  assert.equal(pasteUrl("前 «説明» 後", "https://exa mple.com"), null);
  assert.equal(pasteUrl("前 «説明» 後", "https://a.example\nhttps://b.example"), null);
  assert.equal(pasteUrl("«https://old.example»", "https://new.example"), null);
  assert.equal(pasteUrl("«前\n説明»", "https://example.com"), null);
  assert.equal(pasteUrl("前«   »後", "https://example.com"), null);
  assert.equal(pasteUrl("前 ‸説明 後", "https://example.com"), null);
  assert.equal(pasteUrl("前 «説明» 後", ""), null);
});

// ---- 2026-11-17 コードレビュー（docs/archive/code-review-20261117.md）の指摘の回帰確認 ----

test("レビュー R3: 行頭のインラインコードの後ろの見出しも変える（有効なフェンスの中は従来どおり変えない）", () => {
  assert.equal(shift("```inline```\n# Actual\n‸", "headingDown"), "```inline```\n## Actual\n‸");
  assert.equal(shift("```a`b\n# Actual\n‸", "headingDown"), "```a`b\n## Actual\n‸");
  assert.equal(shift("```inline```\n## Actual\n‸", "headingUp"), "```inline```\n# Actual\n‸");
  assert.equal(shift("```inline```\n«# Actual»\n", "headingDown"), "```inline```\n«## Actual»\n");
  const text = "```inline```\n# Actual\n";
  assert.equal(applyEdit(text, formatEdit("headingDown", text, 0, 0)), "```inline```\n## Actual\n");
  // 有効なフェンス（情報文字列あり・チルダ・閉じない・長い閉じフェンス）の中は変えない
  assert.equal(shift("```js\n# 中\n```\n# 外‸", "headingDown"), "```js\n# 中\n```\n## 外‸");
  assert.equal(shift("~~~ a`b\n# 中\n~~~\n# 外‸", "headingDown"), "~~~ a`b\n# 中\n~~~\n## 外‸");
  assert.equal(shift("```\n# 中\n‸", "headingDown"), null);
  assert.equal(shift("````\n# 中\n```\n# まだ中\n``````\n# 外‸", "headingDown"), "````\n# 中\n```\n# まだ中\n``````\n## 外‸");
});

test("レビュー R5: 水平線の行では Tab・Shift+Tab に介入しない", () => {
  for (const line of ["* * *", "- - -", "***", "---", "  * * *", "-\t-\t-", "_ _ _", "* * * "]) {
    assert.equal(tab(`${line}‸`), null, line);
    assert.equal(tab(`${line}‸`, true), null, line);
  }
  assert.equal(tab("«- a\n* * *\n- b»"), null);
  assert.equal(tab("«- a\n- - -»", true), null);
  // 水平線の後ろのリストは、水平線を飛ばして字下げ量を決める
  assert.equal(tab("- a\n* * *\n- b‸"), "- a\n* * *\n  - b‸");
  // 通常の項目（記号の後ろに文字）は従来どおり
  assert.equal(tab("- a\n- b‸"), "- a\n  - b‸");
  assert.equal(tab("* a * b‸"), "  * a * b‸");
});
