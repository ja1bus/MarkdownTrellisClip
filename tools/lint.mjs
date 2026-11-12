// 拡張の静的な点検。依存を増やさないため、このプロジェクト固有の規則だけを確認する。
// 使い方: node tools/lint.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "extension");
const problems = [];
const fail = (file, message) => problems.push(`${relative(root, file).replaceAll("\\", "/")}: ${message}`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(ext);
const ownCode = files.filter((f) => !f.includes(`${join("extension", "vendor")}`) && [".js", ".mjs", ".html", ".css"].includes(extname(f)));

// 1. manifest: 版の一致、権限なし、CSP、Chromeが拒否する先頭 "_" の名前
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.manifest_version !== 3) fail(join(ext, "manifest.json"), "manifest_version は 3 にする");
if (manifest.version !== pkg.version) fail(join(ext, "manifest.json"), `version ${manifest.version} が package.json ${pkg.version} と一致しない`);
// 権限は設定（追加構文の既定値・書式付きテキストの貼り付け）を保存する storage だけ（理由はPROJECT）
if (JSON.stringify(manifest.permissions ?? []) !== JSON.stringify(["storage"])) {
  fail(join(ext, "manifest.json"), `permissions は ["storage"] だけにする（現在 ${JSON.stringify(manifest.permissions ?? [])}）`);
}
for (const key of ["optional_permissions", "host_permissions", "optional_host_permissions", "content_scripts", "externally_connectable", "web_accessible_resources"]) {
  if (key in manifest) fail(join(ext, "manifest.json"), `${key} を使わない方針（必要ならPROJECTに理由を記録してから lint を更新する）`);
}
const csp = manifest.content_security_policy?.extension_pages ?? "";
for (const directive of ["default-src 'none'", "script-src 'self'", "img-src 'self'", "connect-src 'none'", "object-src 'none'"]) {
  if (!csp.includes(directive)) fail(join(ext, "manifest.json"), `CSP に ${directive} がない`);
}
for (const file of files) {
  const rel = relative(ext, file);
  if (rel.split(/[\\/]/u).some((part) => part.startsWith("_") && part !== "_locales")) fail(file, "先頭が _ の名前はChromeが拒否する");
}

// 2. 版の表示: about の版は manifest から読む。ライブラリの版は同梱のライセンス表記（アプリ情報からリンク）を vendor と一致させる
const html = readFileSync(join(ext, "editor.html"), "utf8");
if (!html.includes('href="licenses/THIRD_PARTY_NOTICES.txt"')) fail(join(ext, "editor.html"), "アプリ情報にライセンス表記へのリンクがない");
const vendorVersion = (file, pattern) => pattern.exec(readFileSync(join(ext, "vendor", file), "utf8"))?.[1];
const markedVersion = vendorVersion("marked.esm.js", /marked v(\d+\.\d+\.\d+)/u);
const purifyVersion = vendorVersion("purify.es.mjs", /DOMPurify (\d+\.\d+\.\d+)/u);
// Turndown の配布ファイルには版の表記がないので、package.json の版を使う（中身の一致は vendor.mjs --verify で確認する）
const turndownVersion = pkg.devDependencies?.turndown;
for (const [name, version] of [["marked", markedVersion], ["DOMPurify", purifyVersion], ["Turndown", turndownVersion]]) {
  const notices = readFileSync(join(ext, "licenses", "THIRD_PARTY_NOTICES.txt"), "utf8");
  if (!notices.includes(`${name} ${version}`)) fail(join(ext, "licenses", "THIRD_PARTY_NOTICES.txt"), `${name} ${version} の記載がない`);
}

// 3. 自前のコード: eval・インラインスクリプト・インラインイベント・innerHTML への代入・外部URLの読み込み・保存APIを使わない
const rules = [
  [/\beval\s*\(|new\s+Function\s*\(/u, "eval / new Function を使わない"],
  [/\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/u, "HTML文字列をDOMへ直接入れない"],
  [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|chrome\.storage|\bcaches\.open|document\.cookie/u, "本文を保存するAPIを使わない"],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/u, "通信APIを使わない"],
  [/showSaveFilePicker|showOpenFilePicker|showDirectoryPicker/u, "File System Access API を使わない"],
  [/clipboard\.read(?:Text)?\s*\(/u, "クリップボードを自動で読み取らない"],
];
for (const file of ownCode) {
  const text = readFileSync(file, "utf8");
  const type = extname(file);
  if (type === ".js" || type === ".mjs") {
    const isSettings = file === join(ext, "settings.js");
    for (const [pattern, message] of rules) {
      // settings.js だけは chrome.storage を使う（保存するのは defaultFeatures と pasteHtml だけ。下で確認する）
      const checked = isSettings ? text.replace(/chrome\.storage\.(?:local\.(?:get|set)|onChanged\.addListener)\(/gu, "") : text;
      if (pattern.test(checked)) fail(file, message);
    }
    if (isSettings) {
      const keys = [...text.matchAll(/const [A-Z_]+ = "([^"]+)";/gu)].map((m) => m[1]).sort();
      if (JSON.stringify(keys) !== JSON.stringify(["defaultFeatures", "pasteHtml"])) {
        fail(file, `保存するキーは defaultFeatures と pasteHtml だけにする（現在 ${JSON.stringify(keys)}）`);
      }
    }
  }
  if (type === ".html") {
    if (/<script(?![^>]*\bsrc=)[^>]*>/iu.test(text)) fail(file, "インラインスクリプトを使わない");
    if (/\son[a-z]+\s*=/iu.test(text)) fail(file, "インラインイベントハンドラーを使わない");
    if (/\sstyle\s*=/iu.test(text)) fail(file, "style 属性を使わない（CSPで拒否される）");
  }
  // 読み込みを起こす要素（script・img・link など）と CSS の url() だけを見る。a のリンクは押したときだけ開くので対象外
  if ((type === ".html" || type === ".css") && /<(?:script|img|link|iframe|frame|source|audio|video|object|embed)\b[^>]*\b(?:src|href|data)\s*=\s*["']?(?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\//iu.test(text)) {
    fail(file, "外部のリソースを読み込まない");
  }
}

// 4. 翻訳: ja と en のキーを一致させ、HTML/JS で使うキーがすべてあること
const locales = Object.fromEntries(["ja", "en"].map((lang) => [lang, JSON.parse(readFileSync(join(ext, "_locales", lang, "messages.json"), "utf8"))]));
const jaKeys = Object.keys(locales.ja).sort();
const enKeys = Object.keys(locales.en).sort();
if (JSON.stringify(jaKeys) !== JSON.stringify(enKeys)) fail(join(ext, "_locales"), "ja と en のキーが一致しない");
// chrome.i18n では $ が書式として解釈され、$$ の扱いも連続すると崩れる（Chrome 157 で確認）。
// 表示したい $ は文言に書かず、差し込み（$1〜$9。editor.html の data-i18n-args）で渡す
for (const [lang, messages] of Object.entries(locales)) {
  for (const [key, { message }] of Object.entries(messages)) {
    if (message.replace(/\$[1-9]/gu, "").includes("$")) {
      fail(join(ext, "_locales", lang), `${key}: 表示したい $ は差し込みで渡す`);
    }
  }
}
const used = new Set();
for (const match of html.matchAll(/data-i18n(?:-title|-aria|-placeholder)?="([A-Za-z0-9_]+)"/gu)) used.add(match[1]);
const script = readFileSync(join(ext, "editor.js"), "utf8");
for (const match of script.matchAll(/\bt\("([A-Za-z0-9_]+)"/gu)) used.add(match[1]);
for (const match of JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/gu)) used.add(match[1]);
for (const key of used) {
  if (!(key in locales.en)) fail(join(ext, "_locales"), `キー ${key} がない`);
}
for (const key of enKeys) {
  if (!used.has(key)) fail(join(ext, "_locales"), `キー ${key} は使われていない`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`lint: ${problems.length} 件の問題`);
  process.exit(1);
}
console.log(`lint: 問題なし（${ownCode.length} ファイル、翻訳キー ${enKeys.length} 件）`);
