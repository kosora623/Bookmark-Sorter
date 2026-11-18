// ダッシュボードの描画前に、選んだテーマを <html data-theme> に当てる。
// モジュールの読み込みを待つと一瞬だけ別の配色が見えるので、<head> から同期で読む小さなファイルにしている。
// キー名と値は src/dashboard/theme.ts と合わせること。
(function () {
  try {
    var theme = localStorage.getItem('dashboardTheme');
    if (theme === 'light' || theme === 'dim' || theme === 'black') {
      document.documentElement.dataset.theme = theme;
    }
  } catch (error) {
    // 保存先が読めないときは「自動」のまま
  }
})();
