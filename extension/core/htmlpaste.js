// 書式付きテキスト（クリップボードの text/html）を Markdown へ変換する。設定がONのときだけ使う。
// クリップボードの HTML は信頼できない入力として扱う。DOMParser の文書（表示されず、スクリプトも画像の読み込みも動かない）で
// 解析し、HTML 文字列を画面の DOM へ入れない。出力するのは Markdown の文字列だけで、HTML タグはセル内の改行（<br>）しか残さない。
// 解析そのものはブラウザーに任せ、要素から Markdown への変換は Turndown（MIT）と、このファイルのルールで行う。
import TurndownService from "../vendor/turndown.browser.es.js";
import { stripEventHandlers } from "./render.js";

/** これより長い HTML は変換しない（解析に時間がかかるため。文字数）。 */
export const HTML_LIMIT = 2_000_000;
/** 変換結果がこれより長ければ使わない（execCommand("insertText") での挿入が遅いため。文字数）。 */
export const MARKDOWN_LIMIT = 20_000;

/** 変換の前に取り除く要素（実行・読み込み・操作の部品で、本文ではないもの）。 */
const DROP = "script, style, noscript, template, iframe, frame, object, embed, applet, link, meta, title, base, "
  + "button, select, textarea, svg, canvas, video, audio, source, track, map, form > input:not([type='checkbox'])";

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/iu;
const HEADINGS = ["H1", "H2", "H3", "H4", "H5", "H6"];

/**
 * 貼り付ける内容を決める。
 * @param {{html: string, plain: string}} data クリップボードの text/html と text/plain
 * @param {{DOMParser: typeof DOMParser}} env
 * @returns {{kind: "markdown", text: string} | {kind: "plain", reason: string}}
 *   kind が plain のときは変換せず、ブラウザー標準の貼り付け（text/plain）に任せる。
 */
export function choosePaste({ html, plain }, env) {
  if (!html || !html.trim()) {
    return { kind: "plain", reason: "no-html" };
  }
  if (html.length > HTML_LIMIT) {
    return { kind: "plain", reason: "too-long" };
  }
  try {
    const root = parseHtml(html, env.DOMParser);
    const found = formattingIn(root);
    if (found.size === 0) {
      return { kind: "plain", reason: "no-format" };
    }
    if (plain && plainKeepsMarkdown(plain, found)) {
      return { kind: "plain", reason: "markdown-plain" };
    }
    const text = elementToMarkdown(root);
    if (!text.trim()) {
      return { kind: "plain", reason: "empty" };
    }
    if (text.length > MARKDOWN_LIMIT) {
      return { kind: "plain", reason: "too-long" };
    }
    return { kind: "markdown", text };
  } catch {
    return { kind: "plain", reason: "error" };
  }
}

/** HTML を表示されない文書で解析し、本文の要素を返す（不要な要素は取り除き、数式は TeX にする）。 */
export function parseHtml(html, DOMParserCtor) {
  // イベント属性は解析の前に除く（解析しただけでも Chrome が CSP 違反として Console に記録するため。実行はされない）
  const doc = new DOMParserCtor().parseFromString(stripEventHandlers(html), "text/html");
  const body = doc.body ?? doc.documentElement;
  for (const el of body.querySelectorAll(DROP)) {
    el.remove();
  }
  replaceMath(doc, body);
  pushDownBlockStrike(doc, body);
  return body;
}

/**
 * HTML に含まれる「意味のある書式」の種類を返す。空の set なら書式なし。
 * 種類: heading, strong, em, strike, list, table, quote, codeblock, code, link, hr, math
 */
export function formattingIn(root) {
  const found = new Set();
  for (const el of root.querySelectorAll("*")) {
    const name = el.nodeName;
    const hasText = el.textContent.trim() !== "";
    if (HEADINGS.includes(name) && hasText) {
      found.add("heading");
    } else if ((name === "STRONG" || name === "B") && hasText && !isNormalWeight(el)) {
      found.add("strong");
    } else if ((name === "EM" || name === "I") && hasText && !isNormalStyle(el)) {
      found.add("em");
    } else if ((name === "DEL" || name === "S" || name === "STRIKE") && hasText) {
      found.add("strike");
    } else if ((name === "UL" || name === "OL") && el.querySelector("li")) {
      found.add("list");
    } else if (name === "TABLE" && el.querySelector("td, th")) {
      found.add("table");
    } else if (name === "BLOCKQUOTE" && hasText) {
      found.add("quote");
    } else if (name === "PRE" && hasText) {
      found.add("codeblock");
    } else if (name === "CODE" && hasText) {
      found.add("code");
    } else if (name === "A" && hasText && SAFE_HREF.test((el.getAttribute("href") ?? "").trim())) {
      found.add("link");
    } else if (name === "HR") {
      found.add("hr");
    } else if (name === "X-MT-MATH") {
      found.add("math");
    } else if (hasText) {
      const style = styleOf(el);
      if (style.bold) found.add("strong");
      if (style.italic) found.add("em");
      if (style.strike) found.add("strike");
    }
  }
  return found;
}

/**
 * text/plain がすでに Markdown の原文か（AI のコピーボタンなど）。
 * HTML の書式に対応する Markdown の記号が text/plain にあれば Markdown とみなす。
 * ただし、HTML の表・コードブロックが text/plain に表・フェンスとして入っていなければ HTML を使う（列やコードが崩れるため）。
 */
export function plainKeepsMarkdown(plain, found) {
  const has = {
    heading: /^ {0,3}#{1,6}[ \t]+\S/mu.test(plain),
    strong: /(\*\*|__)(?=\S)[^\n]*?\S\1/u.test(plain),
    table: /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*\|/mu.test(plain),
    codeblock: /^ {0,3}(```|~~~)/mu.test(plain),
    link: /\[[^\]\n]+\]\([^)\s]+\)/u.test(plain),
    strike: /~~(?=\S)[^\n]*?\S~~/u.test(plain),
  };
  if (found.has("table") && !has.table) {
    return false;
  }
  if (found.has("codeblock") && !has.codeblock) {
    return false;
  }
  return Object.keys(has).some((key) => found.has(key) && has[key]);
}

/** 要素の中身を Markdown にする（parseHtml で整えた要素を渡す）。 */
export function elementToMarkdown(root) {
  const markdown = createService().turndown(root);
  // 空白だけの行と、引用の空行（"> "）の行末の空白を取り、3行以上の空行を1行にまとめる
  return markdown.replace(/^[ \t]+$/gmu, "")
    .replace(/^((?:> ?)*>) +$/gmu, "$1")
    .replace(/\n{3,}/gu, "\n\n");
}

let service = null;

function createService() {
  if (service) {
    return service;
  }
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });

  // 英数字に挟まれた _ はエスケープしない（snake_case が \_ だらけにならないように。GFM では強調にならない）
  const escape = td.escape.bind(td);
  td.escape = (text) => escape(text)
    .replace(/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, "_")
    .replace(/~~/gu, "\\~\\~");

  td.addRule("mtMath", {
    filter: (node) => node.nodeName === "X-MT-MATH",
    replacement: (content, node) => {
      const tex = node.getAttribute("data-tex") ?? "";
      return node.getAttribute("data-display") === "true" ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
    },
  });

  td.addRule("mtTable", {
    filter: "table",
    replacement: (content, node) => tableToMarkdown(node, td),
  });

  td.addRule("mtCodeBlock", {
    filter: "pre",
    replacement: (content, node) => {
      // ChatGPT などは pre の中に言語名やコピーボタンの見出しを置くので、code があれば code の文字だけを使う
      const code = node.querySelector("code");
      const text = (code ?? node).textContent.replace(/\n$/u, "");
      const language = ((code?.getAttribute("class") ?? "").match(/(?:^|\s)(?:language|lang)-([\w+#.-]+)/u) ?? [null, ""])[1];
      let fence = "```";
      for (const run of text.match(/^`{3,}/gmu) ?? []) {
        if (run.length >= fence.length) {
          fence = "`".repeat(run.length + 1);
        }
      }
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
    },
  });

  td.addRule("mtListItem", {
    filter: "li",
    replacement: (content, node) => {
      const parent = node.parentNode;
      let prefix = "- ";
      if (parent.nodeName === "OL") {
        const start = Number(parent.getAttribute("start"));
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${(Number.isFinite(start) && parent.hasAttribute("start") ? start : 1) + index}. `;
      }
      const isParagraph = /\n$/u.test(content);
      const body = content.replace(/^\n+/u, "").replace(/\n+$/u, "").replace(/^(\[[x ]\]) +/u, "$1 ") + (isParagraph ? "\n" : "");
      const indented = body.replace(/\n/gu, `\n${" ".repeat(prefix.length)}`);
      return prefix + indented + (node.nextSibling ? "\n" : "");
    },
  });

  td.addRule("mtCheckbox", {
    filter: (node) => node.nodeName === "INPUT",
    replacement: (content, node) => {
      if ((node.getAttribute("type") ?? "").toLowerCase() !== "checkbox" || !node.closest("li")) {
        return "";
      }
      return node.hasAttribute("checked") ? "[x] " : "[ ] ";
    },
  });

  td.addRule("mtLink", {
    filter: "a",
    replacement: (content, node) => {
      const href = (node.getAttribute("href") ?? "").trim();
      if (!SAFE_HREF.test(href) || !content.trim()) {
        return content;
      }
      const destination = href.replace(/[()]/gu, (c) => `\\${c}`).replace(/ /gu, "%20");
      const title = (node.getAttribute("title") ?? "").replace(/\s+/gu, " ").trim().replace(/"/gu, "\\\"");
      return `[${content}](${destination}${title ? ` "${title}"` : ""})`;
    },
  });

  td.addRule("mtImage", {
    filter: "img",
    // 画像は読み込まず、代わりの文字だけを残す
    replacement: (content, node) => td.escape((node.getAttribute("alt") ?? "").replace(/\s+/gu, " ").trim()),
  });

  td.addRule("mtStrike", {
    filter: ["del", "s", "strike"],
    // すでに取り消し線の中なら記号を重ねない
    replacement: (content, node) => (content.trim() && !isInsideStrike(node.parentNode) ? `~~${content}~~` : content),
  });

  td.addRule("mtStrong", {
    filter: ["strong", "b"],
    replacement: (content, node) => {
      // 見出し・表の見出し・すでに太字の中、または font-weight: normal の b（Google ドキュメントなど）は記号を付けない
      if (!content.trim() || isNormalWeight(node) || isInsideBold(node.parentNode)) {
        return content;
      }
      return `**${content}**`;
    },
  });

  td.addRule("mtEmphasis", {
    filter: ["em", "i"],
    replacement: (content, node) => {
      if (!content.trim() || isNormalStyle(node) || isInsideItalic(node.parentNode)) {
        return content;
      }
      return `*${content}*`;
    },
  });

  // インライン CSS の太字・斜体・取り消し線（Copilot などの span style）
  td.addRule("mtStyled", {
    filter: (node) => (node.nodeName === "SPAN" || node.nodeName === "FONT") && node.hasAttribute("style"),
    replacement: (content, node) => {
      if (!content.trim()) {
        return content;
      }
      const style = styleOf(node);
      let text = content;
      if (style.strike && !isInsideStrike(node.parentNode)) {
        text = `~~${text}~~`;
      }
      if (style.italic && !isInsideItalic(node.parentNode)) {
        text = `*${text}*`;
      }
      if (style.bold && !isInsideBold(node.parentNode)) {
        text = `**${text}**`;
      }
      return text;
    },
  });

  service = td;
  return td;
}

/** HTML の表を GFM の表にする。1行目を見出し行にし、列数は最も多い行に合わせる。 */
function tableToMarkdown(table, td) {
  const rows = [];
  for (const row of table.rows ?? []) {
    const cells = [];
    for (const cell of row.cells) {
      cells.push({ text: cellToMarkdown(cell, td), align: alignOf(cell) });
      const span = Math.min(Math.max(Number(cell.getAttribute("colspan")) || 1, 1), 50);
      for (let i = 1; i < span; i++) {
        cells.push({ text: "", align: "" });
      }
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }
  if (rows.length === 0) {
    return "";
  }
  const width = Math.max(...rows.map((cells) => cells.length));
  const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i]?.text ?? "").join(" | ")} |`;
  const separator = `| ${Array.from({ length: width }, (_, i) => {
    const align = rows[0][i]?.align ?? "";
    return align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---";
  }).join(" | ")} |`;
  return `\n\n${[line(rows[0]), separator, ...rows.slice(1).map(line)].join("\n")}\n\n`;
}

/** セルの中身を1行の Markdown にする（改行は <br>、| はエスケープ）。 */
function cellToMarkdown(cell, td) {
  const markdown = td.turndown(cell);
  return markdown
    .split(/\n+/u)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("<br>")
    .replace(/(?<!\\)\|/gu, "\\|");
}

function alignOf(cell) {
  const value = (cell.style?.textAlign || cell.getAttribute("align") || "").toLowerCase();
  return ["left", "center", "right"].includes(value) ? value : "";
}

/** インライン CSS の太字・斜体・取り消し線。 */
function styleOf(el) {
  const style = el.style;
  if (!style) {
    return { bold: false, italic: false, strike: false };
  }
  const weight = String(style.fontWeight || "").toLowerCase();
  const decoration = `${style.textDecoration || ""} ${style.textDecorationLine || ""}`.toLowerCase();
  return {
    bold: weight === "bold" || weight === "bolder" || (Number(weight) >= 600),
    italic: /^(?:italic|oblique)/u.test(String(style.fontStyle || "").toLowerCase()),
    strike: decoration.includes("line-through"),
  };
}

function isNormalWeight(el) {
  const weight = String(el.style?.fontWeight || "").toLowerCase();
  return weight === "normal" || weight === "lighter" || (weight !== "" && Number(weight) < 600);
}

function isNormalStyle(el) {
  return String(el.style?.fontStyle || "").toLowerCase() === "normal";
}

/** 要素（またはその祖先）がすでに太字として出力されるか。見出しと表の見出しセルも太字とみなす。 */
function isInsideBold(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
    const name = node.nodeName;
    if (HEADINGS.includes(name) || name === "TH") {
      return true;
    }
    if ((name === "STRONG" || name === "B") && !isNormalWeight(node)) {
      return true;
    }
    if ((name === "SPAN" || name === "FONT") && styleOf(node).bold) {
      return true;
    }
  }
  return false;
}

function isInsideStrike(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
    const name = node.nodeName;
    if (name === "DEL" || name === "S" || name === "STRIKE") {
      return true;
    }
    if ((name === "SPAN" || name === "FONT") && styleOf(node).strike) {
      return true;
    }
  }
  return false;
}

/** ブロック要素（段落・表のセルなど）。CSS の取り消し線を中の文字へ下ろすときに使う。 */
const BLOCKS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CENTER", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
  "FOOTER", "HEADER", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
  ...HEADINGS]);

/**
 * ブロック要素に付いた CSS の取り消し線（<p style="text-decoration: line-through"> など）を、中の文字の並びを囲む span へ下ろす。
 * 取り消し線は子の要素にも表示されるが、Markdown の ~~ はインラインにしか付けられないため。
 * 中のブロック要素（入れ子のリスト・表の行やセルなど）にはさらに下ろす。コードブロック（pre）は ~~ で表せないので下ろさない。
 */
function pushDownBlockStrike(doc, body) {
  const wrap = (el) => {
    let run = [];
    const flush = () => {
      if (run.some((node) => node.textContent.trim() !== "" || node.nodeName === "IMG")) {
        const span = doc.createElement("span");
        span.setAttribute("style", "text-decoration: line-through");
        run[0].before(span);
        span.append(...run);
      }
      run = [];
    };
    for (const child of [...el.childNodes]) {
      if (child.nodeType === 1 && BLOCKS.has(child.nodeName)) {
        flush();
        // 子のブロックに自分の取り消し線があれば、その子は下のループで処理する
        if (child.nodeName !== "PRE" && !styleOf(child).strike) {
          wrap(child);
        }
      } else {
        run.push(child);
      }
    }
    flush();
  };
  for (const el of [...body.querySelectorAll("[style]")]) {
    if (BLOCKS.has(el.nodeName) && el.nodeName !== "PRE" && styleOf(el).strike) {
      wrap(el);
    }
  }
}

function isInsideItalic(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
    const name = node.nodeName;
    if ((name === "EM" || name === "I") && !isNormalStyle(node)) {
      return true;
    }
    if ((name === "SPAN" || name === "FONT") && styleOf(node).italic) {
      return true;
    }
  }
  return false;
}

/**
 * KaTeX・MathML の数式を、TeX の原文を持つ目印の要素（x-mt-math）に置き換える。
 * TeX の原文がない数式は文字だけを残す。
 */
function replaceMath(doc, body) {
  const marker = (tex, display) => {
    const el = doc.createElement("x-mt-math");
    el.setAttribute("data-tex", tex.trim());
    el.setAttribute("data-display", String(display));
    el.textContent = tex.trim(); // 空の要素は Turndown が捨てるので文字も入れておく（出力には data-tex を使う）
    return el;
  };
  for (const katex of [...body.querySelectorAll(".katex")]) {
    if (!katex.isConnected) {
      continue;
    }
    const annotation = katex.querySelector("annotation[encoding='application/x-tex']");
    if (!annotation) {
      katex.querySelector(".katex-mathml")?.remove();
      continue;
    }
    const display = katex.closest(".katex-display");
    (display ?? katex).replaceWith(marker(annotation.textContent, Boolean(display)));
  }
  for (const math of [...body.querySelectorAll("math")]) {
    const annotation = math.querySelector("annotation[encoding='application/x-tex']");
    if (annotation) {
      math.replaceWith(marker(annotation.textContent, math.getAttribute("display") === "block"));
    } else {
      math.replaceWith(doc.createTextNode(math.textContent));
    }
  }
}
