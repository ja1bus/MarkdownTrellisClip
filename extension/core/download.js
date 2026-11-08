// ダウンロード時のファイル名。本文の内容をファイル名に使わない。

/** @param {Date} date */
export function buildDownloadName(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `markdown-trellis-clip-${stamp}.md`;
}

/** 原文をそのまま UTF-8（BOMなし）の Markdown として包む。 */
export function buildMarkdownBlob(text, BlobCtor = Blob) {
  return new BlobCtor([text], { type: "text/markdown;charset=utf-8" });
}
