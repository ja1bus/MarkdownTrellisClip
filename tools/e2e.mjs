// インストール済みの Google Chrome を一時プロファイル・画面なしで起動し、拡張を読み込んで
// 作業タブの動作を確かめる。利用者の Chrome プロファイルは使わない。
// 注意: 画面なしでも Windows の OS クリップボードを使うので、実行中にクリップボードの内容が上書きされる。
// Windows のクリップボードはテキストの改行を CRLF にするため、読み戻した text/plain は LF に揃えて比べる。
//
// 使い方: node tools/e2e.mjs [--lang ja|en] [--chrome <chrome.exe>] [--screenshots <フォルダー>] [--only <名前の一部>]
//
// Chrome DevTools Protocol の Extensions.loadUnpacked を使う。これは
// --remote-debugging-pipe と --enable-unsafe-extension-debugging を付けて起動した場合だけ使える。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = join(root, "extension");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const lang = option("--lang", "ja");
const chromePath = option("--chrome", findChrome());
const screenshotDir = option("--screenshots", null);
// --only <文字>: 名前にその文字を含む項目だけを行う（開発中の確認用。起動の確認と Console の確認は常に行う）
const onlyFilter = option("--only", null);

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

// ---- CDP（パイプ）クライアント ----
class Cdp {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    let buffer = "";
    child.stdio[4].on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let end;
      while ((end = buffer.indexOf("\0")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        this.dispatch(message);
      }
    });
  }

  dispatch(message) {
    if (message.id && this.pending.has(message.id)) {
      const { resolve: ok, reject, method } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(`${method}: ${message.error.message}`));
      } else {
        ok(message.result);
      }
      return;
    }
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    this.child.stdio[3].write(JSON.stringify(payload) + "\0");
    return new Promise((ok, reject) => this.pending.set(id, { resolve: ok, reject, method }));
  }

  on(listener) {
    this.listeners.push(listener);
  }

  waitFor(predicate, timeout = 10000) {
    return new Promise((ok, reject) => {
      const timer = setTimeout(() => reject(new Error("イベント待ちがタイムアウト")), timeout);
      const listener = (message) => {
        if (predicate(message)) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((l) => l !== listener);
          ok(message);
        }
      };
      this.listeners.push(listener);
    });
  }
}

const lf = (text) => (text ?? "").replace(/\r\n/gu, "\n");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---- 結果の記録 ----
const results = [];
let currentCheck = "起動";
async function check(name, fn) {
  if (onlyFilter && !name.includes(onlyFilter) && !name.startsWith("service worker") && !name.startsWith("Console")) {
    return;
  }
  currentCheck = name;
  try {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("60秒以内に終わらない")), 60000);
    });
    await Promise.race([fn(), timeout]).finally(() => clearTimeout(timer));
    results.push({ name, ok: true });
    console.log(`✔ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`✖ ${name}\n    ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// ---- 起動 ----
if (!chromePath) {
  console.error("Chrome が見つかりません。--chrome で chrome.exe を指定してください。");
  process.exit(2);
}
const profile = mkdtempSync(join(tmpdir(), "mtc-e2e-profile-"));
const downloads = mkdtempSync(join(tmpdir(), "mtc-e2e-downloads-"));
const child = spawn(chromePath, [
  "--headless=new",
  "--remote-debugging-pipe",
  "--enable-unsafe-extension-debugging",
  `--user-data-dir=${profile}`,
  `--lang=${lang}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--window-size=1280,860",
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

const cdp = new Cdp(child);
const consoleProblems = [];
const externalRequests = [];
const dialogs = [];
const beforeUnloads = []; // 本文があるときの離脱確認（beforeunload）。試験では自動で「離れる」を選ぶ

cdp.on((message) => {
  const { method, params } = message;
  if (method === "Runtime.exceptionThrown") {
    consoleProblems.push(`[${currentCheck}] exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
  } else if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "warning")) {
    consoleProblems.push(`[${currentCheck}] console.${params.type}: ${params.args.map((a) => a.value ?? a.description).join(" ")}`);
  } else if (method === "Log.entryAdded" && (params.entry.level === "error" || params.entry.level === "warning")) {
    consoleProblems.push(`[${currentCheck}] log.${params.entry.level}: ${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ""}`);
  } else if (method === "Network.requestWillBeSent") {
    const url = params.request.url;
    if (!/^(?:chrome-extension|data|blob):/u.test(url)) {
      externalRequests.push(url);
    }
  } else if (method === "Page.javascriptDialogOpening") {
    if (params.type === "beforeunload") {
      beforeUnloads.push(message.sessionId);
      cdp.send("Page.handleJavaScriptDialog", { accept: true }, message.sessionId).catch(() => {});
    } else {
      dialogs.push(params.message);
    }
  }
});

let extensionId;
const sessions = [];

async function openEditor() {
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/editor.html` });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  for (const domain of ["Runtime", "Log", "Network", "Page"]) {
    await cdp.send(`${domain}.enable`, {}, sessionId);
  }
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  const page = new PageSession(sessionId, targetId);
  sessions.push(page);
  await page.waitReady();
  return page;
}

class PageSession {
  constructor(sessionId, targetId) {
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params) {
    return cdp.send(method, params, this.sessionId);
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: false });
    if (result.exceptionDetails) {
      throw new Error(`評価に失敗: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  async waitReady() {
    for (let i = 0; i < 100; i++) {
      const ready = await this.eval("document.readyState === 'complete' && !!document.getElementById('source')").catch(() => false);
      if (ready) {
        await sleep(100);
        return;
      }
      await sleep(50);
    }
    throw new Error("作業タブの読み込みが終わらない");
  }

  async click(selector) {
    const box = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
    assert(box && box.w > 0, `${selector} が表示されていない`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(80);
  }

  /** 書式ボタンを押す。メニューの中にある書式は、先にメニューを開く。 */
  async format(name) {
    const menuId = await this.eval(`document.querySelector("[data-format='${name}']")?.closest(".menu")?.id ?? ""`);
    if (menuId) {
      await this.click(`[aria-controls='${menuId}']`);
    }
    await this.click(`[data-format='${name}']`);
  }

  async key(key, { ctrl = false, shift = false } = {}) {
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, PageDown: 34, PageUp: 33, End: 35, Home: 36, Delete: 46 }[key];
    const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers });
    if (key === "Enter") {
      // 実際のキー入力と同じく文字イベントも送る（ボタンの Enter での実行はこれで起きる）
      await this.send("Input.dispatchKeyEvent", { type: "char", key, code, text: "\r", windowsVirtualKeyCode: vk, modifiers });
    }
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(80);
  }

  value() {
    return this.eval("document.getElementById('source').value");
  }

  async setClipboard(plain, html = null) {
    await this.eval(`(async () => {
      const data = { "text/plain": new Blob([${JSON.stringify(plain)}], { type: "text/plain" }) };
      ${html === null ? "" : `data["text/html"] = new Blob([${JSON.stringify(html)}], { type: "text/html" });`}
      await navigator.clipboard.write([new ClipboardItem(data)]);
    })()`);
  }

  async readClipboard() {
    return this.eval(`(async () => {
      const items = await navigator.clipboard.read();
      const out = {};
      for (const item of items) for (const type of item.types) out[type] = await (await item.getType(type)).text();
      return out;
    })()`);
  }

  toast() {
    return this.eval("(() => { const t = document.getElementById('toast'); return t.hidden ? '' : (t.classList.contains('error') ? 'ERROR:' : '') + t.textContent; })()");
  }

  /** 座標へマウスのクリック（count が 2 ならダブルクリック）を送る。 */
  async mouse(x, y, { count = 1, shift = false } = {}) {
    const modifiers = shift ? 8 : 0;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    for (let n = 1; n <= count; n++) {
      await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: n, modifiers });
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: n, modifiers });
    }
    await sleep(80);
  }

  /** 位置の連動の試験の補助（試験表 docs/verification.md の共通の定義）を作業タブに入れる。 */
  async installJumpHelpers() {
    await this.eval(JUMP_HELPERS);
  }

  /** 編集欄の n 行目を、編集欄の高さの割合 r の位置でクリックする。実際の割合 r を返す。 */
  async clickLine(n, r = 0.4, options = {}) {
    const point = await this.eval(`window.__j.pointForLine(${n}, ${r})`);
    await this.mouse(point.x, point.y, options);
    return point;
  }

  /** プレビューの要素（selector と順番）の、上から割合 fy の点をダブルクリックする。押した P での割合 r を返す。 */
  async dblclickPreview(selector, { index = 0, fy = 0.5, fx = null, text = null, at = null } = {}) {
    const point = await this.eval(`window.__j.pointInPreview(${JSON.stringify(selector)}, ${index}, ${fy}, ${fx}, ${JSON.stringify(text)}, ${at})`);
    assert(point, `${selector} がプレビューにない`);
    await this.mouse(point.x, point.y, { count: 2 });
    return point;
  }

  async screenshot(name) {
    if (!screenshotDir) {
      return;
    }
    mkdirSync(screenshotDir, { recursive: true });
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(screenshotDir, `${lang}-${name}.png`), Buffer.from(data, "base64"));
  }
}

const GFM_SAMPLE = [
  "---", "title: 秘密のメタデータ", "---",
  "# 週次報告", "", "今週は**重要な**変更と`npm test`の整備を行いました。~~旧手順~~は廃止。", "",
  "| 項目 | 状態 |", "|:--|:-:|", "| 実装 | 完了 |", "| 試験 | 進行中 |", "",
  "- [x] 設計", "- [ ] 公開", "", "1. 手順1", "2. 手順2", "", "> 引用の文", "",
  "詳細は https://example.com を参照。", "", "```js", "console.log(\"こんにちは\");", "```", "", "---", "", "以上",
].join("\n");

// 位置の連動（試験表 docs/verification.md の D1）。L55 以降は「埋め草1」〜「埋め草40」
const JUMP_D1 = [
  "---", "title: 試験", "---", "# 見出し1", "",
  "段落Aの1行目", "段落Aの**2行目**", "段落Aの3行目", "段落Aの4行目", "",
  "- 項目1", "- 項目2", "  - 入れ子2-1", "  - 入れ子2-2", "- 項目3", "",
  "> 引用の段落1", ">", "> 引用の段落2", "",
  "| 列A | 列B |", "| --- | --- |", "| a1 | b1 |", "| a2 | b2 |", "| a3 | b3 |", "",
  "```js", "const x = 1;", "const y = 2;", "const z = 3;", "```", "",
  "---", "",
  "<details><summary>概要</summary>中身</details>", "",
  "$$", "E = mc^2", "$$", "",
  "::: note", "コンテナの段落", ":::", "",
  "用語", ": 説明", "",
  "> [!NOTE]", "> 注意の本文", "",
  "本文の脚注[^1]と[リンク](https://example.com)", "",
  "[^1]: 注の本文",
  ...Array.from({ length: 40 }, (_, i) => ["", `埋め草${i + 1}`]).flat(),
].join("\n");

// 作業タブに入れる補助。E は編集欄、P はプレビューの表示領域
const JUMP_HELPERS = `window.__j = {
  E: () => document.getElementById("source"),
  P: () => document.getElementById("previewScroller"),
  lh() { return parseFloat(getComputedStyle(this.E()).lineHeight); },
  lineStart(n) { const lines = this.E().value.split("\\n"); return n <= 1 ? 0 : lines.slice(0, n - 1).join("\\n").length + 1; },
  lineOf(offset) { return this.E().value.slice(0, offset).split("\\n").length; },
  // 折り返さない行の、E の内容の中での上端
  lineTop(n) { const e = this.E(); return parseFloat(getComputedStyle(e).paddingTop) + (n - 1) * this.lh(); },
  pointForLine(n, r) {
    const e = this.E();
    const lh = this.lh();
    e.scrollTop = this.lineTop(n) + lh / 2 - r * e.clientHeight;
    const rect = e.getBoundingClientRect();
    const y = rect.top + this.lineTop(n) - e.scrollTop + lh / 2;
    return { x: rect.left + 20, y, r: (y - rect.top) / e.clientHeight };
  },
  // 折り返す行のための測り方（試験表 T-29）: E と同じ幅・字形・余白・折り返しの非表示の div に、offset の前までを入れた高さ
  wrappedTop(offset) {
    const e = this.E();
    const cs = getComputedStyle(e);
    const div = document.createElement("div");
    for (const name of ["font", "padding", "lineHeight", "letterSpacing", "whiteSpace", "wordBreak", "overflowWrap", "tabSize"]) div.style[name] = cs[name];
    Object.assign(div.style, { position: "absolute", visibility: "hidden", left: "-9999px", top: "0", width: e.clientWidth + "px", boxSizing: "border-box" });
    div.textContent = e.value.slice(0, offset);
    const span = document.createElement("span");
    span.textContent = "x";
    div.append(span);
    document.body.append(div);
    const top = span.offsetTop;
    div.remove();
    return top;
  },
  pointForOffset(offset, r) {
    const e = this.E();
    const lh = this.lh();
    const top = this.wrappedTop(offset);
    e.scrollTop = top + lh / 2 - r * e.clientHeight;
    const rect = e.getBoundingClientRect();
    const y = rect.top + top - e.scrollTop + lh / 2;
    return { x: rect.left + 20, y, r: (y - rect.top) / e.clientHeight };
  },
  pointInPreview(selector, index, fy, fx, text = null, at = null) {
    let list = [...document.querySelectorAll("#preview " + selector)];
    if (text !== null) list = list.filter((el) => el.textContent.trim().startsWith(text));
    const el = list[index];
    if (!el) return null;
    const p = this.P();
    if (at === null) {
      el.scrollIntoView({ block: "center" });
    } else {
      const rect0 = el.getBoundingClientRect();
      p.scrollTop += rect0.top + rect0.height * fy - p.getBoundingClientRect().top - at * p.clientHeight;
    }
    const rect = el.getBoundingClientRect();
    const y = rect.top + rect.height * fy;
    return { x: fx === null ? rect.left + Math.min(20, rect.width / 2) : rect.left + rect.width * fx, y, r: (y - p.getBoundingClientRect().top) / p.clientHeight };
  },
  shown() {
    return [...document.querySelectorAll("#preview .jump-target")].map((el) => ({ tag: el.nodeName, text: el.textContent.trim().slice(0, 30) }));
  },
  // 示した要素の点（上端から frac の高さ）が、P の上端から r の高さにあるか（端でスクロールが止まる場合は許す）
  placed(r, frac = 0) {
    const el = document.querySelector("#preview .jump-target");
    if (!el) return { ok: false, why: "示していない" };
    const p = this.P();
    const rect = el.getBoundingClientRect();
    const y = rect.top + rect.height * frac - p.getBoundingClientRect().top;
    const tolerance = Math.max(24, parseFloat(getComputedStyle(document.querySelector("#preview p") ?? el).lineHeight) || 24);
    const atEdge = p.scrollTop <= 0 || p.scrollTop >= p.scrollHeight - p.clientHeight - 1;
    const ok = Math.abs(y - r * p.clientHeight) <= tolerance || atEdge;
    return { ok, y, want: r * p.clientHeight, scrollTop: p.scrollTop, atEdge };
  },
  // カーソルの行（折り返さない文書）が E の上端から r の高さにあるか
  caretPlaced(n, r) {
    const e = this.E();
    const y = this.lineTop(n) - e.scrollTop;
    const atEdge = e.scrollTop <= 0 || e.scrollTop >= e.scrollHeight - e.clientHeight - 1;
    return { ok: Math.abs(y - r * e.clientHeight) <= this.lh() || atEdge, y, want: r * e.clientHeight, atEdge };
  },
  state() {
    const e = this.E();
    return { start: e.selectionStart, end: e.selectionEnd, line: this.lineOf(e.selectionStart), focus: document.activeElement?.id ?? "", scrollTop: e.scrollTop, value: e.value };
  },
};`;

try {
  await sleep(300);
  const loaded = await cdp.send("Extensions.loadUnpacked", { path: resolve(extensionDir) });
  extensionId = loaded.id;
  await cdp.send("Browser.grantPermissions", {
    origin: `chrome-extension://${extensionId}`,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  const { product } = await cdp.send("Browser.getVersion");
  console.log(`Chrome: ${product} / 拡張ID: ${extensionId} / 言語: ${lang}`);

  await check("service worker が登録され、拡張の読み込みでエラーがない", async () => {
    let worker = null;
    for (let i = 0; i < 40 && !worker; i++) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      worker = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(extensionId));
      if (!worker) {
        await sleep(100);
      }
    }
    assert(worker, "service worker が見つからない");
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, sessionId);
    const r = await cdp.send("Runtime.evaluate", { expression: "chrome.action.onClicked.hasListeners() && typeof chrome.tabs.create === 'function'", returnByValue: true }, sessionId);
    assert(r.result.value === true, "アイコンのクリックの受け口が登録されていない");
  });

  const page = await openEditor();

  await check("空の状態: 原文の貼り付け欄が開き、案内とプライバシー表示がある", async () => {
    const s = await page.eval(`({
      empty: document.getElementById('workspace').classList.contains('is-empty'),
      open: document.getElementById('workspace').classList.contains('source-open'),
      focused: document.activeElement === document.getElementById('source'),
      placeholder: document.getElementById('source').placeholder,
      hint: getComputedStyle(document.getElementById('emptyHint')).display,
      privacy: document.querySelector('.privacy [data-i18n=notSaved]').textContent,
      lang: document.documentElement.lang,
      title: document.querySelector('#copyRich .label-long').textContent,
      toggle: document.getElementById('toggleSource').textContent,
      pasteStatus: document.getElementById('pasteStatus').textContent,
      selectionDisabled: document.getElementById('copySelection').disabled,
      emptyTitle: document.querySelector('#emptyHint .empty-title').textContent,
    })`);
    assert(s.empty && s.open && s.focused, `状態: ${JSON.stringify(s)}`);
    assert(s.hint !== "none", "空のときの案内が見えない");
    assert(s.lang === lang, `lang=${s.lang}`);
    assert(s.selectionDisabled, "未選択なのに選択範囲のコピーが押せる");
    assert(lang === "ja"
      ? s.privacy === "本文は自動保存されません" && s.title === "書式付きでコピー" && s.toggle === "プレビューを広げる" && s.pasteStatus === "書式の取り込み：オフ" && s.emptyTitle === "プレビュー"
      : s.privacy === "Text is not saved automatically" && s.title === "Copy Formatted" && s.toggle === "Expand Preview" && s.pasteStatus === "Formatted paste: Off" && s.emptyTitle === "Preview", `表示: ${JSON.stringify(s)}`);
    await page.screenshot("01-empty");
  });

  await check("Ctrl+V: text/plain だけを取り込み、原文を開いたままプレビューを表示する", async () => {
    await page.setClipboard(GFM_SAMPLE, "<h1 style='color:red'>HTML側の内容</h1><script>window.__bad=1</script>");
    await page.key("v", { ctrl: true });
    await sleep(600);
    const s = await page.eval(`({
      value: document.getElementById('source').value,
      open: document.getElementById('workspace').classList.contains('source-open'),
      html: document.getElementById('preview').innerHTML,
    })`);
    assert(s.value === GFM_SAMPLE, "原文が貼り付けた text/plain と一致しない");
    assert(s.open, "貼り付け後に原文が閉じた");
    assert(!s.html.includes("HTML側の内容"), "text/html を取り込んでいる");
    for (const part of ["<h1>週次報告</h1>", "<strong>重要な</strong>", "<del>旧手順</del>", "<table>", "align=\"center\"", "type=\"checkbox\"", "<ol>", "<blockquote>", "href=\"https://example.com\"", "language-js", "<hr>"]) {
      assert(s.html.includes(part), `プレビューに ${part} がない`);
    }
    assert(!s.html.includes("秘密のメタデータ"), "Frontmatter がプレビューに出ている");
    // Chrome は拡張ページの body に Meiryo を当てる。Meiryo では日本語の斜体が傾かないので、指定したフォントになっていること
    const bodyFont = await page.eval("getComputedStyle(document.body).fontFamily");
    assert(bodyFont.startsWith("\"Segoe UI\", \"Yu Gothic UI\""), `本文のフォント: ${bodyFont}`);
    assert(await page.eval("document.getElementById('previewStatus').hidden"), "生HTMLのない文書で除外・画像の案内が出ている");
    await page.screenshot("02-preview");
  });

  await check("原文の外で Ctrl+V: 原文を開き、カーソル位置に挿入して Undo で戻せる", async () => {
    const before = await page.value();
    await page.eval("document.getElementById('source').setSelectionRange(0, 0); document.getElementById('previewScroller').focus()");
    await page.setClipboard("追記\n");
    await page.key("v", { ctrl: true });
    await sleep(100);
    const s = await page.eval("({ value: document.getElementById('source').value, open: document.getElementById('workspace').classList.contains('source-open') })");
    assert(s.open, "原文が開いていない");
    assert(s.value === "追記\n" + before, "カーソル位置に挿入されていない");
    await page.key("z", { ctrl: true });
    assert(await page.value() === before, "Undo で戻らない");
  });

  await check("書式ボタン: 選択を保ち、1回の Undo で戻り、Redo でやり直せる", async () => {
    await page.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(0, s.value.length); document.execCommand('insertText', false, 'これは重要です\\n二行目'); })()");
    await page.eval("(() => { const s = document.getElementById('source'); s.setSelectionRange(2, 4); })()");
    await page.format("bold");
    let s = await page.eval("(() => { const e = document.getElementById('source'); return { v: e.value, sel: e.value.slice(e.selectionStart, e.selectionEnd), focus: document.activeElement === e }; })()");
    assert(s.v === "これ**は重**要です\n二行目" && s.sel === "は重" && s.focus, `太字: ${JSON.stringify(s)}`);
    await page.format("h2");
    s = await page.eval("document.getElementById('source').value");
    assert(s === "## これ**は重**要です\n二行目", `見出し: ${s}`);
    await page.key("z", { ctrl: true });
    assert(await page.value() === "これ**は重**要です\n二行目", "見出しの Undo が1回で戻らない");
    await page.key("z", { ctrl: true });
    assert(await page.value() === "これは重要です\n二行目", "太字の Undo が1回で戻らない");
    await page.key("y", { ctrl: true });
    assert(await page.value() === "これ**は重**要です\n二行目", "Redo で戻らない");
    for (const format of ["h1", "h3", "bullet", "ordered", "task", "link", "table", "code", "codeblock", "italic", "strike", "quote", "image", "hr"]) {
      await page.eval("(() => { const s = document.getElementById('source'); s.setSelectionRange(0, 2); })()");
      const before = await page.value();
      await page.format(format);
      const after = await page.value();
      assert(after !== before, `${format} で変化しない`);
      await page.key("z", { ctrl: true });
      assert(await page.value() === before, `${format} の Undo が1回で戻らない`);
    }
  });

  await check("IME: 変換中はプレビューを更新せず、確定後に更新する", async () => {
    await page.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); })()");
    await sleep(500);
    const before = await page.eval("document.getElementById('preview').textContent");
    await page.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
    await sleep(700);
    const during = await page.eval("({ preview: document.getElementById('preview').textContent, value: document.getElementById('source').value })");
    assert(during.preview === before, "変換中にプレビューが更新された");
    assert(during.value.endsWith("にほんご"), "変換中の文字が入力欄にない");
    await page.send("Input.insertText", { text: "日本語" });
    await sleep(700);
    const after = await page.eval("({ preview: document.getElementById('preview').textContent, value: document.getElementById('source').value })");
    assert(after.value.endsWith("二行目日本語"), `確定後の原文: ${after.value}`);
    assert(after.preview.includes("二行目日本語"), "確定後にプレビューが更新されない");
  });

  await check("Markdownをコピー: Frontmatter と全文フェンスを含む原文をそのままコピーする", async () => {
    const text = "---\na: 1\n---\n```markdown\n# 中身\n```";
    await page.eval(`(() => { const s = document.getElementById('source'); s.focus(); s.select(); document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`);
    await sleep(500);
    await page.click("#copyMarkdown");
    await sleep(200);
    const clip = await page.readClipboard();
    assert(lf(clip["text/plain"]) === text, `コピーした内容が原文と一致しない: ${JSON.stringify(clip)} / 原文 ${JSON.stringify(await page.value())}`);
    assert(!("text/html" in clip), "text/html も書き込まれている");
    assert(!(await page.toast()).startsWith("ERROR"), "失敗の通知が出た");
    const done = await page.eval("({ copied: document.getElementById('copyMarkdown').classList.contains('copied'), mark: document.getElementById('copyMarkdown').dataset.done, announce: document.getElementById('announce').textContent })");
    assert(done.copied && done.mark === (lang === "ja" ? "✓ コピーしました" : "✓ Copied") && done.announce === (lang === "ja" ? "Markdownをコピーしました" : "Markdown copied"), `コピーした表示: ${JSON.stringify(done)}`);
    await sleep(1800);
    assert(!(await page.eval("document.getElementById('copyMarkdown').classList.contains('copied')")), "コピーした表示が元に戻らない");
  });

  await check("全文フェンス: 検出を表示し、プレビューと書式付きコピーだけ外側を除外する", async () => {
    const banner = await page.eval("!document.getElementById('fenceBanner').hidden");
    assert(banner, "全文フェンスの案内が出ない");
    await page.click("#copyRich");
    await sleep(200);
    let clip = await page.readClipboard();
    assert(clip["text/html"].includes("<pre"), "除外前の書式付きコピーがコードになっていない");
    await page.click("#toggleFence");
    await sleep(200);
    const html = await page.eval("document.getElementById('preview').innerHTML");
    assert(html.includes("<h1>中身</h1>"), "プレビューで外側が除外されていない");
    await page.click("#copyRich");
    await sleep(200);
    clip = await page.readClipboard();
    assert(clip["text/html"].includes("<h1>中身</h1>") && clip["text/plain"] === "中身", `書式付きコピー: ${JSON.stringify(clip)}`);
    assert(!clip["text/html"].includes("a: 1"), "Frontmatter が書式付きコピーに入っている");
    assert(await page.value() === "---\na: 1\n---\n```markdown\n# 中身\n```", "原文が変わった");
    await page.click("#copyMarkdown");
    await sleep(200);
    clip = await page.readClipboard();
    assert(lf(clip["text/plain"]).startsWith("---\na: 1"), "Markdownコピーに除外が反映されている");
    await page.screenshot("03-fence");
  });

  await check("書式付きコピー: インラインCSS・☑☐・details展開・画像の代替テキスト・描画後のテキスト", async () => {
    const text = "| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] 済み\n- [ ] 未了\n\n<details><summary>詳細</summary>\n\n中身\n\n</details>\n\n![図](https://example.com/a.png)";
    await page.eval(`(() => { const s = document.getElementById('source'); s.focus(); s.select(); document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`);
    await sleep(500);
    await page.click("#copyRich");
    await sleep(200);
    const clip = await page.readClipboard();
    const html = clip["text/html"];
    assert(/<table style="border-collapse:collapse;">/u.test(html) && /<td style="border:1px solid #999;/u.test(html), "表のインラインCSSがない");
    assert(html.includes("☑ 済み") && html.includes("☐ 未了") && !html.includes("<input"), "チェックボックスが文字になっていない");
    assert(html.includes("<p><strong>詳細</strong></p>") && html.includes("中身") && !html.includes("<details"), "details が展開されていない");
    assert(!html.includes("<img") && !html.includes("example.com/a.png"), "画像が残っている");
    assert(clip["text/plain"].includes("A\tB") && clip["text/plain"].includes("- ☑ 済み") && clip["text/plain"].endsWith("図"), `text/plain: ${clip["text/plain"]}`);
    const toast = await page.toast();
    assert(/1/u.test(toast) && !toast.startsWith("ERROR"), `画像の通知がない: ${toast}`);
    assert(await page.value() === text, "原文が変わった");
  });

  await check("選択範囲を書式付きコピー: 未選択では押せずクリップボードを変えず、選択は断片として変換する", async () => {
    await page.setClipboard("SENTINEL");
    await page.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(3, 3); })()");
    await sleep(100);
    assert(await page.eval("document.getElementById('copySelection').disabled"), "未選択なのに押せる");
    await page.click("#copySelection");
    await sleep(200);
    let clip = await page.readClipboard();
    assert(clip["text/plain"] === "SENTINEL", "未選択なのにクリップボードが変わった");
    const text = "```markdown\n# 題\n本文 **強調** [参照][r]\n```\n\n[r]: https://example.com";
    await page.eval(`(() => { const s = document.getElementById('source'); s.select(); document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`);
    const start = text.indexOf("本文");
    const end = text.indexOf("\n```");
    await page.eval(`document.getElementById('source').setSelectionRange(${start}, ${end})`);
    await sleep(100);
    assert(!(await page.eval("document.getElementById('copySelection').disabled")), "選択しても押せない");
    await page.click("#copySelection");
    await sleep(200);
    clip = await page.readClipboard();
    assert(clip["text/html"].includes("<strong>強調</strong>") && !clip["text/html"].includes("<a "), `選択の変換: ${clip["text/html"]}`);
    const sel = await page.eval("[document.getElementById('source').selectionStart, document.getElementById('source').selectionEnd]");
    assert(sel[0] === start && sel[1] === end, "選択範囲が変わった");
    assert(await page.value() === text, "原文が変わった");
  });

  await check("書式付きコピー: 変換後に何も残らなければ（Frontmatter だけ）クリップボードを変えず案内する", async () => {
    await page.setClipboard("SENTINEL2");
    await page.eval("(() => { const s = document.getElementById('source'); s.focus(); s.select(); document.execCommand('insertText', false, '---\\ntitle: hi\\n---'); })()");
    await sleep(400);
    await page.click("#copyRich");
    await sleep(200);
    const clip = await page.readClipboard();
    assert(lf(clip["text/plain"]) === "SENTINEL2" && !("text/html" in clip), `クリップボードが変わった: ${JSON.stringify(clip)}`);
    const toast = await page.toast();
    assert(toast.length > 0 && !toast.startsWith("ERROR"), `案内: ${toast}`);
    // 次の確認のため、コピーできる内容に戻す
    await page.eval("(() => { const s = document.getElementById('source'); s.select(); document.execCommand('insertText', false, '# 本文あり'); })()");
    await sleep(400);
  });

  await check("コピー失敗: 失敗を通知し、本文を失わない", async () => {
    const before = await page.value();
    await page.eval("navigator.clipboard.write = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));");
    await page.click("#copyRich");
    await sleep(200);
    let toast = await page.toast();
    assert(toast.startsWith("ERROR:"), `書式付きコピーの失敗が通知されない: ${toast}`);
    await page.click("#copyMarkdown");
    await sleep(200);
    toast = await page.toast();
    assert(toast.startsWith("ERROR:"), `Markdownコピーの失敗が通知されない: ${toast}`);
    assert(await page.value() === before, "本文が変わった");
  });

  // 失敗を試した後は、作業タブを開き直す
  const page2 = await openEditor();

  await check("画像・危険なHTML: 通信・スクリプト実行・ダイアログが起きない", async () => {
    externalRequests.length = 0;
    const text = [
      "![外部](https://example.com/track.png)", "<img src=\"https://example.com/x.png\" onerror=\"window.__pwned=1\">",
      "<img src=\"file:///C:/Windows/win.ini\">", "<script>window.__pwned=2</script>", "<iframe src=\"https://example.com\"></iframe>",
      "<a href=\"javascript:window.__pwned=3\">j</a>", "<p style=\"background:url(https://example.com/bg.png)\">s</p>",
      "<link rel=\"stylesheet\" href=\"https://example.com/a.css\">", "<svg><image href=\"https://example.com/s.png\"/></svg>",
      "<details open ontoggle=\"window.__pwned=4\"><summary>x</summary>y</details>",
    ].join("\n\n");
    await page2.eval(`(() => { const s = document.getElementById('source'); s.focus(); document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`);
    await sleep(800);
    await page2.eval("window.open = (...args) => { window.__opened = args; return null; }");
    await page2.eval("(() => { const a = [...document.querySelectorAll('#preview a')].find((x) => x.textContent === 'j'); a && a.click(); })()");
    await sleep(500);
    const s = await page2.eval("({ pwned: window.__pwned, opened: window.__opened, html: document.getElementById('preview').innerHTML, status: document.getElementById('previewStatusText').textContent })");
    assert(s.pwned === undefined, `スクリプトが実行された: ${s.pwned}`);
    assert(s.opened === undefined, "javascript: リンクが開かれた");
    assert(!/<img|<script|<iframe|onerror|ontoggle|javascript:|style=|<svg|<link/iu.test(s.html), `危険な要素が残っている: ${s.html}`);
    assert(externalRequests.length === 0, `外部への通信: ${externalRequests.join(", ")}`);
    // 多重の防御: 万一 img が作られても、拡張ページの CSP が外部画像を拒否することを確かめる
    const probe = cdp.waitFor((m) => m.method === "Network.loadingFailed" && m.sessionId === page2.sessionId, 5000);
    await page2.eval("(() => { const img = new Image(); img.src = 'https://example.com/csp-probe.png'; document.body.append(img); })()");
    const failed = await probe;
    assert(failed.params.blockedReason === "csp", `CSP で拒否されていない: ${JSON.stringify(failed.params)}`);
    externalRequests.length = 0;
    assert(dialogs.length === 0, "ダイアログが開いた");
    assert(s.status.length > 0, "除外・画像の通知が出ない");
    // CSP で拒否した試行（csp-probe）は Console のエラーになるので、記録から除く
    for (let i = consoleProblems.length - 1; i >= 0; i--) {
      if (consoleProblems[i].includes("csp-probe")) {
        consoleProblems.splice(i, 1);
      }
    }
    await page2.screenshot("04-unsafe");
  });

  await check("リンク: クリックしたときだけ新しいタブで開く（http・https・mailto）", async () => {
    await page2.eval("(() => { const s = document.getElementById('source'); s.focus(); s.select(); document.execCommand('insertText', false, '[サイト](https://example.com/page) [相対](other.md)'); })()");
    await sleep(600);
    await page2.eval("window.__opened = undefined");
    await page2.click("#preview a[href]");
    let opened = await page2.eval("window.__opened");
    assert(opened && opened[0] === "https://example.com/page" && opened[1] === "_blank" && opened[2].includes("noopener"), `開き方: ${JSON.stringify(opened)}`);
    await page2.eval("window.__opened = undefined; [...document.querySelectorAll('#preview a')].find((a) => a.textContent === '相対').click()");
    opened = await page2.eval("window.__opened");
    assert(opened === undefined, "相対リンクが開かれた");
  });

  await check("ダウンロード: UTF-8 の .md が原文と一致し、ファイル名に本文を使わない", async () => {
    const text = "---\ntitle: 機密の題名\n---\n# 日本語の見出し 🌸\n\n本文\r\n";
    await page2.eval(`(() => { const s = document.getElementById('source'); s.focus(); s.select(); document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`);
    const value = await page2.value();
    // 完了の待ち受けもクリックの前に登録する（小さなファイルは開始の直後に完了し、後から待つと取りこぼすため。1.4.0 で修正）
    const begin = cdp.waitFor((m) => m.method === "Browser.downloadWillBegin");
    const completed = cdp.waitFor((m) => m.method === "Browser.downloadProgress" && m.params.state === "completed", 10000);
    completed.catch(() => {}); // 開始の待ちで失敗したときに、未処理の拒否にしない（下の await では失敗として扱う）
    await page2.click("#download");
    const { params } = await begin;
    await completed;
    assert(/^markdown-trellis-clip-\d{8}-\d{6}\.md$/u.test(params.suggestedFilename), `ファイル名: ${params.suggestedFilename}`);
    const files = readdirSync(downloads);
    const file = files.find((f) => f === params.suggestedFilename) ?? files.find((f) => !f.endsWith(".crdownload"));
    const saved = readFileSync(join(downloads, file));
    assert(saved.equals(Buffer.from(value, "utf8")), "保存した内容が原文と一致しない");
    assert(saved[0] !== 0xef, "BOM が付いている");
  });

  await check("クリア: 原文・プレビュー・Undo履歴を消し、Undo で戻らない", async () => {
    await page2.eval("(() => { const s = document.getElementById('source'); s.focus(); s.select(); document.execCommand('insertText', false, '消える本文'); document.execCommand('insertText', false, '、追記'); })()");
    await sleep(500);
    await page2.click("#clear");
    await sleep(150);
    const open = await page2.eval("document.getElementById('clearDialog').open");
    assert(open, "確認が出ない");
    await page2.click("#clearDialog button[value='clear']");
    await sleep(200);
    let s = await page2.eval("({ value: document.getElementById('source').value, preview: document.getElementById('preview').childNodes.length, focus: document.activeElement.id })");
    assert(s.value === "" && s.preview === 0, `消去後: ${JSON.stringify(s)}`);
    await page2.key("z", { ctrl: true });
    await page2.key("z", { ctrl: true });
    await page2.eval("document.execCommand('undo'); document.execCommand('undo');");
    s = await page2.eval("document.getElementById('source').value");
    assert(s === "", `Undo で本文が戻った: ${s}`);
    await page2.screenshot("05-cleared");
  });

  await check("再読み込み・タブを閉じた後に本文が復元されない（本文があれば離脱の確認を出す）", async () => {
    await page2.eval("(() => { const s = document.getElementById('source'); s.focus(); document.execCommand('insertText', false, '再読み込みで消える本文'); })()");
    const asked = beforeUnloads.length;
    await page2.send("Page.reload", {});
    await sleep(300);
    await page2.waitReady();
    await sleep(300);
    assert(await page2.value() === "", "再読み込み後に本文が残っている");
    assert(beforeUnloads.length === asked + 1, `本文があるのに離脱の確認が出ない（${beforeUnloads.length - asked} 回）`);
    // 本文が空なら確認を出さない（確認は操作の後だけ出るので、操作してから試す）
    await page2.click("#source");
    const asked2 = beforeUnloads.length;
    await page2.send("Page.reload", {});
    await sleep(300);
    await page2.waitReady();
    assert(beforeUnloads.length === asked2, "本文が空なのに離脱の確認が出た");
    // 実際の入力と同じく操作してから入れる（操作のないページでは Chrome が確認を出さず、エラーを記録する）
    await page2.click("#source");
    await page2.eval("(() => { const s = document.getElementById('source'); s.focus(); document.execCommand('insertText', false, '閉じると消える本文'); })()");
    await page2.send("Page.navigate", { url: "about:blank" });
    await sleep(300);
    await page2.send("Page.navigate", { url: `chrome-extension://${extensionId}/editor.html` });
    await sleep(300);
    await page2.waitReady();
    assert(await page2.value() === "", "移動して戻った後に本文が残っている");
    const pageReopened = await openEditor();
    assert(await pageReopened.value() === "", "新しいタブに本文が出た");
    const storage = await pageReopened.eval("(async () => ({ local: localStorage.length, session: sessionStorage.length, ext: await chrome.storage.local.get(null), sync: Object.keys(await chrome.storage.sync.get(null)).length, idb: (await indexedDB.databases()).length }))()").catch((error) => ({ error: error.message }));
    // 拡張の保存領域にあってよいのは、追加構文の既定値（defaultFeatures）と書式付きテキストの貼り付けの ON/OFF（pasteHtml）だけ
    const extKeys = Object.keys(storage.ext ?? {});
    assert(!storage.error && storage.local === 0 && storage.session === 0 && storage.sync === 0 && storage.idb === 0 && extKeys.every((key) => key === "defaultFeatures" || key === "pasteHtml"), `保存領域: ${JSON.stringify(storage)}`);
    assert(!JSON.stringify(storage.ext).includes("本文"), "本文が保存されている");
  });

  await check("追加構文: 検出を案内し、GitHub互換で有効にすると表示と書式付きコピーに反映、既定値の保存は部品名だけ", async () => {
    const p = await openEditor();
    const text = "> [!WARNING]\n> 注意する点\n\n本文[^1]と==強調==\n\n[^1]: 注の本文\n\n::: tip\n枠の中\n:::\n\n用語\n: 説明";
    await p.setClipboard(text);
    await p.key("v", { ctrl: true });
    await sleep(700);
    let s = await p.eval("({ banner: !document.getElementById('syntaxBanner').hidden, message: document.getElementById('syntaxMessage').textContent, html: document.getElementById('preview').innerHTML })");
    assert(s.banner && /2/u.test(s.message), `検出の案内: ${JSON.stringify(s.message)}`);
    assert(!s.html.includes("markdown-alert"), "有効にする前にアラートになっている");
    // ⚙ メニューから追加構文を開き、GitHub互換 → 既定値として保存 → OK
    await p.click("#settingsMenuButton");
    await p.click("#openSyntax");
    await sleep(100);
    assert(await p.eval("document.getElementById('syntaxDialog').open"), "追加構文の画面が開かない");
    assert(await p.eval("!document.getElementById('saveDefault').checked"), "既定値の保存が最初からチェックされている");
    const mathLabel = await p.eval("document.querySelector('[data-i18n=featureMathHelp]').textContent");
    const mathTitle = await p.eval("document.querySelector('[data-i18n=featureMath]').textContent");
    assert(mathLabel.includes("$x^2$ ") && mathLabel.includes(" $$…$$ ") && mathTitle.includes(" $$"), `数式の説明の $ が崩れている: ${mathTitle} / ${mathLabel}`);
    await p.click("#presetGitHub");
    await p.screenshot("10-syntax-dialog");
    await p.click("#saveDefault");
    await p.click("#syntaxDialog button[value='ok']");
    await sleep(400);
    s = await p.eval("({ html: document.getElementById('preview').innerHTML, message: document.getElementById('syntaxMessage').textContent, value: document.getElementById('source').value })");
    assert(s.html.includes("markdown-alert-warning") && s.html.includes("footnote-ref") && s.html.includes("class=\"footnotes\""), `表示に反映されない: ${s.html.slice(0, 300)}`);
    assert(!s.html.includes("<mark>"), "有効にしていないハイライトが解釈された");
    assert(s.value === text, "原文が変わった");
    const stored = await p.eval("chrome.storage.local.get(null)");
    assert(JSON.stringify(stored) === JSON.stringify({ defaultFeatures: ["alerts", "footnotes"] }), `保存内容: ${JSON.stringify(stored)}`);
    await p.screenshot("09-syntax");
    // 脚注の番号をクリックすると、プレビューの中で注へ移動する（URLは変わらない）
    await p.click("#preview .footnote-ref a");
    assert(await p.eval("location.hash === ''"), "URL が変わった");
    // 書式付きコピー
    await p.click("#copyRich");
    await sleep(200);
    const clip = await p.readClipboard();
    assert(/border-left:4px solid #9a6700/u.test(clip["text/html"]) && clip["text/html"].includes("<sup>1</sup>") && !clip["text/html"].includes("↩"), `書式付きコピー: ${clip["text/html"].slice(0, 300)}`);
    // 新しいタブは保存した既定値で始まる。キャンセルでは変わらない
    const q = await openEditor();
    await sleep(200);
    await q.eval(`(() => { const s = document.getElementById('source'); s.focus(); document.execCommand('insertText', false, ${JSON.stringify("> [!NOTE]\n> 新しいタブ")}); })()`);
    await sleep(600);
    assert((await q.eval("document.getElementById('preview').innerHTML")).includes("markdown-alert-note"), "保存した既定値で始まらない");
    await q.click("#settingsMenuButton");
    await q.click("#openSyntax");
    await q.click("#clearFeatures");
    await q.click("#syntaxDialog button[value='cancel']");
    await sleep(300);
    assert((await q.eval("document.getElementById('preview').innerHTML")).includes("markdown-alert-note"), "キャンセルで変わった");
    // 後の確認のため、既定値を空に戻す
    await q.eval("chrome.storage.local.clear()");
  });

  await check("書式付きテキストの貼り付け: 初期値OFF、ONでHTMLをMarkdownに変換、書式なし・Markdownの原文はそのまま、Undo/Redo、既存の設定を残す", async () => {
    const p = await openEditor();
    const val = () => p.value();
    const clear = () => p.eval("(() => { const s = document.getElementById('source'); s.focus(); s.select(); document.execCommand('delete'); })()");
    const pasteWith = async (plain, html) => {
      await p.setClipboard(plain, html);
      await p.eval("document.getElementById('source').focus()");
      await p.key("v", { ctrl: true });
      await sleep(500);
    };
    // Microsoft 365 Copilot の回答をまねた HTML（h2・strong・CSS 付きの4列の表・ul・a・br）。text/plain は書式なし
    const copilotHtml = "<div style=\"font-family: 'Segoe UI'\"><h2 style=\"font-weight: 600\">導入の手順</h2>"
      + "<p>次の<strong>3つ</strong>を確認します。<br>詳しくは<a href=\"https://example.com/learn\">Learn</a>へ。</p>"
      + "<table style=\"border-collapse: collapse\"><thead><tr><th style=\"border: 1px solid #ccc\">項目</th><th>内容（Description）</th><th>担当</th><th>参考</th></tr></thead>"
      + "<tbody><tr><td><strong>準備</strong></td><td>1行目<br>2行目</td><td>A|B</td><td><a href=\"https://example.com/doc\">手順書</a></td></tr></tbody></table>"
      + "<ul><li>Teams</li><li><span style=\"font-weight: bold\">Outlook</span></li></ul></div>";
    const copilotPlain = "導入の手順\n次の3つを確認します。\n項目\t内容（Description）\t担当\t参考\n準備\t1行目 2行目\tA|B\t手順書\nTeams\nOutlook";
    const expected = [
      "## 導入の手順", "", "次の**3つ**を確認します。  ", "詳しくは[Learn](https://example.com/learn)へ。", "",
      "| 項目 | 内容（Description） | 担当 | 参考 |", "| --- | --- | --- | --- |", "| **準備** | 1行目<br>2行目 | A\\|B | [手順書](https://example.com/doc) |", "",
      "- Teams", "- **Outlook**",
    ].join("\n");

    // 既存の設定（追加構文の既定値）を入れておき、貼り付けの設定を保存しても残ること
    await p.eval("chrome.storage.local.set({ defaultFeatures: ['alerts'] })");

    // 初期値は OFF: HTML があっても text/plain を貼る
    await pasteWith(copilotPlain, copilotHtml);
    assert(await val() === copilotPlain, `OFF で text/plain にならない: ${await val()}`);
    // OFF で書式付きテキストを貼ると、取り込めることを案内する。閉じるとこのタブでは出さない
    assert(!(await p.eval("document.getElementById('pasteHint').hidden")), "OFF で書式付きテキストを貼っても案内が出ない");
    await p.screenshot("14-paste-hint");
    await p.click("#closePasteHint");
    await clear();
    await pasteWith(copilotPlain, copilotHtml);
    assert(await p.eval("document.getElementById('pasteHint').hidden"), "閉じた案内がまた出た");
    // 書式の取り込みの表示から設定を開ける
    await p.click("#pasteStatus");
    await sleep(100);
    assert(await p.eval("document.getElementById('pasteDialog').open"), "書式の取り込みの表示から設定が開かない");
    await p.click("#pasteDialog button[value='cancel']");
    await sleep(100);
    await p.click("#settingsMenuButton");
    await p.click("#openPaste");
    await sleep(100);
    let s = await p.eval("({ open: document.getElementById('pasteDialog').open, checked: document.getElementById('pasteHtml').checked, text: document.getElementById('pasteDialog').textContent })");
    assert(s.open && !s.checked, `初期値が OFF でない: ${JSON.stringify(s)}`);
    assert(lang === "ja"
      ? s.text.includes("書式付きテキストをMarkdownに変換する") && s.text.includes("オフの場合は、書式を取り込まず文字だけ貼り付けます。") && s.text.includes("設定を保存")
      : s.text.includes("Convert formatted text to Markdown") && s.text.includes("only the text is pasted") && s.text.includes("Save settings"), `表示: ${s.text}`);
    // キャンセルでは変わらない
    await p.click("#pasteHtml");
    await p.click("#pasteDialog button[value='cancel']");
    await sleep(200);
    assert(JSON.stringify(await p.eval("chrome.storage.local.get(null)")) === JSON.stringify({ defaultFeatures: ["alerts"] }), "キャンセルで保存された");
    // ON にして保存
    await p.click("#settingsMenuButton");
    await p.click("#openPaste");
    await sleep(100);
    assert(!(await p.eval("document.getElementById('pasteHtml').checked")), "キャンセルした変更が残っている");
    await p.click("#pasteHtml");
    await p.screenshot("12-paste-dialog");
    await p.click("#pasteDialog button[value='ok']");
    await sleep(300);
    const stored = await p.eval("chrome.storage.local.get(null)");
    assert(stored.pasteHtml === true && JSON.stringify(stored.defaultFeatures) === JSON.stringify(["alerts"]) && Object.keys(stored).length === 2, `保存内容: ${JSON.stringify(stored)}`);
    assert((await p.toast()) === (lang === "ja" ? "貼り付けの設定を保存しました" : "Paste settings saved"), `通知: ${await p.toast()}`);
    assert((await p.eval("document.getElementById('pasteStatus').textContent")) === (lang === "ja" ? "書式の取り込み：オン" : "Formatted paste: On"), "書式の取り込みの表示が ON にならない");

    // ON: Copilot の HTML を Markdown に変換する（Chrome のクリップボードを通しても日本語が壊れない）
    await clear();
    await pasteWith(copilotPlain, copilotHtml);
    assert(await val() === expected, `変換結果:\n${await val()}`);
    assert((await p.toast()) === (lang === "ja" ? "書式付きテキストをMarkdownに変換して貼り付けました" : "Formatted text was converted to Markdown and pasted"), `変換の通知: ${await p.toast()}`);
    const html = await p.eval("document.getElementById('preview').innerHTML");
    for (const part of ["<h2>導入の手順</h2>", "<strong>3つ</strong>", "<th>内容（Description）</th>", "1行目<br>2行目", "<td>A|B</td>", "href=\"https://example.com/doc\"", "<strong>Outlook</strong>"]) {
      assert(html.includes(part), `プレビューに ${part} がない`);
    }
    await p.screenshot("13-paste-html");
    // 編集した後の書式付きコピー
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(0, 0); document.execCommand('insertText', false, '追記の段落\\n\\n'); })()");
    await sleep(400);
    await p.click("#copyRich");
    await sleep(200);
    const clip = await p.readClipboard();
    assert(clip["text/html"].includes("追記の段落") && /<h2[^>]*>導入の手順<\/h2>/u.test(clip["text/html"]) && clip["text/html"].includes("<table") && clip["text/html"].includes("<strong>準備</strong>"), `書式付きコピー: ${clip["text/html"].slice(0, 300)}`);

    // カーソル位置への挿入・選択範囲の置き換え・Undo・Redo
    await clear();
    await p.eval("(() => { const s = document.getElementById('source'); document.execCommand('insertText', false, '前後'); s.setSelectionRange(1, 1); })()");
    await pasteWith("太字", "<p><b>太字</b></p>");
    assert(await val() === "前**太字**後", `途中への挿入: ${await val()}`);
    await p.eval("document.getElementById('source').setSelectionRange(1, 7)");
    await pasteWith("見出し", "<h3>見出し</h3>");
    assert(await val() === "前### 見出し後", `選択範囲の置き換え: ${await val()}`);
    await p.key("z", { ctrl: true });
    assert(await val() === "前**太字**後", `Undo 1回で戻らない: ${await val()}`);
    await p.key("z", { ctrl: true });
    assert(await val() === "前後", `Undo 2回で戻らない: ${await val()}`);
    await p.key("y", { ctrl: true });
    assert(await val() === "前**太字**後", `Redo で戻らない: ${await val()}`);

    // 書式のない HTML・Markdown の原文（AI のコピーボタンなど）は text/plain のまま
    await clear();
    await pasteWith("ただの  文章\n二行目", "<p><span style=\"font-weight: 400\">ただの  文章</span></p><p>二行目</p>");
    assert(await val() === "ただの  文章\n二行目", `書式のない HTML: ${await val()}`);
    await clear();
    const markdownPlain = "## 見出し\n\n**太字**と$x^2$";
    await pasteWith(markdownPlain, "<h2>見出し</h2><p><strong>太字</strong>と<span class=\"katex\">x2</span></p>");
    assert(await val() === markdownPlain, `Markdown の原文: ${await val()}`);
    // VS Code で色付けした Markdown の原文（見出しの行が太字の span、** はない）も text/plain のまま（2026-11-13 利用者の報告、1.2.1）
    await clear();
    const editorPlain = "# 書いて公開する\n\n| 方法 | 操作 |\n|---|---|\n| A | `B` |\n\n- [リンク](../a.md)";
    const editorHtml = `<div style="color: #cccccc;background-color: #1f1f1f;font-family: Consolas, monospace;white-space: pre;">${editorPlain.split("\n")
      .map((line) => (line === "" ? "<br>" : `<div><span style="color: #569cd6;${line.startsWith("#") ? "font-weight: bold;" : ""}">${line}</span></div>`)).join("")}</div>`;
    await pasteWith(editorPlain, editorHtml);
    assert(await val() === editorPlain, `エディターの原文: ${await val()}`);
    assert(/<h1>書いて公開する<\/h1>/u.test(await p.eval("document.getElementById('preview').innerHTML")), "エディターの原文のプレビューに見出しがない");

    // 危険な HTML: 実行・通信・ダイアログが起きず、危険なリンクを出さない
    await clear();
    externalRequests.length = 0;
    // 試験でクリップボードへ入れるとき（clipboard.write）、Chrome は HTML を安全化のために解析し、イベント属性を CSP 違反として記録する。
    // これは入れる側（試験）の記録で実行もされないので除き、貼り付け（拡張の処理）で記録が増えないことを下の Console の確認で見る
    const written = consoleProblems.length;
    await p.setClipboard("x", "<p onclick=\"window.__bad=1\"><b>安全</b> <a href=\"javascript:window.__bad=2\">危険</a> <img src=\"https://example.com/track.png\" alt=\"図\" onerror=\"window.__bad=3\"></p><script>window.__bad=4</script><iframe src=\"https://example.com/\"></iframe>");
    await sleep(200);
    const fromWrite = consoleProblems.splice(written);
    assert(fromWrite.every((line) => line.includes("inline event handler")), `クリップボードへの書き込みで想定外の記録: ${fromWrite.join("\n")}`);
    await p.eval("document.getElementById('source').focus()");
    await p.key("v", { ctrl: true });
    await sleep(500);
    assert(await val() === "**安全** 危険 図", `危険な HTML: ${await val()}`);
    assert(await p.eval("window.__bad === undefined"), "スクリプトが実行された");
    assert(externalRequests.length === 0 && dialogs.length === 0, `通信・ダイアログ: ${JSON.stringify({ externalRequests, dialogs })}`);

    // 原文の外（プレビュー）で貼り付けても変換する
    await clear();
    await p.setClipboard("外", "<p><em>外</em></p>");
    await p.eval("document.getElementById('previewScroller').focus()");
    await p.key("v", { ctrl: true });
    await sleep(300);
    assert(await val() === "*外*", `原文の外での貼り付け: ${await val()}`);

    // 長い回答: 上限（変換結果 20,000 字）に近い長さでも固まらない。上限を超えたら変換せず text/plain を貼り、案内する
    await clear();
    const rows = Array.from({ length: 800 }, (_, i) => `<li>項目 ${i}：<b>太字</b>の説明文です。</li>`).join("");
    const started = Date.now();
    await pasteWith("長い回答", `<ul>${rows}</ul>`);
    const longValue = await val();
    const elapsed = Date.now() - started;
    console.log(`    変換結果 ${longValue.length.toLocaleString()} 字・${longValue.split("\n").length} 行の貼り付け: ${elapsed}ms`);
    assert(longValue.startsWith("- 項目 0：**太字**の説明文です。") && longValue.length > 15000, `長い回答: ${longValue.slice(0, 80)}（${longValue.length} 字）`);
    assert(elapsed < 10000, `長い回答の貼り付けが遅い: ${elapsed}ms`);
    await clear();
    await pasteWith("上限を超える回答", `<ul>${rows}${rows}</ul>`);
    assert(await val() === "上限を超える回答", `上限を超えたとき: ${(await val()).slice(0, 80)}`);
    assert((await p.toast()).includes(lang === "ja" ? "書式を取り込まずに" : "without its formatting"), `上限を超えたときの案内: ${await p.toast()}`);

    // ブラウザーで表示した HTML を選んでコピー（Chrome が作る実際のコピーの HTML）。取り消し線 S01〜S10・表・複合書式
    // （2026-11-11 利用者の試験で、親要素の CSS の取り消し線 S07 が失われた不具合の回帰確認）
    await clear();
    const copied = await p.eval(`(() => {
      const box = document.createElement("div");
      box.id = "copySource";
      const html = '<p><s>S01</s></p><p><del>S02</del></p><p><strike>S03</strike></p>'
        + '<p><span style="text-decoration: line-through;">S04</span></p><p><span style="text-decoration-line: line-through;">S05</span></p>'
        + '<p><span style="text-decoration: underline line-through;">S06</span></p>'
        + '<p style="text-decoration: line-through;"><span>S07 親要素</span></p>'
        + '<p><del><strong>S08</strong></del></p><p><del><em>S09</em></del></p><p>前半、<del>S10</del>、後半。</p>'
        + '<table><tr><th>項目</th><th>内容</th></tr><tr><td>T02</td><td><del>無効</del> → <span style="text-decoration:line-through">CSS</span></td></tr></table>'
        + '<p><a href="https://example.com/"><strong><em><del>X01</del></em></strong></a></p>'
        + '<p><span style="font-weight:700;text-decoration:line-through;color:#be123c">X02</span></p>';
      box.append(document.createRange().createContextualFragment(html));
      document.body.append(box);
      const range = document.createRange();
      range.selectNodeContents(box);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      const ok = document.execCommand("copy");
      getSelection().removeAllRanges();
      box.remove();
      return ok;
    })()`);
    assert(copied, "選択範囲をコピーできない");
    await p.eval("document.getElementById('source').focus()");
    await p.key("v", { ctrl: true });
    await sleep(500);
    const strikes = await val();
    for (const part of ["~~S01~~", "~~S02~~", "~~S03~~", "~~S04~~", "~~S05~~", "~~S06~~", "~~S07 親要素~~", "~~**S08**~~", "~~*S09*~~", "前半、~~S10~~、後半。",
      "| T02 | ~~無効~~ → ~~CSS~~ |", "[***~~X01~~***](https://example.com/)", "**~~X02~~**"]) {
      assert(strikes.includes(part), `${part} がない:\n${strikes}`);
    }

    // 別のタブで OFF にすると、このタブの次の貼り付けから反映する
    const q = await openEditor();
    await q.click("#settingsMenuButton");
    await q.click("#openPaste");
    await sleep(100);
    assert(await q.eval("document.getElementById('pasteHtml').checked"), "新しいタブで ON になっていない");
    await q.click("#pasteHtml");
    await q.click("#pasteDialog button[value='ok']");
    await sleep(300);
    await clear();
    await pasteWith("文字だけ", "<h2>文字だけ</h2>");
    assert(await val() === "文字だけ", `別のタブで OFF にした後: ${await val()}`);
    const after = await q.eval("chrome.storage.local.get(null)");
    assert(after.pasteHtml === false && JSON.stringify(after.defaultFeatures) === JSON.stringify(["alerts"]), `保存内容: ${JSON.stringify(after)}`);
    // 後の確認のため、ON に戻しておく（拡張の再起動後に保持されるかを最後に確かめる）。既定値は空に戻す
    await q.eval("chrome.storage.local.clear().then(() => chrome.storage.local.set({ pasteHtml: true }))");
  });

  await check("表示の切り替え: プレビューを広げると編集欄を閉じ、ボタンの表記が変わる", async () => {
    const p = await openEditor();
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); document.execCommand('insertText', false, '# 見出し'); s.select(); })()");
    await sleep(400);
    await p.click("#toggleSource");
    let s = await p.eval("({ open: document.getElementById('workspace').classList.contains('source-open'), label: document.getElementById('toggleSource').textContent, aria: document.getElementById('toggleSource').getAttribute('aria-expanded'), selection: document.getElementById('copySelection').disabled, pane: getComputedStyle(document.getElementById('sourcePane')).display })");
    assert(!s.open && s.pane === "none" && s.aria === "false" && s.selection && s.label === (lang === "ja" ? "編集欄を表示" : "Show Editor"), `閉じた状態: ${JSON.stringify(s)}`);
    await p.screenshot("15-preview-only");
    await p.click("#toggleSource");
    s = await p.eval("({ open: document.getElementById('workspace').classList.contains('source-open'), label: document.getElementById('toggleSource').textContent, focus: document.activeElement.id })");
    assert(s.open && s.focus === "source" && s.label === (lang === "ja" ? "プレビューを広げる" : "Expand Preview"), `開いた状態: ${JSON.stringify(s)}`);
  });

  await check("メニュー: キーボードで開いて選べ、Escで閉じる", async () => {
    const p = await openEditor();
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); document.execCommand('insertText', false, '本文'); s.setSelectionRange(0, 2); document.querySelector(\"[aria-controls='moreMenu']\").focus(); })()");
    await p.key("Enter");
    let s = await p.eval("({ open: !document.getElementById('moreMenu').hidden, focus: document.activeElement.dataset.format, expanded: document.querySelector(\"[aria-controls='moreMenu']\").getAttribute('aria-expanded') })");
    assert(s.open && s.focus === "italic" && s.expanded === "true", `開いた状態: ${JSON.stringify(s)}`);
    await p.screenshot("11-more-menu");
    await p.key("Escape");
    s = await p.eval("document.getElementById('moreMenu').hidden");
    assert(s, "Esc で閉じない");
    await p.click("[aria-controls='headingMenu']");
    await p.click("[data-format='h2']");
    assert(await p.value() === "## 本文", "見出しメニューから適用できない");
    assert(await p.eval("document.getElementById('headingMenu').hidden"), "選んだ後にメニューが閉じない");
  });

  await check("複数の作業タブの内容が混ざらない", async () => {
    const a = await openEditor();
    const b = await openEditor();
    await a.eval("(() => { const s = document.getElementById('source'); s.focus(); document.execCommand('insertText', false, '# タブA'); })()");
    await b.eval("(() => { const s = document.getElementById('source'); s.focus(); document.execCommand('insertText', false, '# タブB'); })()");
    await sleep(500);
    assert(await a.value() === "# タブA" && await b.value() === "# タブB", "内容が混ざった");
    assert((await a.eval("document.getElementById('preview').textContent")).trim() === "タブA", "プレビューが混ざった");
  });

  await check("長文・不正なMarkdown: 固まらず、上限を超えると手動更新に切り替え、本文を失わない", async () => {
    const p = await openEditor();
    const block = "## 節\n\n日本語の段落です。**強調**と`code`と[リンク](https://example.com)。\n\n| a | b |\n|--|--|\n| 1 | 2 |\n\n";
    const big = block.repeat(Math.ceil(260000 / block.length));
    const started = Date.now();
    await p.setClipboard(big);
    await p.key("v", { ctrl: true });
    await sleep(800);
    const s = await p.eval("({ value: document.getElementById('source').value.length, status: document.getElementById('previewStatusText').textContent, refresh: !document.getElementById('refreshPreview').hidden })");
    assert(s.value === big.length, "本文が欠けた");
    assert(s.refresh && /\d/u.test(s.status), `手動更新の案内がない: ${JSON.stringify(s)}`);
    const t0 = Date.now();
    await p.click("#refreshPreview");
    const rendered = await p.eval("document.querySelectorAll('#preview h2').length");
    assert(rendered > 1000, `手動更新で表示されない: ${rendered}`);
    console.log(`    260,000字超の入力〜表示: 入力 ${t0 - started}ms / 手動更新 ${Date.now() - t0}ms`);
    const broken = "| a |\n|--\n**閉じない\n```\n未完のコード\n<div><span>\n" + "[".repeat(5000) + "\n" + "> ".repeat(300) + "x\n<!-- 閉じないコメント";
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); s.select(); })()");
    await p.setClipboard(broken);
    await p.key("v", { ctrl: true });
    await sleep(800);
    assert(await p.value() === broken, "不正な入力で本文が変わった");
    const status = await p.eval("document.getElementById('previewStatus').classList.contains('error')");
    assert(!status, "不正な入力で変換エラーになった");
  });

  await check("スクロール位置: 内容の更新で先頭へ戻らない", async () => {
    const p = await openEditor();
    const text = Array.from({ length: 200 }, (_, i) => `段落${i}\n`).join("\n");
    await p.eval(`(() => { const s = document.getElementById('source'); s.focus(); document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`);
    await sleep(600);
    await p.eval("document.getElementById('previewScroller').scrollTop = 2000");
    await p.eval("(() => { const s = document.getElementById('source'); s.setSelectionRange(s.value.length, s.value.length); document.execCommand('insertText', false, '末尾の追記'); })()");
    await sleep(600);
    const top = await p.eval("document.getElementById('previewScroller').scrollTop");
    assert(top >= 1900, `スクロール位置: ${top}`);
  });

  await check("狭い画面では縦配置、ダーク表示はOS設定に追従", async () => {
    const p = await openEditor();
    await p.send("Emulation.setDeviceMetricsOverride", { width: 700, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    const narrow = await p.eval("(() => { const s = document.getElementById('sourcePane').getBoundingClientRect(); const v = document.querySelector('.preview-pane').getBoundingClientRect(); return { stacked: v.top >= s.bottom - 1, w: s.width }; })()");
    assert(narrow.stacked, `縦配置になっていない: ${JSON.stringify(narrow)}`);
    const bar = await p.eval("(() => { const shown = (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none'; const tops = [...document.querySelectorAll('.actions button:not([role=menuitem])')].filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().top)); return { short: shown('#copyRich .label-short'), long: shown('#copyRich .label-long'), rows: new Set(tops).size }; })()");
    assert(bar.short && !bar.long && bar.rows === 1, `狭い画面の操作バー: ${JSON.stringify(bar)}`);
    await p.screenshot("06-narrow");
    await p.send("Emulation.clearDeviceMetricsOverride", {});
    await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await sleep(100);
    const light = await p.eval("getComputedStyle(document.body).backgroundColor");
    await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await sleep(100);
    const dark = await p.eval("getComputedStyle(document.body).backgroundColor");
    assert(light !== dark, `ダーク表示に切り替わらない: ${light}`);
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); document.execCommand('insertText', false, '# ダーク表示\\n\\n| a | b |\\n|--|--|\\n| 1 | 2 |\\n\\n`code`'); })()");
    await sleep(500);
    await p.screenshot("07-dark");
  });

  await check("アプリ情報: 名前・版（manifestと一致）・© ja1bus・ライセンス表記", async () => {
    await page2.click("#settingsMenuButton");
    await page2.click("#about");
    await sleep(150);
    const s = await page2.eval("({ open: document.getElementById('aboutDialog').open, text: document.getElementById('aboutDialog').textContent, version: chrome.runtime.getManifest().version })");
    assert(s.open, "アプリ情報が開かない");
    const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    assert(s.version === expected && s.text.includes(expected) && s.text.includes("MarkdownTrellis Clip") && s.text.includes("© ja1bus"), `表示: ${s.text}`);
    const links = await page2.eval("[...document.querySelectorAll('#aboutDialog .about-links a')].map((a) => a.getAttribute('href'))");
    assert(s.text.includes(lang === "ja" ? "MITライセンス" : "MIT License") && links.includes("https://github.com/ja1bus/MarkdownTrellisClip") && links.includes("LICENSE.txt") && links.includes("licenses/THIRD_PARTY_NOTICES.txt"), `MIT・ライセンス表記のリンク: ${JSON.stringify(links)}`);
    const licenseText = await page2.eval("fetch('LICENSE.txt').then((r) => r.text()).catch(() => '')");
    assert(licenseText === "" || licenseText.includes("MIT License"), "LICENSE.txt の内容");
    const notices = await page2.eval("fetch('licenses/THIRD_PARTY_NOTICES.txt').then((r) => r.text())");
    assert(notices.includes("marked 18.1.3") && notices.includes("DOMPurify 3.4.17") && notices.includes("Turndown 7.2.5"), "ライセンス表記にライブラリの版がない");
    await page2.screenshot("08-about");
    const probe = await page2.eval("fetch('https://example.com/connect-probe').then(() => 'fetched', () => 'blocked')");
    assert(probe === "blocked", "connect-src が効いていない（外部へ fetch できた）");
    externalRequests.length = 0;
    await page2.key("Escape");
  });

  await check("拡張の再起動後も、書式付きテキストの貼り付けの設定（ON）を保持する", async () => {
    await page2.eval("chrome.storage.local.get('pasteHtml')").then((v) => assert(v.pasteHtml === true, `再起動前: ${JSON.stringify(v)}`));
    // 読み込んだときと同じ方法で読み込み直す（chrome://extensions の再読み込みと同じ。拡張のページは閉じられる）
    const again = await cdp.send("Extensions.loadUnpacked", { path: resolve(extensionDir) });
    assert(again.id === extensionId, `拡張IDが変わった: ${again.id}`);
    await sleep(1000);
    const { targetInfos } = await cdp.send("Target.getTargets");
    assert(!targetInfos.some((t) => t.targetId === page2.targetId), "読み込み直しで作業タブが閉じられていない（再起動していない）");
    const p = await openEditor();
    await p.click("#settingsMenuButton");
    await p.click("#openPaste");
    await sleep(100);
    assert(await p.eval("document.getElementById('pasteHtml').checked"), "再起動後に ON が保持されていない");
    await p.key("Escape");
    await p.eval("chrome.storage.local.clear()");
  });

  // ---- 位置の連動（1.3.0、仕様 §3.2。試験表 docs/verification.md の 20261115-position-jump） ----

  /** 作業タブを開き、7部品すべてを有効にして text を入れる（paste なら Ctrl+V で貼る）。 */
  async function openJumpEditor(text, { width = 1280, height = 800, paste = false } = {}) {
    const p = await openEditor();
    await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await p.installJumpHelpers();
    // 長い文書は貼り付けで入れる（追加構文のダイアログを閉じた後の作業タブでは、試験の Ctrl+V が効かないため先に貼る）
    if (paste) {
      await p.setClipboard(text);
      await p.key("v", { ctrl: true });
      await sleep(800);
    }
    await p.click("#settingsMenuButton");
    await p.click("#openSyntax");
    await p.eval("document.querySelectorAll(\"#syntaxDialog input[name='feature']\").forEach((input) => { input.checked = true; })");
    await p.click("#syntaxDialog button[value='ok']");
    if (!paste) {
      await p.eval("document.getElementById('source').focus()");
      await p.send("Input.insertText", { text });
    }
    await sleep(1000);
    assert(await p.value() === text, "試験データを編集欄に入れられない");
    return p;
  }

  await check("位置の連動 T-06・T-07: 編集欄のクリックで、その行の箇所をプレビューの同じ高さに出して示す", async () => {
    const p = await openJumpEditor(JUMP_D1);
    await p.eval("window.__j.P().scrollTop = 0");
    await sleep(300);
    let point = await p.clickLine(23, 0.3);
    assert(await p.eval("window.__j.state().line") === 23, "クリックでカーソルが L23 に置かれない（試験の手順の誤り）");
    await sleep(300);
    let shown = await p.eval("window.__j.shown()");
    assert(shown.length === 1 && shown[0].tag === "TR" && shown[0].text.startsWith("a1"), `L23 で示した要素: ${JSON.stringify(shown)}`);
    let placed = await p.eval(`window.__j.placed(${point.r})`);
    assert(placed.ok, `L23 の位置: ${JSON.stringify(placed)}`);
    const colors = await p.eval("(() => { const rows = [...document.querySelectorAll('#preview tbody tr')]; return rows.map((tr) => getComputedStyle(tr.cells[0]).backgroundColor); })()");
    assert(colors[0] !== colors[1], `示した行の背景色が変わらない: ${JSON.stringify(colors)}`);
    await p.screenshot("20-jump-table");
    await sleep(1700);
    assert((await p.eval("window.__j.shown()")).length === 0, "2秒後も示している");
    point = await p.clickLine(6, 0.7);
    await sleep(300);
    shown = await p.eval("window.__j.shown()");
    assert(shown.length === 1 && shown[0].tag === "P" && shown[0].text.startsWith("段落A"), `L6 で示した要素: ${JSON.stringify(shown)}`);
    placed = await p.eval(`window.__j.placed(${point.r})`);
    assert(placed.ok, `L6 の位置: ${JSON.stringify(placed)}`);
    // T-07: コードブロックの中の行は、塊の行数に対する割合で合わせる
    for (const n of [28, 29, 30]) {
      await sleep(2000);
      point = await p.clickLine(n, 0.5);
      await sleep(200);
      shown = await p.eval("window.__j.shown()");
      assert(shown.length === 1 && shown[0].tag === "PRE", `L${n} で示した要素: ${JSON.stringify(shown)}`);
      placed = await p.eval(`window.__j.placed(${point.r}, ${(n - 27) / 5})`);
      assert(placed.ok, `L${n} の位置: ${JSON.stringify(placed)}`);
    }
  });

  await check("位置の連動 T-08: 範囲の選択・Shift+クリック・キーボード・入力ではプレビューを動かさない", async () => {
    const p = await openJumpEditor(JUMP_D1);
    await p.clickLine(4, 0.4);
    await sleep(2000);
    const before = await p.eval("window.__j.P().scrollTop");
    const quiet = async (label) => {
      for (const wait of [500, 1000]) {
        await sleep(wait);
        const s = await p.eval("({ shown: window.__j.shown(), top: window.__j.P().scrollTop })");
        assert(s.shown.length === 0 && Math.abs(s.top - before) <= 1, `${label}: ${JSON.stringify(s)} / 前 ${before}`);
      }
    };
    // (a) L6 の行頭から L9 の行末までドラッグ
    const from = await p.eval("window.__j.pointForLine(6, 0.3)");
    const to = await p.eval(`(() => { const e = window.__j.E(); const rect = e.getBoundingClientRect(); return { x: rect.left + 200, y: rect.top + window.__j.lineTop(9) - e.scrollTop + window.__j.lh() / 2 }; })()`);
    await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x - 15, y: from.y });
    await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x - 15, y: from.y, button: "left", clickCount: 1 });
    await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "left", buttons: 1 });
    await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
    let s = await p.eval("window.__j.state()");
    assert(s.start !== s.end && s.line === 6, `ドラッグの選択: ${JSON.stringify({ start: s.start, end: s.end })}`);
    await quiet("ドラッグ");
    // (b) Shift+クリック
    await p.clickLine(25, 0.6, { shift: true });
    s = await p.eval("window.__j.state()");
    assert(s.start !== s.end, "Shift+クリックで選択にならない");
    await quiet("Shift+クリック");
    // (c) キーボードでの移動
    for (let i = 0; i < 5; i++) {
      await p.key("ArrowDown");
    }
    await p.key("PageDown");
    await p.key("End", { ctrl: true });
    await p.key("Home", { ctrl: true });
    await quiet("キーボード");
    // (d) 入力
    await p.send("Input.insertText", { text: "x" });
    await quiet("入力");
  });

  await check("位置の連動 T-09・T-10: プレビューのダブルクリックで、元の行の先頭にカーソルを置き、同じ高さに出す", async () => {
    const p = await openJumpEditor(JUMP_D1);
    const cases = [
      ["h1", { fy: 0.5 }, 4], ["p", { fy: 0.15 }, 6], ["p", { fy: 0.85 }, 9], ["tbody tr:nth-child(2) td", { fy: 0.5 }, 24], ["li li", { index: 1, fy: 0.5 }, 14],
    ];
    for (const [selector, options, line] of cases) {
      await p.eval("(() => { const e = window.__j.E(); e.scrollTop = 0; e.setSelectionRange(0, 0); window.__j.P().focus(); })()");
      const point = await p.dblclickPreview(selector, options);
      const s = await p.eval("window.__j.state()");
      const want = await p.eval(`window.__j.lineStart(${line})`);
      assert(s.focus === "source" && s.start === want && s.end === want, `${selector}: カーソル ${JSON.stringify({ focus: s.focus, start: s.start, end: s.end, line: s.line })} / 期待 L${line}=${want}`);
      assert(s.value === JUMP_D1, `${selector}: 原文が変わった`);
      const placed = await p.eval(`window.__j.caretPlaced(${line}, ${point.r})`);
      assert(placed.ok, `${selector}: 行の位置 ${JSON.stringify(placed)}`);
    }
    // T-10: 編集欄を閉じていれば開く
    await p.click("#toggleSource");
    assert(!(await p.eval("document.getElementById('workspace').classList.contains('source-open')")), "編集欄が閉じない");
    await p.dblclickPreview("thead th");
    const s = await p.eval("({ ...window.__j.state(), open: document.getElementById('workspace').classList.contains('source-open'), label: document.getElementById('toggleSourceLabel').textContent })");
    assert(s.open && s.label === (lang === "ja" ? "プレビューを広げる" : "Expand Preview"), `編集欄が開かない: ${JSON.stringify({ open: s.open, label: s.label })}`);
    assert(s.focus === "source" && s.start === await p.eval("window.__j.lineStart(21)") && s.value === JUMP_D1, `見出し行: ${JSON.stringify({ focus: s.focus, line: s.line })}`);
  });

  await check("位置の連動 T-11・T-12: リンク・脚注の一覧・空白のダブルクリックでは移らず、Frontmatter のクリックでは先頭へ", async () => {
    const p = await openJumpEditor(JUMP_D1);
    await p.eval("window.open = (...args) => { window.__openedCount = (window.__openedCount ?? 0) + 1; window.__opened = args; return null; }");
    await p.clickLine(4, 0.4);
    const record = await p.eval("window.__j.state()");
    const unchanged = async (label) => {
      const s = await p.eval("window.__j.state()");
      assert(s.start === record.start && s.end === record.end && s.scrollTop === record.scrollTop && s.focus !== "source", `${label}: ${JSON.stringify({ start: s.start, end: s.end, scrollTop: s.scrollTop, focus: s.focus })} / 前 ${JSON.stringify({ start: record.start, scrollTop: record.scrollTop })}`);
    };
    await p.dblclickPreview("a[href^='https']");
    await unchanged("リンク");
    const opened = await p.eval("({ count: window.__openedCount, url: window.__opened?.[0] })");
    assert(opened.count === 1 && opened.url === "https://example.com", `リンクのダブルクリックで開いた回数: ${JSON.stringify(opened)}`);
    await p.dblclickPreview("section.footnotes li");
    await unchanged("脚注の一覧");
    const empty = await p.eval("(() => { const sc = window.__j.P(); sc.scrollTop = sc.scrollHeight; const r = sc.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 10 }; })()");
    await p.mouse(empty.x, empty.y, { count: 2 });
    await unchanged("何もない所");
    // T-12: Frontmatter の中のクリックはプレビューの先頭へ
    await p.eval("window.__j.P().scrollTop = window.__j.P().scrollHeight");
    await p.clickLine(2, 0.2);
    await sleep(100);
    assert(await p.eval("window.__j.P().scrollTop") === 0, "Frontmatter のクリックで先頭へ移らない");
  });

  await check("位置の連動 T-13: 原文・コピーの結果・Undo履歴を変えない", async () => {
    const p = await openJumpEditor(JUMP_D1);
    await p.eval("(() => { const e = window.__j.E(); const at = window.__j.lineStart(10) - 1; e.setSelectionRange(at, at); })()");
    await p.send("Input.insertText", { text: "X" });
    await sleep(1000);
    const value = await p.value();
    const takeCopies = async () => {
      const out = {};
      await p.click("#copyMarkdown");
      out.markdown = await p.readClipboard();
      await p.click("#copyRich");
      out.rich = await p.readClipboard();
      await p.eval("(() => { const e = window.__j.E(); e.focus(); e.setSelectionRange(window.__j.lineStart(6), window.__j.lineStart(10) - 1); document.dispatchEvent(new Event('selectionchange')); })()");
      await sleep(100);
      await p.click("#copySelection");
      out.selection = await p.readClipboard();
      return out;
    };
    const before = await takeCopies();
    await p.clickLine(23, 0.3);
    await p.clickLine(6, 0.7);
    for (const [selector, options] of [["h1", {}], ["p", { fy: 0.15 }], ["p", { fy: 0.85 }], ["tbody tr:nth-child(2) td", {}], ["li li", { index: 1 }]]) {
      await p.dblclickPreview(selector, options);
    }
    await sleep(2500);
    assert(await p.value() === value, "位置の連動で原文が変わった");
    const after = await takeCopies();
    for (const key of ["markdown", "rich", "selection"]) {
      assert(JSON.stringify(after[key]) === JSON.stringify(before[key]), `${key} のコピーが変わった`);
    }
    const dom = await p.eval("(() => { const w = document.createTreeWalker(document.getElementById('preview'), NodeFilter.SHOW_COMMENT); return { comment: w.nextNode() !== null, jump: document.querySelectorAll('#preview .jump-target, #preview .jump-fade').length }; })()");
    assert(!dom.comment && dom.jump === 0, `プレビューの DOM: ${JSON.stringify(dom)}`);
    await p.eval("window.__j.E().focus()");
    await p.key("z", { ctrl: true });
    assert(await p.value() === JUMP_D1, "Ctrl+Z の1回で X を入れる前に戻らない");
    await p.key("y", { ctrl: true });
    assert(await p.value() === value, "Ctrl+Y で X が戻らない");
  });

  // ---- 位置の連動の総合試験（T-15〜T-29、T-32） ----

  /** 示した要素が1つで、tag と文字の始まりが一致するか。 */
  const expectShown = async (p, label, tag, text = null) => {
    const shown = await p.eval("window.__j.shown()");
    assert(shown.length === 1 && shown[0].tag === tag && (text === null || shown[0].text.startsWith(text)), `${label}: ${JSON.stringify(shown)}（期待 ${tag} ${text ?? ""}）`);
  };

  await check("位置の連動 T-15: 各種のブロックの行をクリックすると、その塊を示す", async () => {
    const p = await openJumpEditor(JUMP_D1);
    // [行, 要素, 文字の始まり, 塊の中の割合（表の行は0）]
    const cases = [
      [4, "H1", "見出し1", 0], [11, "LI", "項目1", 0], [12, "LI", "項目2", 0], [13, "LI", "入れ子2-1", 0], [14, "LI", "入れ子2-2", 0],
      [15, "LI", "項目3", 0], [17, "P", "引用の段落1", 0], [19, "P", "引用の段落2", 0], [21, "TR", "列A", 0], [22, "TR", "列A", 0],
      [23, "TR", "a1", 0], [25, "TR", "a3", 0], [33, "HR", null, 0], [35, "DETAILS", "概要", 0], [38, "DIV", "$$", 1 / 3],
      [41, "DIV", "note", 0], [42, "P", "コンテナの段落", 0], [45, "DL", "用語", 0], [46, "DL", "用語", 1 / 2], [48, "DIV", "Note", 0],
      [49, "P", "注意の本文", 1 / 2], [51, "P", "本文の脚注", 0], [93, "P", "埋め草20", 0],
    ];
    for (const [line, tag, text, frac] of cases) {
      // 前の示し方は次のクリックで消える実装なので、2秒ではなく0.4秒あける（1つだけ示すことは毎回確かめる）
      const point = await p.clickLine(line, 0.4);
      await sleep(250);
      await expectShown(p, `L${line}`, tag, text);
      const placed = await p.eval(`window.__j.placed(${point.r}, ${frac})`);
      assert(placed.ok, `L${line} の位置: ${JSON.stringify(placed)}`);
      await sleep(150);
    }
  });

  await check("位置の連動 T-16: 各種のブロックのダブルクリックで、その行へ移る", async () => {
    const p = await openJumpEditor(JUMP_D1);
    // [セレクター, 指定, 期待の行の範囲]
    const cases = [
      ["p strong", { text: "2行目" }, [6, 9]], ["thead th", {}, [21, 21]], ["tbody tr:nth-child(3) td", {}, [25, 25]], ["> ul > li", { index: 2 }, [15, 15]],
      ["li li", {}, [13, 13]], ["blockquote p", { index: 1 }, [19, 19]], ["pre", { fy: 0.2 }, [27, 29]], ["pre", { fy: 0.8 }, [29, 31]],
      ["hr", {}, [33, 33]], ["details summary", {}, [35, 35]], [".mtc-math-display", {}, [37, 39]], [".mtc-container-title", {}, [41, 41]],
      [".mtc-container > p:not(.mtc-container-title)", {}, [42, 42]], ["dt", {}, [45, 45]], ["dd", {}, [46, 46]], [".markdown-alert-title", {}, [48, 48]],
      ["p", { text: "本文の脚注" }, [51, 51]], ["p", { text: "埋め草20" }, [93, 93]],
    ];
    let preLine = 0;
    for (const [selector, options, [low, high]] of cases) {
      await p.eval("(() => { const e = window.__j.E(); e.scrollTop = 0; e.setSelectionRange(0, 0); window.__j.P().focus(); })()");
      const point = await p.dblclickPreview(selector, options);
      const s = await p.eval("window.__j.state()");
      const lineStart = await p.eval(`window.__j.lineStart(${s.line})`);
      assert(s.focus === "source" && s.start === lineStart && s.line >= low && s.line <= high && s.value === JUMP_D1, `${selector} ${JSON.stringify(options)}: L${s.line}（期待 L${low}〜L${high}）、フォーカス ${s.focus}、行頭 ${s.start === lineStart}`);
      if (selector === "pre") {
        assert(s.line > preLine, `pre の下の方が上の方より後の行でない: L${preLine} → L${s.line}`);
        preLine = s.line;
      }
      const placed = await p.eval(`window.__j.caretPlaced(${s.line}, ${point.r})`);
      assert(placed.ok, `${selector}: 行の位置 ${JSON.stringify(placed)}`);
    }
  });

  await check("位置の連動 T-17: 安全化で消えるブロック・コメントの後の段落は、その段落の行と対応する", async () => {
    const C2 = ["<script>alert(1)</script>", "", "段落P", "", "<!-- 利用者のコメント -->", "", "段落Q"].join("\n");
    const dialogsBefore = dialogs.length;
    const p = await openJumpEditor(C2);
    await p.clickLine(3, 0.3);
    await sleep(200);
    await expectShown(p, "L3", "P", "段落P");
    await p.clickLine(7, 0.3);
    await sleep(200);
    await expectShown(p, "L7", "P", "段落Q");
    for (const [text, line] of [["段落P", 3], ["段落Q", 7]]) {
      await p.dblclickPreview("p", { text });
      const s = await p.eval("window.__j.state()");
      assert(s.line === line && s.start === await p.eval(`window.__j.lineStart(${line})`), `${text}: L${s.line}`);
    }
    assert(dialogs.length === dialogsBefore && await p.eval("window.__pwned === undefined"), "スクリプトが動いた");
  });

  await check("位置の連動 T-18: コンテナを無効にすると、::: を含む段落として対応する", async () => {
    const p = await openJumpEditor(JUMP_D1);
    await p.click("#settingsMenuButton");
    await p.click("#openSyntax");
    await p.eval("document.querySelector(\"#syntaxDialog input[value='containers']\").checked = false");
    await p.click("#syntaxDialog button[value='ok']");
    await sleep(400);
    await p.clickLine(42, 0.4);
    await sleep(200);
    const shown = await p.eval("window.__j.shown()");
    assert(shown.length === 1 && shown[0].tag === "P" && shown[0].text.includes("::: note") && shown[0].text.includes("コンテナの段落"), `L42: ${JSON.stringify(shown)}`);
    await p.dblclickPreview("p", { text: "::: note" });
    const s = await p.eval("window.__j.state()");
    assert(s.line >= 41 && s.line <= 43 && s.start === await p.eval(`window.__j.lineStart(${s.line})`), `ダブルクリック: L${s.line}`);
    await p.clickLine(23, 0.4);
    await sleep(200);
    await expectShown(p, "L23", "TR", "a1");
  });

  await check("位置の連動 T-19: 注の定義の行は直前の段落、脚注の番号・↩・案内のダブルクリックでは移らない", async () => {
    const p = await openJumpEditor(JUMP_D1);
    await p.clickLine(53, 0.4);
    await sleep(200);
    await expectShown(p, "L53", "P", "本文の脚注");
    await p.clickLine(4, 0.4);
    const record = await p.eval("window.__j.state()");
    const unchanged = async (label) => {
      const s = await p.eval("window.__j.state()");
      assert(s.start === record.start && s.scrollTop === record.scrollTop && s.focus !== "source", `${label}: ${JSON.stringify({ start: s.start, scrollTop: s.scrollTop, focus: s.focus })}`);
    };
    await p.dblclickPreview("sup.footnote-ref a");
    await unchanged("脚注の番号");
    const noteVisible = await p.eval("(() => { const li = document.getElementById('mtc-fn-1'); const r = li.getBoundingClientRect(); const pr = window.__j.P().getBoundingClientRect(); return r.top >= pr.top && r.bottom <= pr.bottom; })()");
    assert(noteVisible, "番号で注へ移らない");
    await p.dblclickPreview("a.footnote-backref");
    await unchanged("↩");
    await p.click("#settingsMenuButton");
    await p.click("#openSyntax");
    await p.click("#clearFeatures");
    await p.click("#syntaxDialog button[value='ok']");
    await sleep(400);
    await p.clickLine(4, 0.4);
    const record2 = await p.eval("window.__j.state()");
    const banner = await p.eval("(() => { const el = document.getElementById('syntaxMessage'); const r = el.getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2, shown: !document.getElementById('syntaxBanner').hidden }; })()");
    assert(banner.shown, "追加構文の案内が出ない");
    await p.mouse(banner.x, banner.y, { count: 2 });
    const s = await p.eval("window.__j.state()");
    assert(s.start === record2.start && s.scrollTop === record2.scrollTop && s.focus !== "source", `案内: ${JSON.stringify({ start: s.start, focus: s.focus })}`);
  });

  await check("位置の連動 T-20: 空行は直前の塊、空・Frontmatter だけでは何も示さず、クリアの後に古い対応が残らない", async () => {
    const p = await openJumpEditor(JUMP_D1);
    await p.clickLine(5, 0.4);
    await sleep(200);
    await expectShown(p, "L5", "H1", "見出し1");
    await p.clickLine(10, 0.4);
    await sleep(200);
    await expectShown(p, "L10", "P", "段落A");
    const clear = async () => {
      await p.click("#clear");
      if (await p.eval("document.getElementById('clearDialog').open")) {
        await p.click("#clearDialog button[value='clear']");
      }
      await sleep(200);
      await p.installJumpHelpers();
    };
    await clear();
    await p.clickLine(1, 0.1);
    await sleep(200);
    assert((await p.eval("window.__j.shown()")).length === 0 && await p.eval("window.__j.P().scrollTop") === 0, "空の状態で示した");
    await p.eval("window.__j.E().focus()");
    await p.send("Input.insertText", { text: "---\ntitle: 試験\n---" });
    await sleep(800);
    await p.clickLine(2, 0.2);
    await sleep(200);
    assert((await p.eval("window.__j.shown()")).length === 0 && await p.eval("window.__j.P().scrollTop") === 0, "Frontmatter だけで示した");
    await clear();
    await p.eval("window.__j.E().focus()");
    await p.send("Input.insertText", { text: JUMP_D1 });
    await sleep(1000);
    await p.clickLine(23, 0.3);
    await sleep(200);
    await expectShown(p, "クリアの後の L23", "TR", "a1");
  });

  await check("位置の連動 T-21: 全文フェンスの除外の有無・Frontmatter でずれない", async () => {
    const D2 = ["```markdown", "# 外側の中の見出し", "", "中の段落", "", ...Array.from({ length: 30 }, (_, i) => [`埋め草${i + 1}`, ""]).flat(), "```"].join("\n");
    const p = await openJumpEditor(D2);
    await p.clickLine(4, 0.4);
    await sleep(200);
    await expectShown(p, "除外なしの L4", "PRE");
    await p.click("#toggleFence");
    await sleep(400);
    await p.clickLine(4, 0.4);
    await sleep(200);
    await expectShown(p, "除外ありの L4", "P", "中の段落");
    await p.clickLine(2, 0.4);
    await sleep(200);
    await expectShown(p, "除外ありの L2", "H1", "外側の中の見出し");
    await p.eval("window.__j.P().scrollTop = window.__j.P().scrollHeight");
    await p.clickLine(1, 0.1);
    await sleep(100);
    assert(await p.eval("window.__j.P().scrollTop") === 0, "開きの行で先頭へ移らない");
    await p.clickLine(65, 0.8);
    await sleep(200);
    await expectShown(p, "閉じの行", "P", "埋め草30");
    for (const [selector, text, line] of [["h1", null, 2], ["p", "中の段落", 4]]) {
      await p.dblclickPreview(selector, { text });
      const s = await p.eval("window.__j.state()");
      assert(s.line === line && s.start === await p.eval(`window.__j.lineStart(${line})`), `${selector} のダブルクリック: L${s.line}`);
    }
    const D2b = ["---", "a: 1", "---", "```md", "## 見出しF", "", "段落F", "```"].join("\n");
    await p.eval("(() => { const e = window.__j.E(); e.focus(); e.select(); })()");
    await p.send("Input.insertText", { text: D2b });
    await sleep(800);
    if (!(await p.eval("document.querySelector('#preview h2') !== null"))) {
      await p.click("#toggleFence");
      await sleep(400);
    }
    await p.clickLine(7, 0.4);
    await sleep(200);
    await expectShown(p, "D2b の L7", "P", "段落F");
    await p.dblclickPreview("h2");
    const s = await p.eval("window.__j.state()");
    assert(s.line === 5, `D2b の見出し: L${s.line}`);
    await p.click("#copyMarkdown");
    assert(lf((await p.readClipboard())["text/plain"]) === D2b, "Markdownのコピーが原文と違う");
  });

  await check("位置の連動 T-22: 反映前の編集の直後にクリックすると、先にプレビューを更新して移る", async () => {
    const p = await openJumpEditor(JUMP_D1);
    await p.eval("(() => { const e = window.__j.E(); e.focus(); const at = window.__j.lineStart(10) - 1; e.setSelectionRange(at, at); })()");
    await sleep(2000);
    await p.send("Input.insertText", { text: "\n\n新しい段落Z" });
    const point = await p.clickLine(11, 0.5);
    await sleep(50);
    await expectShown(p, "反映前の L11", "P", "新しい段落Z");
    const placed = await p.eval(`window.__j.placed(${point.r})`);
    assert(placed.ok, `位置: ${JSON.stringify(placed)}`);
  });

  await check("位置の連動 T-23: 手動更新の状態では最後の対応を使い、古い対応でも原文の長さを超えない", async () => {
    const para = "埋め草の段落です。".repeat(10);
    const lines = ["# 先頭", ""];
    let length = 0;
    let placedTarget = false;
    while (length < 262000) {
      lines.push(para, "");
      length += para.length + 2;
      if (!placedTarget && length > 130000) {
        lines.push("# 目標", "");
        placedTarget = true;
      }
    }
    const D5 = lines.join("\n");
    const p = await openJumpEditor(D5, { paste: true });
    let status = await p.eval("({ refresh: !document.getElementById('refreshPreview').hidden, text: document.getElementById('previewStatusText').textContent })");
    assert(status.refresh && /\d/u.test(status.text), `手動更新の表示: ${JSON.stringify(status)}`);
    await p.click("#refreshPreview");
    await sleep(500);
    const target = await p.eval("window.__j.E().value.indexOf('\\n# 目標\\n') + 1");
    let point = await p.eval(`window.__j.pointForOffset(${target}, 0.4)`);
    await p.mouse(point.x, point.y);
    await sleep(300);
    await expectShown(p, "# 目標", "H1", "目標");
    let placed = await p.eval(`window.__j.placed(${point.r})`);
    assert(placed.ok, `# 目標 の位置: ${JSON.stringify(placed)}`);
    await p.eval("(() => { const e = window.__j.E(); e.focus(); e.setSelectionRange(0, 0); })()");
    await p.send("Input.insertText", { text: Array.from({ length: 50 }, (_, i) => `追加${i + 1}\n`).join("") });
    await sleep(800);
    const shifted = await p.eval("window.__j.E().value.indexOf('\\n# 目標\\n') + 1");
    point = await p.eval(`window.__j.pointForOffset(${shifted}, 0.4)`);
    await p.mouse(point.x, point.y);
    await sleep(300);
    status = await p.eval("({ refresh: !document.getElementById('refreshPreview').hidden, extra: document.getElementById('preview').textContent.includes('追加1') })");
    assert(status.refresh && !status.extra, `手動更新の状態: ${JSON.stringify(status)}`);
    await p.eval("(() => { const e = window.__j.E(); e.focus(); e.setSelectionRange(e.value.length - 50000, e.value.length); })()");
    await p.key("Delete");
    await sleep(500);
    const before = await p.eval("window.__j.state()");
    assert(before.value.length > 200000, "20万字を下回った（試験の手順の誤り）");
    const lastIndex = await p.eval("document.querySelectorAll('#preview p').length - 1");
    await p.dblclickPreview("p", { index: lastIndex });
    const after = await p.eval("window.__j.state()");
    assert(after.start === after.value.length && after.value === before.value, `末尾にそろわない: ${after.start} / ${after.value.length}`);
  });

  await check("位置の連動 T-24: IME変換中のクリックでは移らない", async () => {
    const p = await openJumpEditor(JUMP_D1);
    await p.clickLine(6, 0.3);
    await sleep(1500);
    const before = await p.eval("window.__j.P().scrollTop");
    await p.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
    await sleep(200);
    const composing = await p.eval("window.__j.E().value.includes('にほんご')");
    assert(composing, "変換中の状態にならない（試験の手順の誤り）");
    await p.clickLine(23, 0.6);
    await sleep(300);
    const s = await p.eval("({ shown: window.__j.shown(), top: window.__j.P().scrollTop })");
    console.log(`    変換中のクリック: 示した要素 ${JSON.stringify(s.shown)}、scrollTop ${before} → ${s.top}`);
    assert(s.shown.length === 0 && Math.abs(s.top - before) <= 1, `変換中のクリックで移った: ${JSON.stringify(s)}`);
    await p.send("Input.insertText", { text: "日本語" });
    await sleep(500);
    assert((await p.value()).includes("日本語"), "確定した文字が入らない");
  });

  await check("位置の連動 T-25: 示している間のコピー・書式ボタン・貼り付け・保存した設定が変わらない", async () => {
    const p = await openJumpEditor(JUMP_D1);
    const storedBefore = await p.eval("chrome.storage.local.get(null)");
    const copyAll = async () => {
      await p.click("#copyRich");
      const rich = await p.readClipboard();
      await p.eval("(() => { const e = window.__j.E(); e.focus(); e.setSelectionRange(window.__j.lineStart(6), window.__j.lineStart(10) - 1); document.dispatchEvent(new Event('selectionchange')); })()");
      await sleep(50);
      await p.click("#copySelection");
      return { rich, selection: await p.readClipboard() };
    };
    const before = await copyAll();
    await p.clickLine(23, 0.3);
    const during = await copyAll();
    for (const key of ["rich", "selection"]) {
      const text = JSON.stringify(during[key]);
      assert(text === JSON.stringify(before[key]), `${key} が示している間に変わった`);
      assert(!/jump-target|mtc-anchor|<!--/u.test(text), `${key} に目印が入った`);
    }
    await sleep(2500);
    const dom = await p.eval("(() => { const root = document.getElementById('preview'); const w = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT); const els = [...root.querySelectorAll('*')]; return { comment: w.nextNode() !== null, jump: root.querySelectorAll('.jump-target, .jump-fade').length, ids: els.filter((el) => el.id && !/^mtc-fn(ref)?-\\d+$/u.test(el.id)).length, data: els.filter((el) => [...el.attributes].some((a) => a.name.startsWith('data-') && !(el.classList.contains('mtc-image') && a.name === 'data-alt'))).length, emptyClass: els.filter((el) => el.getAttribute('class') === '').length }; })()");
    assert(!dom.comment && dom.jump === 0 && dom.ids === 0 && dom.data === 0 && dom.emptyClass === 0, `プレビューの DOM: ${JSON.stringify(dom)}`);
    await p.dblclickPreview("h1");
    await p.click("[aria-controls='headingMenu']");
    await p.click("[data-format='h2']");
    assert((await p.value()).split("\n")[3] === "## 見出し1", "ダブルクリックの後に見出し2にならない");
    await p.key("z", { ctrl: true });
    assert(await p.value() === JUMP_D1, "見出し2を1回の Undo で戻せない");
    await p.dblclickPreview("h1");
    await p.setClipboard("貼");
    await p.key("v", { ctrl: true });
    assert((await p.value()).split("\n")[3] === "貼# 見出し1", `貼り付けの位置: ${(await p.value()).split("\n")[3]}`);
    await p.key("z", { ctrl: true });
    assert(await p.value() === JUMP_D1, "貼り付けを1回の Undo で戻せない");
    const storedAfter = await p.eval("chrome.storage.local.get(null)");
    assert(JSON.stringify(storedAfter) === JSON.stringify(storedBefore), `保存した設定が変わった: ${JSON.stringify(storedAfter)}`);
  });

  await check("位置の連動 T-27: 狭い画面（編集欄が上）でも同じように動く", async () => {
    const p = await openJumpEditor(JUMP_D1, { width: 800, height: 900 });
    const layout = await p.eval("(() => { const s = window.__j.E().getBoundingClientRect(); const v = document.querySelector('.preview-pane').getBoundingClientRect(); return { stacked: s.bottom <= v.top + 1 }; })()");
    assert(layout.stacked, "編集欄が上にない");
    const point = await p.clickLine(23, 0.5);
    await sleep(200);
    await expectShown(p, "狭い画面の L23", "TR", "a1");
    const placed = await p.eval(`window.__j.placed(${point.r})`);
    assert(placed.ok, `狭い画面の位置: ${JSON.stringify(placed)}`);
    for (const [selector, line] of [["h1", 4], ["tbody tr:nth-child(2) td", 24]]) {
      const at = await p.dblclickPreview(selector);
      const s = await p.eval("window.__j.state()");
      assert(s.line === line && s.start === await p.eval(`window.__j.lineStart(${line})`), `狭い画面の ${selector}: L${s.line}`);
      const caret = await p.eval(`window.__j.caretPlaced(${line}, ${at.r})`);
      const visible = await p.eval(`(() => { const e = window.__j.E(); const y = window.__j.lineTop(${line}) - e.scrollTop; return y >= 0 && y < e.clientHeight; })()`);
      assert(caret.ok && visible, `狭い画面の行の位置: ${JSON.stringify(caret)} / 見える ${visible}`);
    }
    await p.click("#toggleSource");
    await p.dblclickPreview("h1");
    const s = await p.eval("({ ...window.__j.state(), open: document.getElementById('workspace').classList.contains('source-open') })");
    assert(s.open && s.line === 4, `狭い画面で閉じた後: ${JSON.stringify({ open: s.open, line: s.line })}`);
  });

  await check("位置の連動 T-28: アニメーションを減らす設定では一度に消し、通常は徐々に薄くする。ダークでも色が見える", async () => {
    const p = await openJumpEditor(JUMP_D1);
    const sample = async () => {
      await p.eval("window.__j.P().scrollTop = 0");
      await sleep(2000);
      const base = await p.eval("getComputedStyle(document.querySelector('#preview h1')).backgroundColor");
      await p.clickLine(4, 0.2);
      return p.eval(`new Promise((resolve) => {
        const h = document.querySelector('#preview h1');
        const shown = getComputedStyle(h).backgroundColor;
        const mo = new MutationObserver(() => {
          if (h.classList.contains('jump-target')) return;
          mo.disconnect();
          const cs = getComputedStyle(h);
          const first = { bg: cs.backgroundColor, duration: cs.transitionDuration, shadow: cs.boxShadow };
          setTimeout(() => resolve({ base: ${JSON.stringify(base)}, shown, first, later: getComputedStyle(h).backgroundColor }), 100);
        });
        mo.observe(h, { attributes: true });
      })`);
    };
    await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "light" }] });
    let s = await sample();
    assert(s.shown !== s.base, `示す色が付かない: ${JSON.stringify(s)}`);
    assert(/^0s(, 0s)*$/u.test(s.first.duration) && s.first.bg === s.base, `減らす設定で徐々に消えた: ${JSON.stringify(s)}`);
    await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }, { name: "prefers-color-scheme", value: "light" }] });
    s = await sample();
    assert(/0\.6s/u.test(s.first.duration) && s.later !== s.shown && s.later !== s.base, `通常で徐々に薄くならない: ${JSON.stringify(s)}`);
    await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await sleep(2000);
    await p.clickLine(4, 0.2);
    await sleep(100);
    const dark = await p.eval("({ shown: getComputedStyle(document.querySelector('#preview h1')).backgroundColor, pane: getComputedStyle(window.__j.P()).backgroundColor, body: getComputedStyle(document.querySelector('.preview-pane')).backgroundColor })");
    assert(dark.shown !== dark.pane && dark.shown !== dark.body, `ダークで示す色が背景と同じ: ${JSON.stringify(dark)}`);
    await p.screenshot("21-jump-dark");
    await p.send("Emulation.setEmulatedMedia", { features: [] });
  });

  await check("位置の連動 T-29: 編集欄で折り返す文書でも、行を同じ高さに出す", async () => {
    const para = "あ".repeat(300);
    const D4 = [...Array.from({ length: 20 }, () => [para, ""]).flat(), "# 目標W", "", ...Array.from({ length: 20 }, () => [para, ""]).flat()].join("\n").replace(/\n$/u, "");
    const p = await openJumpEditor(D4);
    await p.dblclickPreview("h1", { at: 0.4 });
    const s = await p.eval("window.__j.state()");
    const target = await p.eval("window.__j.E().value.indexOf('# 目標W')");
    assert(s.start === target && s.focus === "source", `カーソル: ${s.start} / 期待 ${target}`);
    const measured = await p.eval(`(() => { const e = window.__j.E(); return { y: window.__j.wrappedTop(${target}) - e.scrollTop, want: 0.4 * e.clientHeight, lh: window.__j.lh() }; })()`);
    assert(Math.abs(measured.y - measured.want) <= measured.lh, `折り返す行の位置: ${JSON.stringify(measured)}`);
    const point = await p.eval(`window.__j.pointForOffset(${target}, 0.5)`);
    await p.mouse(point.x, point.y);
    await sleep(200);
    await expectShown(p, "# 目標W", "H1", "目標W");
  });

  await check("位置の連動 T-32: 約10万字で、対応表を作っても描画が遅くならず、クリックで示す", async () => {
    const unit = JUMP_D1.split("\n").slice(3).join("\n");
    let D6 = unit;
    while (D6.length < 100000) {
      D6 += `\n\n${unit}`;
    }
    // 7部品すべてを有効にすると、対応表がなくても約10万字の描画に数秒かかり手動更新になる（1.2.1 からの既存の性質）。
    // そのため「自動更新のまま」ではなく、対応表の有無で描画の時間が変わらないことを、部品なし・7部品の両方で確かめる
    // 短い塊ばかりの D6 は目印が約1万4千個になる最悪に近い文書なので 1.6倍＋60ms、普通の文章は 1.3倍＋50ms を上限とする
    const prose = Array.from({ length: 300 }, (_, i) => `## 節${i}\n\n${"日本語の文章です。".repeat(30)}\n\n- 項目A\n- 項目B\n`).join("\n");
    const probe = await openEditor();
    await probe.eval(`window.__docs = ${JSON.stringify({ dense: D6, prose })}`);
    const timing = await probe.eval(`(async () => {
      const { createRenderer } = await import("./core/render.js");
      const r = createRenderer(window, {});
      const measure = (src, features, anchors) => {
        let best = Infinity;
        for (let i = 0; i < 3; i++) {
          const t = performance.now();
          r.renderDocument(src, { features, anchors });
          best = Math.min(best, performance.now() - t);
        }
        return Math.round(best);
      };
      const all = ${JSON.stringify(["alerts", "footnotes", "math", "containers", "highlight", "wikilinks", "deflists"])};
      const { dense, prose } = window.__docs;
      measure(dense, [], true);
      return {
        none: measure(dense, [], false), noneAnchors: measure(dense, [], true),
        all: measure(dense, all, false), allAnchors: measure(dense, all, true),
        prose: measure(prose, [], false), proseAnchors: measure(prose, [], true),
      };
    })()`);
    console.log(`    ${D6.length.toLocaleString()} 字（短い塊ばかり）の描画: 部品なし ${timing.none}ms → 対応表あり ${timing.noneAnchors}ms / 7部品 ${timing.all}ms → ${timing.allAnchors}ms`);
    console.log(`    ${prose.length.toLocaleString()} 字（普通の文章）の描画: ${timing.prose}ms → 対応表あり ${timing.proseAnchors}ms`);
    assert(timing.noneAnchors <= timing.none * 1.6 + 60 && timing.allAnchors <= timing.all * 1.6 + 60, `対応表で描画が遅くなった（短い塊）: ${JSON.stringify(timing)}`);
    assert(timing.proseAnchors <= timing.prose * 1.3 + 50, `対応表で描画が遅くなった（普通の文章）: ${JSON.stringify(timing)}`);
    const p = await openJumpEditor(D6, { paste: true });
    const middle = await p.eval("(() => { const v = window.__j.E().value; return v.indexOf('\\n# 見出し1', Math.floor(v.length / 2)) + 1; })()");
    const point = await p.eval(`window.__j.pointForOffset(${middle}, 0.4)`);
    const started = Date.now();
    await p.mouse(point.x, point.y);
    let shown = [];
    for (let i = 0; i < 100 && shown.length === 0; i++) {
      shown = await p.eval("window.__j.shown()");
      if (shown.length === 0) {
        await sleep(20);
      }
    }
    assert(shown.length === 1 && shown[0].tag === "H1", `中ほどの見出し: ${JSON.stringify(shown)}`);
    console.log(`    ${D6.length.toLocaleString()} 字: クリックから示すまで ${Date.now() - started}ms（CDP の往復を含む）`);
  });


  // ---- 1.4.0（試験表 docs/verification.md の 20261117-features-140） ----

  const ja = lang === "ja";
  const L140 = {
    total: (n) => (ja ? `${n} 件` : `${n} matches`),
    none: ja ? "見つかりません" : "No matches",
    replaced: (n) => (ja ? `${n} 件を置換しました` : `Replaced ${n} matches`),
    // 英語は数が1のときだけ単数形（1.4.1）
    stats: (c, l, w) => (ja ? `${c} 文字 · ${l} 行 · ${w} 語` : `${c} character${c === 1 ? "" : "s"} · ${l} line${l === 1 ? "" : "s"} · ${w} word${w === 1 ? "" : "s"}`),
    selection: (c, l) => (ja ? `選択 ${c} 文字 · ${l} 行` : `Selection: ${c} character${c === 1 ? "" : "s"} · ${l} line${l === 1 ? "" : "s"}`),
  };
  const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, " ": 32, Backspace: 8, ArrowDown: 40, ArrowUp: 38, Insert: 45 };

  /** キーを送る（Alt・Meta・Tab・Space も扱う）。 */
  async function press(p, key, { ctrl = false, shift = false, alt = false, meta = false } = {}) {
    const single = key.length === 1 && key !== " ";
    const code = single ? `Key${key.toUpperCase()}` : key === " " ? "Space" : key;
    const vk = single ? key.toUpperCase().charCodeAt(0) : KEY_CODES[key];
    const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
    const shown = single && shift ? key.toUpperCase() : key;
    await p.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: shown, code, windowsVirtualKeyCode: vk, modifiers });
    if ((key === "Enter" || key === " ") && !ctrl && !alt && !meta) {
      await p.send("Input.dispatchKeyEvent", { type: "char", key: shown, code, text: key === "Enter" ? "\r" : " ", windowsVirtualKeyCode: vk, modifiers });
    }
    await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: shown, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(60);
  }

  /** "‸" をカーソル、"«" "»" を選択として書いた値を編集欄に設定する（value の代入と input）。 */
  async function setMarked(p, marked, wait = 60) {
    let text = marked;
    let start;
    let end;
    if (marked.includes("‸")) {
      start = end = marked.indexOf("‸");
      text = marked.replace("‸", "");
    } else if (marked.includes("«")) {
      start = marked.indexOf("«");
      text = marked.replace("«", "");
      end = text.indexOf("»");
      text = text.replace("»", "");
    } else {
      start = end = marked.length;
    }
    await p.eval(`(() => { const s = document.getElementById('source'); s.focus(); s.value = ${JSON.stringify(text)}; s.dispatchEvent(new Event('input', { bubbles: true })); s.setSelectionRange(${start}, ${end}); })()`);
    await sleep(wait);
    return text;
  }

  /** 編集欄の値と選択を "‸"・"«»" で書く。 */
  function marked(p) {
    return p.eval(`(() => { const s = document.getElementById('source'); const v = s.value; const a = s.selectionStart; const b = s.selectionEnd;
      return a === b ? v.slice(0, a) + "‸" + v.slice(a) : v.slice(0, a) + "«" + v.slice(a, b) + "»" + v.slice(b); })()`);
  }

  async function open140({ width = 1280, height = 800 } = {}) {
    const p = await openEditor();
    await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    // 拡張がキーの既定の動作を止めたかを、後から登録した window の keydown で記録する
    await p.eval("window.__dp = []; window.addEventListener('keydown', (e) => window.__dp.push(e.defaultPrevented))");
    return p;
  }
  const lastPrevented = (p) => p.eval("window.__dp.at(-1)");
  const active = (p) => p.eval("document.activeElement?.id ?? ''");
  const text140 = (p, id) => p.eval(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const visible = (p, id) => p.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return !!el && !el.hidden && el.offsetParent !== null; })()`);

  await check("1.4.0 T-01: Enter でリスト・引用の記号を続け、1回の Undo で戻る", async () => {
    const p = await open140();
    const cases = [
      ["- 項目A‸", "- 項目A\n- ‸"], ["* 項目B‸", "* 項目B\n* ‸"], ["+ 項目C‸", "+ 項目C\n+ ‸"], ["1. 番号‸", "1. 番号\n2. ‸"],
      ["9) 番号‸", "9) 番号\n10) ‸"], ["- [x] 済み‸", "- [x] 済み\n- [ ] ‸"], ["- [ ] 未‸", "- [ ] 未\n- [ ] ‸"], ["> 引用‸", "> 引用\n> ‸"],
      ["> - 引用のリスト‸", "> - 引用のリスト\n> - ‸"], ["  - 入れ子‸", "  - 入れ子\n  - ‸"], ["- 前半‸後半", "- 前半\n- ‸後半"],
    ];
    for (const [before, after] of cases) {
      const original = await setMarked(p, before);
      await press(p, "Enter");
      assert(await marked(p) === after, `${JSON.stringify(before)} → ${JSON.stringify(await marked(p))}`);
      await press(p, "z", { ctrl: true });
      assert(await p.value() === original, `${JSON.stringify(before)} の Undo: ${JSON.stringify(await p.value())}`);
    }
  });

  await check("1.4.0 T-02: 記号だけの行の Enter は記号を消し、1回の Undo で戻る", async () => {
    const p = await open140();
    const cases = [["- 項目\n- ‸", "- 項目\n‸"], ["1. a\n2. ‸", "1. a\n‸"], ["- [ ] ‸", "‸"], ["> ‸", "‸"], ["  - ‸", "‸"], ["-    ‸", "‸"], ["- a\n- ‸\n- c", "- a\n‸\n- c"]];
    for (const [before, after] of cases) {
      const original = await setMarked(p, before);
      await press(p, "Enter");
      assert(await marked(p) === after, `${JSON.stringify(before)} → ${JSON.stringify(await marked(p))}`);
      await press(p, "z", { ctrl: true });
      assert(await p.value() === original, `${JSON.stringify(before)} の Undo`);
    }
  });

  await check("1.4.0 T-03: Shift+Enter・選択中・IME 変換中・リストでない行では標準の改行", async () => {
    const p = await open140();
    await setMarked(p, "- a‸");
    await press(p, "Enter", { shift: true });
    assert(await p.value() === "- a\n", `Shift+Enter: ${JSON.stringify(await p.value())}`);
    assert(await lastPrevented(p) === false, "Shift+Enter の既定の動作を止めた");
    await setMarked(p, "- «項目»");
    await press(p, "Enter");
    assert(await p.value() === "- \n", `選択中: ${JSON.stringify(await p.value())}`);
    for (const init of ["{ key: 'Enter', isComposing: true, cancelable: true, bubbles: true }", "{ key: 'Enter', cancelable: true, bubbles: true }"]) {
      await setMarked(p, "- a‸");
      const prevented = await p.eval(`(() => { const e = new KeyboardEvent('keydown', ${init}); if (!e.isComposing) Object.defineProperty(e, 'keyCode', { get: () => 229 }); document.getElementById('source').dispatchEvent(e); return e.defaultPrevented; })()`);
      assert(prevented === false && await p.value() === "- a", `変換中の Enter に介入した: ${init}`);
    }
    for (const [before, after] of [["段落‸", "段落\n"], ["‸- a", "\n- a"], ["* * *‸", "* * *\n"], ["- - -‸", "- - -\n"]]) {
      await setMarked(p, before);
      await press(p, "Enter");
      assert(await p.value() === after && await lastPrevented(p) === false, `${JSON.stringify(before)} → ${JSON.stringify(await p.value())}`);
    }
  });

  await check("1.4.0 T-04〜T-07: Tab・Shift+Tab でリストの項目を字下げ・解除し、リストでなければフォーカスが移る", async () => {
    const p = await open140();
    const cases = [
      ["- a\n- b‸", false, "- a\n  - b‸"], ["1. a\n2. b‸", false, "1. a\n   2. b‸"], ["10. a\n11. b‸", false, "10. a\n    11. b‸"],
      ["- [ ] a\n- [ ] b‸", false, "- [ ] a\n  - [ ] b‸"], ["- a‸", false, "  - a‸"], ["1. a‸", false, "   1. a‸"],
      ["- a\n  - b‸", true, "- a\n- b‸"], ["1. a\n   - b‸", true, "1. a\n- b‸"], ["- a\n  - b\n    - c‸", true, "- a\n  - b\n  - c‸"], ["   - a‸", true, "- a‸"],
      ["- a\n«- b\n\n- c»", false, "- a\n«  - b\n\n  - c»"],
    ];
    for (const [before, shift, after] of cases) {
      const original = await setMarked(p, before);
      await press(p, "Tab", { shift });
      assert(await marked(p) === after, `${JSON.stringify(before)} ${shift ? "Shift+Tab" : "Tab"} → ${JSON.stringify(await marked(p))}`);
      assert(await active(p) === "source", `${JSON.stringify(before)}: フォーカスが移った`);
      await press(p, "z", { ctrl: true });
      assert(await p.value() === original, `${JSON.stringify(before)} の Undo`);
    }
    await setMarked(p, "- a‸");
    await press(p, "Tab", { shift: true });
    assert(await p.value() === "- a" && await active(p) === "source" && await lastPrevented(p) === true, "字下げのない項目の Shift+Tab");
    for (const [before, shift] of [["段落‸", false], ["«- a\n段落\n- b»", false], ["段落‸", true]]) {
      const original = await setMarked(p, before);
      await press(p, "Tab", { shift });
      assert(await p.value() === original && await active(p) !== "source", `${JSON.stringify(before)}: フォーカスが移らない`);
    }
  });

  const DH = ["---", "# yamlコメント", "---", "# 見出し1", "## 見出し2", "##### 見出し5", "###### 見出し6", "#ハッシュ", "本文の # は行頭でない", "   ## 字下げ3", "", "```md", "# コードの中", "```", "", "~~~", "## チルダの中", "~~~", "", "見出しS", "==="].join("\n");

  await check("1.4.0 T-08・T-09: 見出しを1段下げる・上げる（1回の Undo で戻る）", async () => {
    const p = await open140();
    const caret = DH.indexOf("本文の # は行頭でない") + "本文の # は行頭でない".length;
    const markedDH = `${DH.slice(0, caret)}‸${DH.slice(caret)}`;
    await setMarked(p, markedDH);
    await p.format("headingDown");
    const down = DH.replace("# 見出し1", "## 見出し1").replace("## 見出し2", "### 見出し2").replace("##### 見出し5", "###### 見出し5").replace("   ## 字下げ3", "   ### 字下げ3");
    assert(await p.value() === down, `下げる: ${JSON.stringify(await p.value())}`);
    assert((await marked(p)).split("‸")[0].endsWith("本文の # は行頭でない"), "カーソルの位置が保たれない");
    await press(p, "z", { ctrl: true });
    assert(await p.value() === DH, "下げるの Undo");
    await setMarked(p, markedDH);
    await p.format("headingUp");
    const up = DH.replace("## 見出し2", "# 見出し2").replace("##### 見出し5", "#### 見出し5").replace("###### 見出し6", "##### 見出し6").replace("   ## 字下げ3", "   # 字下げ3");
    assert(await p.value() === up, `上げる: ${JSON.stringify(await p.value())}`);
    await press(p, "z", { ctrl: true });
    assert(await p.value() === DH, "上げるの Undo");
    await setMarked(p, "# A\n# «B»\n# C");
    await p.format("headingDown");
    assert(await marked(p) === "# A\n## «B»\n# C", `選択した行だけ: ${await marked(p)}`);
    for (const command of ["headingDown", "headingUp"]) {
      await setMarked(p, "‸段落\n- 項目");
      await p.format(command);
      assert(await marked(p) === "‸段落\n- 項目", `${command}: 見出しがないのに変わった`);
    }
  });

  await check("1.4.0 T-10〜T-12: 文字を選んで URL を貼り付けるとリンクにする（書式付きの貼り付けより優先）", async () => {
    const p = await open140();
    for (const [url, result] of [
      ["https://example.com/a?b=1", "リンク先の[説明](https://example.com/a?b=1)"], ["http://example.com/", "リンク先の[説明](http://example.com/)"],
      ["mailto:user@example.com", "リンク先の[説明](mailto:user@example.com)"], ["  https://example.com/x \n", "リンク先の[説明](https://example.com/x)"],
    ]) {
      await setMarked(p, "リンク先の«説明»");
      await p.setClipboard(url);
      await p.eval("document.getElementById('source').focus()");
      await press(p, "v", { ctrl: true });
      assert(await marked(p) === `${result}‸`, `${JSON.stringify(url)} → ${await marked(p)}`);
      await press(p, "z", { ctrl: true });
      assert(await p.value() === "リンク先の説明", `${url} の Undo: ${await p.value()}`);
    }
    for (const [before, url, after] of [
      ["前 «説明» 後", "example.com", "前 example.com 後"], ["前 «説明» 後", "ftp://example.com", "前 ftp://example.com 後"],
      ["前 «説明» 後", "https://exa mple.com", "前 https://exa mple.com 後"], ["前 «説明» 後", "https://a.example\nhttps://b.example", "前 https://a.example\nhttps://b.example 後"],
      ["«https://old.example»", "https://new.example", "https://new.example"], ["«前\n説明»", "https://example.com", "https://example.com"],
      ["前«   »後", "https://example.com", "前https://example.com後"], ["前 ‸説明 後", "https://example.com", "前 https://example.com説明 後"],
    ]) {
      await setMarked(p, before);
      await p.setClipboard(url);
      await p.eval("document.getElementById('source').focus()");
      await press(p, "v", { ctrl: true });
      assert(await p.value() === after, `${JSON.stringify(before)} + ${JSON.stringify(url)} → ${JSON.stringify(await p.value())}`);
    }
    // 書式付きテキストの貼り付けをオンにしても、リンクにする方を優先する
    await p.click("#settingsMenuButton");
    await p.click("#openPaste");
    await p.eval("document.getElementById('pasteHtml').checked = true");
    await p.click("#pasteDialog button[value='ok']");
    await sleep(300);
    await setMarked(p, "リンク先の«説明»");
    await p.eval("document.getElementById('toast').hidden = true");
    await p.setClipboard("https://example.com/", "<a href=\"https://example.com/\">Example</a>");
    await p.eval("document.getElementById('source').focus()");
    await press(p, "v", { ctrl: true });
    assert(await p.value() === "リンク先の[説明](https://example.com/)", `オン: ${await p.value()}`);
    assert(!(await p.toast()).includes(ja ? "変換して" : "onvert"), `変換の通知が出た: ${await p.toast()}`);
    await press(p, "z", { ctrl: true });
    assert(await p.value() === "リンク先の説明", "オンの Undo");
  });

  await check("1.4.0 T-13: Ctrl+I・Ctrl+K・Ctrl+E は斜体・リンク・インラインコードのボタンと同じ結果", async () => {
    const p = await open140();
    for (const [format, key] of [["italic", "i"], ["link", "k"], ["code", "e"]]) {
      for (const start of ["abc‸", "abc «def» ghi"]) {
        await setMarked(p, start);
        await p.format(format);
        const byButton = await marked(p);
        const original = await setMarked(p, start);
        await press(p, key, { ctrl: true });
        const byKey = await marked(p);
        assert(byKey === byButton, `${format} ${start}: ボタン ${byButton} / キー ${byKey}`);
        await press(p, "z", { ctrl: true });
        assert(await p.value() === original, `${format} ${start} の Undo`);
      }
    }
    await setMarked(p, "abc «def» ghi");
    await press(p, "k", { ctrl: true });
    assert(await marked(p) === "abc [def](«https://») ghi", `Ctrl+K: ${await marked(p)}`);
  });

  await check("1.4.0 T-14: Ctrl+Shift+C・Ctrl+Shift+M は2つのコピーのボタンと同じ。ダイアログを開いていれば何もしない", async () => {
    const p = await open140();
    const doc = "# 題\n\n**太字** と [リンク](https://example.com)";
    await setMarked(p, doc, 600);
    await p.click("#copyRich");
    const rich = await p.readClipboard();
    await p.click("#copyMarkdown");
    const md = await p.readClipboard();
    const places = [
      ["編集欄", "document.getElementById('source').focus()"],
      ["プレビュー", "document.getElementById('previewScroller').focus()"],
    ];
    for (const [name, focus] of places) {
      await p.setClipboard("SENTINEL-140");
      await p.eval(focus);
      await press(p, "c", { ctrl: true, shift: true });
      await sleep(200);
      const got = await p.readClipboard();
      assert(lf(got["text/plain"]) === lf(rich["text/plain"]) && got["text/html"] === rich["text/html"], `${name}: Ctrl+Shift+C ${JSON.stringify(got).slice(0, 200)}`);
      await p.setClipboard("SENTINEL-140");
      await press(p, "m", { ctrl: true, shift: true });
      await sleep(200);
      const gotMd = await p.readClipboard();
      assert(lf(gotMd["text/plain"]) === lf(md["text/plain"]), `${name}: Ctrl+Shift+M ${JSON.stringify(gotMd)}`);
    }
    // 検索語の欄の中でも
    await press(p, "h", { ctrl: true });
    assert(await active(p) === "searchQuery", "Ctrl+H で検索語の欄にフォーカスが移らない");
    await p.setClipboard("SENTINEL-140");
    await press(p, "c", { ctrl: true, shift: true });
    await sleep(200);
    assert(lf((await p.readClipboard())["text/plain"]) === lf(rich["text/plain"]), "検索語の欄で Ctrl+Shift+C");
    await press(p, "Escape");
    assert(await p.value() === doc, "コピーで値が変わった");
    // ダイアログを開いているときは何もしない
    await p.click("#settingsMenuButton");
    await p.click("#openSyntax");
    await p.setClipboard("SENTINEL-140");
    for (const key of ["c", "m"]) {
      await press(p, key, { ctrl: true, shift: true });
    }
    await press(p, "h", { ctrl: true });
    await sleep(200);
    const kept = await p.readClipboard();
    assert(lf(kept["text/plain"]) === "SENTINEL-140" && !kept["text/html"], `ダイアログ中にクリップボードが変わった: ${JSON.stringify(kept)}`);
    assert(!(await visible(p, "searchBar")) && await p.eval("document.getElementById('syntaxDialog').open"), "ダイアログ中に検索バーが開いた・ダイアログが閉じた");
    await p.click("#syntaxDialog button[value='cancel']");
  });

  await check("1.4.0 T-15: キーボード操作の一覧とツールチップ", async () => {
    const p = await open140();
    await setMarked(p, "本文");
    await p.click("#settingsMenuButton");
    await p.click("#openKeys");
    const dialog = await p.eval("(() => { const d = document.getElementById('keysDialog'); return { open: d.open, text: d.textContent, buttons: d.querySelectorAll('button').length }; })()");
    await p.screenshot("140-keys-dialog");
    assert(dialog.open && dialog.buttons === 1, `ダイアログ: ${JSON.stringify(dialog).slice(0, 200)}`);
    for (const key of ["Ctrl+B", "Ctrl+I", "Ctrl+K", "Ctrl+E", "Ctrl+Shift+C", "Ctrl+Shift+M", "Ctrl+H", "Ctrl+V", "Ctrl+Z", "Ctrl+Y", "Enter", "Shift+Enter", "Esc", "Tab", "Shift+Tab", "URL"]) {
      assert(dialog.text.includes(key), `一覧に ${key} がない`);
    }
    await p.click("#keysDialog button[value='close']");
    assert(!(await p.eval("document.getElementById('keysDialog').open")) && await p.value() === "本文", "閉じない・値が変わった");
    const titles = await p.eval("({ italic: document.querySelector(\"[data-format='italic']\").title, link: document.querySelector(\"[data-format='link']\").title, code: document.querySelector(\"[data-format='code']\").title, bold: document.querySelector(\"[data-format='bold']\").title, rich: document.getElementById('copyRich').title, md: document.getElementById('copyMarkdown').title })");
    assert(titles.italic.endsWith("(Ctrl+I)") && titles.link.endsWith("(Ctrl+K)") && titles.code.endsWith("(Ctrl+E)") && titles.bold.endsWith("(Ctrl+B)") && titles.rich.endsWith("(Ctrl+Shift+C)") && titles.md.endsWith("(Ctrl+Shift+M)"), `ツールチップ: ${JSON.stringify(titles)}`);
    if (ja) {
      assert(titles.italic === "斜体 (Ctrl+I)" && titles.link === "リンク (Ctrl+K)" && titles.code === "インラインコード (Ctrl+E)" && titles.bold === "太字 (Ctrl+B)", `日本語のツールチップ: ${JSON.stringify(titles)}`);
    }
  });

  const DS = "apple Apple APPLE\nbanana apple pie\napple";
  const sel = (p) => p.eval("[document.getElementById('source').selectionStart, document.getElementById('source').selectionEnd]");
  async function typeQuery(p, id, value) {
    await p.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.focus(); el.select(); })()`);
    if (value === "") {
      await press(p, "Backspace");
    } else {
      await p.send("Input.insertText", { text: value });
    }
    await sleep(60);
  }

  await check("1.4.0 T-16: 検索の次へ・前へ・件数・大文字と小文字の区別", async () => {
    const p = await open140();
    await setMarked(p, `${DS.slice(0, 18)}‸${DS.slice(18)}`);
    await press(p, "h", { ctrl: true });
    assert(await visible(p, "searchBar") && await active(p) === "searchQuery", "Ctrl+H で検索バーが出ない");
    await p.send("Input.insertText", { text: "apple" });
    await sleep(60);
    assert(await text140(p, "searchCount") === L140.total(5), `件数: ${await text140(p, "searchCount")}`);
    const steps = [[false, [25, 30], "4 / 5"], [false, [35, 40], "5 / 5"], [false, [0, 5], "1 / 5"], [true, [35, 40], "5 / 5"], [true, [25, 30], "4 / 5"]];
    for (const [shift, range, count] of steps) {
      await press(p, "Enter", { shift });
      const got = await sel(p);
      assert(got[0] === range[0] && got[1] === range[1] && await text140(p, "searchCount") === count, `${shift ? "Shift+Enter" : "Enter"}: ${got} ${await text140(p, "searchCount")}`);
      assert(await active(p) === "searchQuery", "フォーカスが検索語の欄から移った");
    }
    await p.screenshot("140-search");
    await p.click("#searchCase");
    assert(await text140(p, "searchCount") === "2 / 3", `区別: ${await text140(p, "searchCount")}`);
    await p.click("#searchNext");
    assert(JSON.stringify(await sel(p)) === "[35,40]" && await text140(p, "searchCount") === "3 / 3", "区別して次へ");
    await p.click("#searchNext");
    assert(JSON.stringify(await sel(p)) === "[0,5]" && await text140(p, "searchCount") === "1 / 3", "区別して次へ（先頭へ戻る）");
    await p.click("#searchCase");
    assert(await text140(p, "searchCount") === "1 / 5", `区別を外す: ${await text140(p, "searchCount")}`);
    await typeQuery(p, "searchQuery", "pear");
    assert(await text140(p, "searchCount") === L140.none && await p.value() === DS, "見つからない");
  });

  await check("1.4.0 T-17・T-18: 置換とすべて置換（1回の Undo で戻る）", async () => {
    const p = await open140();
    await setMarked(p, "cat dog cat dog cat");
    await press(p, "h", { ctrl: true });
    await typeQuery(p, "searchQuery", "cat");
    await typeQuery(p, "searchReplace", "bird");
    await p.eval("document.getElementById('source').setSelectionRange(0, 3)");
    await p.click("#replaceOne");
    assert(await p.value() === "bird dog cat dog cat" && JSON.stringify(await sel(p)) === "[9,12]" && await text140(p, "searchCount") === "1 / 2", `1回目: ${await p.value()} ${await sel(p)} ${await text140(p, "searchCount")}`);
    await p.click("#replaceOne");
    assert(await p.value() === "bird dog bird dog cat" && JSON.stringify(await sel(p)) === "[18,21]" && await text140(p, "searchCount") === "1 / 1", `2回目: ${await p.value()} ${await sel(p)}`);
    await p.eval("document.getElementById('source').focus()");
    await press(p, "z", { ctrl: true });
    assert(await p.value() === "bird dog cat dog cat", `Undo: ${await p.value()}`);
    await p.eval("document.getElementById('source').setSelectionRange(0, 0)");
    await p.click("#replaceOne");
    assert(await p.value() === "bird dog cat dog cat" && JSON.stringify(await sel(p)) === "[9,12]", `一致を選んでいない置換: ${await p.value()} ${await sel(p)}`);

    await setMarked(p, "a-b a-b A-B");
    await typeQuery(p, "searchQuery", "a-b");
    await typeQuery(p, "searchReplace", "x");
    await p.click("#replaceAll");
    assert(await p.value() === "x x x" && await p.toast() === L140.replaced(3), `すべて置換: ${await p.value()} ${await p.toast()}`);
    await p.eval("document.getElementById('source').focus()");
    await press(p, "z", { ctrl: true });
    assert(await p.value() === "a-b a-b A-B", `すべて置換の Undo: ${await p.value()}`);
    await press(p, "y", { ctrl: true });
    assert(await p.value() === "x x x", `Redo: ${await p.value()}`);
    await typeQuery(p, "searchQuery", "zzz");
    await p.click("#replaceAll");
    assert(await p.value() === "x x x" && await p.toast() === L140.none, `見つからない: ${await p.toast()}`);
  });

  await check("1.4.0 T-19: 検索バーはメニューからも開け、Esc・×・クリア・編集欄を閉じた状態で正しく動く", async () => {
    const p = await open140();
    await setMarked(p, DS);
    await p.click("#settingsMenuButton");
    await p.click("#openSearch");
    assert(await visible(p, "searchBar") && await active(p) === "searchQuery", "メニューから開かない");
    await typeQuery(p, "searchQuery", "apple");
    await p.eval("document.getElementById('source').setSelectionRange(0, 0)");
    await p.click("#searchNext");
    const chosen = await sel(p);
    await p.eval("document.getElementById('searchQuery').focus()");
    await press(p, "Escape");
    assert(!(await visible(p, "searchBar")) && await active(p) === "source" && JSON.stringify(await sel(p)) === JSON.stringify(chosen), "Esc");
    await press(p, "h", { ctrl: true });
    await p.click("#searchClose");
    assert(!(await visible(p, "searchBar")) && await active(p) === "source", "×");
    await press(p, "h", { ctrl: true });
    await p.click("#clear");
    await p.click("#clearDialog button[value='clear']");
    assert(!(await visible(p, "searchBar")), "クリアで閉じない");
    await setMarked(p, DS);
    await p.click("#toggleSource");
    await p.eval("document.body.focus()");
    await press(p, "h", { ctrl: true });
    const state140 = await p.eval("({ open: document.getElementById('workspace').classList.contains('source-open'), label: document.getElementById('toggleSourceLabel').textContent })");
    assert(state140.open && await visible(p, "searchBar") && await active(p) === "searchQuery", `編集欄を閉じた状態の Ctrl+H: ${JSON.stringify(state140)}`);
  });

  await check("1.4.0 T-20・T-21: 文字数・行数・語数の表示", async () => {
    const p = await open140();
    const stats = () => text140(p, "stats");
    for (const [value, expected] of [["", L140.stats(0, 0, 0)], ["Hello, world 123", L140.stats(16, 1, 3)], ["a\nb\n", L140.stats(2, 3, 2)], ["a".repeat(12345), L140.stats("12,345", 1, 1)], ["x", L140.stats(1, 1, 1)]]) {
      await setMarked(p, value, 300);
      assert(await stats() === expected, `${JSON.stringify(value.slice(0, 20))}: ${await stats()}`);
    }
    await setMarked(p, "one «two\nthree» four\nfive", 300);
    assert(await stats() === `${L140.selection(8, 2)} · ${L140.stats(21, 3, 5)}`, `選択中: ${await stats()}`);
    await p.eval("(() => { const s = document.getElementById('source'); s.setSelectionRange(s.value.length, s.value.length); })()");
    await sleep(100);
    assert(await stats() === L140.stats(21, 3, 5), `選択の解除: ${await stats()}`);
    await p.send("Input.insertText", { text: "x" });
    await sleep(300);
    assert(await stats() === L140.stats(22, 3, 5), `入力後: ${await stats()}`);
    await p.click("#toggleSource");
    assert(!(await visible(p, "stats")), "編集欄を閉じても文字数が見える");
    await p.click("#toggleSource");
    await setMarked(p, "a".repeat(200000), 500);
    assert(await stats() === L140.stats("200,000", 1, 1), `20万: ${await stats()}`);
    await p.send("Input.insertText", { text: "a" });
    await sleep(500);
    const over = await stats();
    assert(over.startsWith(ja ? "200,001 文字 · 1 行 · " : "200,001 characters · 1 line · ") && over.includes("—") && !/\d\s*(語|words)/u.test(over), `20万超: ${over}`);
  });

  const F140 = "埋め草の段落です。".repeat(20);
  const fill = (n) => Array.from({ length: n }, () => F140).join("\n\n");
  const DT = ["# 章1", "", fill(10), "", "## 節1.1", "", fill(10), "", "### 項1.1.1", "", "<h2>HTMLの見出し</h2>", "", "```md", "# コードの中", "```", "", "章2", "===", "", fill(10), "", "## 節2.1", "", fill(10)].join("\n");
  const tocItems = (p) => p.eval("[...document.querySelectorAll('#tocMenu [role=menuitem]')].map((b) => ({ text: b.textContent, left: b.getBoundingClientRect().left + parseFloat(getComputedStyle(b).paddingLeft), em: parseFloat(getComputedStyle(b).fontSize) }))");
  const headingTop = (p, selector, text) => p.eval(`(() => { const h = [...document.querySelectorAll('#preview ${selector}')].find((el) => el.textContent.trim() === ${JSON.stringify(text)}); const s = document.getElementById('previewScroller'); return { y: h.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientTop, max: s.scrollTop >= s.scrollHeight - s.clientHeight - 1, shown: h.classList.contains('jump-target') }; })()`);

  await check("1.4.0 T-22・T-23: 目次の項目・移動・表示の条件", async () => {
    const p = await open140();
    await setMarked(p, DT, 1000);
    assert(await visible(p, "tocWrap"), "［目次▾］が出ない");
    await p.click("#tocButton");
    await p.screenshot("140-toc");
    const items = await tocItems(p);
    assert(JSON.stringify(items.map((i) => i.text)) === JSON.stringify(["章1", "節1.1", "項1.1.1", "章2", "節2.1"]), `項目: ${JSON.stringify(items.map((i) => i.text))}`);
    const base = items[0].left;
    const indents = items.map((i) => Math.round((i.left - base) / i.em));
    assert(JSON.stringify(indents) === "[0,1,2,0,1]", `字下げ: ${JSON.stringify(items)}`);
    await p.eval("document.getElementById('previewScroller').scrollTop = 0; document.getElementById('source').setSelectionRange(0, 0)");
    await p.eval("document.querySelectorAll('#tocMenu [role=menuitem]')[4].click()");
    await sleep(300);
    const top = await headingTop(p, "h2", "節2.1");
    assert((Math.abs(top.y - 16) <= 2 || top.max) && top.shown, `移った位置: ${JSON.stringify(top)}`);
    const caret = await sel(p);
    assert(caret[0] === DT.indexOf("## 節2.1") && caret[1] === caret[0], `カーソル: ${caret}`);
    assert(await active(p) === "tocButton" && await p.value() === DT, "フォーカス・値");
    await p.installJumpHelpers();
    const lineY = await p.eval(`(() => { const e = window.__j.E(); return { y: window.__j.wrappedTop(${DT.indexOf("## 節2.1")}) - e.scrollTop, h: e.clientHeight }; })()`);
    assert(lineY.y >= 0 && lineY.y < lineY.h, `編集欄でその行が見えない: ${JSON.stringify(lineY)}`);
    await sleep(1800);
    assert(!(await headingTop(p, "h2", "節2.1")).shown, "2秒後も示している");
    for (const value of ["段落だけ", "<h1>HTMLだけ</h1>", "```\n# コードだけ\n```"]) {
      await setMarked(p, value, 1000);
      assert(!(await visible(p, "tocWrap")), `${value}: ［目次▾］が出た`);
    }
    await setMarked(p, DT, 1000);
    await p.click("#toggleSource");
    await p.click("#tocButton");
    await p.eval("document.querySelectorAll('#tocMenu [role=menuitem]')[3].click()");
    await sleep(300);
    const closed = await headingTop(p, "h1", "章2");
    assert((Math.abs(closed.y - 16) <= 2 || closed.max) && closed.shown, `閉じた状態: ${JSON.stringify(closed)}`);
    assert(!(await p.eval("document.getElementById('workspace').classList.contains('source-open')")), "編集欄が開いた");
    assert((await sel(p))[0] === DT.indexOf("章2\n===") && await active(p) === "tocButton", "閉じた状態のカーソル・フォーカス");
  });

  const DC = [fill(6), "", "- [ ] 未完了", "- [x] 完了", "- [X] 大文字", "  - [ ] 子", "", "1. [ ] 番号", "", "<input type=\"checkbox\">", "", "> - [ ] 引用の中", "", "- [ ] 同じ", "- [ ] 同じ", "", fill(20)].join("\n");
  const boxPoint = (p, text) => p.eval(`(() => { const li = [...document.querySelectorAll('#preview li')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)})); const box = li.querySelector('input'); const r = box.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, checked: box.checked }; })()`);

  await check("1.4.0 T-24・T-25: プレビューのチェックボックスで原文の [ ] と [x] を切り替える", async () => {
    const p = await open140();
    await setMarked(p, DC, 1000);
    await p.eval("(() => { const li = [...document.querySelectorAll('#preview li')].find((el) => el.textContent.trim().startsWith('未完了')); li.scrollIntoView({ block: 'center' }); })()");
    await sleep(100);
    const scrollTop = await p.eval("document.getElementById('previewScroller').scrollTop");
    assert(scrollTop > 0, "スクロールできない");
    const clickBox = async (text) => {
      const point = await boxPoint(p, text);
      await p.mouse(point.x, point.y);
      await sleep(500);
    };
    await clickBox("未完了");
    assert(await p.value() === DC.replace("- [ ] 未完了", "- [x] 未完了"), "未完了");
    assert((await boxPoint(p, "未完了")).checked, "プレビューの未完了が checked でない");
    assert(Math.abs(await p.eval("document.getElementById('previewScroller').scrollTop") - scrollTop) <= 1, "スクロール位置が変わった");
    await p.eval("document.getElementById('source').focus()");
    await press(p, "z", { ctrl: true });
    await sleep(1000);
    assert(await p.value() === DC && !(await boxPoint(p, "未完了")).checked, "Undo");
    for (const [text, before, after] of [["完了", "- [x] 完了", "- [ ] 完了"], ["大文字", "- [X] 大文字", "- [ ] 大文字"], ["番号", "1. [ ] 番号", "1. [x] 番号"]]) {
      const current = await p.value();
      await clickBox(text);
      assert(await p.value() === current.replace(before, after), `${text}: ${JSON.stringify((await p.value()).slice(0, 0))}`);
    }
    await setMarked(p, DC, 1000);
    await p.eval("(() => { const li = [...document.querySelectorAll('#preview li')].find((el) => el.textContent.trim().startsWith('未完了')); li.querySelector('input').focus(); })()");
    await press(p, " ");
    await sleep(300);
    assert(await p.value() === DC.replace("- [ ] 未完了", "- [x] 未完了"), "Space で切り替わらない");
    const focused = await p.eval("(() => { const el = document.activeElement; return el?.matches('#preview input[type=checkbox]') && el.closest('li').textContent.trim().startsWith('未完了'); })()");
    assert(focused, "Space の後のフォーカス");
    await setMarked(p, DC, 1000);
    for (const selector of ["#preview p > input, #preview > input, #preview input:not(li input)", "#preview blockquote input"]) {
      const point = await p.eval(`(() => { const box = document.querySelector(${JSON.stringify(selector)}); box.scrollIntoView({ block: 'center' }); const r = box.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, checked: box.checked }; })()`);
      await p.mouse(point.x, point.y);
      await sleep(400);
      const after = await p.eval(`document.querySelector(${JSON.stringify(selector)}).checked`);
      assert(await p.value() === DC && after === point.checked, `${selector}: 変わった`);
    }
  });

  // ---- 1.4.0 総合（試験表 20261117-features-140 の T-28〜T-55。レビュー R1〜R7 の回帰を含む） ----

  const stats140 = (p) => text140(p, "stats");
  const hl = (p) => p.eval("document.getElementById('searchHighlight').children.length");
  const msg = (p, key) => p.eval(`chrome.i18n.getMessage(${JSON.stringify(key)})`);
  const expectedStats = (p) => p.eval(`(() => { const v = document.getElementById('source').value; const chars = [...v.replace(/\\n/g, '')].length; const lines = v === '' ? 0 : v.split('\\n').length; const words = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(v)].filter((s) => s.isWordLike).length; return { chars: chars.toLocaleString(), lines: lines.toLocaleString(), words: words.toLocaleString() }; })()`);
  const sourceOpen = (p) => p.eval("document.getElementById('workspace').classList.contains('source-open')");
  const menuOpen = (p, id) => p.eval(`!document.getElementById(${JSON.stringify(id)}).hidden`);
  async function setPasteHtml(p, on) {
    await p.click("#settingsMenuButton");
    await p.click("#openPaste");
    await p.eval(`document.getElementById('pasteHtml').checked = ${on}`);
    await p.click("#pasteDialog button[value='ok']");
    await sleep(300);
  }
  async function enableAllFeatures(p) {
    await p.click("#settingsMenuButton");
    await p.click("#openSyntax");
    await p.eval("document.querySelectorAll('#syntaxDialog input[name=feature]').forEach((c) => { c.checked = true; })");
    await p.click("#syntaxDialog button[value='ok']");
    await sleep(400);
  }
  /** プレビューの、指定の文字で始まる li の中の n 番目の input（既定は先頭）を表示して、その中心の座標を返す。 */
  const boxIn = (p, text, n = 0) => p.eval(`(() => { const li = [...document.querySelectorAll('#preview li')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)})); const box = li.querySelectorAll('input')[${n}]; box.scrollIntoView({ block: 'center' }); const r = box.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, checked: box.checked }; })()`);
  const boxChecked = (p, text, n = 0) => p.eval(`[...document.querySelectorAll('#preview li')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)})).querySelectorAll('input')[${n}].checked`);
  async function clickBoxIn(p, text, n = 0, wait = 500) {
    const point = await boxIn(p, text, n);
    await p.mouse(point.x, point.y);
    await sleep(wait);
    return point;
  }
  const tocTexts = async (p) => {
    await p.click("#tocButton");
    const texts = await p.eval("[...document.querySelectorAll('#tocMenu [role=menuitem]')].map((b) => b.textContent)");
    await press(p, "Escape");
    await p.eval("document.getElementById('tocMenu').hidden = true");
    return texts;
  };
  const DL300 = Array.from({ length: 300 }, (_, i) => (i === 249 ? "行250 目標" : `行${i + 1}`)).join("\n");
  const DM = (() => {
    const parts = ["# 先頭", "", "- [ ] 手動の項目", ""];
    let length = parts.join("\n").length;
    while (length <= 210000) {
      parts.push(F140, "");
      length += F140.length + 2;
    }
    return parts.join("\n");
  })();
  const PNG1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  await check("1.4.0 総合 T-28: Enter の境界（空白・タブ・入れ子の引用・番号を振り直さない・記号の途中・修飾キー・Redo）", async () => {
    const p = await open140();
    for (const [before, after] of [
      ["1.  a‸", "1.  a\n2.  ‸"], ["-\ta‸", "-\ta\n-\t‸"], ["\t- a‸", "\t- a\n\t- ‸"], ["> > a‸", "> > a\n> > ‸"], ["1. a‸\n2. b", "1. a\n2. ‸\n2. b"],
    ]) {
      await setMarked(p, before);
      await press(p, "Enter");
      assert(await marked(p) === after, `${JSON.stringify(before)} → ${JSON.stringify(await marked(p))}`);
    }
    for (const [before, after] of [["-‸ a", "-\n a"], ["- [‸x] a", "- [\nx] a"]]) {
      await setMarked(p, before);
      await press(p, "Enter");
      assert(await p.value() === after && await lastPrevented(p) === false, `${JSON.stringify(before)} → ${JSON.stringify(await p.value())}`);
    }
    for (const mod of [{ ctrl: true }, { alt: true }]) {
      await setMarked(p, "- a‸");
      await press(p, "Enter", mod);
      assert(!(await p.value()).includes("\n- ") && await lastPrevented(p) === false, `${JSON.stringify(mod)}+Enter: ${JSON.stringify(await p.value())}`);
    }
    await setMarked(p, "- 項目A‸");
    await press(p, "Enter");
    await press(p, "z", { ctrl: true });
    assert(await p.value() === "- 項目A", "Undo");
    await press(p, "y", { ctrl: true });
    assert(await p.value() === "- 項目A\n- ", `Redo: ${JSON.stringify(await p.value())}`);
  });

  await check("1.4.0 総合 T-29: IME 変換中の Enter・Tab には介入しない", async () => {
    const p = await open140();
    await setMarked(p, "- a‸");
    await p.eval("document.getElementById('source').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))");
    await press(p, "Enter");
    assert(!(await p.value()).includes("\n- "), `変換中の Enter: ${JSON.stringify(await p.value())}`);
    await setMarked(p, "- a‸");
    await p.eval("document.getElementById('source').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))");
    await press(p, "Enter");
    assert(await marked(p) === "- a\n- ‸", `確定後の Enter: ${await marked(p)}`);
    await setMarked(p, "- a\n- b‸");
    await p.eval("document.getElementById('source').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))");
    const prevented = await p.eval("(() => { const e = new KeyboardEvent('keydown', { key: 'Tab', isComposing: true, cancelable: true, bubbles: true }); document.getElementById('source').dispatchEvent(e); return e.defaultPrevented; })()");
    assert(prevented === false && await p.value() === "- a\n- b", "変換中の Tab");
    await p.eval("document.getElementById('source').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))");
  });

  await check("1.4.0 総合 T-30: Tab・Shift+Tab の境界と水平線（レビュー R5）", async () => {
    const p = await open140();
    for (const [before, shift, after] of [
      ["- a\n  続き\n\n- b‸", false, "- a\n  続き\n\n  - b"], ["10. a\n- b‸", false, "10. a\n    - b"], ["- a\n\t- b‸", true, "- a\n- b"],
      ["- p\n«    - a\n  - b»", true, "- p\n- a\n- b"],
    ]) {
      const original = await setMarked(p, before);
      await press(p, "Tab", { shift });
      assert(await p.value() === after, `${JSON.stringify(before)} → ${JSON.stringify(await p.value())}`);
      await press(p, "z", { ctrl: true });
      assert(await p.value() === original, `${JSON.stringify(before)} の Undo`);
    }
    await setMarked(p, "- x\n- ab‸c");
    await press(p, "Tab");
    assert(await marked(p) === "- x\n  - ab‸c", `(e) Tab: ${await marked(p)}`);
    await press(p, "Tab", { shift: true });
    assert(await marked(p) === "- x\n- ab‸c", `(e) Shift+Tab: ${await marked(p)}`);
    await press(p, "z", { ctrl: true });
    assert(await p.value() === "- x\n  - abc", `(e) の Undo: ${JSON.stringify(await p.value())}`);
    await setMarked(p, "«- a\n  - b»");
    await press(p, "Tab", { shift: true });
    assert(await p.value() === "- a\n  - b" && await active(p) === "source", "(f)");
    await setMarked(p, "前\n段落‸");
    await press(p, "Tab", { shift: true });
    assert(await p.value() === "前\n段落" && await active(p) !== "source", "(g)");
    for (const before of ["* * *‸", "- - -‸", "  * * *‸", "-\t-\t-‸", "«- a\n* * *\n- b»"]) {
      for (const shift of before.includes("«") ? [false] : [false, true]) {
        const original = await setMarked(p, before);
        await press(p, "Tab", { shift });
        assert(await p.value() === original && await lastPrevented(p) === false, `(h) ${JSON.stringify(before)} ${shift ? "Shift+Tab" : "Tab"}: ${JSON.stringify(await p.value())}`);
      }
    }
  });

  await check("1.4.0 総合 T-31: 見出しのシフトの範囲・メニューのキーボード操作・行頭のインラインコード（レビュー R3）", async () => {
    const p = await open140();
    await setMarked(p, "«# A\n# B\n»# C");
    await p.format("headingDown");
    assert(await p.value() === "## A\n## B\n# C", `(a): ${JSON.stringify(await p.value())}`);
    await setMarked(p, "#\n本文");
    await p.format("headingDown");
    assert(await p.value() === "##\n本文", "(b)");
    await setMarked(p, DH);
    await press(p, "a", { ctrl: true });
    await p.format("headingDown");
    const down = DH.replace("# 見出し1", "## 見出し1").replace("## 見出し2", "### 見出し2").replace("##### 見出し5", "###### 見出し5").replace("   ## 字下げ3", "   ### 字下げ3");
    assert(await p.value() === down, "(c)");
    const fenced = "```markdown\n# 外\n## 中\n```";
    await setMarked(p, fenced);
    await p.format("headingDown");
    assert(await p.value() === fenced, "(d)");
    await setMarked(p, "# A");
    await p.eval("document.querySelector(\"[aria-controls='headingMenu']\").focus()");
    await press(p, "Enter");
    for (let i = 0; i < 12 && await p.eval("document.activeElement?.dataset?.format") !== "headingDown"; i++) {
      await press(p, "ArrowDown");
    }
    await press(p, "Enter");
    assert(await p.value() === "## A" && !(await menuOpen(p, "headingMenu")), `(e): ${await p.value()}`);
    await sleep(400);
    const want = await expectedStats(p);
    assert((await stats140(p)).startsWith(ja ? `${want.chars} 文字` : `${want.chars} characters`), `(f): ${await stats140(p)}`);
    for (const first of ["```inline```", "```a`b"]) {
      const text = `${first}\n# Actual\n`;
      for (const [marks, command, start, expected] of [
        ["", "headingDown", text, `${first}\n## Actual\n`],
        ["line", "headingDown", text, `${first}\n## Actual\n`],
        ["", "headingUp", `${first}\n## Actual\n`, `${first}\n# Actual\n`],
      ]) {
        const at = start.indexOf("#");
        const lineEnd = start.indexOf("\n", at);
        const m = marks === "line" ? `${start.slice(0, at)}«${start.slice(at, lineEnd)}»${start.slice(lineEnd)}` : `${start}‸`;
        await setMarked(p, m);
        await p.format(command);
        assert(await p.value() === expected, `(g) ${JSON.stringify(m)} ${command}: ${JSON.stringify(await p.value())}`);
        await press(p, "z", { ctrl: true });
        assert(await p.value() === start, `(g) ${JSON.stringify(m)} の Undo`);
      }
    }
  });

  await check("1.4.0 総合 T-32: URL の貼り付けの境界と、編集欄の外からの貼り付け（レビュー R1）", async () => {
    const p = await open140();
    const pasteIn = async (before, plain, html = null) => {
      await setMarked(p, before);
      await p.setClipboard(plain, html);
      await p.eval("document.getElementById('source').focus()");
      await press(p, "v", { ctrl: true });
    };
    await pasteIn("前« 説明 »後", "https://example.com");
    assert(await p.value() === "前 [説明](https://example.com) 後", `(a): ${await p.value()}`);
    await pasteIn("リンク先の«説明»", "https://example.com/", "<a href=\"https://example.com/\">Example</a>");
    assert(await p.value() === "リンク先の[説明](https://example.com/)", `(b): ${await p.value()}`);
    // (c) 選択の後、プレビューの何もない所をクリックしてから Ctrl+V
    await setMarked(p, "前 «説明» 後", 600);
    const blank = await p.eval("(() => { const r = document.getElementById('previewScroller').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 10 }; })()");
    await p.mouse(blank.x, blank.y);
    assert(await active(p) !== "source", "(c) フォーカスがプレビューへ移らない");
    await p.setClipboard("https://example.com");
    await press(p, "v", { ctrl: true });
    assert(!(await p.value()).includes("[説明](") && (await p.value()).includes("https://example.com"), `(c): ${await p.value()}`);
    // (d) 画像だけのクリップボード
    await setMarked(p, "前 «説明» 後");
    await p.eval(`(async () => { const bin = Uint8Array.from(atob(${JSON.stringify(PNG1)}), (c) => c.charCodeAt(0)); await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bin], { type: "image/png" }) })]); })()`);
    await press(p, "v", { ctrl: true });
    // Chrome は文字のないクリップボードの貼り付けでも選択を消す。拡張の処理のない textarea と同じ結果で、リンクにしないこと（2026-11-17 工程Gで期待結果を訂正）
    await p.eval("(() => { const t = document.createElement('textarea'); t.id = 'plainTa'; document.body.prepend(t); t.value = '前 説明 後'; t.focus(); t.setSelectionRange(2, 4); })()");
    await press(p, "v", { ctrl: true });
    const plainResult = await p.eval("(() => { const t = document.getElementById('plainTa'); const v = t.value; t.remove(); return v; })()");
    assert(await p.value() === plainResult && !(await p.value()).includes("]("), `(d): ${await p.value()} / 標準 ${plainResult}`);
    // (e) Undo・Redo
    await pasteIn("リンク先の«説明»", "https://example.com/a?b=1");
    await press(p, "z", { ctrl: true });
    await press(p, "y", { ctrl: true });
    assert(await p.value() === "リンク先の[説明](https://example.com/a?b=1)", `(e): ${await p.value()}`);
    await pasteIn("前 «説明» 後", "https://example.com/日本語");
    assert(await p.value() === "前 [説明](https://example.com/日本語) 後", `(f): ${await p.value()}`);
    // (g) 外からの貼り付け: Shift+Insert・編集欄を閉じた状態・選択なし・書式付きテキストの貼り付けのオン・オフ
    for (const on of [false, true]) {
      await setPasteHtml(p, on);
      for (const [name, before, key, close] of [
        ["Ctrl+V", "前 «説明» 後", ["v", { ctrl: true }], false],
        ["Shift+Insert", "前 «説明» 後", ["Insert", { shift: true }], false],
        ["編集欄を閉じた状態", "前 «説明» 後", ["v", { ctrl: true }], true],
        ["選択なし", "前 説明‸ 後", ["v", { ctrl: true }], false],
      ]) {
        const original = await setMarked(p, before);
        if (close) {
          await p.click("#toggleSource");
        }
        await p.eval("document.getElementById('previewScroller').focus()");
        await p.setClipboard("https://example.com");
        await press(p, ...key);
        const value = await p.value();
        assert(!value.includes("[説明](") && value.includes("https://example.com"), `(g) ${on ? "オン" : "オフ"} ${name}: ${value}`);
        await p.eval("document.getElementById('source').focus()");
        await press(p, "z", { ctrl: true });
        assert(await p.value() === original, `(g) ${on ? "オン" : "オフ"} ${name} の Undo: ${await p.value()}`);
        // 直後の編集欄での貼り付けは、これまでどおりリンクにする
        await pasteIn("前 «説明» 後", "https://example.com");
        assert(await p.value() === "前 [説明](https://example.com) 後", `(g) ${on ? "オン" : "オフ"} ${name} の後の編集欄での貼り付け: ${await p.value()}`);
        await press(p, "z", { ctrl: true });
        assert(await p.value() === "前 説明 後", `(g) ${name} の後の貼り付けの Undo`);
      }
    }
  });

  await check("1.4.0 総合 T-33: Meta のショートカット・対象外の修飾キー・フォーカスの場所", async () => {
    const p = await open140();
    const start = "abc «def» ghi";
    for (const [format, key] of [["italic", "i"], ["link", "k"], ["code", "e"]]) {
      await setMarked(p, start);
      await p.format(format);
      const byButton = await marked(p);
      await setMarked(p, start);
      await press(p, key, { meta: true });
      assert(await marked(p) === byButton, `(a) Meta+${key}: ${await marked(p)} / ${byButton}`);
    }
    await setMarked(p, start, 600);
    await p.click("#copyRich");
    const rich = await p.readClipboard();
    await p.click("#copyMarkdown");
    const md = await p.readClipboard();
    await p.eval("document.getElementById('source').focus()");
    await p.setClipboard("SENTINEL-T33");
    await press(p, "c", { meta: true, shift: true });
    await sleep(200);
    const gotRich = await p.readClipboard();
    assert(gotRich["text/html"] === rich["text/html"] && lf(gotRich["text/plain"]) === lf(rich["text/plain"]), "(b) Meta+Shift+C");
    await p.setClipboard("SENTINEL-T33");
    await press(p, "m", { meta: true, shift: true });
    await sleep(200);
    assert(lf((await p.readClipboard())["text/plain"]) === lf(md["text/plain"]), "(b) Meta+Shift+M");
    await setMarked(p, start);
    await press(p, "h", { meta: true });
    assert(await visible(p, "searchBar") && await p.eval("document.getElementById('searchQuery').value") === "def", "(c) Meta+H");
    await press(p, "Escape");
    for (const [key, mod] of [["i", { ctrl: true, shift: true }], ["i", { ctrl: true, alt: true }], ["k", { ctrl: true, alt: true }], ["e", { ctrl: true, shift: true }]]) {
      const original = await setMarked(p, start);
      await press(p, key, mod);
      assert(await p.value() === original, `(d) ${JSON.stringify(mod)}+${key}: ${await p.value()}`);
    }
    await setMarked(p, start);
    await p.setClipboard("SENTINEL-T33");
    await press(p, "c", { ctrl: true, alt: true, shift: true });
    await sleep(200);
    assert(lf((await p.readClipboard())["text/plain"]) === "SENTINEL-T33", "(e) Ctrl+Alt+Shift+C");
    const original = await setMarked(p, start);
    await p.eval("document.getElementById('previewScroller').focus()");
    await press(p, "i", { ctrl: true });
    assert(await p.value() === original, "(f) プレビューで Ctrl+I");
    await setMarked(p, start);
    await press(p, "b", { ctrl: true });
    assert(await p.value() === "abc **def** ghi", `(g) Ctrl+B: ${await p.value()}`);
    for (const key of ["f", "y"]) {
      await setMarked(p, start);
      await press(p, key, { ctrl: true });
      assert(await lastPrevented(p) === false, `(h) Ctrl+${key} の既定の動作を止めた`);
    }
  });

  await check("1.4.0 総合 T-34: コピーのショートカットの境界（空・Frontmatter だけ・失敗・IME・ダイアログ）", async () => {
    const p = await open140();
    for (const [key, button] of [["m", "#copyMarkdown"], ["c", "#copyRich"]]) {
      await setMarked(p, "");
      await p.setClipboard("SENTINEL-T34");
      await p.eval("document.getElementById('toast').hidden = true");
      await press(p, key, { ctrl: true, shift: true });
      await sleep(200);
      const byKey = await p.toast();
      await p.eval("document.getElementById('toast').hidden = true");
      await p.click(button);
      await sleep(200);
      assert(lf((await p.readClipboard())["text/plain"]) === "SENTINEL-T34" && byKey === await p.toast(), `(a) ${key}: ${byKey} / ${await p.toast()}`);
    }
    await setMarked(p, "---\na: 1\n---\n");
    await p.setClipboard("SENTINEL-T34");
    await press(p, "c", { ctrl: true, shift: true });
    await sleep(200);
    assert(lf((await p.readClipboard())["text/plain"]) === "SENTINEL-T34" && await p.toast() === await msg(p, "nothingToCopy"), `(b): ${await p.toast()}`);
    // (d) IME 変換中
    await setMarked(p, "# 題");
    await p.setClipboard("SENTINEL-T34");
    await p.eval("document.getElementById('source').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))");
    await press(p, "m", { ctrl: true, shift: true });
    await sleep(200);
    assert(lf((await p.readClipboard())["text/plain"]) === "SENTINEL-T34", "(d) 変換中にコピーした");
    await p.eval("document.getElementById('source').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))");
    await press(p, "m", { ctrl: true, shift: true });
    await sleep(200);
    assert(lf((await p.readClipboard())["text/plain"]) === await p.value(), "(d) 確定後");
    // (e) ダイアログを開いている間
    for (const [open, id] of [["#openPaste", "pasteDialog"], ["#openKeys", "keysDialog"], ["#about", "aboutDialog"]]) {
      await p.click("#settingsMenuButton");
      await p.click(open);
      await p.setClipboard("SENTINEL-T34");
      await press(p, "c", { ctrl: true, shift: true });
      await press(p, "m", { ctrl: true, shift: true });
      await press(p, "h", { ctrl: true });
      await sleep(200);
      assert(lf((await p.readClipboard())["text/plain"]) === "SENTINEL-T34" && !(await visible(p, "searchBar")) && await p.eval(`document.getElementById('${id}').open`), `(e) ${id}`);
      await p.eval(`document.getElementById('${id}').close()`);
    }
    // (c) 書き込みの失敗（最後に行う）
    await setMarked(p, "# 題");
    await p.eval("navigator.clipboard.write = () => Promise.reject(new DOMException('denied', 'NotAllowedError')); navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));");
    for (const [key, button] of [["c", "copyRich"], ["m", "copyMarkdown"]]) {
      await press(p, key, { ctrl: true, shift: true });
      await sleep(200);
      assert((await p.toast()).startsWith("ERROR:") && !(await p.eval(`document.getElementById('${button}').classList.contains('copied')`)), `(c) ${key}: ${await p.toast()}`);
    }
    assert(await p.value() === "# 題", "(c) 値が変わった");
  });

  await check("1.4.0 総合 T-35: Ctrl+H の検索語に入れる選択の長さ（200文字まで・改行なし）", async () => {
    for (const [value, expected] of [["x".repeat(199), "x".repeat(199)], ["x".repeat(200), "x".repeat(200)], ["x".repeat(201), ""], ["ab\ncd", ""]]) {
      const p = await open140();
      await setMarked(p, `«${value}»`);
      await press(p, "h", { ctrl: true });
      const got = await p.eval("document.getElementById('searchQuery').value");
      assert(got === expected && await p.value() === value && JSON.stringify(await sel(p)) === JSON.stringify([0, value.length]), `${value.length}: ${got.length}`);
      await cdp.send("Target.closeTarget", { targetId: p.targetId }).catch(() => {});
    }
  });

  await check("1.4.0 総合 T-36: 検索語は文字どおり・重ならない・大文字小文字・絵文字・置換後の $", async () => {
    const p = await open140();
    await setMarked(p, "a.b axb a.b (x) $1 \\d [z]");
    await press(p, "h", { ctrl: true });
    for (const [query, count] of [["a.b", L140.total(2)], ["(x)", L140.total(1)], ["$1", L140.total(1)], ["\\d", L140.total(1)], ["[z]", L140.total(1)], [".*", L140.none]]) {
      await typeQuery(p, "searchQuery", query);
      assert(await text140(p, "searchCount") === count, `(a) ${query}: ${await text140(p, "searchCount")}`);
    }
    for (const [value, count] of [["aaaa", 2], ["aaa", 1]]) {
      await setMarked(p, value);
      await typeQuery(p, "searchQuery", "aa");
      assert(await text140(p, "searchCount") === L140.total(count), `(b) ${value}`);
    }
    await setMarked(p, "‸İİabcABC");
    await typeQuery(p, "searchQuery", "abc");
    assert(await text140(p, "searchCount") === L140.total(2), `(c) 件数: ${await text140(p, "searchCount")}`);
    const selected = () => p.eval("(() => { const s = document.getElementById('source'); return s.value.slice(s.selectionStart, s.selectionEnd); })()");
    await p.click("#searchNext");
    assert(await selected() === "abc", `(c) 1回目: ${await selected()}`);
    await p.click("#searchNext");
    assert(await selected() === "ABC" && await text140(p, "searchCount") === "2 / 2", `(c) 2回目: ${await selected()}`);
    await setMarked(p, "‸👍x👍");
    await typeQuery(p, "searchQuery", "👍");
    assert(await text140(p, "searchCount") === L140.total(2), "(d) 件数");
    for (let i = 0; i < 2; i++) {
      await p.click("#searchNext");
      assert(await selected() === "👍", `(d) ${i + 1}回目: ${await selected()}`);
    }
    await setMarked(p, "a b a");
    await typeQuery(p, "searchQuery", "a");
    await typeQuery(p, "searchReplace", "$&$$");
    await p.click("#replaceAll");
    assert(await p.value() === "$&$$ b $&$$", `(e): ${await p.value()}`);
    await setMarked(p, "«a» b a");
    await typeQuery(p, "searchReplace", "aa");
    await p.eval("document.getElementById('source').setSelectionRange(0, 1)");
    await p.click("#replaceOne");
    assert(await p.value() === "aa b a" && JSON.stringify(await sel(p)) === "[5,6]", `(f) 置換: ${await p.value()} ${await sel(p)}`);
    await setMarked(p, "a b a");
    await p.click("#replaceAll");
    assert(await p.value() === "aa b aa" && await p.toast() === L140.replaced(2), `(f) すべて: ${await p.value()} ${await p.toast()}`);
    await setMarked(p, "a b a");
    await typeQuery(p, "searchReplace", "");
    await p.click("#replaceAll");
    assert(await p.value() === " b ", `(g): ${JSON.stringify(await p.value())}`);
  });

  await check("1.4.0 総合 T-37: 検索の件数の更新・置換の順・一致の枠（レビュー R6）・Undo・クリア・編集欄を閉じる", async () => {
    const p = await open140();
    await setMarked(p, DS);
    await press(p, "h", { ctrl: true });
    await typeQuery(p, "searchQuery", "apple");
    assert(await text140(p, "searchCount") === L140.total(5), "件数");
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); })()");
    await p.send("Input.insertText", { text: " apple" });
    await sleep(100);
    assert(await text140(p, "searchCount") === L140.total(6), `(a): ${await text140(p, "searchCount")}`);
    // (b)
    await setMarked(p, `${DS.slice(0, 18)}‸${DS.slice(18)}`);
    await p.click("#searchNext");
    assert(JSON.stringify(await sel(p)) === "[25,30]", `(b) 次へ: ${await sel(p)}`);
    await typeQuery(p, "searchQuery", "pie");
    assert(await text140(p, "searchCount") === L140.total(1), `(b) 件数: ${await text140(p, "searchCount")}`);
    await typeQuery(p, "searchReplace", "PIE");
    await p.click("#replaceOne");
    const pie = DS.indexOf("pie");
    assert(await p.value() === DS && JSON.stringify(await sel(p)) === JSON.stringify([pie, pie + 3]) && await text140(p, "searchCount") === "1 / 1", `(b) 1回目: ${await sel(p)} ${await text140(p, "searchCount")}`);
    await p.click("#replaceOne");
    assert(await p.value() === DS.replace("pie", "PIE"), "(b) 2回目");
    // (c) 一致の枠: 選んだ直後・編集欄・検索欄へ戻る（クリック・Shift+Tab）・手で選んだ一致・置換後の欄・閉じた後
    await setMarked(p, DS);
    await typeQuery(p, "searchQuery", "apple");
    await p.eval("document.getElementById('source').setSelectionRange(0, 0)");
    await p.click("#searchNext");
    assert(await hl(p) >= 1, "(c) 選んだ直後に枠がない");
    await p.eval("document.getElementById('source').focus()");
    assert(await hl(p) === 0, "(c) 編集欄で枠が消えない");
    await p.click("#searchQuery");
    assert(await hl(p) >= 1 && await active(p) === "searchQuery", `(c) クリックで検索欄へ戻った後の枠: ${await hl(p)}`);
    await p.eval("document.getElementById('source').focus()");
    await press(p, "Tab", { shift: true });
    assert(await active(p) !== "source" && await hl(p) >= 1, `(c) Shift+Tab で戻った後の枠: ${await active(p)} ${await hl(p)}`);
    await p.eval("document.getElementById('source').focus(); document.getElementById('source').setSelectionRange(35, 40)");
    await p.click("#searchQuery");
    assert(await hl(p) >= 1, "(c) 手で選んだ一致の枠");
    await p.eval("document.getElementById('source').focus()");
    await p.click("#searchReplace");
    assert(await hl(p) >= 1, "(c) 置換後の欄へ移った後の枠");
    await p.click("#searchClose");
    await p.eval("document.getElementById('source').blur()");
    assert(await hl(p) === 0, "(c) 閉じた後に枠が出た");
    // (d)
    await setMarked(p, DS);
    await press(p, "h", { ctrl: true });
    await typeQuery(p, "searchQuery", "apple");
    await typeQuery(p, "searchReplace", "x");
    await p.click("#replaceAll");
    assert(await text140(p, "searchCount") === L140.none, `(d) 置換後: ${await text140(p, "searchCount")}`);
    await p.eval("document.getElementById('source').focus()");
    await press(p, "z", { ctrl: true });
    const countD = await text140(p, "searchCount");
    assert(await p.value() === DS && (countD === L140.total(5) || / \/ 5$/u.test(countD)), `(d) Undo: ${countD}`);
    // (e)
    await p.click("#clear");
    await p.click("#clearDialog button[value='clear']");
    await setMarked(p, "x y");
    await press(p, "h", { ctrl: true });
    const countE = await text140(p, "searchCount");
    assert(!/5/u.test(countE), `(e): ${countE}`);
    // (f)
    await p.click("#toggleSource");
    assert(!(await visible(p, "searchBar")), "(f) 編集欄を閉じても検索バーが見える");
  });

  await check("1.4.0 総合 T-38: 検索の一致へのスクロールと枠の位置", async () => {
    const p = await open140();
    await setMarked(p, DL300);
    await p.eval("(() => { const s = document.getElementById('source'); s.scrollTop = 0; s.setSelectionRange(0, 0); })()");
    await press(p, "h", { ctrl: true });
    await typeQuery(p, "searchQuery", "目標");
    await p.click("#searchNext");
    const at = DL300.indexOf("目標");
    assert(JSON.stringify(await sel(p)) === JSON.stringify([at, at + 2]), `(1) 選択: ${await sel(p)}`);
    const geo = () => p.eval("(() => { const s = document.getElementById('source'); const cs = getComputedStyle(s); const lh = parseFloat(cs.lineHeight); const top = parseFloat(cs.paddingTop) + 249 * lh - s.scrollTop; const box = document.getElementById('searchHighlight').children[0]; const er = s.getBoundingClientRect(); return { top, lh, h: s.clientHeight, scrollTop: s.scrollTop, max: s.scrollTop >= s.scrollHeight - s.clientHeight - 1, mark: box ? box.getBoundingClientRect().top - er.top - s.clientTop : null }; })()");
    const g = await geo();
    assert(g.top >= 0 && g.top < g.h && (Math.abs(g.top - g.h / 3) <= g.lh || g.max), `(1) 位置: ${JSON.stringify(g)}`);
    await p.click("#searchNext");
    assert((await geo()).scrollTop === g.scrollTop, "(1) 2回目でスクロールした");
    assert(g.mark !== null && Math.abs(g.mark - g.top) <= 2, `(2) 枠の位置: ${JSON.stringify(g)}`);
    await p.eval("(() => { const s = document.getElementById('source'); s.scrollTop += 30; s.dispatchEvent(new Event('scroll')); })()");
    await sleep(50);
    const g2 = await geo();
    assert(Math.abs((g.mark - g2.mark) - 30) <= 1, `(2) スクロールの後: ${g.mark} → ${g2.mark}`);
    const long = "検索".repeat(200);
    await setMarked(p, `‸${long}`);
    await typeQuery(p, "searchQuery", long);
    await p.click("#searchNext");
    assert(await hl(p) >= 2, `(3) 枠の数: ${await hl(p)}`);
  });

  await check("1.4.0 総合 T-39: 語数を数える上限（20万文字）の前後", async () => {
    const p = await open140();
    for (const [n, words] of [[199999, true], [200000, true]]) {
      await setMarked(p, "a".repeat(n), 500);
      assert(await stats140(p) === L140.stats(n.toLocaleString(), 1, 1), `${n}: ${await stats140(p)}`);
    }
    await setMarked(p, "a".repeat(200001), 500);
    const over = await stats140(p);
    assert(over.includes("—") && !/\d\s*(語|words)/u.test(over), `200,001: ${over}`);
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); })()");
    await press(p, "Backspace");
    await sleep(500);
    assert(await stats140(p) === L140.stats("200,000", 1, 1), `Backspace の後: ${await stats140(p)}`);
    await setMarked(p, `«${"a".repeat(200001)}»`, 500);
    const selected = await stats140(p);
    assert(selected.startsWith(`${L140.selection("200,001", 1)} · `) && selected.includes("—"), `(d): ${selected}`);
  });

  await check("1.4.0 総合 T-40: 各操作の後の文字数の表示", async () => {
    const p = await open140();
    await setMarked(p, "a a");
    await press(p, "h", { ctrl: true });
    await typeQuery(p, "searchQuery", "a");
    await typeQuery(p, "searchReplace", "bb");
    await p.click("#replaceAll");
    await sleep(400);
    assert(await stats140(p) === L140.stats(5, 1, 2), `(a): ${await stats140(p)}`);
    await p.click("#searchClose");
    await setMarked(p, "- a‸");
    await press(p, "Enter");
    await sleep(400);
    assert(await stats140(p) === L140.stats(5, 2, 1), `(b): ${await stats140(p)}`);
    await setMarked(p, "# A");
    await p.format("headingDown");
    await sleep(400);
    assert(await stats140(p) === L140.stats(4, 1, 1), `(c): ${await stats140(p)}`);
    await press(p, "z", { ctrl: true });
    await sleep(400);
    assert(await stats140(p) === L140.stats(3, 1, 1), `(c) Undo: ${await stats140(p)}`);
    await setMarked(p, "前 «説明» 後");
    await p.setClipboard("https://e.x");
    await press(p, "v", { ctrl: true });
    await sleep(400);
    let want = await expectedStats(p);
    assert(await p.value() === "前 [説明](https://e.x) 後" && (await stats140(p)).startsWith(ja ? `${want.chars} 文字 · ${want.lines} 行` : `${want.chars} characters · ${want.lines} lines`), `(d): ${await stats140(p)}`);
    await p.click("#clear");
    await p.click("#clearDialog button[value='clear']");
    await sleep(400);
    assert(await stats140(p) === L140.stats(0, 0, 0), `(e): ${await stats140(p)}`);
    await setMarked(p, "- [ ] a", 600);
    await p.click("#toggleSource");
    await clickBoxIn(p, "a");
    await p.click("#toggleSource");
    await sleep(400);
    want = await expectedStats(p);
    assert(await p.value() === "- [x] a" && await stats140(p) === L140.stats(7, 1, want.words), `(f): ${await stats140(p)} / ${JSON.stringify(want)}`);
    await setMarked(p, "x‸", 400);
    const beforeIme = await stats140(p);
    await p.send("Input.imeSetComposition", { text: "あ", selectionStart: 1, selectionEnd: 1 });
    await sleep(400);
    assert(await stats140(p) === beforeIme, `(g) 変換中: ${await stats140(p)}`);
    await p.send("Input.insertText", { text: "あ" });
    await sleep(400);
    assert((await stats140(p)).startsWith(ja ? "2 文字" : "2 characters"), `(g) 確定後: ${await stats140(p)}`);
  });

  await check("1.4.0 総合 T-41: 目次の上限（200項目）と並び", async () => {
    const p = await open140();
    const heads = (n) => Array.from({ length: n }, (_, i) => `## 見出し${i + 1}`).join("\n\n");
    for (const [n, count, last] of [[199, 199, "見出し199"], [200, 200, "見出し200"], [201, 200, "見出し200"]]) {
      await setMarked(p, heads(n), 800);
      const items = await tocTexts(p);
      assert(items.length === count && items.at(-1) === last, `(${n}) ${items.length} ${items.at(-1)}`);
    }
    const mixed = [...Array.from({ length: 100 }, (_, i) => `# A${i + 1}`), ...Array.from({ length: 101 }, (_, i) => `B${i + 1}\n===`)].join("\n\n");
    await setMarked(p, mixed, 800);
    const items = await tocTexts(p);
    const expected = [...Array.from({ length: 100 }, (_, i) => `A${i + 1}`), ...Array.from({ length: 100 }, (_, i) => `B${i + 1}`)];
    assert(JSON.stringify(items) === JSON.stringify(expected), `(d) ${items.length} ${items.at(-1)}`);
    await setMarked(p, `<h2>HTML</h2>\n\n${heads(200)}`, 800);
    const withHtml = await tocTexts(p);
    assert(withHtml.length === 200 && !withHtml.includes("HTML"), "(e)");
    await setMarked(p, "#\n\n## 本物", 600);
    assert(JSON.stringify(await tocTexts(p)) === "[\"本物\"]", "(f)");
  });

  await check("1.4.0 総合 T-42: 目次の文字・同じ見出し・キーボード操作・最後の見出し・行を取らない", async () => {
    const p = await open140();
    await setMarked(p, "## **太字** と `code` と [リンク](https://example.com)\n\n##   余分な   空白   ##", 600);
    assert(JSON.stringify(await tocTexts(p)) === JSON.stringify(["太字 と code と リンク", "余分な 空白"]), "(a)");
    const same = ["# 同じ", "", fill(10), "", "# 同じ", "", fill(10)].join("\n");
    await setMarked(p, same, 800);
    await p.click("#tocButton");
    await p.eval("document.querySelectorAll('#tocMenu [role=menuitem]')[1].click()");
    await sleep(300);
    const second = same.indexOf("# 同じ", 1);
    const shownIndex = await p.eval("[...document.querySelectorAll('#preview h1')].findIndex((h) => h.classList.contains('jump-target'))");
    assert((await sel(p))[0] === second && shownIndex === 1, `(b) ${await sel(p)} ${shownIndex}`);
    await setMarked(p, DT, 1000);
    const focusedItem = () => p.eval("(() => { const list = [...document.querySelectorAll('#tocMenu [role=menuitem]')]; return list.indexOf(document.activeElement); })()");
    await p.eval("document.getElementById('tocButton').focus()");
    await press(p, "Enter");
    assert(await menuOpen(p, "tocMenu") && await focusedItem() === 0, "(c) Enter で開く");
    await press(p, "ArrowDown");
    assert(await focusedItem() === 1, "(c) ↓");
    await press(p, "ArrowUp");
    assert(await focusedItem() === 0, "(c) ↑");
    await press(p, "Escape");
    assert(!(await menuOpen(p, "tocMenu")) && await active(p) === "tocButton", "(c) Esc");
    await press(p, " ");
    assert(await menuOpen(p, "tocMenu") && await focusedItem() === 0, "(c) Space で開く");
    await press(p, "Escape");
    await press(p, "ArrowDown");
    assert(await menuOpen(p, "tocMenu") && await focusedItem() === 0, "(c) ↓で開く");
    for (let i = 0; i < 3; i++) {
      await press(p, "ArrowDown");
    }
    await press(p, "Enter");
    await sleep(300);
    const top = await headingTop(p, "h1", "章2");
    assert((Math.abs(top.y - 16) <= 2 || top.max) && top.shown && (await sel(p))[0] === DT.indexOf("章2\n===") && await active(p) === "tocButton", `(c) 章2: ${JSON.stringify(top)}`);
    await setMarked(p, `${fill(10)}\n\n# 最後`, 800);
    await p.click("#tocButton");
    await p.eval("document.querySelector('#tocMenu [role=menuitem]').click()");
    await sleep(300);
    const lastTop = await headingTop(p, "h1", "最後");
    assert(lastTop.max && lastTop.shown, `(d): ${JSON.stringify(lastTop)}`);
    const firstP = () => p.eval("(() => { const s = document.getElementById('previewScroller'); s.scrollTop = 0; return document.querySelector('#preview p').getBoundingClientRect().top - s.getBoundingClientRect().top; })()");
    await setMarked(p, "段落X", 600);
    const y1 = await firstP();
    await setMarked(p, "段落X\n\n# 見出し", 600);
    const y2 = await firstP();
    assert(Math.abs(y1 - y2) <= 0.5, `(e) ${y1} / ${y2}`);
  });

  await check("1.4.0 総合 T-43: 目次は反映前の編集・手動更新・全文フェンス・Frontmatter・クリアに従う", async () => {
    const p = await open140();
    await setMarked(p, DT, 1000);
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); })()");
    await p.send("Input.insertText", { text: "\n\n# 新しい章" });
    await p.click("#tocButton");
    const items = await p.eval("[...document.querySelectorAll('#tocMenu [role=menuitem]')].map((b) => b.textContent)");
    await press(p, "Escape");
    assert(items.at(-1) === "新しい章", `(a): ${JSON.stringify(items)}`);
    await setMarked(p, DM, 800);
    assert(await visible(p, "refreshPreview"), "(b) 手動更新にならない");
    await p.click("#refreshPreview");
    await sleep(800);
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(0, 0); })()");
    await p.send("Input.insertText", { text: "# 未反映の章\n\n" });
    await sleep(300);
    const stale = await tocTexts(p);
    assert(stale.includes("先頭") && !stale.includes("未反映の章"), `(b) 更新前: ${JSON.stringify(stale)}`);
    await p.click("#refreshPreview");
    await sleep(800);
    assert((await tocTexts(p))[0] === "未反映の章", "(b) 更新後");
    await setMarked(p, DT, 800);
    await setMarked(p, "段落だけ", 1000);
    assert(!(await visible(p, "tocWrap")), "(c)");
    const D2 = ["```markdown", "# 外側の中の見出し", "", "中の段落", "", ...Array.from({ length: 30 }, (_, i) => [`埋め草${i + 1}`, ""]).flat(), "```"].join("\n");
    await setMarked(p, D2, 800);
    assert(!(await visible(p, "tocWrap")), "(d) 除外前");
    await p.click("#toggleFence");
    await sleep(400);
    assert(await visible(p, "tocWrap") && JSON.stringify(await tocTexts(p)) === "[\"外側の中の見出し\"]", "(d) 除外後");
    await p.click("#toggleFence");
    await setMarked(p, "---\ntitle: x\n---\n# 本文の見出し", 600);
    assert(JSON.stringify(await tocTexts(p)) === "[\"本文の見出し\"]", "(e)");
    await setMarked(p, DT, 800);
    await p.click("#clear");
    await p.click("#clearDialog button[value='clear']");
    await sleep(300);
    assert(!(await visible(p, "tocWrap")), "(f) クリアの後");
    await setMarked(p, "# 別の文書", 600);
    assert(JSON.stringify(await tocTexts(p)) === "[\"別の文書\"]", "(f)");
  });

  await check("1.4.0 総合 T-44: チェックボックスは反映前の編集・手動更新・Undo に従う", async () => {
    const p = await open140();
    await setMarked(p, DC, 1000);
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); })()");
    const point = await boxIn(p, "未完了");
    await p.send("Input.insertText", { text: "Z" });
    await p.mouse(point.x, point.y);
    await sleep(500);
    assert(await p.value() === `${DC}Z` && (await p.eval("document.getElementById('preview').textContent")).includes("Z"), "(a) 1回目");
    await sleep(500);
    await clickBoxIn(p, "未完了");
    assert(await p.value() === `${DC}Z`.replace("- [ ] 未完了", "- [x] 未完了"), "(a) 2回目");
    await setMarked(p, DM, 800);
    await p.click("#refreshPreview");
    await sleep(800);
    await clickBoxIn(p, "手動の項目");
    assert(await p.value() === DM.replace("- [ ] 手動の項目", "- [x] 手動の項目") && await boxChecked(p, "手動の項目"), "(b) 1回目");
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(0, 0); })()");
    await p.send("Input.insertText", { text: "Y" });
    await clickBoxIn(p, "手動の項目");
    assert(await p.value() === `Y${DM.replace("- [ ] 手動の項目", "- [x] 手動の項目")}`, "(b) 2回目");
    await setMarked(p, DC, 1000);
    await clickBoxIn(p, "未完了");
    await p.eval("document.getElementById('source').focus()");
    await press(p, "z", { ctrl: true });
    await sleep(1000);
    assert(await p.value() === DC && !(await boxChecked(p, "未完了")), "(c)");
  });

  await check("1.4.0 総合 T-45: チェックボックスの切り替えの範囲（編集欄の開閉・選択・ダブルクリック・入れ子・生 HTML（レビュー R2））", async () => {
    const p = await open140();
    await setMarked(p, DC, 1000);
    await p.click("#toggleSource");
    await clickBoxIn(p, "未完了");
    assert(await p.value() === DC.replace("- [ ] 未完了", "- [x] 未完了"), "(a) 1回目");
    await clickBoxIn(p, "未完了");
    assert(await p.value() === DC && !(await sourceOpen(p)), "(a) 2回目");
    await p.click("#toggleSource");
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(3, 8); s.scrollTop = 40; })()");
    const scrollTop = await p.eval("document.getElementById('source').scrollTop");
    await clickBoxIn(p, "未完了");
    assert(await p.value() === DC.replace("- [ ] 未完了", "- [x] 未完了") && JSON.stringify(await sel(p)) === "[3,8]" && await p.eval("document.getElementById('source').scrollTop") === scrollTop, "(b)");
    await setMarked(p, DC, 1000);
    const dbl = await boxIn(p, "完了");
    await p.mouse(dbl.x, dbl.y, { count: 2 });
    await sleep(500);
    assert(await p.value() === DC.replace("- [x] 完了", "- [ ] 完了"), "(c)");
    await setMarked(p, DC, 1000);
    const textPoint = await p.eval("(() => { const li = [...document.querySelectorAll('#preview li')].find((el) => el.textContent.trim().startsWith('未完了')); const node = [...li.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('未完了')); const range = document.createRange(); range.selectNodeContents(node); const r = range.getBoundingClientRect(); return { x: r.right - 4, y: r.top + r.height / 2 }; })()");
    await p.mouse(textPoint.x, textPoint.y);
    await sleep(400);
    assert(await p.value() === DC, "(d)");
    await p.eval("[...document.querySelectorAll('#preview li')].filter((el) => el.textContent.trim().startsWith('同じ'))[1].setAttribute('data-second', '')");
    const second = await p.eval("(() => { const box = document.querySelector('#preview li[data-second] input'); box.scrollIntoView({ block: 'center' }); const r = box.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
    await p.mouse(second.x, second.y);
    await sleep(500);
    assert(await p.value() === DC.replace("- [ ] 同じ\n- [ ] 同じ", "- [ ] 同じ\n- [x] 同じ"), "(e)");
    await setMarked(p, DC, 1000);
    await clickBoxIn(p, "子");
    assert(await p.value() === DC.replace("  - [ ] 子", "  - [x] 子"), "(f)");
    const fm = "---\na: 1\n---\n```markdown\n- [ ] フェンスの中\n```";
    await setMarked(p, fm, 600);
    await p.click("#toggleFence");
    await sleep(300);
    await clickBoxIn(p, "フェンスの中");
    assert(await p.value() === fm.replace("- [ ] フェンスの中", "- [x] フェンスの中"), "(g)");
    await p.click("#toggleFence");
    await enableAllFeatures(p);
    const ct = "::: note\n- [ ] 枠の中\n:::\n\n> [!NOTE]\n> - [ ] 注意の中";
    await setMarked(p, ct, 600);
    await clickBoxIn(p, "枠の中");
    assert(await p.value() === ct.replace("- [ ] 枠の中", "- [x] 枠の中"), "(h) 枠の中");
    const now = await p.value();
    await clickBoxIn(p, "注意の中");
    assert(await p.value() === now, "(h) 注意の中");
    // (i) 項目の中の生 HTML の input（レビュー R2）
    for (const [source, text, rawIndex, toggled] of [
      ["- [ ] task <input type=\"checkbox\">", "task", 1, "- [x] task <input type=\"checkbox\">"],
      ["- [x] task <input type=\"checkbox\" checked>", "task", 1, "- [ ] task <input type=\"checkbox\" checked>"],
      ["- [ ] task <input type=\"checkbox\" checked>", "task", 1, "- [x] task <input type=\"checkbox\" checked>"],
      ["- [ ] task\n\n  段落 <input type=\"checkbox\">", "task", 1, "- [x] task\n\n  段落 <input type=\"checkbox\">"],
      ["- [ ] 親 <input type=\"checkbox\">\n  - [x] 子", "親", 1, "- [x] 親 <input type=\"checkbox\">\n  - [x] 子"],
    ]) {
      for (const closed of [false, true]) {
        await setMarked(p, source, 600);
        if (closed) {
          await p.click("#toggleSource");
        }
        const rawBefore = await boxChecked(p, text, rawIndex);
        await clickBoxIn(p, text, rawIndex);
        assert(await p.value() === source && await boxChecked(p, text, rawIndex) === rawBefore, `(i) ${JSON.stringify(source)} ${closed ? "閉" : "開"} クリック: ${JSON.stringify(await p.value())}`);
        await p.eval(`[...document.querySelectorAll('#preview li')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)})).querySelectorAll('input')[${rawIndex}].focus()`);
        await press(p, " ");
        await sleep(300);
        assert(await p.value() === source, `(i) ${JSON.stringify(source)} Space`);
        await clickBoxIn(p, text, 0);
        assert(await p.value() === toggled, `(i) ${JSON.stringify(source)} ${closed ? "閉" : "開"} タスクの box: ${JSON.stringify(await p.value())}`);
        if (closed) {
          await p.click("#toggleSource");
        } else {
          await p.eval("document.getElementById('source').focus()");
          await press(p, "z", { ctrl: true });
          assert(await p.value() === source, `(i) ${JSON.stringify(source)} の Undo`);
        }
      }
    }
    // 子の box は子の行だけ
    await setMarked(p, "- [ ] 親 <input type=\"checkbox\">\n  - [x] 子", 600);
    await clickBoxIn(p, "子");
    assert(await p.value() === "- [ ] 親 <input type=\"checkbox\">\n  - [ ] 子", "(i) 入れ子の子");
    await clickBoxIn(p, "親", 0);
    await p.click("#copyRich");
    const clip = await p.readClipboard();
    assert(clip["text/plain"].includes("☑ 親"), `(i) コピー: ${clip["text/plain"]}`);
  });

  await check("1.4.0 総合 T-46: チェックボックスの切り替えとコピー・disabled なし・ページを離れない", async () => {
    const p = await open140();
    await setMarked(p, DC, 1000);
    const href = await p.eval("location.href");
    const targets = (await cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "page").length;
    const dialogCount = dialogs.length;
    await clickBoxIn(p, "未完了");
    await p.click("#copyRich");
    const clip = await p.readClipboard();
    assert(clip["text/html"].includes("☑ 未完了") && clip["text/plain"].includes("☑ 未完了") && clip["text/plain"].includes("☐ 同じ") && clip["text/html"].includes("☐ 同じ"), "コピー");
    assert(await p.eval("document.querySelectorAll('#preview input[disabled]').length") === 0, "disabled の input がある");
    assert(await p.eval("location.href") === href && (await cdp.send("Target.getTargets")).targetInfos.filter((t) => t.type === "page").length === targets && dialogs.length === dialogCount, "ページを離れた・タブやダイアログが開いた");
  });

  await check("1.4.0 総合 T-47 (3): 閉じない引用符の HTML を貼り付け・設定しても固まらない", async () => {
    const p = await open140();
    await setPasteHtml(p, true);
    const X40 = `<div ${"x ".repeat(40)}"`;
    await setMarked(p, "");
    await p.setClipboard("太字", `${X40}<b>太字</b>`);
    await p.eval("document.getElementById('source').focus()");
    const started = Date.now();
    await press(p, "v", { ctrl: true });
    assert(await p.value() !== "" && Date.now() - started < 1000, `貼り付け: ${await p.value()} ${Date.now() - started}ms`);
    await p.click("#clear");
    await p.click("#clearDialog button[value='clear']");
    await setMarked(p, `${X40}\n\n段落`, 1000);
    assert((await p.eval("document.getElementById('preview').textContent")).includes("段落") && !(await visible(p, "refreshPreview")), "設定");
  });

  await check("1.4.0 総合 T-50: 保存・通信は増えない（操作を一通り行う）", async () => {
    const p = await open140();
    const storage = () => p.eval("chrome.storage.local.get(null)");
    const before = await storage();
    externalRequests.length = 0;
    await setMarked(p, "- 項目‸");
    await press(p, "Enter");
    await setMarked(p, "- a\n- b‸");
    await press(p, "Tab");
    await setMarked(p, DH);
    await p.format("headingDown");
    await setMarked(p, "リンク先の«説明»");
    await p.setClipboard("https://example.com");
    await press(p, "v", { ctrl: true });
    await setMarked(p, "abc «def» ghi");
    await press(p, "i", { ctrl: true });
    await press(p, "c", { ctrl: true, shift: true });
    await press(p, "m", { ctrl: true, shift: true });
    await setMarked(p, DS);
    await press(p, "h", { ctrl: true });
    await typeQuery(p, "searchQuery", "apple");
    await press(p, "Enter");
    await typeQuery(p, "searchReplace", "x");
    await p.click("#replaceOne");
    await p.click("#replaceAll");
    await press(p, "Escape");
    await setMarked(p, DT, 800);
    await p.click("#tocButton");
    await p.eval("document.querySelectorAll('#tocMenu [role=menuitem]')[1].click()");
    await setMarked(p, DC, 800);
    await clickBoxIn(p, "未完了");
    const after = await storage();
    assert(JSON.stringify(after) === JSON.stringify(before) && Object.keys(after).every((k) => ["defaultFeatures", "pasteHtml"].includes(k)), `storage: ${JSON.stringify(after)}`);
    const web = await p.eval("(async () => ({ local: localStorage.length, session: sessionStorage.length, idb: (await indexedDB.databases()).length, cookie: document.cookie }))()");
    assert(web.local === 0 && web.session === 0 && web.idb === 0 && web.cookie === "", `Web の保存: ${JSON.stringify(web)}`);
    const net = externalRequests.filter((u) => /^(?:https?|wss?):/u.test(u));
    assert(net.length === 0, `通信: ${net.join(", ")}`);
    await p.send("Page.reload", {});
    await sleep(800);
    await p.waitReady();
    assert(await p.value() === "" && !(await visible(p, "searchBar")) && await stats140(p) === L140.stats(0, 0, 0) && !(await visible(p, "tocWrap")), "再読み込みの後");
  });

  await check("1.4.0 総合 T-51: 編集しない操作は Undo の履歴に積まれない", async () => {
    const p = await open140();
    await setMarked(p, DT, 1000);
    await p.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); })()");
    await p.send("Input.insertText", { text: "X" });
    await sleep(300);
    await press(p, "h", { ctrl: true });
    // 検索語は値の代入で入れる。打ち込んだ文字は Chrome の文書全体の Undo の履歴に入り、編集欄の Ctrl+Z でも戻る（Chrome の標準。拡張の処理のない textarea と input でも同じ。確認記録を参照）
    await p.eval("(() => { const q = document.getElementById('searchQuery'); q.value = '章'; q.dispatchEvent(new Event('input')); })()");
    await p.click("#searchCase");
    await p.click("#searchCase");
    await p.click("#searchNext");
    await p.click("#searchPrev");
    await press(p, "Escape");
    await p.click("#tocButton");
    await press(p, "Escape");
    await p.click("#settingsMenuButton");
    await p.click("#openKeys");
    await p.click("#keysDialog button[value='close']");
    await p.eval("document.getElementById('source').setSelectionRange(2, 10); document.getElementById('source').setSelectionRange(5, 5)");
    await p.installJumpHelpers();
    await p.dblclickPreview("p", { index: 1 });
    await sleep(300);
    assert(await p.value() === `${DT}X`, "編集しない操作で値が変わった");
    await p.eval("document.getElementById('source').focus()");
    await press(p, "z", { ctrl: true });
    assert(await p.value() === DT, `Undo の1回で戻らない: ${(await p.value()).slice(-10)}`);
  });

  await check("1.4.0 総合 T-54: 狭い画面の配置と英語の表示", async () => {
    const p = await open140({ width: 800, height: 900 });
    await setMarked(p, DT, 1000);
    await press(p, "h", { ctrl: true });
    const layout = await p.eval("(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const e = r('source'), bar = r('searchBar'), st = r('stats'), t = r('tocButton'), pv = r('previewScroller'); return { barBottom: bar.bottom, eTop: e.top, statsTop: st.top, eBottom: e.bottom, toc: { l: t.left, r: t.right, t: t.top, b: t.bottom }, p: { l: pv.left, r: pv.right, t: pv.top, b: pv.bottom, w: pv.width, h: pv.height } }; })()");
    const inside = layout.toc.l >= layout.p.l && layout.toc.r <= layout.p.r && layout.toc.t >= layout.p.t && layout.toc.b <= layout.p.b;
    const topRight = layout.p.r - layout.toc.r <= layout.p.w / 4 && layout.toc.t - layout.p.t <= layout.p.h / 4;
    assert(layout.barBottom <= layout.eTop + 0.5 && layout.statsTop >= layout.eBottom - 0.5 && inside && topRight, `配置: ${JSON.stringify(layout)}`);
    await p.screenshot("140-narrow");
    if (!ja) {
      const text = await p.eval("document.body.innerText + [...document.querySelectorAll('[title]')].map((e) => e.title).join(' ')");
      assert(!text.includes("__MSG_"), "英語の画面に未翻訳の文字がある");
      await typeQuery(p, "searchQuery", "章");
      assert(/^\d+ matches$/u.test(await text140(p, "searchCount")), `英語の件数: ${await text140(p, "searchCount")}`);
    }
  });

  await check("1.4.0 総合 T-55: 検索欄の中のキーは編集欄を変えない", async () => {
    const p = await open140();
    await setMarked(p, DS);
    await press(p, "h", { ctrl: true });
    await typeQuery(p, "searchQuery", "- a");
    for (const key of ["i", "k", "e"]) {
      await press(p, key, { ctrl: true });
      assert(await p.value() === DS, `Ctrl+${key}`);
    }
    await p.eval("document.getElementById('searchQuery').focus()");
    await press(p, "Tab");
    assert(await active(p) !== "searchQuery" && await active(p) !== "source" && await p.value() === DS, `Tab: ${await active(p)}`);
    await typeQuery(p, "searchQuery", "apple");
    await p.eval("document.getElementById('source').setSelectionRange(1, 1); document.getElementById('searchQuery').focus()");
    await press(p, "Enter");
    assert(await p.value() === DS && JSON.stringify(await sel(p)) === "[6,11]", `Enter: ${await sel(p)}`);
  });

  await check("Console に未処理のエラー・警告がない", async () => {
    // fetch の拒否（直前の CSP 確認）は意図した失敗なので除く
    const problems = consoleProblems.filter((p) => !p.includes("connect-probe"));
    assert(problems.length === 0, problems.join("\n"));
  });
} catch (error) {
  console.error(`中断: ${error.stack}`);
  results.push({ name: "実行", ok: false, error: error.message });
} finally {
  child.kill();
  await sleep(500);
  for (const dir of [profile, downloads]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 終了直後でファイルが使用中の場合は一時フォルダーに残る
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\ne2e (${lang}): ${results.length - failed.length}/${results.length} 件成功`);
process.exit(failed.length > 0 ? 1 : 0);
