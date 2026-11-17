// Markdown を GFM として解釈し、許可リストで安全化した DOM の断片を作る。
// 生成した HTML 文字列を innerHTML へ入れず、DOMPurify が返す DocumentFragment を使う。
import { Marked } from "../vendor/marked.esm.js";
import createDOMPurify from "../vendor/purify.es.mjs";
import { splitFrontmatter, detectOuterFence, unwrapOuterFence } from "./syntax.js";
import { buildMarkedOptions, applyAlerts, detectFeatures, normalizeFeatures } from "./extensions.js";
import { anchorExtension, createAnchorRequest, insertAnchors, captureMarker, resolveAnchors, checkboxMarker } from "./anchors.js";

/** Markdown が生成する要素と、生HTMLで許可する要素。 */
export const ALLOWED_TAGS = Object.freeze([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "s", "del", "ins", "mark",
  "sub", "sup", "kbd", "abbr", "code", "pre", "blockquote", "hr", "br",
  "ul", "ol", "li", "input", "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "details", "summary", "div", "span", "dl", "dt", "dd", "section",
]);

const ALLOWED_ATTR = ["href", "title", "alt", "src", "align", "colspan", "rowspan", "start", "type", "checked", "open", "class", "id"];
const ATTR_BY_TAG = {
  a: new Set(["href", "title", "id", "class"]),
  img: new Set(["alt", "title", "src"]),
  abbr: new Set(["title"]),
  th: new Set(["align", "colspan", "rowspan"]),
  td: new Set(["align", "colspan", "rowspan"]),
  ol: new Set(["start"]),
  input: new Set(["type", "checked"]),
  details: new Set(["open"]),
  code: new Set(["class"]),
  div: new Set(["class"]),
  span: new Set(["class", "title"]),
  p: new Set(["class"]),
  sup: new Set(["class"]),
  li: new Set(["id"]),
  section: new Set(["class"]),
};
// 追加構文が出力する class（要素ごと）。生HTMLで同じ class を書いても見た目が変わるだけ
const CLASS_BY_TAG = {
  code: [/^language-[A-Za-z0-9_+#.-]{1,40}$/u],
  div: [/^mtc-math$/u, /^mtc-math-display$/u, /^mtc-container$/u, /^mtc-container-[a-z][a-z0-9-]{0,30}$/u],
  span: [/^mtc-math$/u, /^mtc-wikilink$/u],
  p: [/^mtc-container-title$/u],
  sup: [/^footnote-ref$/u],
  a: [/^footnote-backref$/u],
  section: [/^footnotes$/u],
};
const FOOTNOTE_ID = /^mtc-fn(?:ref)?-\d{1,4}$/u;
const SAFE_URL = /^(?:https?:|mailto:|#)/iu;
const ALIGN = new Set(["left", "right", "center"]);

/**
 * @param {Window} win DOM を持つ window（ブラウザーでは window、テストでは jsdom）
 * @param {{ imageLabel?: string }} [options]
 */
export function createRenderer(win, options = {}) {
  const purify = createDOMPurify(win);
  const markedByFeatures = new Map();
  const imageLabel = options.imageLabel ?? "Image";

  purify.addHook("uponSanitizeAttribute", (node, data) => {
    const tag = node.nodeName.toLowerCase();
    const name = data.attrName;
    const allowed = ATTR_BY_TAG[tag];
    if (!allowed || !allowed.has(name)) {
      data.keepAttr = false;
      return;
    }
    if (name === "class") {
      const patterns = CLASS_BY_TAG[tag] ?? [];
      const classes = data.attrValue.trim().split(/\s+/u);
      if (!classes.every((value) => patterns.some((pattern) => pattern.test(value)))) {
        data.keepAttr = false;
      }
    } else if (name === "id" && !FOOTNOTE_ID.test(data.attrValue)) {
      data.keepAttr = false;
    } else if (name === "align" && !ALIGN.has(data.attrValue.toLowerCase())) {
      data.keepAttr = false;
    } else if ((name === "colspan" || name === "rowspan" || name === "start") && !/^\d{1,4}$/u.test(data.attrValue)) {
      data.keepAttr = false;
    } else if (name === "type" && data.attrValue.toLowerCase() !== "checkbox") {
      data.keepAttr = false;
    }
  });

  purify.addHook("afterSanitizeAttributes", (node) => {
    // 隔離した文書の中にいる間に画像の参照先を外し、取り込み時に読み込みが起きないようにする
    if (node.nodeName === "IMG") {
      for (const name of ["src", "srcset", "sizes"]) {
        node.removeAttribute(name);
      }
    }
    if (node.nodeName === "A") {
      const href = node.getAttribute("href");
      if (href !== null && !SAFE_URL.test(href.trim())) {
        node.removeAttribute("href");
      }
    }
    if (node.nodeName === "INPUT" && node.getAttribute("type") !== "checkbox") {
      node.setAttribute("type", "checkbox");
    }
    // 1.4.0: チェックボックスは押せるようにする（押したときの既定の動作は画面側で止め、原文を切り替える。§3.4）
    if (node.nodeName === "INPUT") {
      node.removeAttribute("disabled");
    }
  });

  const config = {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: SAFE_URL,
    // URLではない属性の値を、上のURL判定にかけない（値は uponSanitizeAttribute で個別に確認する）
    ADD_URI_SAFE_ATTR: ["align", "colspan", "rowspan", "start", "type"],
    RETURN_DOM_FRAGMENT: true,
  };
  // 描画1回分の対応表の依頼（§3.2）。同期処理の parse と sanitize の間だけ設定する
  let anchorRequest = null;
  // 目印のコメントは DOMPurify が消す前に、対応する要素を記録する
  purify.addHook("uponSanitizeElement", (node) => {
    if (anchorRequest && node.nodeType === 8) {
      captureMarker(anchorRequest, node);
    }
  });

  /** 部品の組み合わせごとに解析器を作り、使い回す。 */
  function markedFor(features) {
    const key = features.join(",");
    let instance = markedByFeatures.get(key);
    if (!instance) {
      instance = new Marked({ gfm: true, breaks: false, async: false });
      instance.use(buildMarkedOptions(features));
      instance.use({
        // 対応表を作る描画では、タスクのチェックボックスの直前に目印を置く（押したものがタスク由来かを見分ける。§3.4）。
        // false を返すと marked の標準の描画になる
        renderer: {
          checkbox(token) {
            return anchorRequest ? checkboxMarker(anchorRequest) + `<input ${token.checked ? 'checked="" ' : ""}disabled="" type="checkbox"> ` : false;
          },
        },
        extensions: [anchorExtension],
        hooks: {
          processAllTokens: (tokens) => (anchorRequest ? insertAnchors(tokens, anchorRequest) : tokens),
        },
      });
      markedByFeatures.set(key, instance);
    }
    return instance;
  }

  /**
   * Markdown を安全な DocumentFragment にする。
   * @param {string} markdown
   * @param {string[]} [featureList] 有効にする追加構文
   * @param {{ anchorBase?: number }} [opts] anchorBase を渡すと、原文での位置（markdown の先頭が anchorBase）の対応表も返す
   * @returns {{ fragment: DocumentFragment, imageCount: number, removedCount: number, anchors?: object[] }}
   */
  function renderMarkdown(markdown, featureList = [], opts = {}) {
    const features = normalizeFeatures(featureList);
    const request = typeof opts.anchorBase === "number" ? createAnchorRequest(markdown, opts.anchorBase) : null;
    let fragment;
    anchorRequest = request;
    try {
      const html = stripEventHandlers(markedFor(features).parse(markdown));
      fragment = purify.sanitize(html, config);
    } finally {
      anchorRequest = null;
    }
    // 断片を返す設定では、包みの BODY も「除外」として記録されるので数えない
    const removedCount = purify.removed.filter((entry) => entry.element && entry.element.nodeType === 1 && !["BODY", "HTML", "HEAD"].includes(entry.element.nodeName)).length;
    const imageCount = replaceImages(fragment, win.document, imageLabel);
    const replaced = features.includes("alerts") ? applyAlerts(fragment, win.document) : new Map();
    if (request) {
      return { fragment, imageCount, removedCount, anchors: resolveAnchors(fragment, request, replaced) };
    }
    return { fragment, imageCount, removedCount };
  }

  /**
   * 全文をプレビューと書式付きコピー用に変換する。Frontmatter は除外し、
   * unwrapFence が true で全文フェンスがあれば外側の行も除外する。原文は変更しない。
   * @param {string} source
   * detected は追加構文らしい箇所の件数（有効かどうかに関係なく数える）。
   * anchors が true なら、位置の連動の対応表 anchors（原文での位置と要素。§3.2）も返す。
   * @param {{ unwrapFence?: boolean, features?: string[], anchors?: boolean }} [opts]
   */
  function renderDocument(source, opts = {}) {
    const { frontmatter, body } = splitFrontmatter(source);
    const fence = detectOuterFence(body);
    const unwrap = Boolean(fence && opts.unwrapFence);
    const markdown = unwrap ? unwrapOuterFence(body, fence) : body;
    const anchorBase = frontmatter.length + (unwrap ? fence.innerStart : 0);
    return {
      ...renderMarkdown(markdown, opts.features, opts.anchors ? { anchorBase } : {}),
      fence: fence !== null,
      fenceApplied: unwrap,
      detected: detectFeatures(markdown),
    };
  }

  /**
   * 原文の選択範囲を独立した Markdown 断片として変換する。全文フェンスの除外は行わない。
   * 選択が文書の先頭から始まる場合だけ、Frontmatter を除外する。
   * @param {string} source
   * @param {number} start
   * @param {number} end
   * @param {string[]} [features]
   */
  function renderSelection(source, start, end, features = []) {
    let markdown = source.slice(start, end);
    if (start === 0) {
      markdown = splitFrontmatter(markdown).body;
    }
    return renderMarkdown(markdown, features);
  }

  return { renderMarkdown, renderDocument, renderSelection };
}

/**
 * タグの中の on〜= 属性を、解析前に取り除く。
 * Chrome は解析しただけでもイベント属性を CSP 違反として Console に記録するため、その記録を減らす前処理。
 * 安全性はこの処理ではなく、DOMPurify の許可リストと CSP で守る（取りこぼしても実行はされない）。
 * marked は本文の < をエスケープするので、ここで見る < はタグの始まりに限られる。
 * @param {string} html
 */
export function stripEventHandlers(html) {
  // 1.4.0: 正規表現の後戻りで指数的に遅くなる入力（閉じない引用符など。R1）があったため、先頭から1回だけ読む。
  // 区切りの規則は 1.3.0 の正規表現と同じにして、出力を変えない
  // レビュー R4: タグとして読めなかった範囲を、後ろの < から何度も読み直さない（全体でおおむね線形にする）
  let out = "";
  let copied = 0;
  const memo = {
    noQuote: { '"': Infinity, "'": Infinity }, // この位置より後ろには、その引用符がない
    failed: new Set(), // 属性を読み始めて、タグとして読めなかった位置
    nameEnd: 0, // 直前に読んだタグ名の終わり
  };
  for (let i = html.indexOf("<"); i >= 0; ) {
    const tag = readTag(html, i, memo);
    if (!tag) {
      // タグ名の途中の < から読み直しても、同じ名前の残りと同じ続きを読むので、やはり読めない。名前の後ろから探す
      i = html.indexOf("<", Math.max(i + 1, memo.nameEnd));
      continue;
    }
    // 1.3.0 と同じく、属性の文字に on があるときだけ組み立て直す（このとき > の前の空白は詰める）
    if (/\bon/iu.test(tag.attributes.map((attribute) => attribute.text).join(""))) {
      const kept = tag.attributes.map((attribute) => (attribute.event ? " " : attribute.text)).join("");
      out += html.slice(copied, i) + `<${tag.name}${kept}${tag.selfClose ? " /" : ""}>`;
      copied = tag.end;
    }
    i = html.indexOf("<", tag.end);
  }
  return copied === 0 ? html : out + html.slice(copied);
}

const TAG_NAME = /[A-Za-z][^\s/>]*/uy;
const ATTRIBUTE_NAME = /[^\s"'=<>/]+/uy;
const UNQUOTED_VALUE = /[^\s"'=<>`]+/uy;
const SPACES = /\s*/uy;

function skip(pattern, html, at) {
  pattern.lastIndex = at;
  const m = pattern.exec(html);
  return m ? at + m[0].length : at;
}

/**
 * html の at（<）から始まるタグを読む。タグとして読めなければ null。
 * 属性の前の区切りは「空白・/ 1つまで・空白」、最後は「空白・/（あれば > の直前）・>」（1.3.0 の正規表現と同じ）。
 */
function readTag(html, at, memo) {
  TAG_NAME.lastIndex = at + 1;
  const name = TAG_NAME.exec(html);
  memo.nameEnd = at + 1 + (name ? name[0].length : 0);
  if (!name) {
    return null;
  }
  const attributes = [];
  let tagName = name[0];
  let pos = at + 1 + tagName.length;
  // 名前の直後（空白の後）が = なら、1.3.0 の正規表現は名前の最後の1文字を属性名として読んでいた（後戻り）。同じにする
  if (html[skip(SPACES, html, pos)] === "=" && tagName.length > 1 && !/["'=<]/u.test(tagName.at(-1))) {
    tagName = tagName.slice(0, -1);
    pos--;
  }
  // 属性の続きは位置だけで決まる。読めなかったときは、通った位置を覚えて次からすぐ諦める
  const visited = [];
  const fail = () => {
    for (const p of visited) {
      memo.failed.add(p);
    }
    return null;
  };
  for (;;) {
    const lead = pos;
    if (memo.failed.has(lead)) {
      return fail();
    }
    visited.push(lead);
    pos = skip(SPACES, html, pos);
    const slash = html[pos] === "/";
    if (slash) {
      pos++;
    }
    const afterSlash = pos;
    pos = skip(SPACES, html, pos);
    if (html[pos] === ">") {
      // 「/」と「>」の間に空白があるときは、タグとして読まない（1.3.0 と同じ）
      if (slash && pos !== afterSlash) {
        return fail();
      }
      return { name: tagName, attributes, selfClose: slash, end: pos + 1 };
    }
    ATTRIBUTE_NAME.lastIndex = pos;
    const attrName = ATTRIBUTE_NAME.exec(html);
    if (!attrName) {
      return fail();
    }
    pos += attrName[0].length;
    const beforeValue = pos;
    let next = skip(SPACES, html, pos);
    if (html[next] === "=") {
      next = skip(SPACES, html, next + 1);
      const quote = html[next];
      if (quote === '"' || quote === "'") {
        const close = next + 1 >= memo.noQuote[quote] ? -1 : html.indexOf(quote, next + 1);
        if (close < 0) {
          memo.noQuote[quote] = Math.min(memo.noQuote[quote], next + 1);
          return fail();
        }
        pos = close + 1;
      } else {
        UNQUOTED_VALUE.lastIndex = next;
        const value = UNQUOTED_VALUE.exec(html);
        if (!value) {
          return fail();
        }
        pos = next + value[0].length;
      }
    } else {
      pos = beforeValue;
    }
    attributes.push({ text: html.slice(lead, pos), event: /^on/iu.test(attrName[0]) });
  }
}

/** 画像を代替テキストの表示に置き換え、その数を返す。 */
function replaceImages(fragment, doc, label) {
  const images = [...fragment.querySelectorAll("img")];
  for (const img of images) {
    const alt = img.getAttribute("alt") ?? "";
    const placeholder = doc.createElement("span");
    placeholder.className = "mtc-image";
    placeholder.dataset.alt = alt;
    placeholder.title = label;
    placeholder.textContent = alt === "" ? label : alt;
    img.replaceWith(placeholder);
  }
  return images.length;
}
