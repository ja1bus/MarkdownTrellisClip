# MarkdownTrellis Clip

English | [日本語](README.md)

MarkdownTrellis Clip is a Google Chrome extension for Markdown you copied from an AI answer or anywhere else. Paste it, check it in the preview, fix it a little if needed, and copy it out as Markdown or as formatted text you can paste into Teams or email. The interface is available in English and Japanese.

This repository contains the source code of the publicly released MarkdownTrellis Clip.

## Features

- Opens a work tab from the toolbar icon. Ctrl+V takes in plain text only. The source and the preview are shown side by side
- Paste formatted text (off by default; turn it on in ⚙ > Paste settings…): formatted (HTML) text copied from an AI answer or elsewhere comes in as Markdown headings, bold, lists, tables, links and code. Text without formatting and Markdown source are pasted as they are
- GitHub Flavored Markdown: headings, emphasis, lists, task lists, tables, strikethrough, links, autolinks, code, quotes and horizontal rules
- Formatting buttons: headings, bold, italic, strikethrough, lists, checklists, links, images, tables, inline code, code blocks, quotes and horizontal rules (each action is undone with one Ctrl+Z)
- Copy Markdown (the source as is), Copy Formatted (HTML with inline styles plus matching plain text) and Copy Selection Formatted
- Detects a code fence that wraps the whole answer and can leave it out of the preview and formatted copy only. Front matter is hidden from the preview and kept in the source
- Extra syntax (alerts, footnotes, math shown as text, containers, highlight, wiki links, definition lists) with detection and a saved default
- Download the source as .md; Clear erases the source and the undo history

The text you enter is handled only in the work tab's memory and is never saved or sent anywhere. Only your settings are saved (the extra syntax default and whether to paste formatted text). The only permission is `storage` (for saving the settings). There is no website access, no content script and no analytics. The preview uses DOMPurify's allowlist and the extension page's CSP to prevent script execution and external loading.

## Supported OS and requirements

- Google Chrome 120 or later (the latest stable version is recommended). Tested on Windows 11.
- No account, other software or internet connection is needed.

## Installation

The official distribution is the [Chrome Web Store](https://chromewebstore.google.com/detail/markdowntrellis-clip/igldgckfcgjoinkicilfpkcbfilpggoe) (free).

- Web page: https://www.ja1bus.com/markdowntrellis-clip/en/

This GitHub repository does not distribute a packaged extension (ZIP or CRX).

## Basic usage

1. Click the toolbar icon to open a work tab.
2. Copy some Markdown and press Ctrl+V in the work tab.
3. Check it in the preview on the right and fix it with the formatting buttons if needed.
4. Use Copy Formatted for Teams or email, or Copy Markdown to paste the source as is.

See the user guide for details.

- User guide: https://www.ja1bus.com/markdowntrellis-clip/en/manual/

## Loading from source and testing

### Requirements

- Google Chrome 120 or later
- Only for tests and lint: [Node.js](https://nodejs.org/) 22 or later (tested: 26.13.0) and npm

### Loading into Chrome

No build is needed. Turn on Developer mode at chrome://extensions, click "Load unpacked", and select the `extension` folder (the folder with `manifest.json`). Do not select the repository root (it contains `node_modules` and other files).

### Tests

Run from the repository root.

```powershell
npm ci
npm run check   # bundled libraries match node_modules, lint, unit tests
npm run e2e     # starts the installed Chrome with a temporary profile and no window (English and Japanese)
```

`npm run e2e` uses the operating system clipboard even without a window, so the clipboard content is overwritten while it runs. If Chrome is not found, pass its path with `node tools/e2e.mjs --chrome <path to chrome.exe>`.

### Structure

| Path | Contents |
|---|---|
| `extension/manifest.json` | Manifest V3 definition (`storage` permission only, CSP) |
| `extension/background.js` | Service worker. Opens a work tab when the icon is clicked |
| `extension/editor.html` / `editor.css` / `editor.js` | Work screen (source, formatting buttons, preview, copy, download, clear) |
| `extension/core/` | Logic independent of the screen (front matter and outer fence, conversion and sanitizing, extra syntax, formatted copy, formatting, pasting formatted text) |
| `extension/settings.js` | Saves the settings (extra syntax default, pasting formatted text). The only file that uses storage |
| `extension/vendor/` / `extension/licenses/` | Bundled libraries (marked, DOMPurify) and their licenses, copied from `node_modules` with `npm run vendor` |
| `extension/_locales/` / `extension/icons/` | Languages (English and Japanese) and icons (made with `node tools/make-icons.mjs`) |
| `tests/` | Node.js unit tests (`node:test`, jsdom) |
| `tools/` | Lint, copying the bundled libraries, checks in Chrome, icon generation |

Materials for the Chrome Web Store submission and the scripts that build its ZIP and images are not included in this repository. Source comments are in Japanese.

## License

Released under the [MIT License](LICENSE).

Copyright (c) 2026 ja1bus (© ja1bus)

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for the bundled third-party libraries.

## No warranty

This software is provided "as is", without warranty of any kind, express or implied. In no event shall the author be liable for any damages arising from the use of this software (see [LICENSE](LICENSE) for details).

## Links

- Web page: https://www.ja1bus.com/markdowntrellis-clip/en/
- User guide: https://www.ja1bus.com/markdowntrellis-clip/en/manual/
- Privacy policy: https://www.ja1bus.com/markdowntrellis-clip/en/privacy/
- Contact: contact@ja1bus.com
