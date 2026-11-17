import { test } from "node:test";
import assert from "node:assert/strict";
import { textStats } from "../extension/core/stats.js";

// 文字数・行数・語数（仕様 §1、1.4.0）

test("F6: 文字数は改行を除くコードポイント、行数は改行＋1（空なら0）、語数は Intl.Segmenter", () => {
  assert.deepEqual(textStats(""), { chars: 0, lines: 0, words: 0 });
  assert.deepEqual(textStats("Hello, world 123"), { chars: 16, lines: 1, words: 3 });
  assert.deepEqual(textStats("a\nb\n"), { chars: 2, lines: 3, words: 2 });
  assert.deepEqual(textStats("one two\nthree four\nfive"), { chars: 21, lines: 3, words: 5 });
  assert.equal(textStats("👍あ").chars, 2);
  assert.ok(textStats("日本語の文章です").words > 0);
});

test("F6: words: false なら語数を数えない", () => {
  assert.deepEqual(textStats("two\nthree", { words: false }), { chars: 8, lines: 2, words: null });
});
