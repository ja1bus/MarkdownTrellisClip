// 安全化済みの DOM 断片から、書式付きコピー用の HTML（インライン CSS）と
// 描画後の内容に対応するプレーンテキストを作る。

const CODE_FONT = "font-family:Consolas,'Courier New',monospace;";

const STYLES = {
  table: "border-collapse:collapse;",
  th: "border:1px solid #999;padding:4px 8px;background:#f2f2f2;font-weight:bold;",
  td: "border:1px solid #999;padding:4px 8px;",
  pre: "background:#f5f5f5;padding:8px;white-space:pre-wrap;" + CODE_FONT,
  code: CODE_FONT,
  kbd: CODE_FONT,
  blockquote: "border-left:4px solid #ccc;margin:0 0 8px 0;padding-left:12px;color:#555;",
  mark: "background:#fff3a3;",
  dt: "font-weight:bold;",
  dd: "margin:0 0 4px 24px;",
};
const INLINE_CODE = CODE_FONT + "background:#f2f2f2;padding:0 3px;";

// 追加構文の class に対応するインラインCSS（貼り付け先には class が届かないため）
const ALERT_COLORS = { note: "#0969da", tip: "#1a7f37", important: "#8250df", warning: "#9a6700", caution: "#cf222e" };
function classStyle(node, tag) {
  const list = node.classList;
  if (tag === "div" && list.contains("markdown-alert")) {
    const kind = Object.keys(ALERT_COLORS).find((k) => list.contains(`markdown-alert-${k}`)) ?? "note";
    return `border-left:4px solid ${ALERT_COLORS[kind]};padding:4px 12px;margin:0 0 8px 0;`;
  }
  if (tag === "p" && list.contains("markdown-alert-title")) {
    const box = node.parentElement?.classList;
    const kind = Object.keys(ALERT_COLORS).find((k) => box?.contains(`markdown-alert-${k}`)) ?? "note";
    return `font-weight:bold;color:${ALERT_COLORS[kind]};margin:0 0 4px 0;`;
  }
  if (tag === "div" && list.contains("mtc-container")) {
    return "border:1px solid #ccc;padding:4px 12px;margin:0 0 8px 0;";
  }
  if (tag === "p" && list.contains("mtc-container-title")) {
    return "font-weight:bold;margin:0 0 4px 0;";
  }
  if (list.contains("mtc-math")) {
    return CODE_FONT + (tag === "div" ? "white-space:pre-wrap;margin:0 0 8px 0;" : "");
  }
  return "";
}

const BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "table", "ul", "ol", "dl", "dt", "dd", "div", "details", "hr"]);
const VOID = new Set(["br", "hr"]);
const KEEP = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "s", "del", "ins", "mark", "sub", "sup", "kbd", "abbr",
  "code", "pre", "blockquote", "hr", "br", "ul", "ol", "li", "a", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "div", "span", "dl", "dt", "dd",
]);
const SAFE_HREF = /^(?:https?:|mailto:)/iu;

// 最後の空白整理から守る文字（私用領域の文字に置き換え、整理の後で戻す）
const KEEP_NEWLINE = "";
const KEEP_SPACE = "";
const KEEP_TAB = "";
const protect = (value) => value.replace(/\n/gu, KEEP_NEWLINE).replace(/ /gu, KEEP_SPACE).replace(/\t/gu, KEEP_TAB);
const restore = (value) => value.replaceAll(KEEP_NEWLINE, "\n").replaceAll(KEEP_SPACE, " ").replaceAll(KEEP_TAB, "\t");

const BLOCK_LIKE = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "ul", "ol", "li", "dl", "dt", "dd", "div", "details", "summary", "section", "hr", "br"]);
/** 段落の中で文字として並ぶもの（文字・強調・リンク・コードなど）か。 */
function isInline(node) {
  if (!node) {
    return false;
  }
  return node.nodeType === 3 || (node.nodeType === 1 && !BLOCK_LIKE.has(node.nodeName.toLowerCase()));
}

/**
 * @param {DocumentFragment | Element} root render.js が返した安全な断片
 * @returns {{ html: string, text: string, imageCount: number }}
 */
export function toClipboardPayload(root) {
  const state = { html: [], text: [], lists: [], pre: 0, imageCount: 0, afterMarker: false };
  for (const child of root.childNodes) {
    walk(child, state);
  }
  // 整形のための空白・空行だけを整理し、コードと表のセル区切りは元に戻す
  const text = restore(state.text.join("").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").replace(/^\n+|\n+$/gu, ""));
  return { html: state.html.join(""), text, imageCount: state.imageCount };
}

function walk(node, state) {
  if (node.nodeType === 3) {
    writeText(node.nodeValue, state, node);
    return;
  }
  if (node.nodeType !== 1) {
    return;
  }
  const tag = node.nodeName.toLowerCase();

  if (tag === "span" && node.classList.contains("mtc-image")) {
    const alt = node.dataset.alt ?? "";
    state.imageCount++;
    if (alt !== "") {
      state.html.push(escapeHtml(alt));
      state.text.push(alt);
    }
    return;
  }
  if (tag === "input") {
    const next = node.nextSibling;
    const spaced = next !== null && next.nodeType === 3 && /^\s/u.test(next.nodeValue);
    const box = (node.hasAttribute("checked") ? "☑" : "☐") + (spaced ? "" : " ");
    state.html.push(box);
    state.text.push(box);
    return;
  }
  if (tag === "a" && node.classList.contains("footnote-backref")) {
    // 脚注から本文へ戻るリンクは貼り付け先で使えないので出さない
    return;
  }
  if (tag === "sup" && node.classList.contains("footnote-ref")) {
    const number = node.textContent.trim();
    state.html.push(`<sup>${escapeHtml(number)}</sup>`);
    state.text.push(`[${number}]`);
    return;
  }
  if ((tag === "span" && node.classList.contains("mtc-wikilink")) || (tag === "a" && !SAFE_HREF.test((node.getAttribute("href") ?? "").trim()))) {
    // 開けないリンクは文字だけにする
    for (const child of node.childNodes) {
      walk(child, state);
    }
    return;
  }
  if (tag === "section") {
    gap(state);
    for (const child of node.childNodes) {
      walk(child, state);
    }
    gap(state);
    return;
  }
  if (tag === "details") {
    // 折りたたみは貼り付け先で使えないことが多いので、summary を見出し相当にして本文を展開する
    newline(state);
    for (const child of node.childNodes) {
      walk(child, state);
    }
    gap(state);
    return;
  }
  if (tag === "summary") {
    newline(state);
    state.html.push("<p><strong>");
    for (const child of node.childNodes) {
      walk(child, state);
    }
    state.html.push("</strong></p>");
    newline(state);
    return;
  }
  if (!KEEP.has(tag)) {
    for (const child of node.childNodes) {
      walk(child, state);
    }
    return;
  }

  open(node, tag, state);
  if (VOID.has(tag)) {
    return;
  }
  for (const child of node.childNodes) {
    walk(child, state);
  }
  close(tag, state, node);
}

function open(node, tag, state) {
  switch (tag) {
    case "br":
      state.html.push("<br>");
      state.text.push("\n");
      return;
    case "hr":
      gap(state);
      state.html.push("<hr>");
      state.text.push("---");
      gap(state);
      return;
    case "ul":
    case "ol": {
      newline(state);
      const start = Number.parseInt(node.getAttribute("start") ?? "1", 10);
      state.lists.push(tag === "ul" ? null : Number.isFinite(start) && start >= 0 ? start : 1);
      break;
    }
    case "li": {
      newline(state);
      const depth = state.lists.length;
      if (depth > 0) {
        const number = state.lists[depth - 1];
        state.text.push("  ".repeat(depth - 1) + (number === null ? "- " : `${number}. `));
        if (number !== null) {
          state.lists[depth - 1] = number + 1;
        }
        state.afterMarker = true;
      }
      break;
    }
    case "tr":
      newline(state);
      state.cell = 0;
      break;
    case "th":
    case "td":
      if ((state.cell ?? 0) > 0) {
        state.text.push(KEEP_TAB);
      }
      state.cell = (state.cell ?? 0) + 1;
      break;
    case "pre":
      gap(state);
      state.pre++;
      break;
    case "dt":
      newline(state);
      break;
    case "dd":
      newline(state);
      state.text.push("  ");
      break;
    default:
      if (BLOCKS.has(tag) && !state.afterMarker) {
        gap(state);
      }
  }
  state.html.push(`<${tag}${attributes(node, tag, state)}>`);
}

function close(tag, state, node) {
  if (tag === "ul" || tag === "ol") {
    state.lists.pop();
  }
  if (tag === "pre") {
    state.pre = Math.max(0, state.pre - 1);
  }
  state.html.push(`</${tag}>`);
  const isTitle = tag === "p" && (node.classList.contains("markdown-alert-title") || node.classList.contains("mtc-container-title"));
  if (tag === "li" || tag === "tr" || tag === "dt" || tag === "dd" || isTitle) {
    newline(state);
    // 枠の見出しの直後の段落は、空行を空けずに続ける
    state.afterMarker ||= isTitle;
  } else if (BLOCKS.has(tag)) {
    if (state.lists.length > 0) {
      newline(state);
    } else {
      gap(state);
    }
  }
}

function attributes(node, tag, state) {
  let style = (STYLES[tag] ?? "") + classStyle(node, tag);
  if (tag === "code" && state.pre === 0) {
    style = INLINE_CODE;
  }
  const parts = [];
  if (tag === "a") {
    const href = node.getAttribute("href");
    if (href !== null && SAFE_HREF.test(href.trim())) {
      parts.push(` href="${escapeAttr(href.trim())}"`);
    }
  }
  for (const name of ["title", "colspan", "rowspan", "start"]) {
    const value = node.getAttribute(name);
    if (value !== null && (name === "title" || /^\d{1,4}$/u.test(value))) {
      parts.push(` ${name}="${escapeAttr(value)}"`);
    }
  }
  const align = node.getAttribute("align");
  if ((tag === "th" || tag === "td") && align !== null && /^(?:left|right|center)$/iu.test(align)) {
    style += `text-align:${align.toLowerCase()};`;
  }
  if (style !== "") {
    parts.push(` style="${escapeAttr(style)}"`);
  }
  return parts.join("");
}

function writeText(value, state, node = null) {
  state.html.push(escapeHtml(value));
  if (state.pre > 0) {
    // コードの空白・空行・改行は、最後の空白整理で消えないよう置き換えて保つ（末尾の改行はブロックの区切りとして残す）
    const body = value.endsWith("\n") ? value.slice(0, -1) : value;
    state.text.push(protect(body) + (body === value ? "" : "\n"));
    return;
  }
  if (value.trim() === "" && value.includes("\n")) {
    // ブロックの間の改行は表示されないので含めない。段落の中で書式の間にある改行は空白1文字として表示される
    if (isInline(node?.previousSibling) && isInline(node?.nextSibling)) {
      state.text.push(" ");
    }
    return;
  }
  state.afterMarker &&= value.trim() === "";
  state.text.push(value.replace(/\s*\n\s*/gu, " "));
}

function newline(state) {
  const last = lastChar(state);
  if (last !== "" && last !== "\n") {
    state.text.push("\n");
  }
}

function gap(state) {
  newline(state);
  if (lastChar(state) !== "" && !endsWithBlank(state)) {
    state.text.push("\n");
  }
}

function lastChar(state) {
  for (let i = state.text.length - 1; i >= 0; i--) {
    const chunk = state.text[i];
    if (chunk.length > 0) {
      return chunk[chunk.length - 1];
    }
  }
  return "";
}

function endsWithBlank(state) {
  const tail = state.text.slice(-3).join("");
  return tail.endsWith("\n\n");
}

export function escapeHtml(value) {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/gu, "&quot;");
}
