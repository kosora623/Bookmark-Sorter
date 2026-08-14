(() => {
  try {
    if (typeof chrome.runtime.id !== 'string') return;
    const src = `${chrome.runtime.getURL('assets/content.js')}?t=${Date.now()}`;
    void import(src).catch(() => {
      // 拡張機能の再読み込み後はモジュール取得に失敗することがある
    });
  } catch {
    // Extension context invalidated
  }
})();
