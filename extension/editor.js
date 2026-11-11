// 作業タブの画面処理。本文・選択・履歴・プレビューはこのタブのメモリだけに置き、どこにも保存しない。
// 保存するのは追加構文の既定値と、書式付きテキストの貼り付けの ON/OFF だけ（settings.js）。
import { createRenderer } from "./core/render.js";
import { toClipboardPayload } from "./core/richcopy.js";
import { formatEdit } from "./core/formatter.js";
import { buildDownloadName, buildMarkdownBlob } from "./core/download.js";
import { FEATURES, GITHUB_PRESET, normalizeFeatures, usesOutsideDefinitions } from "./core/extensions.js";
import { choosePaste } from "./core/htmlpaste.js";
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
  timer: 0,
  toastTimer: 0,
  features: [], // このタブで有効な追加構文
  pasteHtml: false, // 書式付きテキスト（HTML）を Markdown に変換して貼り付けるか（保存した設定。初期値 OFF）
};

localize();
bindSource(source);
bindCommands();
updateEmptyState();
source.focus();

// 追加構文の既定値を読む（読む前に入力があれば、読んだ後に表示し直す）
loadDefaultFeatures().then((features) => {
  state.features = features;
  if (source.value !== "") {
    updatePreview();
  }
});

// 書式付きテキストの貼り付けの設定を読む。別のタブで変えたときも、次の貼り付けから反映する
loadPasteHtml().then((enabled) => {
  state.pasteHtml = enabled;
});
watchPasteHtml((enabled) => {
  state.pasteHtml = enabled;
});

// 戻る・進むのキャッシュから表示し直された場合も、前の内容を残さない
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    resetWorkspace();
  }
});

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
  // 設定が ON で、書式付きテキストを Markdown にできるときだけ、標準の貼り付けの代わりに変換結果を入れる（Undo 1回で戻る）
  el.addEventListener("paste", (event) => {
    const markdown = convertPaste(event.clipboardData);
    if (markdown !== null) {
      event.preventDefault();
      insertText(markdown);
    }
  });
  el.addEventListener("keydown", (event) => {
    if (event.isComposing || state.composing) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
      event.preventDefault();
      applyFormat("bold");
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
  $("syntaxFromBanner").addEventListener("click", openSyntaxDialog);
  $("presetGitHub").addEventListener("click", () => setDialogFeatures(GITHUB_PRESET));
  $("clearFeatures").addEventListener("click", () => setDialogFeatures([]));
  bindMenus();
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
    const link = event.target.closest("a");
    if (!link) {
      return;
    }
    event.preventDefault();
    const href = (link.getAttribute("href") ?? "").trim();
    if (/^(?:https?:|mailto:)/iu.test(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
    } else if (href.startsWith("#") && href.length > 1) {
      // 脚注などのページ内リンクは、プレビューの中だけで移動する（URLは変えない）
      const target = preview.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
      target?.scrollIntoView({ block: "center" });
    }
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
  }, true);

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
  if (!state.pasteHtml || !data) {
    return null;
  }
  const plain = data.getData("text/plain");
  const result = choosePaste({ html: data.getData("text/html"), plain }, { DOMParser: window.DOMParser });
  if (result.kind === "markdown") {
    return result.text;
  }
  if (result.reason === "too-long" && plain !== "") {
    toast(t("pasteTooLong"));
  } else if ((result.reason === "error" || result.reason === "empty") && plain === "") {
    toast(t("pasteFailed"), { error: true });
  }
  return null;
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
    state.pasteHtml = enabled;
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
  source.focus();
  if (edit.start !== edit.end || edit.insert !== "") {
    source.setSelectionRange(edit.start, edit.end);
    insertText(edit.insert);
  }
  source.setSelectionRange(edit.selStart, edit.selEnd);
}

function setSourceVisible(visible) {
  workspace.classList.toggle("source-open", visible);
  toggleSourceButton.setAttribute("aria-pressed", String(visible));
}

function onSourceChanged() {
  updateEmptyState();
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
  const started = performance.now();
  try {
    result = renderer.renderDocument(text, { unwrapFence: state.unwrapFence, features: state.features });
  } catch {
    showStatus(t("renderFailed"), { error: true, refresh: true });
    return;
  }
  const elapsed = performance.now() - started;

  const top = scroller.scrollTop;
  preview.replaceChildren(result.fragment);
  scroller.scrollTop = top;

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

async function copyMarkdown() {
  const text = source.value;
  if (text === "") {
    toast(t("nothingToCopy"));
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(t("copiedMarkdown"));
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
  await writeFormatted(() => renderer.renderDocument(text, { unwrapFence: state.unwrapFence, features: state.features }), t("copiedRich"));
}

async function copySelection() {
  if (!workspace.classList.contains("source-open")) {
    toast(t("selectionNeedsSource"));
    return;
  }
  const start = source.selectionStart;
  const end = source.selectionEnd;
  const text = source.value;
  if (start === end || text.slice(start, end).trim() === "") {
    toast(t("selectionRequired"));
    return;
  }
  const note = usesOutsideDefinitions(text, start, end, state.features) ? t("selectionOutside") : "";
  await writeFormatted(() => renderer.renderSelection(text, start, end, state.features), t("copiedSelection"), note);
}

/** 書式付きの HTML と、描画後の内容に対応するプレーンテキストを同時に書き込む。 */
async function writeFormatted(render, successMessage, extraNote = "") {
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
  toast(notes.length > 0 ? t("messageWithNote", successMessage, notes.join(" ")) : successMessage);
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
  preview.replaceChildren();
  scroller.scrollTop = 0;
  $("fenceBanner").hidden = true;
  $("syntaxBanner").hidden = true;
  hideStatus();
  setSourceVisible(true);
  updateEmptyState();
  source.focus();
}
