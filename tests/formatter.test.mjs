import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEdit, applyEdit } from "../extension/core/formatter.js";

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
