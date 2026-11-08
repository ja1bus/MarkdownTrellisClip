// node_modules の配布ファイルを extension/vendor/ と extension/licenses/ へ複製する。
// 使い方: node tools/vendor.mjs          … 複製する
//         node tools/vendor.mjs --verify … 複製済みのファイルが node_modules と一致するか確認する
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const verify = process.argv.includes("--verify");

// ソースマップの参照は同梱しないので取り除く（DevToolsの読み込み警告を避ける）
const stripSourceMap = (text) => text.replace(/\n\/\/# sourceMappingURL=\S+\s*$/u, "\n");

const items = [
  { from: "node_modules/marked/lib/marked.esm.js", to: "extension/vendor/marked.esm.js", transform: stripSourceMap },
  { from: "node_modules/dompurify/dist/purify.es.mjs", to: "extension/vendor/purify.es.mjs", transform: stripSourceMap },
  { from: "node_modules/marked/LICENSE", to: "extension/licenses/marked-LICENSE.txt" },
  { from: "node_modules/dompurify/LICENSE", to: "extension/licenses/dompurify-LICENSE.txt" },
];

let failed = 0;
for (const item of items) {
  const source = join(root, item.from);
  if (!existsSync(source)) {
    console.error(`見つかりません: ${item.from}（先に npm ci を実行してください）`);
    process.exit(1);
  }
  const text = readFileSync(source, "utf8");
  const expected = item.transform ? item.transform(text) : text;
  const target = join(root, item.to);
  if (verify) {
    // Git の改行変換（autocrlf）で CRLF になっていても同じとみなす
    const lf = (text) => text.replace(/\r\n/gu, "\n");
    const actual = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (actual === null || lf(actual) !== lf(expected)) {
      console.error(`不一致: ${item.to}（npm run vendor で更新してください）`);
      failed++;
    }
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, expected, "utf8");
  console.log(`複製: ${item.from} -> ${item.to}`);
}

if (failed > 0) {
  process.exit(1);
}
if (verify) {
  console.log("vendor: 同梱ファイルは node_modules と一致しています");
}
