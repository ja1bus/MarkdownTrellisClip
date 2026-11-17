import { test } from "node:test";
import assert from "node:assert/strict";
import { findMatches, matchIndexAt, nextMatch, replaceAllText } from "../extension/core/search.js";

// 検索と置換（仕様 §2.3、1.4.0）
const DS = "apple Apple APPLE\nbanana apple pie\napple";
const spans = (list) => list.map((m) => [m.start, m.end]);

test("F5: 大文字と小文字を区別しない・する一致", () => {
  assert.deepEqual(spans(findMatches(DS, "apple")), [[0, 5], [6, 11], [12, 17], [25, 30], [35, 40]]);
  assert.deepEqual(spans(findMatches(DS, "apple", { caseSensitive: true })), [[0, 5], [25, 30], [35, 40]]);
  assert.deepEqual(findMatches(DS, ""), []);
  assert.deepEqual(findMatches(DS, "pear"), []);
});

test("F5: 検索語は文字どおり（正規表現の記号を解釈しない）。一致は重ならない", () => {
  const text = "a.b axb a.b (x) $1 \\d [z] a-b a/b";
  assert.equal(findMatches(text, "a.b").length, 2);
  for (const query of ["(x)", "$1", "\\d", "[z]", "a-b", "a/b"]) {
    assert.equal(findMatches(text, query).length, 1, query);
  }
  assert.equal(findMatches(text, ".*").length, 0);
  assert.equal(findMatches("aaaa", "aa").length, 2);
  assert.equal(findMatches("aaa", "aa").length, 1);
  assert.deepEqual(spans(findMatches("👍x👍", "👍")), [[0, 2], [3, 5]]);
  assert.deepEqual(spans(findMatches("İİabcABC", "abc")), [[2, 5], [5, 8]]);
});

test("F5: 次・前の一致は端で反対側へ戻る。選択がちょうど一致なら番号", () => {
  const m = findMatches(DS, "apple");
  assert.equal(nextMatch(m, 18), 3);
  assert.equal(nextMatch(m, 30), 4);
  assert.equal(nextMatch(m, 40), 0);
  assert.equal(nextMatch(m, 25), 3, "カーソルが一致の先頭ならその一致");
  assert.equal(nextMatch(m, 0, true), 4);
  assert.equal(nextMatch(m, 35, true), 3);
  assert.equal(nextMatch([], 0), -1);
  assert.equal(matchIndexAt(m, 25, 30), 3);
  assert.equal(matchIndexAt(m, 25, 29), -1);
  assert.equal(matchIndexAt(m, 18, 18), -1);
});

test("F5: すべて置換は置換後の文字を文字どおりに入れ、件数を返す", () => {
  assert.deepEqual(replaceAllText("a-b a-b A-B", "a-b", "x"), { text: "x x x", count: 3 });
  assert.deepEqual(replaceAllText("a-b a-b A-B", "a-b", "x", { caseSensitive: true }), { text: "x x A-B", count: 2 });
  assert.deepEqual(replaceAllText("a b a", "a", "$&$$"), { text: "$&$$ b $&$$", count: 2 });
  assert.deepEqual(replaceAllText("a b a", "a", ""), { text: " b ", count: 2 });
  assert.deepEqual(replaceAllText("x", "zzz", "y"), { text: "x", count: 0 });
});
