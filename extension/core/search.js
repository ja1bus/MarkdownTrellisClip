// 検索と置換（仕様 §2.3）。画面に依存しない計算だけを置く。検索語は文字どおりに扱う（正規表現は使わせない）。

/** @typedef {{ start: number, end: number }} Match */

function escapeRegExp(value) {
  // u フラグでは、エスケープしてよいのは構文の記号と / だけ（- などは誤りになる）
  return value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

/**
 * 重ならない一致を先頭から探す。大文字と小文字を区別しないときは、文字数が変わらないよう正規表現の i で比べる。
 * @param {string} text
 * @param {string} query
 * @param {{ caseSensitive?: boolean }} [options]
 * @returns {Match[]}
 */
export function findMatches(text, query, { caseSensitive = false } = {}) {
  if (!query) {
    return [];
  }
  const matches = [];
  if (caseSensitive) {
    for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + query.length)) {
      matches.push({ start: at, end: at + query.length });
    }
    return matches;
  }
  const pattern = new RegExp(escapeRegExp(query), "giu");
  for (const m of text.matchAll(pattern)) {
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return matches;
}

/** 選択（start〜end）がちょうど一致なら、その番号（0始まり）。なければ -1。 */
export function matchIndexAt(matches, start, end) {
  let low = 0;
  let high = matches.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (matches[mid].start < start) {
      low = mid + 1;
    } else if (matches[mid].start > start) {
      high = mid - 1;
    } else {
      return matches[mid].end === end ? mid : -1;
    }
  }
  return -1;
}

/**
 * 次（backward なら前）の一致の番号。次は開始が from 以上の最初、前は終わりが from 以下の最後。
 * 端を越えたら反対側へ戻る。一致がなければ -1。
 */
export function nextMatch(matches, from, backward = false) {
  if (matches.length === 0) {
    return -1;
  }
  if (backward) {
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].end <= from) {
        return i;
      }
    }
    return matches.length - 1;
  }
  const i = matches.findIndex((m) => m.start >= from);
  return i < 0 ? 0 : i;
}

/**
 * すべての一致を置き換えた全文と件数。置換後の文字は文字どおり（$ などを解釈しない）。
 * @returns {{ text: string, count: number }}
 */
export function replaceAllText(text, query, replacement, options = {}) {
  const matches = findMatches(text, query, options);
  if (matches.length === 0) {
    return { text, count: 0 };
  }
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.start) + replacement;
    last = m.end;
  }
  return { text: out + text.slice(last), count: matches.length };
}
