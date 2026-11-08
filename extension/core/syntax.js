// 原文を変更せずに、Frontmatter と全文を囲むコードフェンスの位置を調べる。

const FRONTMATTER_OPEN = /^﻿?---[ \t]*\r?\n/u;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gmu;

/**
 * 先頭の YAML Frontmatter（--- で始まり --- か ... の行で閉じる）を切り分ける。
 * 閉じる行がなければ Frontmatter とみなさない。
 * @param {string} text
 * @returns {{ frontmatter: string, body: string }}
 */
export function splitFrontmatter(text) {
  const open = FRONTMATTER_OPEN.exec(text);
  if (!open) {
    return { frontmatter: "", body: text };
  }
  FRONTMATTER_CLOSE.lastIndex = open[0].length;
  const close = FRONTMATTER_CLOSE.exec(text);
  if (!close) {
    return { frontmatter: "", body: text };
  }
  const end = close.index + close[0].length;
  return { frontmatter: text.slice(0, end), body: text.slice(end) };
}

const OUTER_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z]*)[ \t]*$/u;
const OUTER_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const ANY_FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const MARKDOWN_LANGUAGES = new Set(["markdown", "md", "gfm", "commonmark"]);
// 言語指定のないフェンスは、中身がMarkdownらしいときだけ候補にする
const MARKDOWN_BLOCK = /^ {0,3}(?:#{1,6}[ \t]|[-*+][ \t]|\d{1,9}[.)][ \t]|>|\|.*\|)/mu;

/**
 * AIの回答などで、文書全体が1つのMarkdownコードフェンスで囲まれているかを調べる。
 * 言語が markdown 以外（python など）のフェンスはコード例とみなし、候補にしない。
 * 内側に同じ種類のフェンスの区切りが奇数個ある場合は対応が崩れるため候補にしない。
 * @param {string} text Frontmatter を除いた本文
 * @returns {{ innerStart: number, innerEnd: number, language: string } | null}
 */
export function detectOuterFence(text) {
  const lines = splitLines(text);
  const first = lines.findIndex((line) => line.content.trim() !== "");
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].content.trim() !== "") {
      last = i;
      break;
    }
  }
  if (first < 0 || last <= first) {
    return null;
  }

  const open = OUTER_OPEN.exec(lines[first].content);
  const close = OUTER_CLOSE.exec(lines[last].content);
  if (!open || !close) {
    return null;
  }
  const fence = open[1];
  if (close[1][0] !== fence[0] || close[1].length < fence.length) {
    return null;
  }
  const language = open[2].toLowerCase();
  if (language !== "" && !MARKDOWN_LANGUAGES.has(language)) {
    return null;
  }

  let innerRuns = 0;
  for (let i = first + 1; i < last; i++) {
    const inner = ANY_FENCE.exec(lines[i].content);
    if (inner && inner[1][0] === fence[0] && inner[1].length >= fence.length) {
      innerRuns++;
    }
  }
  if (innerRuns % 2 !== 0) {
    return null;
  }

  const innerStart = lines[first].next;
  const innerEnd = lines[last].start;
  if (text.slice(innerStart, innerEnd).trim() === "") {
    return null;
  }
  if (language === "" && !MARKDOWN_BLOCK.test(text.slice(innerStart, innerEnd))) {
    return null;
  }
  return { innerStart, innerEnd, language };
}

/**
 * 外側のフェンス行を除いた本文を返す（プレビューと書式付きコピー専用。原文は変えない）。
 * @param {string} text
 * @param {{ innerStart: number, innerEnd: number }} fence
 */
export function unwrapOuterFence(text, fence) {
  return text.slice(fence.innerStart, fence.innerEnd);
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const content = text.slice(start, end).replace(/\r$/u, "");
    lines.push({ start, content, next: newline < 0 ? text.length : newline + 1 });
    if (newline < 0) {
      break;
    }
    start = newline + 1;
  }
  return lines;
}
