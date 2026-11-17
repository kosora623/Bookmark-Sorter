// フォルダ一覧の状態と、選別画面の保存先（棚のボタンと、値を持つ select）
import { DEFAULT_FOLDER } from '../constants';
import { saveLastFolder, sendMessage } from './api';
import { state } from './state';

/** 数字キーで選べるフォルダの数 */
const SHORTCUT_FOLDERS = 9;

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
  renderFolderRack();
  return true;
}

export function selectFolderByShortcut(index: number): boolean {
  if (index >= SHORTCUT_FOLDERS) return false;
  const folder = state.folders[index];
  return folder ? applySortFolder(folder.name) : false;
}

export function populateFolderSelect(select: HTMLSelectElement, selected: string): void {
  const previous = selected || select.value || DEFAULT_FOLDER;
  select.replaceChildren();

  for (const folder of state.folders) {
    const option = document.createElement('option');
    option.value = folder.name;
    option.innerText = folder.name;
    select.appendChild(option);
  }

  if (![...select.options].some((option) => option.value === previous)) {
    const extra = document.createElement('option');
    extra.value = previous;
    extra.innerText = previous;
    select.appendChild(extra);
  }

  select.value = previous;
  if (select === sortFolderSelect()) renderFolderRack();
}

export function adjustFolderCount(name: string, delta: number): void {
  state.folders = state.folders.map((folder) =>
    folder.name === name ? { ...folder, count: Math.max(0, folder.count + delta) } : folder
  );
}

function createSlot(name: string, count: number | null, index: number, selected: boolean): HTMLButtonElement {
  const slot = document.createElement('button');
  slot.type = 'button';
  slot.className = 'slot';
  slot.dataset.folder = name;
  slot.setAttribute('aria-pressed', String(selected));

  const key = document.createElement('span');
  key.className = 'slot-key';
  if (index < SHORTCUT_FOLDERS) {
    key.innerText = String(index + 1);
    slot.setAttribute('aria-keyshortcuts', String(index + 1));
  } else {
    // 10 個目以降は数字キーでは選べないので、番号を出さない
    key.classList.add('none');
    key.innerText = '·';
    key.setAttribute('aria-hidden', 'true');
  }

  const label = document.createElement('span');
  label.className = 'slot-name';
  label.innerText = name;
  label.title = name;

  slot.append(key, label);

  if (count !== null) {
    const countEl = document.createElement('span');
    countEl.className = 'slot-count';
    countEl.innerText = String(count);
    countEl.setAttribute('aria-label', `${count}件`);
    slot.appendChild(countEl);
  }

  return slot;
}

/** 選別画面の棚（保存先のボタン）を作り直し、保存ボタンの文言を合わせる */
export function renderFolderRack(): void {
  const rack = document.getElementById('folder-rack');
  const selected = selectedSortFolder();

  if (rack) {
    for (const old of rack.querySelectorAll('.slot')) old.remove();
    const addForm = rack.querySelector('.add-folder-form');
    const fragment = document.createDocumentFragment();

    state.folders.forEach((folder, index) => {
      fragment.appendChild(createSlot(folder.name, folder.count, index, folder.name === selected));
    });
    // 一覧にないフォルダ（削除直後など）が選ばれていても、選択中であることは見せる
    if (!state.folders.some((folder) => folder.name === selected)) {
      fragment.appendChild(createSlot(selected, null, SHORTCUT_FOLDERS, true));
    }

    rack.insertBefore(fragment, addForm);
  }

  const keepLabel = document.getElementById('keep-label');
  if (keepLabel) keepLabel.innerText = `${selected}に保存`;
  document.getElementById('btn-keep')?.setAttribute('aria-label', `「${selected}」に保存（→）`);
}

/** 保存したフォルダの棚を一瞬光らせ、どこに入ったかを見せる */
export function flashFolderSlot(name: string): void {
  const rack = document.getElementById('folder-rack');
  if (!rack) return;
  for (const slot of rack.querySelectorAll<HTMLElement>('.slot')) {
    if (slot.dataset.folder !== name) continue;
    slot.classList.remove('received');
    void slot.offsetWidth; // アニメーションを最初からやり直す
    slot.classList.add('received');
  }
}

/** 棚のボタンのクリックで保存先を切り替える */
export function bindFolderRack(): void {
  document.getElementById('folder-rack')?.addEventListener('click', (e) => {
    const slot = (e.target as HTMLElement | null)?.closest('.slot');
    if (slot instanceof HTMLElement && slot.dataset.folder) {
      applySortFolder(slot.dataset.folder);
    }
  });
}

/** フォルダ一覧を取り直し、選別画面の保存先を作り直す */
export async function loadFolders(): Promise<void> {
  const response = await sendMessage({ action: 'list_folders' });
  state.folders = response.folders;

  const sortSelect = sortFolderSelect();
  if (sortSelect) populateFolderSelect(sortSelect, sortSelect.value || DEFAULT_FOLDER);
}
