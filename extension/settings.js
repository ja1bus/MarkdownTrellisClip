// 設定の保存。保存するのは「今後開くタブで有効にする追加構文の名前」と「書式付きテキストの貼り付け」の ON/OFF だけで、本文は扱わない。
// 保存先: 拡張の保存領域（local）のキー defaultFeatures（例: ["alerts", "footnotes"]）と pasteHtml（true / false）。
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

// 書式付きテキストの貼り付け（HTML を Markdown へ変換する）の ON/OFF。キー pasteHtml（true / false）。
// 既定値の保存（defaultFeatures）とは別のキーなので、どちらを保存しても他方は変わらない。
export const PASTE_HTML_KEY = "pasteHtml";

/** 書式付きテキストの貼り付けが ON か。未保存・読めないときは OFF。 */
export async function loadPasteHtml() {
  try {
    const stored = await chrome.storage.local.get(PASTE_HTML_KEY);
    return stored[PASTE_HTML_KEY] === true;
  } catch {
    return false;
  }
}

/** 書式付きテキストの貼り付けの ON/OFF を保存する。 */
export async function savePasteHtml(enabled) {
  await chrome.storage.local.set({ [PASTE_HTML_KEY]: enabled === true });
}

/** 書式付きテキストの貼り付けの ON/OFF が（別のタブなどで）変わったら知らせる。 */
export function watchPasteHtml(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && PASTE_HTML_KEY in changes) {
      callback(changes[PASTE_HTML_KEY].newValue === true);
    }
  });
}
