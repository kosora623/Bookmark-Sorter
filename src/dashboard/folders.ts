// フォルダ一覧の状態と、選別画面の棚（保存先のボタン）
import { DEFAULT_FOLDER } from '../constants';
import { sendMessage } from './api';
import { state } from './state';

/** 数字キーで選べるフォルダの数 */
const SHORTCUT_FOLDERS = 9;

/** 数字キー（1 始まりの並び順）に当たるフォルダ名。無ければ null */
export function folderByShortcut(index: number): string | null {
  if (index >= SHORTCUT_FOLDERS) return null;
  return state.folders[index]?.name ?? null;
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
}

export function adjustFolderCount(name: string, delta: number): void {
  state.folders = state.folders.map((folder) =>
    folder.name === name ? { ...folder, count: Math.max(0, folder.count + delta) } : folder
  );
}

function createSlot(name: string, count: number, index: number): HTMLButtonElement {
  const slot = document.createElement('button');
  slot.type = 'button';
  slot.className = 'slot';
  slot.dataset.folder = name;
  slot.title = `「${name}」に保存して次へ`;

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

  const countEl = document.createElement('span');
  countEl.className = 'slot-count';
  countEl.innerText = String(count);
  countEl.setAttribute('aria-label', `${count}件`);
  slot.appendChild(countEl);

  return slot;
}

/** 選別画面の棚（保存先のボタン）を作り直す */
export function renderFolderRack(): void {
  const rack = document.getElementById('folder-rack');
  if (!rack) return;

  for (const old of rack.querySelectorAll('.slot')) old.remove();
  const fragment = document.createDocumentFragment();
  state.folders.forEach((folder, index) => {
    fragment.appendChild(createSlot(folder.name, folder.count, index));
  });
  rack.insertBefore(fragment, rack.querySelector('.add-folder-form'));
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

/** 棚のボタンをクリックしたら、そのフォルダを onPick に渡す */
export function bindFolderRack(onPick: (folder: string) => void): void {
  document.getElementById('folder-rack')?.addEventListener('click', (e) => {
    const slot = (e.target as HTMLElement | null)?.closest('.slot');
    if (slot instanceof HTMLElement && slot.dataset.folder) {
      onPick(slot.dataset.folder);
    }
  });
}

/** フォルダ一覧を取り直し、選別画面の棚を作り直す */
export async function loadFolders(): Promise<void> {
  const response = await sendMessage({ action: 'list_folders' });
  state.folders = response.folders;
  renderFolderRack();
}
