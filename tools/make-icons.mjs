// 拡張のアイコン（16/32/48/128px）を描いて extension/icons/ へ保存する。
// MarkdownTrellis（Notepad++版）の Core/IconPainter.cs と同じ図柄・色・描き方（緑の角丸四角に白いM、
// 16単位の座標で設計し、1画素を4×4に分けて塗る）。依存を増やさないため PNG は自前で書き出す。
// 使い方: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
const SAMPLES = 4;
const RADIUS = 3.0;
const STROKE_WIDTH = 2.1;
const STROKES = [
  [4, 4, 4, 12],
  [4, 4, 8, 9.2],
  [8, 9.2, 12, 4],
  [12, 4, 12, 12],
];
// IconPainter の通常（ライト）の色 #1E8E3E。Chrome のツールバーは1種類のアイコンしか指定できない
const BACK = [0x1e, 0x8e, 0x3e];

function insideBackground(x, y) {
  const dx = Math.max(Math.max(RADIUS - x, x - (16 - RADIUS)), 0);
  const dy = Math.max(Math.max(RADIUS - y, y - (16 - RADIUS)), 0);
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

function onMark(x, y) {
  for (const [x1, y1, x2, y2] of STROKES) {
    const vx = x2 - x1;
    const vy = y2 - y1;
    const t = Math.min(Math.max(((x - x1) * vx + (y - y1) * vy) / (vx * vx + vy * vy), 0), 1);
    const cx = x1 + t * vx - x;
    const cy = y1 + t * vy - y;
    if (cx * cx + cy * cy <= (STROKE_WIDTH * STROKE_WIDTH) / 4) {
      return true;
    }
  }
  return false;
}

/** RGBA（アルファは乗算なし）の画素を返す。 */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0;
      let mark = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const px = ((x + (sx + 0.5) / SAMPLES) * 16) / size;
          const py = ((y + (sy + 0.5) / SAMPLES) * 16) / size;
          if (insideBackground(px, py)) {
            inside++;
            if (onMark(px, py)) {
              mark++;
            }
          }
        }
      }
      if (inside === 0) {
        continue;
      }
      const white = mark / inside;
      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        pixels[offset + c] = Math.round(BACK[c] + (255 - BACK[c]) * white);
      }
      pixels[offset + 3] = Math.round((255 * inside) / (SAMPLES * SAMPLES));
    }
  }
  return pixels;
}

// ---- PNG の書き出し ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8bit
  header[9] = 6; // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 図柄を artwork 画素で描き、周りに透明の余白を付けて size 画素にする。 */
function padded(size, artwork) {
  const inner = render(artwork);
  const out = Buffer.alloc(size * size * 4);
  const offset = (size - artwork) / 2;
  for (let y = 0; y < artwork; y++) {
    inner.copy(out, ((y + offset) * size + offset) * 4, y * artwork * 4, (y + 1) * artwork * 4);
  }
  return out;
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log(`作成: ${file}`);
}
// Webページの共有画像（OGP）用の 256px（拡張には入れない）
const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "store", "output");
mkdirSync(webDir, { recursive: true });
writeFileSync(join(webDir, "icon-256.png"), png(256, render(256)));
console.log(`作成: ${join(webDir, "icon-256.png")}`);
// 128px は Chrome ウェブストアの指針どおり、96px の図柄に16pxの透明な余白を付ける
const file128 = join(outDir, "icon-128.png");
writeFileSync(file128, png(128, padded(128, 96)));
console.log(`作成: ${file128}`);
