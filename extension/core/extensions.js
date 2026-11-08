// 追加構文（部品）。MarkdownTrellis（Notepad++版）の部品に合わせる。
// どれもプレビューと書式付きコピーの解釈だけに効き、原文は変更しない。

/** 部品の名前（保存・画面で使う識別子）。 */
export const FEATURES = Object.freeze(["alerts", "footnotes", "math", "containers", "highlight", "wikilinks", "deflists"]);

/** 「GitHub互換」でまとめて有効にする部品。 */
export const GITHUB_PRESET = Object.freeze(["alerts", "footnotes"]);

/** 知らない名前や重複を除き、決まった順に並べる。 */
export function normalizeFeatures(list) {
  const set = new Set(Array.isArray(list) ? list.filter((name) => typeof name === "string") : []);
  return FEATURES.filter((name) => set.has(name));
}

const escapeHtml = (value) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

/**
 * marked.use() に渡す設定を作る。
 * @param {string[]} features
 */
export function buildMarkedOptions(features) {
  const on = new Set(features);
  const extensions = [];
  const options = { extensions };

  if (on.has("math")) {
    extensions.push(mathBlock, mathInline);
  }
  if (on.has("containers")) {
    extensions.push(container);
  }
  if (on.has("highlight")) {
    extensions.push(highlight);
  }
  if (on.has("wikilinks")) {
    extensions.push(wikilink);
  }
  if (on.has("deflists")) {
    extensions.push(definitionList);
  }
  if (on.has("footnotes")) {
    const notes = createFootnotes();
    extensions.push(notes.definition, notes.reference);
    options.hooks = { preprocess: notes.reset, postprocess: notes.append };
  }
  return options;
}

// ---- 数式（文字のまま表示。他の書式と区別するだけ） ----

const mathBlock = {
  name: "mtcMathBlock",
  level: "block",
  tokenizer(src) {
    const match = /^ {0,3}\$\$([\s\S]*?)\$\$[ \t]*(?:\n|$)/u.exec(src);
    if (match) {
      return { type: "mtcMathBlock", raw: match[0], text: match[0].trim() };
    }
    return undefined;
  },
  renderer(token) {
    return `<div class="mtc-math mtc-math-display">${escapeHtml(token.text)}</div>\n`;
  },
};

const mathInline = {
  name: "mtcMathInline",
  level: "inline",
  start(src) {
    const index = src.indexOf("$");
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    // $x$。開きの直後と閉じの直前に空白を置かず、閉じの直後が数字なら金額とみなす
    const match = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?!\d)/u.exec(src);
    if (match) {
      return { type: "mtcMathInline", raw: match[0], text: match[0] };
    }
    return undefined;
  },
  renderer(token) {
    return `<span class="mtc-math">${escapeHtml(token.text)}</span>`;
  },
};

// ---- コンテナ（::: name … :::） ----

const container = {
  name: "mtcContainer",
  level: "block",
  start(src) {
    const match = /^ {0,3}:{3,}/mu.exec(src);
    return match ? match.index : undefined;
  },
  tokenizer(src) {
    const open = /^ {0,3}(:{3,})[ \t]*([A-Za-z][\w-]*)?[^\n]*(?:\n|$)/u.exec(src);
    if (!open) {
      return undefined;
    }
    const colons = open[1].length;
    const lines = src.slice(open[0].length).split("\n");
    let depth = 1;
    let consumed = open[0].length;
    const body = [];
    let fence = null; // コードブロックの中の ::: は開始・終了として扱わない
    for (const line of lines) {
      const lineLength = line.length + 1;
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
      if (fence !== null) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1]) {
          fence = null;
        }
        body.push(line);
        consumed += lineLength;
        continue;
      }
      if (fenceMatch) {
        fence = fenceMatch[1];
        body.push(line);
        consumed += lineLength;
        continue;
      }
      if (new RegExp(`^ {0,3}:{${colons},}[ \\t]*$`, "u").test(line)) {
        depth--;
        if (depth === 0) {
          consumed += lineLength;
          break;
        }
      } else if (new RegExp(`^ {0,3}:{${colons},}[ \\t]*[A-Za-z]`, "u").test(line)) {
        depth++;
      }
      body.push(line);
      consumed += lineLength;
    }
    const raw = src.slice(0, Math.min(consumed, src.length));
    const kind = (open[2] ?? "").toLowerCase();
    const token = { type: "mtcContainer", raw, kind, tokens: [] };
    this.lexer.blockTokens(body.join("\n"), token.tokens);
    return token;
  },
  renderer(token) {
    const kind = /^[a-z][a-z0-9-]{0,30}$/u.test(token.kind) ? token.kind : "";
    const title = kind ? `<p class="mtc-container-title">${escapeHtml(kind)}</p>\n` : "";
    return `<div class="mtc-container${kind ? ` mtc-container-${kind}` : ""}">\n${title}${this.parser.parse(token.tokens)}</div>\n`;
  },
};

// ---- ハイライト（==text==） ----

const highlight = {
  name: "mtcHighlight",
  level: "inline",
  start(src) {
    const index = src.indexOf("==");
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    const match = /^==(?=[^=\s])([^\n]*?[^=\s])==(?!=)/u.exec(src);
    if (match) {
      return { type: "mtcHighlight", raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
    }
    return undefined;
  },
  renderer(token) {
    return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
  },
};

// ---- Wikiリンク（[[page]]、[[page|label]]）。ブラウザーからPCのファイルは開けないので、リンクの見た目だけにする ----

const wikilink = {
  name: "mtcWikilink",
  level: "inline",
  start(src) {
    const index = src.indexOf("[[");
    return index < 0 ? undefined : index;
  },
  tokenizer(src) {
    const match = /^\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/u.exec(src);
    if (!match) {
      return undefined;
    }
    const target = match[1].trim();
    const label = (match[2] ?? match[1]).trim();
    if (target === "" || label === "") {
      return undefined;
    }
    return { type: "mtcWikilink", raw: match[0], target, label };
  },
  renderer(token) {
    return `<span class="mtc-wikilink" title="${escapeHtml(token.target)}">${escapeHtml(token.label)}</span>`;
  },
};

// ---- 定義リスト（用語の次の行を「: 説明」で始める） ----

const TERM = /^(?! {0,3}(?:[-*+>#|]|\d+[.)]|```|~~~|:))[^\n]*\S[^\n]*$/u;
const DEFINITION = /^:[ \t]+(\S[^\n]*)$/u;

const definitionList = {
  name: "mtcDefinitionList",
  level: "block",
  tokenizer(src) {
    const lines = src.split("\n");
    const items = [];
    let i = 0;
    while (i < lines.length) {
      // 用語の行、続いて「: 説明」の行が1行以上（説明の続きは字下げした行）
      if (!TERM.test(lines[i]) || i + 1 >= lines.length || !DEFINITION.test(lines[i + 1])) {
        break;
      }
      const term = lines[i].trim();
      const definitions = [];
      i++;
      while (i < lines.length && DEFINITION.test(lines[i])) {
        let text = DEFINITION.exec(lines[i])[1];
        i++;
        while (i < lines.length && /^(?: {2,}|\t)\S/u.test(lines[i])) {
          text += `\n${lines[i].trim()}`;
          i++;
        }
        definitions.push(text);
      }
      items.push({ term, definitions });
      // 次の組との間の空行は1行まで
      if (i < lines.length && lines[i].trim() === "" && i + 2 < lines.length && TERM.test(lines[i + 1]) && DEFINITION.test(lines[i + 2])) {
        i++;
      }
    }
    if (items.length === 0) {
      return undefined;
    }
    const raw = lines.slice(0, i).join("\n") + (i < lines.length ? "\n" : "");
    return {
      type: "mtcDefinitionList",
      raw,
      items: items.map((item) => ({
        term: this.lexer.inline(item.term),
        definitions: item.definitions.map((text) => this.lexer.inline(text)),
      })),
    };
  },
  renderer(token) {
    const body = token.items.map((item) =>
      `<dt>${this.parser.parseInline(item.term)}</dt>\n${item.definitions.map((d) => `<dd>${this.parser.parseInline(d)}</dd>\n`).join("")}`).join("");
    return `<dl>\n${body}</dl>\n`;
  },
};

// ---- 脚注（本文[^1] と [^1]: 注） ----

function createFootnotes() {
  let defined = new Map(); // id -> { html }
  let order = []; // 参照された順の id

  const reset = (markdown) => {
    defined = new Map();
    order = [];
    return markdown;
  };

  const definition = {
    name: "mtcFootnoteDef",
    level: "block",
    tokenizer(src) {
      const match = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?: {2,}|\t)[^\n]*)*)(?:\n|$)/u.exec(src);
      if (!match) {
        return undefined;
      }
      const id = match[1];
      if (!defined.has(id)) {
        defined.set(id, { html: "" });
      }
      const text = match[2].split("\n").map((line) => line.trim()).join("\n");
      return { type: "mtcFootnoteDef", raw: match[0], id, tokens: this.lexer.inline(text) };
    },
    renderer(token) {
      const entry = defined.get(token.id);
      if (entry && entry.html === "") {
        entry.html = this.parser.parseInline(token.tokens);
      }
      return "";
    },
  };

  const reference = {
    name: "mtcFootnoteRef",
    level: "inline",
    start(src) {
      const index = src.indexOf("[^");
      return index < 0 ? undefined : index;
    },
    tokenizer(src) {
      const match = /^\[\^([^\]\s]+)\]/u.exec(src);
      // 定義のない参照は文字のまま残す
      if (!match || !defined.has(match[1])) {
        return undefined;
      }
      let number = order.indexOf(match[1]) + 1;
      if (number === 0) {
        order.push(match[1]);
        number = order.length;
      }
      return { type: "mtcFootnoteRef", raw: match[0], number };
    },
    renderer(token) {
      return `<sup class="footnote-ref"><a href="#mtc-fn-${token.number}" id="mtc-fnref-${token.number}">${token.number}</a></sup>`;
    },
  };

  const append = (html) => {
    if (order.length === 0) {
      return html;
    }
    const items = order.map((id, index) => {
      const n = index + 1;
      return `<li id="mtc-fn-${n}">${defined.get(id)?.html ?? ""} <a href="#mtc-fnref-${n}" class="footnote-backref">↩</a></li>\n`;
    }).join("");
    return `${html}<section class="footnotes">\n<hr>\n<ol>\n${items}</ol>\n</section>\n`;
  };

  return { definition, reference, reset, append };
}

// ---- アラート（> [!NOTE]）。安全化した後の DOM で引用を枠に置き換える ----

const ALERT_KINDS = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

/**
 * @param {DocumentFragment} fragment
 * @param {Document} doc
 */
export function applyAlerts(fragment, doc) {
  for (const quote of [...fragment.querySelectorAll("blockquote")]) {
    const first = quote.firstElementChild;
    if (!first || first.nodeName !== "P" || !first.firstChild || first.firstChild.nodeType !== 3) {
      continue;
    }
    const match = /^\s*\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/iu.exec(first.firstChild.nodeValue);
    if (!match) {
      continue;
    }
    // [!NOTE] の直後（同じ行）に書式付きの本文が続く場合は対象外（GitHub と同じ）
    const sameLineNext = first.firstChild.nextSibling;
    if (!match[0].includes("\n") && match[0].length === first.firstChild.nodeValue.length && sameLineNext && sameLineNext.nodeName !== "BR") {
      continue;
    }
    const kind = match[1].toLowerCase();
    first.firstChild.nodeValue = first.firstChild.nodeValue.slice(match[0].length);
    if (first.textContent.trim() === "" && first.children.length === 0) {
      first.remove();
    }
    const box = doc.createElement("div");
    box.className = `markdown-alert markdown-alert-${kind}`;
    const title = doc.createElement("p");
    title.className = "markdown-alert-title";
    title.textContent = ALERT_KINDS[kind];
    box.append(title, ...quote.childNodes);
    quote.replaceWith(box);
  }
}

// ---- 検出（有効にするかは利用者が選ぶ） ----

const DETECTORS = {
  alerts: [/^\s*>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gimu],
  footnotes: [/\[\^[^\]\s]+\]/gu],
  math: [/^\s*\$\$/gmu],
  containers: [/^:{3,}[ \t]*\w/gmu],
  highlight: [/==[^=\s](?:[^=\n]*[^=\s])?==/gu],
  wikilinks: [/\[\[[^[\]\n]+\]\]/gu],
  deflists: [/^:[ \t]+\S/gmu],
};

/**
 * 部品の構文らしい箇所を数える。コードブロック・インラインコードの中は数えない。
 * $x$ は金額と区別しにくいので数えない（部品を有効にすれば解釈する）。
 * @param {string} body Frontmatter を除いた本文
 * @returns {Record<string, number>}
 */
export function detectFeatures(body) {
  const text = maskCode(body);
  const counts = {};
  for (const [name, patterns] of Object.entries(DETECTORS)) {
    let count = 0;
    for (const pattern of patterns) {
      count += (text.match(pattern) ?? []).length;
    }
    if (name === "math") {
      count = Math.floor(count / 2) + (count % 2);
    }
    if (count > 0) {
      counts[name] = count;
    }
  }
  return counts;
}

/**
 * 原文の選択範囲が、範囲外にある参照リンク・脚注の定義を使っているか（選択範囲のコピーで通知するため）。
 * 参照は [文字][名前]・[名前][]・[名前] の3形式と、脚注を有効にしていれば [^名前]。
 * 文書のどこかに定義があり、選択範囲の中には定義がないものを範囲外とみなす。コードの中は見ない。
 * @param {string} source 原文全体
 * @param {number} start
 * @param {number} end
 * @param {string[]} features
 */
export function usesOutsideDefinitions(source, start, end, features) {
  const masked = maskCode(source);
  const label = (value) => value.trim().replace(/\s+/gu, " ").toLowerCase();
  const definitions = (text) => new Set([...text.matchAll(/^ {0,3}\[([^\]\n]+)\]:/gmu)].map((m) => label(m[1])));
  const inDocument = definitions(masked);
  const inSelection = definitions(masked.slice(start, end));
  const selection = masked.slice(start, end).replace(/^ {0,3}\[[^\]\n]+\]:.*$/gmu, "");
  const references = [];
  for (const m of selection.matchAll(/\[([^\]\n]*)\](?:\[([^\]\n]*)\])?(?![(:])/gu)) {
    if (m[1].startsWith("^")) {
      if (features.includes("footnotes") && m[2] === undefined) {
        references.push(m[1]);
      }
      continue;
    }
    references.push(m[2] === undefined || m[2] === "" ? m[1] : m[2]);
  }
  return references.some((name) => inDocument.has(label(name)) && !inSelection.has(label(name)));
}

/** コードブロックとインラインコードを空白に置き換える（位置は保つ）。 */
export function maskCode(text) {
  const lines = text.split("\n");
  let fence = null;
  const masked = lines.map((line) => {
    const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fence === null) {
      if (match) {
        fence = match[1];
        return " ".repeat(line.length);
      }
      return line.replace(/(`+)[^`\n]*?\1/gu, (span) => " ".repeat(span.length));
    }
    if (match && match[1][0] === fence[0] && match[1].length >= fence.length && line.trim() === match[1]) {
      fence = null;
    }
    return " ".repeat(line.length);
  });
  return masked.join("\n");
}
