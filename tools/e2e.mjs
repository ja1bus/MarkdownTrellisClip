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
    dialogs.push(params.message);
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
    const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27 }[key];
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
      privacy: document.querySelector('.privacy').textContent,
      lang: document.documentElement.lang,
      title: document.getElementById('copyRich').textContent,
    })`);
    assert(s.empty && s.open && s.focused, `状態: ${JSON.stringify(s)}`);
    assert(s.hint !== "none", "空のときの案内が見えない");
    assert(s.lang === lang, `lang=${s.lang}`);
    assert(lang === "ja" ? s.privacy === "内容は保存されません" && s.title === "書式付きコピー" : s.privacy === "Content is not saved" && s.title === "Copy Formatted", `表示: ${JSON.stringify(s)}`);
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

  await check("選択範囲を書式付きコピー: 未選択では案内してクリップボードを変えず、選択は断片として変換する", async () => {
    await page.setClipboard("SENTINEL");
    await page.eval("(() => { const s = document.getElementById('source'); s.focus(); s.setSelectionRange(3, 3); })()");
    await page.click("#copySelection");
    await sleep(200);
    let clip = await page.readClipboard();
    assert(clip["text/plain"] === "SENTINEL", "未選択なのにクリップボードが変わった");
    assert((await page.toast()).length > 0, "未選択の案内がない");
    const text = "```markdown\n# 題\n本文 **強調** [参照][r]\n```\n\n[r]: https://example.com";
    await page.eval(`(() => { const s = document.getElementById('source'); s.select(); document.execCommand('insertText', false, ${JSON.stringify(text)}); })()`);
    const start = text.indexOf("本文");
    const end = text.indexOf("\n```");
    await page.eval(`document.getElementById('source').setSelectionRange(${start}, ${end})`);
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

  await check("再読み込み・タブを閉じた後に本文が復元されない", async () => {
    await page2.eval("(() => { const s = document.getElementById('source'); s.focus(); document.execCommand('insertText', false, '再読み込みで消える本文'); })()");
    await page2.send("Page.reload", {});
    await sleep(300);
    await page2.waitReady();
    await sleep(300);
    assert(await page2.value() === "", "再読み込み後に本文が残っている");
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
    // 拡張の保存領域にあってよいのは、追加構文の既定値（defaultFeatures）だけ
    const extKeys = Object.keys(storage.ext ?? {});
    assert(!storage.error && storage.local === 0 && storage.session === 0 && storage.sync === 0 && storage.idb === 0 && extKeys.every((key) => key === "defaultFeatures"), `保存領域: ${JSON.stringify(storage)}`);
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
    const links = await page2.eval("[...document.querySelectorAll('#aboutDialog .about-license a')].map((a) => a.getAttribute('href'))");
    assert(s.text.includes("MIT License") && links.includes("https://github.com/ja1bus/MarkdownTrellisClip") && links.includes("LICENSE.txt"), `MIT の表示: ${JSON.stringify(links)}`);
    const licenseText = await page2.eval("fetch('LICENSE.txt').then((r) => r.text()).catch(() => '')");
    assert(licenseText === "" || licenseText.includes("MIT License"), "LICENSE.txt の内容");
    assert(s.text.includes("marked 18.1.3") && s.text.includes("DOMPurify 3.4.17"), "ライブラリの表記がない");
    await page2.screenshot("08-about");
    const probe = await page2.eval("fetch('https://example.com/connect-probe').then(() => 'fetched', () => 'blocked')");
    assert(probe === "blocked", "connect-src が効いていない（外部へ fetch できた）");
    externalRequests.length = 0;
    await page2.key("Escape");
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
