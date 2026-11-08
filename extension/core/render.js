// Markdown を GFM として解釈し、許可リストで安全化した DOM の断片を作る。
// 生成した HTML 文字列を innerHTML へ入れず、DOMPurify が返す DocumentFragment を使う。
import { Marked } from "../vendor/marked.esm.js";
import createDOMPurify from "../vendor/purify.es.mjs";
import { splitFrontmatter, detectOuterFence, unwrapOuterFence } from "./syntax.js";
import { buildMarkedOptions, applyAlerts, detectFeatures, normalizeFeatures } from "./extensions.js";

/** Markdown が生成する要素と、生HTMLで許可する要素。 */
export const ALLOWED_TAGS = Object.freeze([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "s", "del", "ins", "mark",
  "sub", "sup", "kbd", "abbr", "code", "pre", "blockquote", "hr", "br",
  "ul", "ol", "li", "input", "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "details", "summary", "div", "span", "dl", "dt", "dd", "section",
]);

const ALLOWED_ATTR = ["href", "title", "alt", "src", "align", "colspan", "rowspan", "start", "type", "checked", "disabled", "open", "class", "id"];
const ATTR_BY_TAG = {
  a: new Set(["href", "title", "id", "class"]),
  img: new Set(["alt", "title", "src"]),
  abbr: new Set(["title"]),
  th: new Set(["align", "colspan", "rowspan"]),
  td: new Set(["align", "colspan", "rowspan"]),
  ol: new Set(["start"]),
  input: new Set(["type", "checked", "disabled"]),
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
    if (node.nodeName === "INPUT") {
      node.setAttribute("disabled", "");
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

  /** 部品の組み合わせごとに解析器を作り、使い回す。 */
  function markedFor(features) {
    const key = features.join(",");
    let instance = markedByFeatures.get(key);
    if (!instance) {
      instance = new Marked({ gfm: true, breaks: false, async: false });
      instance.use(buildMarkedOptions(features));
      markedByFeatures.set(key, instance);
    }
    return instance;
  }

  /**
   * Markdown を安全な DocumentFragment にする。
   * @param {string} markdown
   * @param {string[]} [featureList] 有効にする追加構文
   * @returns {{ fragment: DocumentFragment, imageCount: number, removedCount: number }}
   */
  function renderMarkdown(markdown, featureList = []) {
    const features = normalizeFeatures(featureList);
    const html = stripEventHandlers(markedFor(features).parse(markdown));
    const fragment = purify.sanitize(html, config);
    // 断片を返す設定では、包みの BODY も「除外」として記録されるので数えない
    const removedCount = purify.removed.filter((entry) => entry.element && entry.element.nodeType === 1 && !["BODY", "HTML", "HEAD"].includes(entry.element.nodeName)).length;
    const imageCount = replaceImages(fragment, win.document, imageLabel);
    if (features.includes("alerts")) {
      applyAlerts(fragment, win.document);
    }
    return { fragment, imageCount, removedCount };
  }

  /**
   * 全文をプレビューと書式付きコピー用に変換する。Frontmatter は除外し、
   * unwrapFence が true で全文フェンスがあれば外側の行も除外する。原文は変更しない。
   * @param {string} source
   * detected は追加構文らしい箇所の件数（有効かどうかに関係なく数える）。
   * @param {{ unwrapFence?: boolean, features?: string[] }} [opts]
   */
  function renderDocument(source, opts = {}) {
    const { body } = splitFrontmatter(source);
    const fence = detectOuterFence(body);
    const markdown = fence && opts.unwrapFence ? unwrapOuterFence(body, fence) : body;
    return {
      ...renderMarkdown(markdown, opts.features),
      fence: fence !== null,
      fenceApplied: Boolean(fence && opts.unwrapFence),
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
  // タグを属性の区切りどおりに読み、名前が on で始まる属性だけを除く（引用符の中の文字は変えない）
  const TAG = /<([A-Za-z][^\s/>]*)((?:\s*\/?\s*[^\s"'=<>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/gu;
  const ATTRIBUTE = /(\s*\/?\s*)([^\s"'=<>/]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gu;
  return html.replace(TAG, (tag, name, attributes, selfClose) => {
    if (!/\bon/iu.test(attributes)) {
      return tag;
    }
    const kept = attributes.replace(ATTRIBUTE, (attribute, lead, attrName) => (/^on/iu.test(attrName) ? " " : attribute));
    return `<${name}${kept}${selfClose ? " /" : ""}>`;
  });
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
