import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { setup } from "./helpers.mjs";
import { choosePaste, parseHtml, formattingIn, plainKeepsMarkdown, MARKDOWN_LIMIT } from "../extension/core/htmlpaste.js";
import { toClipboardPayload } from "../extension/core/richcopy.js";

const { window } = new JSDOM("");
const env = { DOMParser: window.DOMParser };
const paste = (html, plain = "") => choosePaste({ html, plain }, env);
const md = (html, plain = "") => {
  const result = paste(html, plain);
  assert.equal(result.kind, "markdown", `変換されなかった: ${JSON.stringify(result)}`);
  return result.text;
};

// Chrome の paste イベントで取れる形（CF_HTML の見出し部分は除かれ、Fragment の目印のコメントが残る）
const wrap = (body) => `<html><body>\n<!--StartFragment-->${body}<!--EndFragment-->\n</body></html>`;

// Microsoft 365 Copilot の回答をまねた HTML（h2・strong・CSS 付きの表・ul・a・br）
const COPILOT = wrap(`<div style="font-family: 'Segoe UI'; color: rgb(36, 36, 36);">
<h2 style="font-size: 20px; font-weight: 600;">導入の手順</h2>
<p>次の<strong>3つ</strong>を確認します。<br>詳しくは<a href="https://learn.microsoft.com/ja-jp/" target="_blank">Microsoft Learn</a>を参照してください。</p>
<table style="border-collapse: collapse; width: 100%;">
<thead><tr><th style="border: 1px solid #ccc; padding: 4px;">項目</th><th style="border: 1px solid #ccc;">内容（Description）</th><th>担当</th><th>参考</th></tr></thead>
<tbody>
<tr><td style="border: 1px solid #ccc;"><strong>準備</strong></td><td>ライセンスを確認し、管理センターで<strong>割り当て</strong>を行います。長い説明の文章がセルに入っていても、列の構造は崩れません。</td><td>情シス / IT</td><td><a href="https://example.com/a?b=1&amp;c=2">手順書</a></td></tr>
<tr><td>設定</td><td>1行目<br>2行目</td><td>A|B</td><td>*注意* と _下線_ と [角括弧]</td></tr>
</tbody></table>
<ul><li>Teams に貼り付ける</li><li>Outlook に貼り付ける</li></ul>
</div>`);

test("Copilot の回答（見出し・太字・リンク・4列の表・箇条書き）を Markdown にする", () => {
  const text = md(COPILOT, "導入の手順\n次の3つを確認します。\n項目\t内容\n準備\t…");
  assert.match(text, /^## 導入の手順$/mu);
  assert.match(text, /次の\*\*3つ\*\*を確認します。 {2}\n詳しくは\[Microsoft Learn\]\(https:\/\/learn\.microsoft\.com\/ja-jp\/\)を参照してください。/u);
  assert.match(text, /^\| 項目 \| 内容（Description） \| 担当 \| 参考 \|$/mu);
  assert.match(text, /^\| --- \| --- \| --- \| --- \|$/mu);
  assert.match(text, /^\| \*\*準備\*\* \| ライセンスを確認し、管理センターで\*\*割り当て\*\*を行います。長い説明の文章がセルに入っていても、列の構造は崩れません。 \| 情シス \/ IT \| \[手順書\]\(https:\/\/example\.com\/a\?b=1&c=2\) \|$/mu);
  // セル内の改行は <br>、| はエスケープ、Markdown の記号は文字のまま残るようにエスケープする
  assert.match(text, /^\| 設定 \| 1行目<br>2行目 \| A\\\|B \| \\\*注意\\\* と \\_下線\\_ と \\\[角括弧\\\] \|$/mu);
  assert.match(text, /^- Teams に貼り付ける\n- Outlook に貼り付ける$/mu);
  assert.ok(!/<(?!br>)[a-z]/iu.test(text), "<br> 以外の HTML タグを残さない");
});

test("変換した Markdown を書式付きコピーすると、見出し・太字・表・リンクが HTML に戻る", () => {
  const { renderer } = setup();
  const text = md(COPILOT);
  const { html } = toClipboardPayload(renderer.renderDocument(text).fragment);
  assert.match(html, /<h2[^>]*>導入の手順<\/h2>/u);
  assert.match(html, /<strong>3つ<\/strong>/u);
  assert.match(html, /<th[^>]*>内容（Description）<\/th>/u);
  assert.match(html, /<td[^>]*>1行目<br>2行目<\/td>/u);
  assert.match(html, /<td[^>]*>A\|B<\/td>/u);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2">手順書<\/a>/u);
  assert.match(html, /<li>Teams に貼り付ける<\/li>/u);
});

test("番号付き・入れ子のリスト、引用、水平線、取り消し線、斜体", () => {
  const text = md(wrap(`<ol start="3"><li>三<ul><li>入れ子</li></ul></li><li>四</li></ol>
    <blockquote><p>引用1</p><p>引用2</p></blockquote><hr><p><em>斜体</em>と<del>削除</del>と<s>取消</s></p>`));
  assert.match(text, /^3\. 三\n {3}- 入れ子\n4\. 四$/mu);
  assert.match(text, /^> 引用1\n>\n> 引用2$/mu);
  assert.match(text, /^---$/mu);
  assert.match(text, /^\*斜体\*と~~削除~~と~~取消~~$/mu);
});

test("コードブロック（ChatGPT のように言語名とコピーボタンが pre の中にある）とインラインコード", () => {
  const text = md(wrap(`<p>例: <code>npm run check</code></p><pre><div><span>python</span><button>Copy code</button></div><div><code class="hljs language-python">print("こんにちは")
if a &lt; b:
    pass
</code></div></pre>`));
  assert.match(text, /^例: `npm run check`$/mu);
  assert.match(text, /^```python\nprint\("こんにちは"\)\nif a < b:\n {4}pass\n```$/mu);
  assert.ok(!text.includes("Copy code"));
});

test("コードの中にフェンスがあれば、それより長いフェンスで囲む", () => {
  const text = md(wrap("<pre><code>```js\nx\n```</code></pre>"));
  assert.match(text, /^````\n```js\nx\n```\n````$/mu);
});

test("インライン CSS の太字・斜体・取り消し線を変換する（太字の中では重ねない）", () => {
  const text = md(wrap(`<p><span style="font-weight: bold">重要</span>、<span style="font-weight:700">700</span>、`
    + `<span style="font-style: italic">斜め</span>、<span style="text-decoration: line-through">線</span>、`
    + `<strong><span style="font-weight: 700">二重</span></strong>、<span style="font-weight: 400">普通</span></p>`));
  assert.equal(text, "**重要**、**700**、*斜め*、~~線~~、**二重**、普通");
});

// 利用者の試験用 HTML（2026-11-11）の取り消し線 S01〜S10・表の T02・複合書式 X01/X02
test("取り消し線 S01〜S10: タグ・CSS・親要素の CSS・太字/斜体との入れ子・文中", () => {
  const text = md(wrap(`<p><s>S01</s></p><p><del>S02</del></p><p><strike>S03</strike></p>
    <p><span style="text-decoration: line-through;">S04</span></p>
    <p><span style="text-decoration-line: line-through;">S05</span></p>
    <p><span style="text-decoration: underline line-through;">S06</span></p>
    <p style="text-decoration: line-through;">
      <span>S07：親要素のCSSによる取り消し線</span>
    </p>
    <p><del><strong>S08</strong></del></p><p><del><em>S09</em></del></p>
    <p>前半、<del>S10</del>、後半。</p>`));
  assert.equal(text, ["~~S01~~", "~~S02~~", "~~S03~~", "~~S04~~", "~~S05~~", "~~S06~~", "~~S07：親要素のCSSによる取り消し線~~",
    "~~**S08**~~", "~~*S09*~~", "前半、~~S10~~、後半。"].join("\n\n"));
});

test("取り消し線: 表のセル（タグ・CSS・セル自体の CSS）と、リンク・太字・斜体・CSS の複合書式", () => {
  const text = md(wrap(`<table><tr><th>項目</th><th>内容</th><th>CSS</th><th>セル</th></tr>
    <tr><td>T02</td><td><del>無効</del> → 有効</td><td><span style="text-decoration:line-through">CSSの取り消し線</span></td>
    <td style="text-decoration: line-through">セル全体<br>二行目</td></tr></table>
    <p><a href="https://example.com/"><strong><em><del>X01</del></em></strong></a></p>
    <p><span style="font-weight:700;text-decoration:line-through;color:#be123c;background-color:#ffec99">X02</span></p>`));
  assert.match(text, /^\| T02 \| ~~無効~~ → 有効 \| ~~CSSの取り消し線~~ \| ~~セル全体<br>二行目~~ \|$/mu);
  // セル内の改行をまたぐ ~~ もプレビュー・書式付きコピーで取り消し線になる
  const { renderer } = setup();
  const { html } = toClipboardPayload(renderer.renderDocument(text).fragment);
  assert.match(html, /<td[^>]*><del>セル全体<br>二行目<\/del><\/td>/u);
  assert.match(html, /<td[^>]*><del>無効<\/del> → 有効<\/td>/u);
  assert.match(text, /^\[\*\*\*~~X01~~\*\*\*\]\(https:\/\/example\.com\/\)$/mu);
  assert.match(text, /^\*\*~~X02~~\*\*$/mu);
});

test("取り消し線: ブロックの CSS は中の段落・リストへ下ろし、二重にせず、コードブロックには付けない", () => {
  const text = md(wrap(`<div style="text-decoration: line-through"><p>段落 <del>中のdel</del> <span style="text-decoration: line-through">中のCSS</span></p>
    <ul><li>項目<ul><li>入れ子</li></ul></li></ul><pre><code>code</code></pre></div>
    <ul style="text-decoration: line-through"><li>リストごと</li></ul><p style="text-decoration: underline">下線だけ</p>`));
  assert.equal(text, ["~~段落 中のdel 中のCSS~~", "- ~~項目~~\n  - ~~入れ子~~", "```\ncode\n```", "- ~~リストごと~~", "下線だけ"].join("\n\n"));
});

test("見出しと表の見出しセルの太字には記号を付けない。font-weight: normal の b（Google ドキュメント）は太字にしない", () => {
  const text = md(wrap(`<h3><strong>見出し</strong></h3><table><tr><th><b>A</b></th></tr><tr><td><b>B</b></td></tr></table>`
    + `<b style="font-weight: normal;"><p>本文 <span style="font-weight:700">太</span></p></b>`));
  assert.match(text, /^### 見出し$/mu);
  assert.match(text, /^\| A \|\n\| --- \|\n\| \*\*B\*\* \|$/mu);
  assert.match(text, /^本文 \*\*太\*\*$/mu);
});

test("表: thead がなくても1行目を見出しにし、列数を最も多い行に合わせ、colspan は空のセルで埋める。配置も残す", () => {
  const text = md(wrap(`<table><tr><td>a</td><td style="text-align: right">b</td><td align="center">c</td></tr>`
    + `<tr><td colspan="2">結合</td><td>3</td></tr><tr><td>だけ</td></tr></table>`));
  assert.match(text, /^\| a \| b \| c \|\n\| --- \| ---: \| :---: \|\n\| 結合 \|  \| 3 \|\n\| だけ \|  \|  \|$/mu);
});

test("表のセル内のリストや段落は1行にまとめ、文字を失わない", () => {
  const text = md(wrap("<table><tr><th>H</th></tr><tr><td><p>段落1</p><p>段落2</p><ul><li>x</li><li>y</li></ul></td></tr></table>"));
  assert.match(text, /^\| 段落1<br>段落2<br>- x<br>- y \|$/mu);
});

test("書式のない HTML（p・span・Chrome が付ける font-weight: 400）は変換せず、text/plain に任せる", () => {
  assert.deepEqual(paste(wrap(`<p><span style="font-weight: 400; color: red">ただの文章</span></p><p>二行目</p>`), "ただの文章\n二行目"),
    { kind: "plain", reason: "no-format" });
  assert.deepEqual(paste("", "テキストだけ"), { kind: "plain", reason: "no-html" });
  // href のない a や、空の strong は書式に数えない
  assert.equal(paste(wrap(`<p><a name="x">名前</a><strong> </strong></p>`)).reason, "no-format");
});

test("text/plain がすでに Markdown（ChatGPT のコピーボタンなど）なら text/plain を使う", () => {
  const html = wrap("<h2>見出し</h2><p><strong>太字</strong>と<a href='https://example.com'>リンク</a></p>");
  assert.deepEqual(paste(html, "## 見出し\n\n**太字**と[リンク](https://example.com)"), { kind: "plain", reason: "markdown-plain" });
  // 書式なしの文章（Copilot の text/plain など）なら HTML を変換する
  assert.equal(paste(html, "見出し\n太字とリンク").kind, "markdown");
});

test("VS Code などのエディターで色付けした Markdown の原文は変換せず、text/plain を使う", () => {
  const esc = (s) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  const plain = "# 書いて公開する\n\n本文の `code` と [リンク](../a.md)。\n\n## 公開する\n\n| 方法 | 操作 |\n|---|---|\n| A | B |\n\n```text\nタイトル\n```\n\n- 箇条書き";
  // VS Code の形式: white-space: pre の div の中に行ごとの div、空行は br、見出しの行は太字の span（太字の ** はない）
  const lines = plain.split("\n").map((line) => (line === "" ? "<br>"
    : `<div><span style="color: #569cd6;${line.startsWith("#") ? "font-weight: bold;" : ""}">${esc(line)}</span></div>`));
  const vscode = `<meta charset='utf-8'><div style="color: #cccccc;background-color: #1f1f1f;font-family: Consolas, 'Courier New', monospace;`
    + `font-weight: normal;font-size: 14px;line-height: 19px;white-space: pre;">${lines.join("")}</div>`;
  assert.deepEqual(paste(wrap(vscode), plain), { kind: "plain", reason: "source-view" });
  // JetBrains の形式: pre の中に色付けした原文
  assert.equal(paste(wrap(`<pre style="font-family: monospace"><span style="font-weight: bold">${esc(plain)}</span></pre>`), plain).reason, "source-view");

  // 次の場合は今までどおり HTML を変換する
  // Markdown の記号がない（太字のある普通の文章を等幅で表示）
  assert.equal(paste(wrap(`<div style="white-space: pre"><b>注意</b> 本文です</div>`), "注意 本文です").kind, "markdown");
  // 等幅の表示の外に文字がある（Google ドキュメントなど。番号付きの段落があっても）
  assert.equal(paste(wrap(`<p><b>1. 準備</b></p><p>本文です</p>`), "1. 準備\n本文です").kind, "markdown");
  // Web ページのコードブロック（pre > code）はフェンス付きにする
  assert.match(paste(wrap(`<pre><code class="language-markdown"># 見出し\n- 項目</code></pre>`), "# 見出し\n- 項目").text,
    /^```markdown\n# 見出し\n- 項目\n```$/u);
  // text/plain と文字が違う（表示された文書の一部）
  assert.equal(paste(wrap(`<div style="white-space: pre"><b>見出し</b></div>`), "# 別の文").kind, "markdown");
  // 文書の要素がある（AI の回答の表示）
  assert.equal(paste(wrap(`<div style="white-space: pre-wrap"><h2>見出し</h2><p><b>太字</b></p></div>`), "見出し\n太字").kind, "markdown");
});

test("HTML の表が text/plain で表になっていなければ、text/plain に太字の記号があっても HTML を変換する", () => {
  const found = formattingIn(parseHtml(wrap("<p><b>x</b></p><table><tr><th>A</th></tr><tr><td>1</td></tr></table>"), env.DOMParser));
  assert.equal(plainKeepsMarkdown("**x**\nA\n1", found), false);
  assert.equal(plainKeepsMarkdown("**x**\n\n| A |\n|---|\n| 1 |", found), true);
});

test("数式（KaTeX）は TeX の原文を $…$ / $$…$$ にする", () => {
  const katex = (tex, display) => {
    const inner = `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>x</mi></mrow>`
      + `<annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span>`
      + `<span class="katex-html" aria-hidden="true">描画</span></span>`;
    return display ? `<span class="katex-display">${inner}</span>` : inner;
  };
  const text = md(wrap(`<p>式 ${katex("x^2_i", false)} です</p>${katex("\\frac{a}{b}", true)}`));
  assert.match(text, /^式 \$x\^2_i\$ です$/mu);
  assert.match(text, /^\$\$\n\\frac\{a\}\{b\}\n\$\$$/mu);
  assert.ok(!text.includes("描画"));
});

test("チェックボックス付きのリストはタスクリストにする", () => {
  const text = md(wrap(`<ul><li><input type="checkbox" checked disabled> 済み</li><li><input type="checkbox" disabled> 未了</li></ul>`));
  assert.match(text, /^- \[x\] 済み\n- \[ \] 未了$/mu);
});

test("日本語・英語・記号・絵文字を壊さない", () => {
  const text = md(wrap("<p><strong>日本語とEnglish</strong>：①〜⑩、「」『』、©®™、😀、snake_case、C# &amp; C++、50%</p>"));
  assert.equal(text, "**日本語とEnglish**：①〜⑩、「」『』、©®™、😀、snake_case、C# & C++、50%");
});

test("安全: script・style・イベントハンドラー・画像・危険な URL を出力しない", () => {
  const text = md(wrap(`<script>alert("x")</script><style>p{color:red}</style>`
    + `<p onclick="alert(1)"><strong onmouseover="alert(2)">太字</strong> `
    + `<a href="javascript:alert(3)">危険</a> <a href=" JaVaScRiPt:alert(4)">危険2</a> <a href="data:text/html,x">データ</a> `
    + `<a href="vbscript:x">vb</a> <a href="/relative">相対</a> <a href="mailto:a@example.com">メール</a> `
    + `<img src="https://evil.example/x.png" alt="図の説明" onerror="alert(5)"><iframe src="https://evil.example/"></iframe></p>`
    + `<svg><script>alert(6)</script></svg><button>押す</button>`));
  assert.equal(text, "**太字** 危険 危険2 データ vb 相対 [メール](mailto:a@example.com) 図の説明");
  assert.ok(!/alert|javascript|onclick|onerror|evil|<script|<img|<iframe/iu.test(text));
});

test("安全: 解析した HTML のスクリプトは実行されず、画像も読み込まれない", () => {
  // jsdom ではスクリプトを有効にした window でも、DOMParser の文書は実行しない
  const dom = new JSDOM("", { runScripts: "dangerously", resources: "usable" });
  dom.window.hit = 0;
  const result = choosePaste({ html: `<p><b>x</b><img src="x" onerror="window.hit++"></p><script>window.hit++</script>`, plain: "" },
    { DOMParser: dom.window.DOMParser });
  assert.equal(result.kind, "markdown");
  assert.equal(dom.window.hit, 0);
});

test("変換に失敗したら text/plain に任せる（reason: error）", () => {
  const broken = { DOMParser: class { parseFromString() { throw new Error("broken"); } } };
  assert.deepEqual(choosePaste({ html: "<b>x</b>", plain: "x" }, broken), { kind: "plain", reason: "error" });
});

test("変換結果が長すぎるときは text/plain に任せる（reason: too-long）", () => {
  const html = `<p><b>x</b></p><p>${"あ".repeat(MARKDOWN_LIMIT)}</p>`;
  assert.deepEqual(paste(html, "x"), { kind: "plain", reason: "too-long" });
});
