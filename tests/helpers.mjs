import { JSDOM } from "jsdom";
import { createRenderer } from "../extension/core/render.js";

export function setup() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const renderer = createRenderer(dom.window, { imageLabel: "Image" });
  return { window: dom.window, renderer };
}

/** DocumentFragment を HTML 文字列にする（確認用）。 */
export function fragmentHtml(window, fragment) {
  const div = window.document.createElement("div");
  div.append(fragment.cloneNode(true));
  return div.innerHTML;
}
