// ダッシュボードのエントリー。各画面の部品は src/dashboard/ にあり、ここでは
// タブの切り替え・データ全体の操作の後始末・初期化と、画面をまたぐイベントの登録だけを行う。
import { logUnexpected } from './runtime';
import {
  clearAllData,
  exportAllData,
  importFromFile,
  retryUnbookmarkFailures,
  updateUnbookmarkFailures
} from './dashboard/data';
import { loadFolders, renderFolderRack } from './dashboard/folders';
import { showToast } from './dashboard/notify';
import { bindThemeMenu } from './dashboard/theme';
import { addFolderFromInput, bindKeptView, loadKeptView, resetKeptState } from './dashboard/kept-view';
import { bindSortView, loadNextPost, resetSortState } from './dashboard/sort-view';
import { runExclusive, state, type ViewMode } from './dashboard/state';

const FAILURE_POLL_MS = 10_000;

function setView(mode: ViewMode): void {
  state.viewMode = mode;
  const sortView = document.getElementById('sort-view');
  const keptView = document.getElementById('kept-view');
  const tabSort = document.getElementById('tab-sort');
  const tabKept = document.getElementById('tab-kept');

  if (sortView) sortView.hidden = mode !== 'sort';
  if (keptView) keptView.hidden = mode !== 'kept';
  tabSort?.classList.toggle('active', mode === 'sort');
  tabKept?.classList.toggle('active', mode === 'kept');

  if (mode === 'kept') {
    void loadKeptView().catch(logUnexpected);
  } else {
    // 保存済み画面でフォルダを増減・移動していることがあるので、棚の件数を合わせる
    renderFolderRack();
  }
}

/** データ全体が入れ替わった後（全消去・インポート）に、手元の状態を捨てて読み込み直す */
async function reloadAll(): Promise<void> {
  resetSortState();
  resetKeptState();
  await loadFolders();
  await loadNextPost();
  if (state.viewMode === 'kept') await loadKeptView();
}

bindThemeMenu();
bindSortView();
bindKeptView();

document.getElementById('tab-sort')?.addEventListener('click', () => setView('sort'));
document.getElementById('tab-kept')?.addEventListener('click', () => setView('kept'));

// フォルダ追加は選別画面と保存済み画面の両方にある
for (const [formId, inputId] of [
  ['add-folder-form', 'add-folder-input'],
  ['sort-add-folder-form', 'sort-add-folder-input']
] as const) {
  document.getElementById(formId)?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    void addFolderFromInput(input, true).catch(logUnexpected);
  });
}

// ヘッダーのメニュー（表示・データ）は、外をクリックしたら・Esc で閉じる。
// データの項目は選んだら閉じる。表示のテーマは見比べられるよう、選んでも開いたままにする。
for (const menu of document.querySelectorAll<HTMLDetailsElement>('header details.data-menu')) {
  menu.addEventListener('click', (e) => {
    if ((e.target as HTMLElement | null)?.closest('.menu-item')) menu.open = false;
  });
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
  });
  // 片方を開いたら、もう片方は閉じる
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    for (const other of document.querySelectorAll<HTMLDetailsElement>('header details.data-menu')) {
      if (other !== menu) other.open = false;
    }
  });
}

document.getElementById('clear-all-btn')?.addEventListener('click', () => {
  void runExclusive(async () => {
    if (await clearAllData()) await reloadAll();
  });
});

document.getElementById('unbookmark-failed-btn')?.addEventListener('click', () => {
  void runExclusive(retryUnbookmarkFailures);
});

document.getElementById('export-btn')?.addEventListener('click', () => {
  void runExclusive(exportAllData);
});

document.getElementById('import-btn')?.addEventListener('click', () => {
  document.getElementById('import-file')?.click();
});

document.getElementById('import-file')?.addEventListener('change', (e) => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  void runExclusive(async () => {
    const imported = await importFromFile(file);
    if (imported === null) return;
    await reloadAll();
    showToast(`${imported}件を読み込みました`, 'success');
  });
});

// 解除キューは background で進むので、失敗件数はときどき取り直す
setInterval(() => {
  if (document.hidden) return;
  void updateUnbookmarkFailures().catch(logUnexpected);
}, FAILURE_POLL_MS);

void loadFolders()
  .then(async () => {
    await updateUnbookmarkFailures();
    return loadNextPost();
  })
  .catch(logUnexpected);
