// フォルダ一覧の状態と、選別画面のフォルダのプルダウン
import { DEFAULT_FOLDER } from '../constants';
import { saveLastFolder, sendMessage } from './api';
import { state } from './state';

export function sortFolderSelect(): HTMLSelectElement | null {
  return document.getElementById('folder-select') as HTMLSelectElement | null;
}

export function selectedSortFolder(): string {
  return sortFolderSelect()?.value || DEFAULT_FOLDER;
}

function applySortFolder(name: string): boolean {
  const sortSelect = sortFolderSelect();
  if (!sortSelect) return false;
  if (![...sortSelect.options].some((option) => option.value === name)) return false;
  sortSelect.value = name;
  saveLastFolder(name);
  return true;
}

export function selectFolderByShortcut(index: number): boolean {
  const folder = state.folders[index];
  return folder ? applySortFolder(folder.name) : false;
}

export function populateFolderSelect(select: HTMLSelectElement, selected: string): void {
  const previous = selected || select.value || DEFAULT_FOLDER;
  const withShortcuts = select.id === 'folder-select';
  select.replaceChildren();

  state.folders.forEach((folder, index) => {
    const option = document.createElement('option');
    option.value = folder.name;
    option.innerText = withShortcuts && index < 9 ? `${index + 1}  ${folder.name}` : folder.name;
    select.appendChild(option);
  });

  if (![...select.options].some((option) => option.value === previous)) {
    const extra = document.createElement('option');
    extra.value = previous;
    extra.innerText = previous;
    select.appendChild(extra);
  }

  select.value = previous;
}

export function adjustFolderCount(name: string, delta: number): void {
  state.folders = state.folders.map((folder) =>
    folder.name === name ? { ...folder, count: Math.max(0, folder.count + delta) } : folder
  );
}

/** フォルダ一覧を取り直し、選別画面のプルダウンを作り直す */
export async function loadFolders(): Promise<void> {
  const response = await sendMessage({ action: 'list_folders' });
  state.folders = response.folders;

  const sortSelect = sortFolderSelect();
  if (sortSelect) populateFolderSelect(sortSelect, sortSelect.value || DEFAULT_FOLDER);
}
