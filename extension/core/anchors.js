// 編集欄とプレビューの位置の連動（仕様 §3.2）。プレビューの塊が原文のどこから作られたかの対応表を作る。
// marked のトークンに目印（HTML のコメント）を差し込み、DOMPurify が要素を調べる途中で目印から要素を決める。
// 目印のコメントは DOMPurify が通常どおり消す。要素に属性・class は付けない（表示は対応表なしと同じ）。

export const ANCHOR_TYPE = "mtcAnchor";

// NodeFilter の値（DOMPurify の断片の文書は window を持たないので、数値で指定する）
const SHOW_TEXT = 0x4;

/** 目印を付けないトークン（表示されない・別の場所へ移る）。 */
const SKIP = new Set(["space", "def", "mtcFootnoteDef", ANCHOR_TYPE]);
/** リストの項目の中で目印を付けないトークン（要素にならない文字）。 */
const SKIP_IN_ITEM = new Set(["text", "checkbox"]);

/** 目印のトークンを描画する marked の拡張。 */
export const anchorExtension = {
  name: ANCHOR_TYPE,
  renderer(token) {
    return `<!--m${token.nonce}-${token.index}${token.parent ? "p" : ""}-->`;
  },
};

/**
 * 描画1回分の依頼を作る。text は marked に渡す文字列、base はその先頭の原文での位置。
 * @param {string} text
 * @param {number} base
 */
export function createAnchorRequest(text, base) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
  // targets: 目印の番号 -> 要素。matched: コメントとして見つかった目印の数
  // boxes: Markdown のタスクの記号から作ったチェックボックス（本文の生 HTML の input は入らない。§3.4・レビュー R2）
  return {
    text, base, nonce, entries: [], pattern: new RegExp(`^m${nonce}-(?:(\\d+)(p?)|(b))$`, "u"),
    targets: new Map(), matched: 0, boxes: new Set(), boxMarkers: 0,
  };
}

/**
 * タスクのチェックボックスの直前に置く目印（marked の checkbox の描画から呼ぶ）。
 * 乱数は描画ごとに変わるので、本文に書いた HTML のコメントでは作れない。
 * @param {{ nonce: string, boxMarkers: number }} request
 */
export function checkboxMarker(request) {
  request.boxMarkers++;
  return `<!--m${request.nonce}-b-->`;
}

/**
 * 最上位のトークンの列に目印を差し込む（marked の hooks.processAllTokens から呼ぶ）。
 * @param {object[]} tokens
 * @param {{ text: string, nonce: string, entries: object[] }} request
 */
export function insertAnchors(tokens, request) {
  return place(tokens, 0, request.text.length, request, { item: false, top: true });
}

function place(tokens, from, to, request, { item, top }) {
  const out = [];
  let cursor = from;
  for (const token of tokens) {
    if (token.type === ANCHOR_TYPE) {
      out.push(token);
      continue;
    }
    const found = locate(request.text, token.raw ?? "", cursor, to);
    if (found) {
      cursor = found.end;
    }
    if (!found || SKIP.has(token.type) || (item && SKIP_IN_ITEM.has(token.type))) {
      out.push(token);
      continue;
    }
    out.push(marker(request, found, { parent: false, top, type: token.type }));
    out.push(token);
    if (token.type === "list") {
      let itemCursor = found.start;
      for (const listItem of token.items ?? []) {
        const at = locate(request.text, listItem.raw ?? "", itemCursor, found.end);
        if (!at) {
          continue;
        }
        itemCursor = at.end;
        listItem.tokens = place(listItem.tokens ?? [], at.start, at.end, request, { item: true, top: false });
        listItem.tokens.push(marker(request, at, { parent: true, top: false, type: "list_item" }));
      }
    } else if ((token.type === "blockquote" || token.type === "mtcContainer") && Array.isArray(token.tokens)) {
      token.tokens = place(token.tokens, found.start, found.end, request, { item: false, top: false });
    }
  }
  return out;
}

function marker(request, found, { parent, top, type }) {
  const index = request.entries.length;
  request.entries.push({ index, start: found.start, end: found.end, parent, top, type });
  return { type: ANCHOR_TYPE, raw: "", nonce: request.nonce, index, parent };
}

/**
 * トークンの原文での位置を探す。raw がそのまま見つからなければ（入れ子で字下げや > が除かれている）、
 * 最初の空でない行で探し、raw の行数だけ続く範囲とする。開始は行の先頭にそろえる。
 */
function locate(text, raw, from, to) {
  // 最上位のトークンは直前のトークンの直後から始まる（raw をつなぐと原文になる）
  if (raw !== "" && text.startsWith(raw, from) && from + raw.length <= to) {
    return { start: lineStart(text, from), end: from + raw.length };
  }
  const lines = raw.replace(/\n+$/u, "").split("\n");
  const first = lines.find((line) => line.trim() !== "")?.trim();
  if (!first) {
    return null;
  }
  // 最初の空でない行で探す（見つかればそこで止まるので、文書の残りを毎回すべて探さない）
  const at = text.indexOf(first, from);
  if (at < 0 || at + first.length > to) {
    return null;
  }
  const exact = at - raw.indexOf(first);
  if (exact >= from && exact + raw.length <= to && text.startsWith(raw, exact)) {
    return { start: lineStart(text, exact), end: exact + raw.length };
  }
  let end = at;
  const count = lines.length - lines.findIndex((line) => line.trim() !== "");
  for (let i = 0; i < count; i++) {
    const newline = text.indexOf("\n", end);
    if (newline < 0 || newline >= to) {
      end = to;
      break;
    }
    end = i === count - 1 ? newline : newline + 1;
  }
  return { start: lineStart(text, at), end: Math.max(end, at + first.length) };
}

function lineStart(text, index) {
  return text.lastIndexOf("\n", index - 1) + 1;
}

/**
 * DOMPurify が調べているコメントが目印なら、対応する要素を記録する（uponSanitizeElement のフックから呼ぶ。
 * コメントはこの後 DOMPurify が消す）。次の兄弟の要素、または「親を指す」目印なら親の要素。
 * @param {object} request
 * @param {Comment} comment
 */
export function captureMarker(request, comment) {
  const match = request.pattern.exec(comment.data);
  if (!match) {
    return;
  }
  request.matched++;
  if (match[3]) {
    const box = nextElement(comment);
    if (box?.nodeName === "INPUT") {
      request.boxes.add(box);
    }
    return;
  }
  const element = match[2] ? comment.parentElement : nextElement(comment);
  if (element) {
    request.targets.set(Number(match[1]), element);
  }
}

/**
 * 安全化・アラートの組み立ての後の断片で、記録した目印から対応表を作る。
 * @param {DocumentFragment} fragment
 * @param {object} request
 * @param {Map<Element, Element>} [replaced] 組み立てで置き換えた要素（アラートの引用 -> 枠）
 * @returns {{ start: number, end: number, element: Element, type: string }[]} type は元のトークンの種類（GFM の表は table）
 */
export function resolveAnchors(fragment, request, replaced = new Map()) {
  const targets = request.targets;
  for (const [index, element] of targets) {
    if (replaced.has(element)) {
      targets.set(index, replaced.get(element));
    }
  }
  // 文字として扱われる場所（閉じていない textarea など）に入った目印は、文字から除く（コメントとして見つからない目印があるときだけ調べる）
  if (request.matched < request.entries.length + request.boxMarkers) {
    const text = new RegExp(`<!--m${request.nonce}-(?:\\d+p?|b)-->`, "gu");
    const textWalker = fragment.ownerDocument.createTreeWalker(fragment, SHOW_TEXT);
    for (let node = textWalker.nextNode(); node; node = textWalker.nextNode()) {
      if (node.data.includes(request.nonce)) {
        node.data = node.data.replace(text, "");
      }
    }
  }
  // 先頭の目印は、HTML の解析で文書の外（body より前）に置かれて消えることがある。
  // 先頭から続けて見つからない最上位の目印は、断片の最初の要素に対応させる
  for (const entry of request.entries) {
    if (!entry.top || targets.has(entry.index)) {
      break;
    }
    if (fragment.firstElementChild) {
      targets.set(entry.index, fragment.firstElementChild);
    }
  }

  // 1つの要素に複数の目印が対応したとき（直前の塊が安全化で消えた・コメントだけだった）は、
  // 要素の直前にあった目印（番号が最後のもの）だけを使う
  const byElement = new Map();
  for (const entry of request.entries) {
    const element = targets.get(entry.index);
    if (element && fragment.contains(element)) {
      byElement.set(element, entry);
    }
  }
  const anchors = [];
  for (const [element, entry] of byElement) {
    // 範囲の終わりは、後ろの空行を含めず塊の最後の文字の後にそろえる（追加構文の raw は空行を含むことがある）
    let end = entry.end;
    while (end > entry.start && request.text[end - 1] === "\n") {
      end--;
    }
    const anchor = { start: request.base + entry.start, end: request.base + end, element, type: entry.type };
    if (entry.type === "list_item") {
      // その項目自身のタスクのチェックボックス（入れ子の項目のものは除く）。なければ null
      anchor.checkbox = [...element.querySelectorAll("input")].find((box) => request.boxes.has(box) && box.closest("li") === element) ?? null;
    }
    anchors.push(anchor);
  }
  // アラートは先頭の [!NOTE] の行を段落から除いて見出しにするので、枠と同じ行から始まる中の段落は次の行からにする
  const byNode = new Map(anchors.map((anchor) => [anchor.element, anchor]));
  for (const anchor of anchors) {
    const box = anchor.element.parentElement;
    const outer = box?.classList.contains("markdown-alert") ? byNode.get(box) : null;
    if (outer && outer.start === anchor.start) {
      const newline = request.text.indexOf("\n", anchor.start - request.base);
      if (newline >= 0 && request.base + newline + 1 < anchor.end) {
        anchor.start = request.base + newline + 1;
      }
    }
  }
  // 同じ位置から始まるときは外側（範囲の長い方）を先に置き、内側（リストの項目など）を後にする
  // 範囲も同じとき（余白のあるリストの項目とその段落など）は、要素を含む外側を先にする
  anchors.sort((a, b) => a.start - b.start || b.end - a.end || (a.element.contains(b.element) ? -1 : b.element.contains(a.element) ? 1 : 0));
  return anchors;
}

/**
 * 原文の位置に対応する塊を選ぶ。位置以下で最後に始まるもの（同じ位置なら内側）。
 * その範囲の外なら、位置を含む範囲の塊を前へ探す（なければ最後に始まるものを使う）。
 * 位置より前に始まる塊がなければ null（Frontmatter の中など）。
 * @param {{ start: number, end: number }[]} anchors start の昇順
 * @param {number} offset
 */
export function findAnchor(anchors, offset) {
  let low = 0;
  let high = anchors.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (anchors[mid].start <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found < 0) {
    return null;
  }
  if (anchors[found].end < offset) {
    for (let i = found - 1; i >= 0; i--) {
      if (anchors[i].start <= offset && anchors[i].end >= offset) {
        return anchors[i];
      }
    }
  }
  return anchors[found];
}

/** text の from から to の前までにある改行の数。 */
export function countNewlines(text, from, to) {
  let count = 0;
  for (let i = text.indexOf("\n", from); i >= 0 && i < to; i = text.indexOf("\n", i + 1)) {
    count++;
  }
  return count;
}

/** 塊の行数（末尾の改行は数えない。最低1）。 */
export function blockLineCount(text, anchor) {
  let end = Math.min(anchor.end, text.length);
  while (end > anchor.start && text[end - 1] === "\n") {
    end--;
  }
  return countNewlines(text, anchor.start, end) + 1;
}

/** 塊の中の line 行目（0始まり）の先頭の位置。行数を超えるときは最後の行。 */
export function lineOffsetInBlock(text, anchor, line) {
  let offset = anchor.start;
  for (let i = 0; i < line; i++) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0 || newline + 1 >= anchor.end) {
      break;
    }
    offset = newline + 1;
  }
  return Math.min(offset, text.length);
}

function nextElement(node) {
  for (let next = node.nextSibling; next; next = next.nextSibling) {
    if (next.nodeType === 1) {
      return next;
    }
  }
  return null;
}

// ---- 1.4.0: 目次（§3.3）とチェックボックスの切り替え（§3.4） ----

/**
 * 対応表から見出しの一覧を作る（目次）。type が heading のもの（HTML で書いた見出しは html なので含まない）。
 * 文字は要素の textContent（空白を詰める）。文字が空の見出しは除く。
 * @param {{ type: string, element: Element }[]} anchors
 * @param {number} [limit]
 * @returns {{ level: number, text: string, anchor: object }[]}
 */
export function headingList(anchors, limit = 200) {
  const list = [];
  for (const anchor of anchors) {
    if (list.length >= limit) {
      break;
    }
    if (anchor.type !== "heading") {
      continue;
    }
    const level = Number(/^H([1-6])$/u.exec(anchor.element.nodeName)?.[1] ?? 0);
    const text = (anchor.element.textContent ?? "").replace(/\s+/gu, " ").trim();
    if (level > 0 && text !== "") {
      list.push({ level, text, anchor });
    }
  }
  return list;
}

const TASK_BOX = /^(\s*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)( |x|X)(\])/u;

/**
 * リストの項目の対応から、原文のチェックの1文字を切り替える Edit（選択は変えないので selStart・selEnd は null）。
 * 項目の最初の行がチェックリストでなければ null（引用の中など）。
 * @param {string} text
 * @param {{ start: number, type: string }} anchor
 * @returns {{ start: number, end: number, insert: string, checked: boolean } | null} checked は切り替える前の状態
 */
export function toggleTaskEdit(text, anchor) {
  if (!anchor || anchor.type !== "list_item" || anchor.start > text.length) {
    return null;
  }
  const newline = text.indexOf("\n", anchor.start);
  const line = text.slice(anchor.start, newline < 0 ? text.length : newline);
  const m = TASK_BOX.exec(line);
  if (!m) {
    return null;
  }
  const at = anchor.start + m[1].length;
  const checked = m[2] !== " ";
  return { start: at, end: at + 1, insert: checked ? " " : "x", checked };
}
