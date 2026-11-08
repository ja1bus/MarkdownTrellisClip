// 設定の保存。保存するのは「今後開くタブで有効にする追加構文の名前」だけで、本文は扱わない。
// 保存先: 拡張の保存領域（local）のキー defaultFeatures（例: ["alerts", "footnotes"]）。
import { normalizeFeatures } from "./core/extensions.js";

const KEY = "defaultFeatures";

/** 保存済みの既定値を読む。読めなければ空（どれも無効）。 */
export async function loadDefaultFeatures() {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return normalizeFeatures(stored[KEY]);
  } catch {
    return [];
  }
}

/** 既定値を保存する。知らない名前は保存しない。 */
export async function saveDefaultFeatures(features) {
  await chrome.storage.local.set({ [KEY]: normalizeFeatures(features) });
}
