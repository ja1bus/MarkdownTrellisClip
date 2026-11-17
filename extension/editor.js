// 作業タブの画面処理。本文・選択・履歴・プレビューはこのタブのメモリだけに置き、どこにも保存しない。
// 保存するのは追加構文の既定値と、書式付きテキストの貼り付けの ON/OFF だけ（settings.js）。
import { createRenderer } from "./core/render.js";
import { toClipboardPayload } from "./core/richcopy.js";
import { formatEdit, minimize, continueList, indentList, linkPaste } from "./core/formatter.js";
import { findMatches, matchIndexAt, nextMatch, replaceAllText } from "./core/search.js";
import { textStats } from "./core/stats.js";
import { buildDownloadName, buildMarkdownBlob } from "./core/download.js";
import { FEATURES, GITHUB_PRESET, normalizeFeatures, usesOutsideDefinitions } from "./core/extensions.js";
import { choosePaste } from "./core/htmlpaste.js";
import { findAnchor, countNewlines, blockLineCount, lineOffsetInBlock, headingList, toggleTaskEdit } from "./core/anchors.js";
import { loadDefaultFeatures, saveDefaultFeatures, loadPasteHtml, savePasteHtml, watchPasteHtml } from "./settings.js";

const FEATURE_LABELS = {
  alerts: "featureAlerts",
  footnotes: "featureFootnotes",
  math: "featureMath",
  containers: "featureContainers",
  highlight: "featureHighlight",
  wikilinks: "featureWikiLinks",
  deflists: "featureDefinitionLists",
};

const AUTO_UPDATE_LIMIT = 200_000; // これより長い原文は手動更新にする（文字数）
const SLOW_RENDER_MS = 400; // 1回の変換がこれより遅ければ手動更新に切り替える
const UPDATE_DELAY_MS = 300;
const JUMP_SHOW_MS = 1200; // 位置の連動で移った箇所を示す時間
const JUMP_FADE_MS = 650; // 示すのをやめてから薄くし終えるまで（CSS の transition と合わせる）
const LINK_DBLCLICK_MS = 1000; // リンクを押してからこの間のダブルクリックでは、編集欄へ移らない
const STATS_DELAY_MS = 120; // 文字数の表示を入力からこの後に数え直す（長い本文で入力を重くしない）
const SEARCH_SELECTION_MAX = 200; // Ctrl+H で検索語に入れる選択の長さの上限
const TOC_TOP_MARGIN = 16; // 目次で移った見出しを、プレビューの上端からこの位置に出す

const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;
const $ = (id) => document.getElementById(id);

const workspace = $("workspace");
const preview = $("preview");
const scroller = $("previewScroller");
const toggleSourceButton = $("toggleSource");
let source = $("source");

const renderer = createRenderer(window, { imageLabel: t("imageLabel") });

const state = {
  unwrapFence: false,
  manual: false,
  composing: false,
  forwardedPaste: false, // 編集欄の外の Ctrl+V から移した貼り付け（URL のリンク化をしない）
  timer: 0,
  toastTimer: 0,
  features: [], // このタブで有効な追加構文
  pasteHtml: false, // 書式付きテキスト（HTML）を Markdown に変換して貼り付けるか（保存した設定。初期値 OFF）
  pasteHintDismissed: false, // 書式の取り込みの案内を、このタブで閉じたか
  pending: false, // 編集をまだプレビューへ反映していないか
  anchors: [], // 表示中のプレビューの塊と原文の位置の対応（§3.2）
  anchorByElement: new Map(), // 要素 -> 対応
  jumpTimer: 0,
  linkClickedAt: -Infinity, // 最後にプレビューのリンクを押した時刻（event.timeStamp）
  stats: { chars: 0, lines: 0, words: 0 }, // 文字数の表示（全体）
  statsTimer: 0,
};

// 検索と置換（§2.3）。matches は今の検索語での一致、rects は現在の一致の枠（編集欄の内容の中での位置）
const search = { open: false, matches: [], rects: [] };

localize();
bindSource(source);
bindCommands();
bindSearch();
computeStats();
updateEmptyState();
updatePasteStatus();
setSourceVisible(true);
source.focus();

// 追加構文の既定値を読む（読む前に入力があれば、読んだ後に表示し直す）
loadDefaultFeatures().then((features) => {
  state.features = features;
  if (source.value !== "") {
    updatePreview();
  }
});

// 書式付きテキストの貼り付けの設定を読む。別のタブで変えたときも、次の貼り付けから反映する
loadPasteHtml().then(setPasteHtml);
watchPasteHtml(setPasteHtml);

// 戻る・進むのキャッシュから表示し直された場合も、前の内容を残さない
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    resetWorkspace();
  }
});

// 本文があるときにタブを閉じる・再読み込みする場合は、Chrome の確認を出す（本文は保存しないため）
window.addEventListener("beforeunload", (event) => {
  if (source.value !== "") {
    event.preventDefault();
    event.returnValue = "";
  }
});

// 選択範囲のコピーは、編集欄で範囲を選択しているときだけ押せるようにする（文字数の選択の数・検索の件数も更新する）
document.addEventListener("selectionchange", onSelectionChanged);

function localize() {
  document.documentElement.lang = chrome.i18n.getUILanguage().toLowerCase().startsWith("ja") ? "ja" : "en";
  for (const el of document.querySelectorAll("[data-i18n]")) {
    // $ を含む文字は chrome.i18n の書式と衝突するので、差し込み（$1〜）で渡す
    const args = el.dataset.i18nArgs ? JSON.parse(el.dataset.i18nArgs) : [];
    el.textContent = t(el.dataset.i18n, ...args);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of document.querySelectorAll("[data-i18n-aria]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  $("aboutVersion").textContent = t("versionLabel", chrome.runtime.getManifest().version);
}

function bindSource(el) {
  el.addEventListener("compositionstart", () => {
    state.composing = true;
  });
  el.addEventListener("compositionend", () => {
    state.composing = false;
    onSourceChanged();
  });
  el.addEventListener("input", (event) => {
    if (event.isComposing || state.composing) {
      return;
    }
    onSourceChanged();
  });
  for (const type of ["select", "keyup", "mouseup"]) {
    el.addEventListener(type, onSelectionChanged);
  }
  // 検索の現在の一致の枠は、編集欄にフォーカスがない間だけ出す（フォーカスがあればブラウザーが選択を表示する）
  el.addEventListener("focus", clearSearchHighlight);
  // 編集欄からフォーカスが外れたら、枠を描き直す（検索欄へ戻ったときなど。レビュー R6）
  el.addEventListener("blur", () => {
    if (search.open) {
      refreshMatches();
      drawSearchHighlight();
    }
  });
  el.addEventListener("scroll", positionSearchHighlight);
  // クリックでカーソルを置いたら、その行から作られたプレビューの箇所へ移る（範囲の選択・Shift+クリックでは動かさない）
  el.addEventListener("click", (event) => {
    if (event.button !== 0 || event.shiftKey || event.detail > 1 || state.composing || el.selectionStart !== el.selectionEnd) {
      return;
    }
    const rect = el.getBoundingClientRect();
    jumpToPreview(el.selectionStart, ratioIn(event.clientY - rect.top - el.clientTop, el.clientHeight));
  });
  // 設定が ON で、書式付きテキストを Markdown にできるときだけ、標準の貼り付けの代わりに変換結果を入れる（Undo 1回で戻る）
  el.addEventListener("paste", (event) => {
    // 編集欄の外で押した Ctrl+V を移した貼り付けは、リンクにしない（§2。レビュー R1）
    const forwarded = state.forwardedPaste;
    state.forwardedPaste = false;
    // 文字を選んで URL を貼り付けたら、リンクにする（書式付きテキストの貼り付けより先に判定する。§2）
    const link = forwarded ? null : linkPaste(el.value, el.selectionStart, el.selectionEnd, event.clipboardData?.getData("text/plain"));
    if (link) {
      event.preventDefault();
      applySourceEdit(link);
      return;
    }
    const markdown = convertPaste(event.clipboardData);
    if (markdown !== null) {
      event.preventDefault();
      insertText(markdown);
    }
  });
  el.addEventListener("keydown", (event) => {
    if (event.isComposing || state.composing || event.keyCode === 229) {
      return;
    }
    // 書式のショートカット（§2.2）。配列によらないよう event.code で見る
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
      const command = { KeyB: "bold", KeyI: "italic", KeyK: "link", KeyE: "code" }[event.code];
      if (command) {
        event.preventDefault();
        applyFormat(command);
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    // Enter でリスト・引用の記号を続け、Tab / Shift+Tab でリストの項目を字下げする（§2.2）。
    // 対象でなければ標準の動作に任せる（Tab ならフォーカスが移る）
    let edit = null;
    if (event.key === "Enter" && !event.shiftKey) {
      edit = continueList(el.value, el.selectionStart, el.selectionEnd);
    } else if (event.key === "Tab") {
      edit = indentList(el.value, el.selectionStart, el.selectionEnd, event.shiftKey);
    }
    if (edit) {
      event.preventDefault();
      applySourceEdit(edit);
    }
  });
}

function bindCommands() {
  toggleSourceButton.addEventListener("click", () => {
    const visible = !workspace.classList.contains("source-open");
    setSourceVisible(visible);
    if (visible) {
      source.focus();
    }
  });
  $("copyMarkdown").addEventListener("click", copyMarkdown);
  $("copyRich").addEventListener("click", copyRich);
  $("copySelection").addEventListener("click", copySelection);
  $("download").addEventListener("click", downloadMarkdown);
  $("clear").addEventListener("click", confirmClear);
  $("about").addEventListener("click", () => $("aboutDialog").showModal());
  $("openSyntax").addEventListener("click", openSyntaxDialog);
  $("openPaste").addEventListener("click", openPasteDialog);
  $("pasteStatus").addEventListener("click", openPasteDialog);
  $("pasteFromHint").addEventListener("click", openPasteDialog);
  $("closePasteHint").addEventListener("click", () => {
    state.pasteHintDismissed = true;
    $("pasteHint").hidden = true;
  });
  $("syntaxFromBanner").addEventListener("click", openSyntaxDialog);
  $("presetGitHub").addEventListener("click", () => setDialogFeatures(GITHUB_PRESET));
  $("clearFeatures").addEventListener("click", () => setDialogFeatures([]));
  $("openSearch").addEventListener("click", openSearch);
  $("openKeys").addEventListener("click", () => $("keysDialog").showModal());
  // 目次は開く直前に一覧を作る（bindMenus の開く処理より先に登録する。§3.3）
  $("tocButton").addEventListener("click", buildTocMenu);
  $("tocButton").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      buildTocMenu();
    }
  });
  bindMenus();
  $("tocMenu").addEventListener("click", (event) => {
    const item = event.target.closest("[role='menuitem']");
    if (item?.tocAnchor) {
      jumpToHeading(item.tocAnchor);
      $("tocButton").focus();
    }
  });
  $("toggleFence").addEventListener("click", () => {
    state.unwrapFence = !state.unwrapFence;
    updatePreview({ force: true });
  });
  $("refreshPreview").addEventListener("click", () => updatePreview({ force: true }));

  const formatBar = document.querySelector(".format-bar");
  // ボタンを押しても原文の選択とフォーカスを失わないようにする
  formatBar.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) {
      event.preventDefault();
    }
  });
  formatBar.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-format]");
    if (button) {
      applyFormat(button.dataset.format);
    }
  });

  // リンクは利用者がクリックしたときだけ、新しいタブで開く
  preview.addEventListener("click", (event) => {
    // チェックリストのチェックボックスは、原文の [ ] と [x] を切り替える（§3.4）。チェックボックス自体の切り替えは止める
    const box = event.target.closest("input[type='checkbox']");
    if (box) {
      event.preventDefault();
      // ダブルクリックの2回目以降では切り替えない
      if (event.detail <= 1) {
        toggleCheckbox(box);
      }
      return;
    }
    const link = event.target.closest("a");
    if (!link) {
      return;
    }
    event.preventDefault();
    // 脚注などのリンクでプレビューが動いた後の2回目のクリックは、別の要素のダブルクリックになるので移らない（1.3.0）
    state.linkClickedAt = event.timeStamp;
    // ダブルクリックの2回目のクリックでは、もう一度開かない（1.3.0）
    if (event.detail > 1) {
      return;
    }
    const href = (link.getAttribute("href") ?? "").trim();
    if (/^(?:https?:|mailto:)/iu.test(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
    } else if (href.startsWith("#") && href.length > 1) {
      // 脚注などのページ内リンクは、プレビューの中だけで移動する（URLは変えない）
      const target = preview.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
      target?.scrollIntoView({ block: "center" });
    }
  });
  // ダブルクリックした箇所の元の行へ、編集欄のカーソルを移す（リンクの上では移さない）
  preview.addEventListener("dblclick", (event) => {
    if (event.button !== 0 || event.target.closest("a") || event.timeStamp - state.linkClickedAt < LINK_DBLCLICK_MS) {
      return;
    }
    const rect = scroller.getBoundingClientRect();
    let target = event.target;
    if (state.pending && !state.manual) {
      // 反映前の編集があれば先にプレビューを更新し、同じ位置にある要素で求め直す（手動更新のときは最後の対応を使う）
      updatePreview();
      target = document.elementFromPoint(event.clientX, event.clientY);
      if (!target || !preview.contains(target) || target.closest("a")) {
        return;
      }
    }
    jumpToSource(target, event.clientY, ratioIn(event.clientY - rect.top - scroller.clientTop, scroller.clientHeight));
  });
  preview.addEventListener("auxclick", (event) => {
    if (event.target.closest("a")) {
      event.preventDefault();
    }
  });

  // 原文の外で Ctrl+V を押したら、貼り付けの前に原文へフォーカスを移す。
  // ブラウザー標準の貼り付けがそのまま原文に入るので、text/plain だけを取り込み、Undo もできる。
  document.addEventListener("keydown", (event) => {
    const isPaste = ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v")
      || (event.shiftKey && !event.ctrlKey && event.key === "Insert");
    if (!isPaste || event.isComposing || event.target === source || isEditable(event.target) || document.querySelector("dialog[open]")) {
      return;
    }
    setSourceVisible(true);
    source.focus();
    // 続く paste は編集欄に届くが、外からの貼り付けとして扱う。貼り付けが起きなくても次へ残さない
    state.forwardedPaste = true;
    setTimeout(() => {
      state.forwardedPaste = false;
    });
  }, true);

  // 画面全体のショートカット（§2.2）。ダイアログを開いているとき・IME 変換中は何もしない
  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || state.composing || document.querySelector("dialog[open]")) {
      return;
    }
    if (event.shiftKey && event.code === "KeyC") {
      event.preventDefault();
      copyRich();
    } else if (event.shiftKey && event.code === "KeyM") {
      event.preventDefault();
      copyMarkdown();
    } else if (!event.shiftKey && event.code === "KeyH") {
      event.preventDefault();
      openSearch();
    }
  });

  // 上で受けられなかった貼り付け（メニューからの貼り付けなど）も、原文へ text/plain だけを取り込む
  // （書式付きテキストの貼り付けが ON なら、原文での貼り付けと同じく Markdown に変換する）
  document.addEventListener("paste", (event) => {
    if (event.target === source || isEditable(event.target)) {
      return;
    }
    const text = convertPaste(event.clipboardData) ?? event.clipboardData?.getData("text/plain") ?? "";
    if (text === "") {
      return;
    }
    event.preventDefault();
    pasteFromOutside(text);
  });
}

/**
 * 書式付きテキストの貼り付け。設定が ON で、クリップボードの HTML に意味のある書式があれば Markdown を返す。
 * null のときは変換せず、これまでどおり text/plain を貼り付ける（書式がない・Markdown の原文がある・長い・変換できない）。
 */
function convertPaste(data) {
  if (!data) {
    return null;
  }
  if (!state.pasteHtml) {
    maybeShowPasteHint(data);
    return null;
  }
  const plain = data.getData("text/plain");
  const result = choosePaste({ html: data.getData("text/html"), plain }, { DOMParser: window.DOMParser });
  if (result.kind === "markdown") {
    toast(t("pasteConverted"));
    return result.text;
  }
  if (result.reason === "too-long" && plain !== "") {
    toast(t("pasteTooLong"));
  } else if ((result.reason === "error" || result.reason === "empty") && plain === "") {
    toast(t("pasteFailed"), { error: true });
  }
  return null;
}

/**
 * 設定が OFF で、書式を取り込めたはずの内容を貼り付けたときに、設定があることを案内する（このタブで閉じるまで）。
 * 判定は変換と同じ処理で行い、貼り付ける内容は変えない（text/plain のまま）。
 */
function maybeShowPasteHint(data) {
  if (state.pasteHintDismissed || !$("pasteHint").hidden) {
    return;
  }
  const result = choosePaste({ html: data.getData("text/html"), plain: data.getData("text/plain") }, { DOMParser: window.DOMParser });
  if (result.kind === "markdown") {
    $("pasteHint").hidden = false;
  }
}

function setPasteHtml(enabled) {
  state.pasteHtml = enabled;
  updatePasteStatus();
  if (enabled) {
    $("pasteHint").hidden = true;
  }
}

function updatePasteStatus() {
  $("pasteStatus").textContent = t("pasteStatus", state.pasteHtml ? t("pasteOn") : t("pasteOff"));
  $("pasteStatus").classList.toggle("on", state.pasteHtml);
}

function updateSelectionButton() {
  const open = workspace.classList.contains("source-open");
  $("copySelection").disabled = !open || source.selectionStart === source.selectionEnd;
}

function onSelectionChanged() {
  updateSelectionButton();
  renderStats();
  if (search.open) {
    updateSearchCount();
  }
}

function isEditable(target) {
  return Boolean(target?.closest?.("input, textarea, [contenteditable]:not([contenteditable='false'])"));
}

function pasteFromOutside(text) {
  const wasEmpty = source.value === "";
  setSourceVisible(true);
  source.focus();
  if (wasEmpty) {
    source.setSelectionRange(0, 0);
  }
  insertText(text);
  onSourceChanged();
}

/** ツールバーのメニュー（見出し・その他・設定）。開閉、キーボード操作、外側のクリックで閉じる。 */
function bindMenus() {
  const buttons = [...document.querySelectorAll(".menu-button")];
  const close = (except = null) => {
    for (const button of buttons) {
      if (button !== except) {
        button.setAttribute("aria-expanded", "false");
        $(button.getAttribute("aria-controls")).hidden = true;
      }
    }
  };
  const items = (menu) => [...menu.querySelectorAll("[role='menuitem']")];

  for (const button of buttons) {
    const menu = $(button.getAttribute("aria-controls"));
    // 書式のメニューは、押しても原文の選択とフォーカスを失わないようにする
    button.addEventListener("mousedown", (event) => event.preventDefault());
    menu.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      const open = menu.hidden;
      close(button);
      menu.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      // Enter・Space で開いたとき（detail が 0）は、最初の項目へフォーカスを移す
      if (open && event.detail === 0) {
        items(menu)[0]?.focus();
      }
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        close(button);
        menu.hidden = false;
        button.setAttribute("aria-expanded", "true");
        items(menu)[0]?.focus();
      }
    });
    menu.addEventListener("keydown", (event) => {
      const list = items(menu);
      const index = list.indexOf(document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = (index + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
        list[next].focus();
      } else if (event.key === "Escape" || event.key === "Tab") {
        close();
        if (event.key === "Escape") {
          event.preventDefault();
          button.focus();
        }
      }
    });
    menu.addEventListener("click", (event) => {
      if (event.target.closest("[role='menuitem']")) {
        close();
      }
    });
  }
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu-wrap")) {
      close();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    }
  });
}

function openSyntaxDialog() {
  const dialog = $("syntaxDialog");
  setDialogFeatures(state.features);
  // 「既定値として保存」は開くたびに未チェックから始める
  $("saveDefault").checked = false;
  dialog.returnValue = "";
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "ok") {
      return;
    }
    const chosen = normalizeFeatures([...dialog.querySelectorAll("input[name='feature']:checked")].map((input) => input.value));
    state.features = chosen;
    updatePreview({ force: true });
    if ($("saveDefault").checked) {
      try {
        await saveDefaultFeatures(chosen);
        toast(t("syntaxSaved"));
      } catch {
        toast(t("syntaxSaveFailed"), { error: true });
      }
    }
  }, { once: true });
  dialog.showModal();
}

function openPasteDialog() {
  const dialog = $("pasteDialog");
  $("pasteHtml").checked = state.pasteHtml;
  dialog.returnValue = "";
  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "ok") {
      return;
    }
    const enabled = $("pasteHtml").checked;
    setPasteHtml(enabled);
    try {
      await savePasteHtml(enabled);
      toast(t("pasteSaved"));
    } catch {
      toast(t("pasteSaveFailed"), { error: true });
    }
  }, { once: true });
  dialog.showModal();
}

function setDialogFeatures(features) {
  for (const input of $("syntaxDialog").querySelectorAll("input[name='feature']")) {
    input.checked = features.includes(input.value);
  }
}

/** 原文の選択範囲を置き換える。ブラウザーの編集履歴に1回分として積まれるので Undo で戻せる。 */
function insertText(text) {
  const ok = text === "" ? document.execCommand("delete", false) : document.execCommand("insertText", false, text);
  if (!ok) {
    // execCommand が使えない場合の代替（この場合は Undo の対象にならない）
    source.setRangeText(text, source.selectionStart, source.selectionEnd, "end");
    source.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function applyFormat(command) {
  if (state.composing || !workspace.classList.contains("source-open")) {
    return;
  }
  const edit = formatEdit(command, source.value, source.selectionStart, source.selectionEnd, {
    tableHeaders: [t("tableHeader1"), t("tableHeader2")],
  });
  if (!edit) {
    source.focus();
    return;
  }
  applySourceEdit(edit);
}

/**
 * 編集（formatter.js の Edit）を編集欄に1回の挿入で適用し、選択を置く（1回の Undo で戻る）。
 * execCommand はフォーカスのある入力欄にだけ効くので、先に編集欄へフォーカスを移す。
 */
function applySourceEdit(edit) {
  source.focus({ preventScroll: true });
  if (edit.start !== edit.end || edit.insert !== "") {
    source.setSelectionRange(edit.start, edit.end);
    insertText(edit.insert);
  }
  source.setSelectionRange(edit.selStart, edit.selEnd);
}

function setSourceVisible(visible) {
  workspace.classList.toggle("source-open", visible);
  // ボタンには「押すとどうなるか」を表示する（編集欄を閉じてプレビューを広げる／編集欄を戻す）
  const label = visible ? t("hideSource") : t("showSource");
  $("toggleSourceLabel").textContent = label;
  toggleSourceButton.setAttribute("aria-label", label);
  toggleSourceButton.setAttribute("aria-expanded", String(visible));
  toggleSourceButton.title = visible ? t("hideSourceTitle") : t("showSourceTitle");
  if (!visible) {
    closeSearch({ focus: false });
  }
  updateSelectionButton();
}

function onSourceChanged() {
  updateEmptyState();
  scheduleStats();
  if (search.open) {
    clearSearchHighlight();
    refreshMatches();
  }
  state.pending = true;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => updatePreview(), UPDATE_DELAY_MS);
}

function updateEmptyState() {
  workspace.classList.toggle("is-empty", source.value === "");
}

/** プレビューを更新する。失敗しても原文には触れない。 */
function updatePreview({ force = false } = {}) {
  clearTimeout(state.timer);
  if (state.composing && !force) {
    return;
  }
  const text = source.value;
  const large = text.length > AUTO_UPDATE_LIMIT;
  if (large) {
    state.manual = "large";
  } else if (state.manual === "large") {
    state.manual = false;
  }
  if (state.manual && !force) {
    // 遅い変換で手動にした場合は、利用者が更新するまで自動更新しない
    showStatus(manualMessage(text), { refresh: true });
    return;
  }

  let result;
  state.pending = false;
  const started = performance.now();
  try {
    result = renderer.renderDocument(text, { unwrapFence: state.unwrapFence, features: state.features, anchors: true });
  } catch {
    showStatus(t("renderFailed"), { error: true, refresh: true });
    return;
  }
  const elapsed = performance.now() - started;

  const top = scroller.scrollTop;
  clearTimeout(state.jumpTimer);
  preview.replaceChildren(result.fragment);
  state.anchors = result.anchors ?? [];
  state.anchorByElement = new Map(state.anchors.map((anchor) => [anchor.element, anchor]));
  scroller.scrollTop = top;
  updateTocButton();

  updateFenceBanner(result);
  updateSyntaxBanner(result.detected);
  if (!large) {
    state.manual = elapsed > SLOW_RENDER_MS ? "slow" : false;
  }
  const notes = [];
  if (state.manual) {
    notes.push(manualMessage(text));
  }
  if (result.removedCount > 0) {
    notes.push(t("removedHtml", result.removedCount));
  }
  if (result.imageCount > 0) {
    notes.push(t("imagesReplaced", result.imageCount));
  }
  if (notes.length > 0) {
    showStatus(notes.join(" "), { refresh: state.manual });
  } else {
    hideStatus();
  }
}

// ---- 編集欄とプレビューの位置の連動（§3.2） ----

/** 表示領域の中での高さの割合（0〜1）。 */
function ratioIn(y, height) {
  return height > 0 ? Math.min(1, Math.max(0, y / height)) : 0;
}

/** プレビューの表示領域の内容の中での、要素の上端の位置。 */
function topInScroller(element) {
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop + scroller.scrollTop;
}

/** 表の原文の行（0始まり。1行目が見出し、2行目が区切り）に対応する行の要素。 */
function tableRowForLine(table, line) {
  const rows = table.rows;
  if (rows.length === 0) {
    return table;
  }
  return rows[Math.min(rows.length - 1, Math.max(0, line - 1))];
}

/** 原文の位置 offset から作られたプレビューの箇所を、表示領域の ratio の高さに出して示す。 */
function jumpToPreview(offset, ratio) {
  if (state.pending && !state.manual) {
    // 反映前の編集があれば、先にプレビューを更新する（手動更新のときは最後の対応を使う）
    updatePreview();
  }
  const anchor = findAnchor(state.anchors, offset);
  if (!anchor) {
    scroller.scrollTop = 0;
    return;
  }
  const text = source.value;
  const line = countNewlines(text, anchor.start, Math.min(offset, text.length));
  let target = anchor.element;
  let y;
  if (anchor.type === "table" && target.nodeName === "TABLE") {
    target = tableRowForLine(target, line);
    y = topInScroller(target);
  } else {
    const lines = blockLineCount(text, anchor);
    y = topInScroller(target) + (Math.min(line, lines - 1) / lines) * target.getBoundingClientRect().height;
  }
  scroller.scrollTop = y - ratio * scroller.clientHeight;
  showJumpTarget(target);
}

/** ダブルクリックしたプレビューの箇所の元の行の先頭にカーソルを置き、その行を編集欄の ratio の高さに出す。 */
function jumpToSource(node, clientY, ratio) {
  const byElement = state.anchorByElement;
  let element = node.nodeType === 1 ? node : node.parentElement;
  while (element && element !== preview && !byElement.has(element)) {
    element = element.parentElement;
  }
  const anchor = element && element !== preview ? byElement.get(element) : null;
  if (!anchor) {
    return;
  }
  const text = source.value;
  let line;
  if (anchor.type === "table" && element.nodeName === "TABLE") {
    // 見出し行→1行目、本文の n 行目→n+2 行目（区切りの行を飛ばす）
    const row = node.nodeType === 1 ? node.closest("tr") : node.parentElement?.closest("tr");
    const index = row && element.contains(row) ? [...element.rows].indexOf(row) : 0;
    line = index <= 0 ? 0 : index + 1;
  } else {
    const rect = element.getBoundingClientRect();
    const lines = blockLineCount(text, anchor);
    line = Math.min(lines - 1, Math.floor(ratioIn(clientY - rect.top, rect.height) * lines));
  }
  // 手動更新で古い対応を使うときも、原文の長さを超えない（lineOffsetInBlock がそろえる）
  const offset = lineOffsetInBlock(text, anchor, line);
  if (!workspace.classList.contains("source-open")) {
    setSourceVisible(true);
  }
  source.focus({ preventScroll: true });
  source.setSelectionRange(offset, offset);
  source.scrollTop = caretTop(source, offset) - ratio * source.clientHeight;
  updateSelectionButton();
}

/**
 * 編集欄の内容の中での、offset の位置の行の上端（scrollTop と同じ基準）。
 * 編集欄は折り返して表示するので、同じ幅・字形・余白・折り返しの見えない要素に offset の前までを入れて測る。
 */
function caretTop(textarea, offset) {
  const mirror = createMirror(textarea);
  mirror.textContent = textarea.value.slice(0, offset);
  const mark = document.createElement("span");
  mark.textContent = "​";
  mirror.append(mark);
  const top = mark.offsetTop;
  mirror.remove();
  return top;
}

/**
 * 編集欄の start〜end の文字が表示される矩形（編集欄の内容の中での位置。折り返しで複数になる）。検索の一致の枠に使う。
 * 一致の行の折り返しが同じになるよう、一致の後ろも行の終わりまで入れて測る。
 */
function textRects(textarea, start, end) {
  const mirror = createMirror(textarea);
  const value = textarea.value;
  const newline = value.indexOf("\n", end);
  mirror.textContent = value.slice(0, start);
  const mark = document.createElement("span");
  mark.textContent = value.slice(start, end);
  mirror.append(mark, document.createTextNode(value.slice(end, newline < 0 ? value.length : newline)));
  const base = mirror.getBoundingClientRect();
  const rects = [...mark.getClientRects()].map((r) => ({ left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height }));
  mirror.remove();
  return rects;
}

/** 編集欄と同じ幅・字形・余白・折り返しの見えない要素（文書に追加して返す。使った後に remove する）。 */
function createMirror(textarea) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const name of [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "wordSpacing", "lineHeight", "tabSize",
    "textTransform", "textIndent", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "whiteSpace", "wordBreak", "overflowWrap",
  ]) {
    mirror.style[name] = style[name];
  }
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "-10000px",
    boxSizing: "border-box",
    border: "0",
    width: `${textarea.clientWidth}px`,
    whiteSpace: "pre-wrap",
    overflowWrap: style.overflowWrap === "normal" ? "break-word" : style.overflowWrap,
    overflow: "hidden",
  });
  document.body.append(mirror);
  return mirror;
}

/** 移った箇所を約1秒示し、その後に徐々に薄くする（OSでアニメーションを減らしていれば一度に消す。CSS）。 */
function showJumpTarget(target) {
  clearTimeout(state.jumpTimer);
  for (const old of preview.querySelectorAll(".jump-target, .jump-fade")) {
    clearJumpClass(old, ["jump-target", "jump-fade"]);
  }
  target.classList.add("jump-target");
  state.jumpTimer = setTimeout(() => {
    target.classList.add("jump-fade");
    target.classList.remove("jump-target");
    state.jumpTimer = setTimeout(() => clearJumpClass(target, ["jump-fade"]), JUMP_FADE_MS);
  }, JUMP_SHOW_MS);
}

/** 示すための class を外す。ほかの class がなければ属性も消し、表示前の DOM に戻す。 */
function clearJumpClass(element, names) {
  element.classList.remove(...names);
  if (element.classList.length === 0) {
    element.removeAttribute("class");
  }
}

function manualMessage(text) {
  return state.manual === "large" ? t("manualLarge", text.length.toLocaleString()) : t("manualSlow");
}

function updateFenceBanner(result) {
  const banner = $("fenceBanner");
  if (!result.fence) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  $("fenceMessage").textContent = result.fenceApplied ? t("fenceApplied") : t("fenceDetected");
  $("toggleFence").textContent = result.fenceApplied ? t("fenceRestore") : t("fenceUnwrap");
}

/** 有効になっていない追加構文らしい箇所があれば、件数を案内する（有効にするかは利用者が選ぶ）。 */
function updateSyntaxBanner(detected) {
  const found = FEATURES.filter((name) => (detected?.[name] ?? 0) > 0 && !state.features.includes(name));
  const banner = $("syntaxBanner");
  if (found.length === 0) {
    banner.hidden = true;
    return;
  }
  const list = found.map((name) => t("featureCount", t(FEATURE_LABELS[name]), detected[name])).join(t("listSeparator"));
  $("syntaxMessage").textContent = t("syntaxDetected", list);
  banner.hidden = false;
}

function showStatus(message, { error = false, refresh = false } = {}) {
  $("previewStatus").hidden = false;
  $("previewStatus").classList.toggle("error", error);
  $("previewStatusText").textContent = message;
  $("refreshPreview").hidden = !refresh;
}

function hideStatus() {
  $("previewStatus").hidden = true;
}

function toast(message, { error = false } = {}) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.hidden = true;
  }, error ? 6000 : 3000);
}

/**
 * コピーできたことを、押したボタン自体の表示（✓ コピーしました）で知らせる。
 * 補足があるときだけ通知も出す。画面読み上げには通知の代わりに読み上げ用の領域で伝える。
 */
function copied(button, message, notes = []) {
  clearTimeout(button.copiedTimer);
  if (!button.classList.contains("copied")) {
    button.style.minWidth = `${button.offsetWidth}px`;
  }
  button.dataset.done = `✓ ${t("copied")}`;
  button.classList.add("copied");
  button.copiedTimer = setTimeout(() => {
    button.classList.remove("copied");
    button.style.minWidth = "";
  }, 1600);
  if (notes.length > 0) {
    toast(t("messageWithNote", message, notes.join(" ")));
  } else {
    const announce = $("announce");
    announce.textContent = "";
    setTimeout(() => {
      announce.textContent = message;
    }, 50);
  }
}

async function copyMarkdown() {
  const text = source.value;
  if (text === "") {
    toast(t("nothingToCopy"));
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    copied($("copyMarkdown"), t("copiedMarkdown"));
  } catch {
    toast(t("copyFailed"), { error: true });
  }
}

async function copyRich() {
  const text = source.value;
  if (text.trim() === "") {
    toast(t("nothingToCopy"));
    return;
  }
  await writeFormatted(() => renderer.renderDocument(text, { unwrapFence: state.unwrapFence, features: state.features }), $("copyRich"), t("copiedRich"));
}

async function copySelection() {
  const start = source.selectionStart;
  const end = source.selectionEnd;
  const text = source.value;
  if (!workspace.classList.contains("source-open") || start === end || text.slice(start, end).trim() === "") {
    toast(t("selectionRequired"));
    return;
  }
  const note = usesOutsideDefinitions(text, start, end, state.features) ? t("selectionOutside") : "";
  await writeFormatted(() => renderer.renderSelection(text, start, end, state.features), $("copySelection"), t("copiedSelection"), note);
}

/** 書式付きの HTML と、描画後の内容に対応するプレーンテキストを同時に書き込む。 */
async function writeFormatted(render, button, successMessage, extraNote = "") {
  let payload;
  try {
    payload = toClipboardPayload(render().fragment);
  } catch {
    toast(t("copyFailed"), { error: true });
    return;
  }
  // Frontmatter だけ・除外されるHTMLだけなど、変換後に何も残らなければクリップボードを変えない
  if (payload.text.trim() === "") {
    toast(t("nothingToCopy"));
    return;
  }
  try {
    const item = new ClipboardItem({
      "text/html": new Blob([payload.html], { type: "text/html" }),
      "text/plain": new Blob([payload.text], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
  } catch {
    toast(t("copyFailed"), { error: true });
    return;
  }
  const notes = [];
  if (payload.imageCount > 0) {
    notes.push(t("copiedImages", payload.imageCount));
  }
  if (extraNote !== "") {
    notes.push(extraNote);
  }
  copied(button, successMessage, notes);
}

function downloadMarkdown() {
  const text = source.value;
  if (text === "") {
    toast(t("nothingToDownload"));
    return;
  }
  const url = URL.createObjectURL(buildMarkdownBlob(text));
  const link = document.createElement("a");
  link.href = url;
  link.download = buildDownloadName(new Date());
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  toast(t("downloaded"));
}

function confirmClear() {
  if (source.value === "") {
    resetWorkspace();
    return;
  }
  const dialog = $("clearDialog");
  dialog.returnValue = "";
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "clear") {
      resetWorkspace();
      toast(t("cleared"));
    }
  }, { once: true });
  dialog.showModal();
}

/**
 * 作業データを破棄する。原文の入力欄は要素ごと作り直し、ブラウザーの Undo 履歴から
 * 以前の本文へ戻れないようにする。
 */
function resetWorkspace() {
  clearTimeout(state.timer);
  const fresh = source.cloneNode(false);
  fresh.value = "";
  source.replaceWith(fresh);
  source = fresh;
  bindSource(source);
  state.unwrapFence = false;
  state.manual = false;
  state.composing = false;
  state.pending = false;
  state.anchors = [];
  state.anchorByElement = new Map();
  clearTimeout(state.jumpTimer);
  preview.replaceChildren();
  scroller.scrollTop = 0;
  $("fenceBanner").hidden = true;
  $("syntaxBanner").hidden = true;
  $("pasteHint").hidden = true;
  hideStatus();
  closeSearch({ focus: false });
  updateTocButton();
  setSourceVisible(true);
  updateEmptyState();
  computeStats();
  source.focus();
}

// ---- 1.4.0: 検索と置換（§2.3） ----

function bindSearch() {
  const query = $("searchQuery");
  const replace = $("searchReplace");
  const changed = () => {
    refreshMatches();
    drawSearchHighlight();
  };
  query.addEventListener("input", changed);
  $("searchCase").addEventListener("change", changed);
  query.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      findNext(event.shiftKey);
    }
  });
  replace.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      replaceOne();
    }
  });
  $("searchBar").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    }
  });
  $("searchNext").addEventListener("click", () => findNext(false));
  $("searchPrev").addEventListener("click", () => findNext(true));
  $("replaceOne").addEventListener("click", replaceOne);
  $("replaceAll").addEventListener("click", replaceAllMatches);
  $("searchClose").addEventListener("click", () => closeSearch());
  // 編集欄の大きさが変わったら、一致の枠を置き直す
  new ResizeObserver(() => {
    if (search.rects.length > 0) {
      drawSearchHighlight();
    }
  }).observe($("sourceWrap"));
}

function openSearch() {
  if (!workspace.classList.contains("source-open")) {
    setSourceVisible(true);
  }
  const selected = source.value.slice(source.selectionStart, source.selectionEnd);
  if (selected !== "" && !selected.includes("\n") && selected.length <= SEARCH_SELECTION_MAX) {
    $("searchQuery").value = selected;
  }
  $("searchBar").hidden = false;
  search.open = true;
  refreshMatches();
  $("searchQuery").focus();
  $("searchQuery").select();
  drawSearchHighlight();
}

/** 検索バーを閉じる。検索語・置換後・チェックは残す。focus が true なら編集欄へフォーカスを戻す（選択はそのまま）。 */
function closeSearch({ focus = true } = {}) {
  const wasOpen = search.open;
  search.open = false;
  $("searchBar").hidden = true;
  clearSearchHighlight();
  if (focus && wasOpen && workspace.classList.contains("source-open")) {
    source.focus();
  }
}

function searchOptions() {
  return { caseSensitive: $("searchCase").checked };
}

function refreshMatches() {
  search.matches = findMatches(source.value, $("searchQuery").value, searchOptions());
  updateSearchCount();
}

/** 件数: 現在の一致を選んでいれば「3 / 12」、選んでいなければ「12 件」、なければ「見つかりません」。検索語が空なら出さない。 */
function updateSearchCount() {
  const count = $("searchCount");
  const total = search.matches.length;
  if ($("searchQuery").value === "") {
    count.textContent = "";
  } else if (total === 0) {
    count.textContent = t("searchNone");
  } else {
    const index = matchIndexAt(search.matches, source.selectionStart, source.selectionEnd);
    count.textContent = index >= 0
      ? t("searchPosition", (index + 1).toLocaleString(), total.toLocaleString())
      : t("searchTotal", total.toLocaleString());
  }
}

/** 次（backward なら前）の一致を編集欄で選ぶ。フォーカスは検索バーに残し、一致は重ねた枠で示す。 */
function findNext(backward) {
  if ($("searchQuery").value === "") {
    return;
  }
  refreshMatches();
  const index = nextMatch(search.matches, backward ? source.selectionStart : source.selectionEnd, backward);
  if (index < 0) {
    return;
  }
  const match = search.matches[index];
  source.setSelectionRange(match.start, match.end);
  revealOffset(match.start);
  updateSearchCount();
  updateSelectionButton();
  renderStats();
  drawSearchHighlight();
}

/** 選択がちょうど一致なら置き換えて、次の一致を選ぶ。一致を選んでいなければ次の一致を選ぶだけ。 */
function replaceOne() {
  if ($("searchQuery").value === "") {
    return;
  }
  const back = document.activeElement;
  refreshMatches();
  const index = matchIndexAt(search.matches, source.selectionStart, source.selectionEnd);
  if (index >= 0) {
    const match = search.matches[index];
    const text = $("searchReplace").value;
    const caret = match.start + text.length;
    applySourceEdit({ start: match.start, end: match.end, insert: text, selStart: caret, selEnd: caret });
  }
  findNext(false);
  restoreSearchFocus(back, $("searchReplace"));
}

/** すべての一致を置き換える。変わる範囲だけを1回で置き換えるので、1回の Undo で全部戻る。 */
function replaceAllMatches() {
  const query = $("searchQuery").value;
  if (query === "") {
    return;
  }
  const back = document.activeElement;
  const before = source.value;
  const { text, count } = replaceAllText(before, query, $("searchReplace").value, searchOptions());
  if (count === 0) {
    toast(t("searchNone"));
    return;
  }
  const edit = minimize(before, { start: 0, end: before.length, insert: text, selStart: 0, selEnd: 0 });
  edit.selStart = edit.start;
  edit.selEnd = edit.start;
  applySourceEdit(edit);
  refreshMatches();
  toast(t("replacedAll", count.toLocaleString()));
  restoreSearchFocus(back, $("replaceAll"));
}

function restoreSearchFocus(previous, fallback) {
  const target = previous && previous !== source && $("searchBar").contains(previous) ? previous : fallback;
  target.focus();
  drawSearchHighlight();
}

/** 編集欄の offset の行が見えていなければ、表示領域の上から1/3の高さに出す。 */
function revealOffset(offset) {
  if (!workspace.classList.contains("source-open")) {
    return;
  }
  const top = caretTop(source, offset);
  const lineHeight = parseFloat(getComputedStyle(source).lineHeight) || 20;
  if (top < source.scrollTop || top + lineHeight > source.scrollTop + source.clientHeight) {
    source.scrollTop = top - source.clientHeight / 3;
  }
}

/** 現在の一致（選択がちょうど一致のとき）を、編集欄の上に重ねた枠で示す。編集欄にフォーカスがあれば出さない。 */
function drawSearchHighlight() {
  clearSearchHighlight();
  if (!search.open || document.activeElement === source || !workspace.classList.contains("source-open")) {
    return;
  }
  const index = matchIndexAt(search.matches, source.selectionStart, source.selectionEnd);
  if (index < 0) {
    return;
  }
  const { start, end } = search.matches[index];
  search.rects = textRects(source, start, end);
  const layer = $("searchHighlight");
  for (const rect of search.rects) {
    const box = document.createElement("div");
    box.className = "search-mark";
    box.rect = rect;
    layer.append(box);
  }
  positionSearchHighlight();
}

/** 枠を編集欄のスクロールに合わせて置く（内容の中の位置 − スクロール量）。 */
function positionSearchHighlight() {
  for (const box of $("searchHighlight").children) {
    const { left, top, width, height } = box.rect;
    Object.assign(box.style, {
      left: `${left - source.scrollLeft}px`,
      top: `${top - source.scrollTop}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }
}

function clearSearchHighlight() {
  search.rects = [];
  $("searchHighlight").replaceChildren();
}

// ---- 1.4.0: 文字数・行数・語数（§1） ----

/** 全体の数を少し後に数え直す（入力のたびに長い本文を数えない）。 */
function scheduleStats() {
  clearTimeout(state.statsTimer);
  state.statsTimer = setTimeout(computeStats, STATS_DELAY_MS);
}

function computeStats() {
  clearTimeout(state.statsTimer);
  const text = source.value;
  // 語数は自動更新の上限（文字列の長さ）を超えると数えない（重くしないため）
  state.stats = textStats(text, { words: text.length <= AUTO_UPDATE_LIMIT });
  renderStats();
}

function renderStats() {
  const { chars, lines, words } = state.stats;
  const parts = [];
  if (source.selectionStart !== source.selectionEnd) {
    const selected = textStats(source.value.slice(source.selectionStart, source.selectionEnd), { words: false });
    parts.push(t("statsSelection", selected.chars.toLocaleString(), selected.lines.toLocaleString()));
  }
  parts.push(t("statsText", chars.toLocaleString(), lines.toLocaleString(), words === null ? t("statsNoWords") : words.toLocaleString()));
  $("stats").textContent = parts.join(" · ");
}

// ---- 1.4.0: 目次（§3.3） ----

/** 表示中のプレビューに見出しがあるときだけ［目次▾］を出す。 */
function updateTocButton() {
  const visible = headingList(state.anchors, 1).length > 0;
  $("tocWrap").hidden = !visible;
  if (!visible) {
    $("tocMenu").hidden = true;
    $("tocButton").setAttribute("aria-expanded", "false");
  }
}

/** 目次の項目を作る。反映前の編集があれば先にプレビューを更新する（手動更新では最後の一覧）。 */
function buildTocMenu() {
  if (state.pending && !state.manual) {
    updatePreview();
  }
  const list = headingList(state.anchors);
  const top = Math.min(...list.map((item) => item.level));
  $("tocMenu").replaceChildren(...list.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = item.text;
    button.title = item.text;
    button.style.paddingLeft = `calc(10px + ${item.level - top}em)`;
    button.tocAnchor = item.anchor;
    return button;
  }));
}

/** 見出しへプレビューを移して示し、編集欄のカーソルもその行の先頭へ移す（フォーカスは移さない）。 */
function jumpToHeading(anchor) {
  const element = anchor.element;
  if (!preview.contains(element)) {
    return;
  }
  scroller.scrollTop = topInScroller(element) - TOC_TOP_MARGIN;
  showJumpTarget(element);
  const offset = Math.min(anchor.start, source.value.length);
  source.setSelectionRange(offset, offset);
  if (workspace.classList.contains("source-open")) {
    source.scrollTop = caretTop(source, offset) - source.clientHeight / 3;
  }
  onSelectionChanged();
}

// ---- 1.4.0: プレビューのチェックボックス（§3.4） ----

/** 押したチェックボックスの項目の原文の [ ] と [x] を切り替え、プレビューを更新する。対応しなければ何もしない。 */
function toggleCheckbox(box) {
  if (state.pending) {
    // 反映前の編集があれば対応が古いので、プレビューを更新するだけにする（手動更新では何もしない）
    if (!state.manual) {
      updatePreview();
    }
    return;
  }
  const item = box.closest("li");
  const anchor = item ? state.anchorByElement.get(item) : null;
  // 本文に書いた HTML の input は、項目の中にあっても切り替えない（タスクの記号から作ったものだけ。レビュー R2）
  if (!anchor || anchor.checkbox !== box) {
    return;
  }
  const edit = toggleTaskEdit(source.value, anchor);
  // プレビューの表示（checked 属性）と原文の状態が違えば、古い対応とみなす
  if (!edit || edit.checked !== box.hasAttribute("checked")) {
    return;
  }
  if (workspace.classList.contains("source-open")) {
    const { selectionStart, selectionEnd, scrollTop } = source;
    applySourceEdit({ ...edit, selStart: selectionStart, selEnd: selectionEnd });
    source.scrollTop = scrollTop;
  } else {
    // 編集欄を閉じているとフォーカスを移せず execCommand が使えない（このときは Undo の履歴に積めない）
    source.setRangeText(edit.insert, edit.start, edit.end, "preserve");
    onSourceChanged();
  }
  updatePreview({ force: true });
  const fresh = state.anchors.find((a) => a.type === "list_item" && a.start === anchor.start);
  fresh?.checkbox?.focus({ preventScroll: true });
}
