import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFrontmatter, detectOuterFence, unwrapOuterFence } from "../extension/core/syntax.js";

test("Frontmatter を本文から切り分け、原文の文字列は変えない", () => {
  const text = "---\ntitle: メモ\ntags: [a]\n---\n# 本文\n";
  const result = splitFrontmatter(text);
  assert.equal(result.frontmatter, "---\ntitle: メモ\ntags: [a]\n---\n");
  assert.equal(result.body, "# 本文\n");
  assert.equal(result.frontmatter + result.body, text);
});

test("... で閉じる Frontmatter と CRLF も扱う", () => {
  const result = splitFrontmatter("---\r\na: 1\r\n...\r\nbody");
  assert.equal(result.body, "body");
});

test("閉じていない --- や先頭以外の --- は Frontmatter にしない", () => {
  assert.equal(splitFrontmatter("---\nno close").frontmatter, "");
  assert.equal(splitFrontmatter("text\n---\na\n---\n").frontmatter, "");
  assert.equal(splitFrontmatter("").body, "");
});

test("markdown 指定の全文フェンスを検出し、内側だけを取り出す", () => {
  const text = "```markdown\n# 見出し\n\n- 項目\n```\n";
  const fence = detectOuterFence(text);
  assert.ok(fence);
  assert.equal(unwrapOuterFence(text, fence), "# 見出し\n\n- 項目\n");
});

test("前後の空行やチルダのフェンス、長いフェンスも検出する", () => {
  assert.ok(detectOuterFence("\n\n~~~md\n## a\n~~~\n\n"));
  assert.ok(detectOuterFence("````markdown\n# a\n```js\nx\n```\n````"));
});

test("コード例のフェンス（python など）は外さない", () => {
  assert.equal(detectOuterFence("```python\nprint('x')\n```"), null);
  assert.equal(detectOuterFence("```js\n# not heading\n```"), null);
});

test("言語指定がないフェンスは、中身がMarkdownらしいときだけ候補にする", () => {
  assert.equal(detectOuterFence("```\nnpm install\nnpm test\n```"), null);
  assert.ok(detectOuterFence("```\n# 手順\n- npm install\n```"));
});

test("全文を囲んでいない場合や内側の区切りが奇数の場合は候補にしない", () => {
  assert.equal(detectOuterFence("前置き\n```markdown\n# a\n```"), null);
  assert.equal(detectOuterFence("```markdown\n# a\n```\n後書き"), null);
  assert.equal(detectOuterFence("```markdown\n# a\n```js\nx\n```"), null);
  assert.equal(detectOuterFence("```markdown\n```"), null);
  assert.equal(detectOuterFence(""), null);
});
