// 書式ボタンの処理。原文と選択範囲から「どこを何に置き換え、どこを選択するか」を計算する。
// 画面側はこの結果を1回の挿入操作として適用するので、1回の Undo で戻せる。

/**
 * @typedef {{ start: number, end: number, insert: string, selStart: number, selEnd: number }} Edit
 *   start〜end を insert で置き換え、置き換え後の文書で selStart〜selEnd を選択する。
 */

const TASK = /^(\s*)[-*+][ \t]+\[[ xX]\][ \t]+/u;
const BULLET = /^(\s*)[-*+][ \t]+(?!\[[ xX]\][ \t])/u;
const ORDERED = /^(\s*)(\d{1,9})[.)][ \t]+/u;
const ANY_LIST = /^(\s*)(?:[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/u;
const HEADING = /^(\s{0,3})(#{1,6})(?:[ \t]+|$)/u;
const URL_ONLY = /^(?:https?:\/\/|mailto:)\S+$/iu;

/**
 * @param {string} command
 * @param {string} text
 * @param {number} selStart
 * @param {number} selEnd
 * @param {{ tableHeaders?: [string, string] }} [labels]
 * @returns {Edit | null}
 */
export function formatEdit(command, text, selStart, selEnd, labels = {}) {
  const start = Math.min(selStart, selEnd);
  const end = Math.max(selStart, selEnd);
  let edit;
  switch (command) {
    case "h1":
    case "h2":
    case "h3":
      edit = heading(text, start, end, Number(command[1]));
      break;
    case "bold":
      edit = wrapInline(text, start, end, "**");
      break;
    case "italic":
      edit = wrapInline(text, start, end, "*");
      break;
    case "strike":
      edit = wrapInline(text, start, end, "~~");
      break;
    case "quote":
      edit = quote(text, start, end);
      break;
    case "image":
      edit = link(text, start, end, "!");
      break;
    case "hr":
      edit = horizontalRule(text, end);
      break;
    case "code":
      edit = inlineCode(text, start, end);
      break;
    case "bullet":
    case "ordered":
    case "task":
      edit = list(text, start, end, command);
      break;
    case "link":
      edit = link(text, start, end);
      break;
    case "table":
      edit = table(text, end, labels.tableHeaders ?? ["Column 1", "Column 2"]);
      break;
    case "codeblock":
      edit = codeBlock(text, start, end);
      break;
    default:
      return null;
  }
  return edit ? minimize(text, edit) : null;
}

/** 置き換え範囲を、実際に変わる部分だけに縮める（選択位置は変えない）。 */
export function minimize(text, edit) {
  const old = text.slice(edit.start, edit.end);
  let prefix = 0;
  const maxPrefix = Math.min(old.length, edit.insert.length);
  while (prefix < maxPrefix && old[prefix] === edit.insert[prefix]) {
    prefix++;
  }
  let suffix = 0;
  const maxSuffix = Math.min(old.length, edit.insert.length) - prefix;
  while (suffix < maxSuffix && old[old.length - 1 - suffix] === edit.insert[edit.insert.length - 1 - suffix]) {
    suffix++;
  }
  return {
    start: edit.start + prefix,
    end: edit.end - suffix,
    insert: edit.insert.slice(prefix, edit.insert.length - suffix),
    selStart: edit.selStart,
    selEnd: edit.selEnd,
  };
}

/** 結果の文書を返す（テストと確認用）。 */
export function applyEdit(text, edit) {
  return text.slice(0, edit.start) + edit.insert + text.slice(edit.end);
}

function lineRange(text, start, end) {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  // 選択の終わりが行頭なら、その行は含めない
  const effectiveEnd = end > start && end > 0 && text[end - 1] === "\n" ? end - 1 : end;
  const newline = text.indexOf("\n", effectiveEnd);
  const to = newline < 0 ? text.length : newline;
  return { from, to };
}

/** 行単位の変換。各行を変換し、選択は変換後の行全体にする（1行で未選択ならカーソルを行末へ）。 */
function mapLines(text, start, end, transform) {
  const { from, to } = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const mapped = transform(lines);
  if (mapped === null) {
    return null;
  }
  const insert = mapped.join("\n");
  if (start === end && lines.length === 1) {
    const caret = from + insert.length - (lines[0].length - (start - from));
    const pos = Math.max(from, Math.min(from + insert.length, caret));
    return { start: from, end: to, insert, selStart: pos, selEnd: pos };
  }
  return { start: from, end: to, insert, selStart: from, selEnd: from + insert.length };
}

function heading(text, start, end, level) {
  const marker = "#".repeat(level);
  return mapLines(text, start, end, (lines) => {
    const targets = lines.filter((line) => line.trim() !== "" || lines.length === 1);
    const all = targets.length > 0 && targets.every((line) => {
      const m = HEADING.exec(line);
      return m !== null && m[2].length === level;
    });
    return lines.map((line) => {
      if (line.trim() === "" && lines.length > 1) {
        return line;
      }
      const m = HEADING.exec(line);
      const rest = m ? line.slice(m[0].length) : line.replace(/^\s{0,3}/u, "");
      return all ? rest : `${marker} ${rest}`;
    });
  });
}

function list(text, start, end, kind) {
  const pattern = kind === "task" ? TASK : kind === "bullet" ? BULLET : ORDERED;
  const { from } = lineRange(text, start, end);
  let number = 1;
  if (kind === "ordered" && from > 0) {
    const prevStart = text.lastIndexOf("\n", from - 2) + 1;
    const prev = ORDERED.exec(text.slice(prevStart, from - 1));
    const firstLine = text.slice(from, text.indexOf("\n", from) < 0 ? text.length : text.indexOf("\n", from));
    const indent = /^\s*/u.exec(firstLine)[0];
    if (prev && prev[1] === indent) {
      number = Number(prev[2]) + 1;
    }
  }
  return mapLines(text, start, end, (lines) => {
    const targets = lines.filter((line) => line.trim() !== "" || lines.length === 1);
    const all = targets.length > 0 && targets.every((line) => pattern.test(line));
    return lines.map((line) => {
      if (line.trim() === "" && lines.length > 1) {
        return line;
      }
      const m = ANY_LIST.exec(line);
      const indent = m ? m[1] : /^\s*/u.exec(line)[0];
      const rest = m ? line.slice(m[0].length) : line.slice(indent.length);
      if (all) {
        return indent + rest;
      }
      const marker = kind === "task" ? "- [ ] " : kind === "bullet" ? "- " : `${number++}. `;
      return indent + marker + rest;
    });
  });
}

/** 選択の前後の空白は囲みの外に残す。 */
function trimSelection(text, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/u.test(text[s])) {
    s++;
  }
  while (e > s && /\s/u.test(text[e - 1])) {
    e--;
  }
  return [s, e];
}

function wrapInline(text, start, end, marker) {
  if (start === end) {
    const m = marker.length;
    // カーソルが空の囲み（**|**）の間にあれば取り除く
    if (markerBefore(text, start, marker) && markerAfter(text, start, marker)) {
      return { start: start - m, end: start + m, insert: "", selStart: start - m, selEnd: start - m };
    }
    return { start, end, insert: marker + marker, selStart: start + m, selEnd: start + m };
  }
  const selected = text.slice(start, end);
  if (selected.includes("\n")) {
    return wrapLines(text, start, end, (line) => toggleMarker(line, marker));
  }
  const [s, e] = trimSelection(text, start, end);
  if (s === e) {
    return null;
  }
  const inner = text.slice(s, e);
  const m = marker.length;
  if (inner.length >= m * 2 && opensWith(inner, marker) && closesWith(inner, marker)) {
    const unwrapped = inner.slice(m, inner.length - m);
    return { start: s, end: e, insert: unwrapped, selStart: s, selEnd: s + unwrapped.length };
  }
  if (markerBefore(text, s, marker) && markerAfter(text, e, marker)) {
    return { start: s - m, end: e + m, insert: inner, selStart: s - m, selEnd: s - m + inner.length };
  }
  return { start: s, end: e, insert: marker + inner + marker, selStart: s + m, selEnd: e + m };
}

// 斜体の * は、太字の ** の一部と区別する（*** は太字と斜体の両方）
function opensWith(value, marker) {
  if (marker !== "*") {
    return value.startsWith(marker);
  }
  return value.startsWith("***") || (value.startsWith("*") && !value.startsWith("**"));
}

function closesWith(value, marker) {
  if (marker !== "*") {
    return value.endsWith(marker);
  }
  return value.endsWith("***") || (value.endsWith("*") && !value.endsWith("**"));
}

function markerBefore(text, pos, marker) {
  return opensWith(text.slice(Math.max(0, pos - 3), pos).split("").reverse().join(""), marker)
    && text.slice(pos - marker.length, pos) === marker;
}

function markerAfter(text, pos, marker) {
  return opensWith(text.slice(pos, pos + 3), marker);
}

function toggleMarker(segment, marker) {
  const lead = /^\s*/u.exec(segment)[0];
  const trail = /\s*$/u.exec(segment.slice(lead.length))[0];
  const core = segment.slice(lead.length, segment.length - trail.length);
  if (core === "") {
    return segment;
  }
  const m = marker.length;
  if (core.length >= m * 2 && opensWith(core, marker) && closesWith(core, marker)) {
    return lead + core.slice(m, core.length - m) + trail;
  }
  return lead + marker + core + marker + trail;
}

/** 複数行の選択は、行ごとに囲む（空行は飛ばす）。選択は変換後の範囲全体にする。 */
function wrapLines(text, start, end, transform) {
  const segments = text.slice(start, end).split("\n");
  const insert = segments.map((segment) => transform(segment)).join("\n");
  return { start, end, insert, selStart: start, selEnd: start + insert.length };
}

function inlineCode(text, start, end) {
  const selected = text.slice(start, end);
  if (selected.includes("\n")) {
    return wrapLines(text, start, end, (line) => toggleCode(line));
  }
  if (start === end) {
    return wrapInline(text, start, end, "`");
  }
  const [s, e] = trimSelection(text, start, end);
  if (s === e) {
    return null;
  }
  const inner = text.slice(s, e);
  // 既に囲まれていれば外す
  const wrapped = /^(`+)( ?)([\s\S]*?)\2\1$/u.exec(inner);
  if (wrapped && wrapped[3] !== "" && !wrapped[3].includes(wrapped[1])) {
    return { start: s, end: e, insert: wrapped[3], selStart: s, selEnd: s + wrapped[3].length };
  }
  // 選択の外側がコードの区切り（codeSpan が付けた補助の空白を含む）なら外す
  const before = /(?:^|[^`])(`+)( ?)$/u.exec(text.slice(0, s));
  const after = /^( ?)(`+)(?!`)/u.exec(text.slice(e));
  if (before && after && before[1].length === after[2].length && before[2] === after[1]
    && !(inner.match(/`+/gu) ?? []).some((run) => run.length === before[1].length)) {
    const from = s - before[1].length - before[2].length;
    return { start: from, end: e + after[1].length + after[2].length, insert: inner, selStart: from, selEnd: from + inner.length };
  }
  const insert = codeSpan(inner);
  const offset = insert.indexOf(inner);
  return { start: s, end: e, insert, selStart: s + offset, selEnd: s + offset + inner.length };
}

function toggleCode(segment) {
  const lead = /^\s*/u.exec(segment)[0];
  const trail = /\s*$/u.exec(segment.slice(lead.length))[0];
  const core = segment.slice(lead.length, segment.length - trail.length);
  if (core === "") {
    return segment;
  }
  const wrapped = /^(`+)( ?)([\s\S]*?)\2\1$/u.exec(core);
  if (wrapped && wrapped[3] !== "" && !wrapped[3].includes(wrapped[1])) {
    return lead + wrapped[3] + trail;
  }
  return lead + codeSpan(core) + trail;
}

/** 中にバッククォートがあれば、それより長い区切りを使う。 */
function codeSpan(inner) {
  const runs = inner.match(/`+/gu) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  if (longest === 0) {
    return "`" + inner + "`";
  }
  const fence = "`".repeat(longest + 1);
  return `${fence} ${inner} ${fence}`;
}

/** リンク（prefix が "!" なら画像）。 */
function link(text, start, end, prefix = "") {
  const p = prefix.length;
  const selected = text.slice(start, end);
  if (start === end) {
    return { start, end, insert: prefix + "[](https://)", selStart: start + p + 1, selEnd: start + p + 1 };
  }
  const [s, e] = trimSelection(text, start, end);
  const inner = text.slice(s, e);
  if (inner === "") {
    return null;
  }
  if (URL_ONLY.test(inner)) {
    return { start: s, end: e, insert: prefix + "[](" + inner + ")", selStart: s + p + 1, selEnd: s + p + 1 };
  }
  const label = selected.includes("\n") ? inner.replace(/\s*\n\s*/gu, " ") : inner;
  const insert = prefix + "[" + label + "](https://)";
  const urlStart = s + p + label.length + 3;
  return { start: s, end: e, insert, selStart: urlStart, selEnd: urlStart + "https://".length };
}

/** 引用: 選択した行すべてに「> 」を付け、全行に付いていれば外す。 */
function quote(text, start, end) {
  const QUOTE = /^ {0,3}> ?/u;
  return mapLines(text, start, end, (lines) => {
    const targets = lines.filter((line) => line.trim() !== "" || lines.length === 1);
    const all = targets.length > 0 && targets.every((line) => QUOTE.test(line));
    return lines.map((line) => {
      if (line.trim() === "" && lines.length > 1) {
        return line;
      }
      return all ? line.replace(QUOTE, "") : "> " + line;
    });
  });
}

/** 水平線: 独立した行に --- を置く。前の行に文字があれば、見出しと解釈されないよう空行を空ける。 */
function horizontalRule(text, pos) {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const newline = text.indexOf("\n", pos);
  const lineEnd = newline < 0 ? text.length : newline;
  const line = text.slice(lineStart, lineEnd);
  let insertAt = pos;
  let before = "";
  if (line.trim() !== "") {
    insertAt = lineEnd;
    before = "\n\n";
  } else if (lineStart > 0) {
    const prevStart = text.lastIndexOf("\n", lineStart - 2) + 1;
    if (text.slice(prevStart, lineStart - 1).trim() !== "") {
      before = "\n";
    }
  }
  const nextStart = lineEnd + 1;
  const nextEnd = text.indexOf("\n", nextStart);
  const following = lineEnd < text.length ? text.slice(nextStart, nextEnd < 0 ? text.length : nextEnd) : "";
  const after = following.trim() !== "" ? "\n" : "";
  const insert = before + "---" + after;
  const caret = insertAt + before.length + 3;
  return { start: insertAt, end: insertAt, insert, selStart: caret, selEnd: caret };
}

function table(text, pos, headers) {
  const [h1, h2] = headers;
  const body = `| ${h1} | ${h2} |\n| --- | --- |\n|  |  |`;
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const newline = text.indexOf("\n", pos);
  const lineEnd = newline < 0 ? text.length : newline;
  const line = text.slice(lineStart, lineEnd);
  // 表として解釈されるよう、文字のある行の途中・直後では前に空行を置き、後ろの文字とも空行で分ける
  let insertAt = pos;
  let before = "";
  if (line.trim() !== "") {
    insertAt = lineEnd;
    before = "\n\n";
  } else if (lineStart > 0) {
    const prevStart = text.lastIndexOf("\n", lineStart - 2) + 1;
    if (text.slice(prevStart, lineStart - 1).trim() !== "") {
      before = "\n";
    }
  }
  // 次の行に文字があれば、表の行として取り込まれないよう空行で分ける
  const nextStart = lineEnd + 1;
  const nextEnd = text.indexOf("\n", nextStart);
  const following = lineEnd < text.length ? text.slice(nextStart, nextEnd < 0 ? text.length : nextEnd) : "";
  const after = following.trim() !== "" ? "\n" : "";
  const insert = before + body + after;
  const headerStart = insertAt + before.length + 2;
  return { start: insertAt, end: insertAt, insert, selStart: headerStart, selEnd: headerStart + h1.length };
}

function codeBlock(text, start, end) {
  if (start === end) {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const newline = text.indexOf("\n", start);
    const lineEnd = newline < 0 ? text.length : newline;
    if (text.slice(lineStart, lineEnd).trim() === "") {
      const insert = "```\n\n```";
      return { start: lineStart, end: lineEnd, insert, selStart: lineStart + 4, selEnd: lineStart + 4 };
    }
    const insert = "\n```\n\n```";
    return { start: lineEnd, end: lineEnd, insert, selStart: lineEnd + 5, selEnd: lineEnd + 5 };
  }
  const { from, to } = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  // 選択した行が1つのコードブロックそのものなら、囲みの行を外す
  if (lines.length >= 2 && /^ {0,3}(`{3,}|~{3,})/u.test(lines[0])) {
    const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(lines[0])[1];
    const closing = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`, "u");
    if (closing.test(lines[lines.length - 1])) {
      const insert = lines.slice(1, -1).join("\n");
      return { start: from, end: to, insert, selStart: from, selEnd: from + insert.length };
    }
  }
  const content = lines.join("\n");
  const runs = content.match(/^ {0,3}`{3,}/gmu) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.trim().length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  const insert = `${fence}\n${content}\n${fence}`;
  return { start: from, end: to, insert, selStart: from + fence.length + 1, selEnd: from + fence.length + 1 + content.length };
}
