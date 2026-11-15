// インストール済みの Google Chrome を一時プロファイル・画面なしで起動し、拡張を読み込んで
// 作業タブの動作を確かめる。利用者の Chrome プロファイルは使わない。
// 注意: 画面なしでも Windows の OS クリップボードを使うので、実行中にクリップボードの内容が上書きされる。
// Windows のクリップボードはテキストの改行を CRLF にするため、読み戻した text/plain は LF に揃えて比べる。
//
// 使い方: node tools/e2e.mjs [--lang ja|en] [--chrome <chrome.exe>] [--screenshots <フォルダー>]
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
    const begin = cdp.waitFor((m) => m.method === "Browser.downloadWillBegin");
    await page2.click("#download");
    const { params } = await begin;
    await cdp.waitFor((m) => m.method === "Browser.downloadProgress" && m.params.state === "completed", 10000);
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
