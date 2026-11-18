// 表示テーマ（自動・ライト・ダークブルー・ブラック）の切り替え。
// 選んだテーマは <html data-theme> に入れ、localStorage に覚える。
// 描画前の適用は public/theme-init.js が行うので、キー名と値はそちらと合わせること。

const THEME_KEY = 'dashboardTheme';

export const THEMES = ['auto', 'light', 'dim', 'black'] as const;
export type Theme = (typeof THEMES)[number];

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isTheme(stored) ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

/** テーマを当てて覚える。auto は data-theme を外し、端末の設定に任せる */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;

  try {
    if (theme === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 保存できなくても、開いている間は選んだテーマで表示する
  }
}

/** 表示メニューのラジオボタンを今のテーマに合わせ、選んだらすぐ切り替える */
export function bindThemeMenu(): void {
  const current = loadTheme();
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="theme"]');
  for (const radio of radios) {
    radio.checked = radio.value === current;
    radio.addEventListener('change', () => {
      if (radio.checked && isTheme(radio.value)) applyTheme(radio.value);
    });
  }
}
