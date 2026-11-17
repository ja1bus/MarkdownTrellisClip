// 文字数・行数・語数（仕様 §1）。画面に依存しない計算だけを置く。

let segmenter = null;

/**
 * @param {string} text
 * @param {{ words?: boolean }} [options] words が false なら語数を数えない（null）
 * @returns {{ chars: number, lines: number, words: number | null }}
 */
export function textStats(text, { words = true } = {}) {
  let chars = 0;
  let newlines = 0;
  for (const ch of text) {
    if (ch === "\n") {
      newlines++;
    } else {
      chars++;
    }
  }
  return { chars, lines: text === "" ? 0 : newlines + 1, words: words ? countWords(text) : null };
}

/** 語の数（Intl.Segmenter の isWordLike）。Intl.Segmenter がなければ null。 */
export function countWords(text) {
  if (typeof Intl.Segmenter !== "function") {
    return null;
  }
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  let count = 0;
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike) {
      count++;
    }
  }
  return count;
}
