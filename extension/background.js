// 拡張アイコンを押すたびに、独立した作業タブを開く。状態は持たない。
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
});
