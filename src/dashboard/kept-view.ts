// 保存済み画面: フォルダごとの一覧・検索・フォルダの移動と、フォルダの追加・削除
import { DEFAULT_FOLDER } from '../constants';
import type { BookmarkPost } from '../db';
import { sanitizeFolderName } from '../normalize';
import { logUnexpected } from '../runtime';
import { openTweet, saveLastFolder, sendMessage } from './api';
import { createIcon, fillAuthor, fillTextWithLinks, renderLinkPreview } from './dom';
import { adjustFolderCount, loadFolders, populateFolderSelect, sortFolderSelect } from './folders';
import { runExclusive, state } from './state';

const SEARCH_DEBOUNCE_MS = 150;
const KEPT_PAGE_SIZE = 40;

// 保存済みは「いま読み込んだページ分」だけを持つ。全件は background 側にある
let keptPosts: BookmarkPost[] = [];
let keptTotal = 0;
let keptRequestId = 0;
let openFolder = DEFAULT_FOLDER;
let searchQuery = '';
let searchTimer: ReturnType<typeof setTimeout> | null = null;

/** データの全消去・インポートの後に、保存済み画面の状態を捨てる */
export function resetKeptState(): void {
  keptPosts = [];
  keptTotal = 0;
  keptRequestId++;
  searchQuery = '';
  openFolder = DEFAULT_FOLDER;
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  clearSearchInput();
}

function clearSearchInput(): void {
  const searchInput = document.getElementById('kept-search') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';
}

function renderFolderList(): void {
  const listEl = document.getElementById('folder-list');
  if (!listEl) return;

  listEl.replaceChildren();
  const fragment = document.createDocumentFragment();

  for (const folder of state.folders) {
    const item = document.createElement('li');
    item.className = 'folder-row';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `folder-item${folder.name === openFolder ? ' active' : ''}`;
    button.dataset.folder = folder.name;

    const name = document.createElement('span');
    name.className = 'folder-item-name';
    name.innerText = folder.name;

    const count = document.createElement('span');
    count.className = 'folder-item-count';
    count.innerText = String(folder.count);

    button.append(name, count);
    item.appendChild(button);

    if (!folder.locked) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'folder-delete';
      remove.dataset.action = 'delete-folder';
      remove.dataset.folder = folder.name;
      remove.title = '削除';
      remove.setAttribute('aria-label', `フォルダ「${folder.name}」を削除`);
      remove.appendChild(createIcon('trash'));
      item.appendChild(remove);
    }

    fragment.appendChild(item);
  }

  listEl.appendChild(fragment);
}

/**
 * 現在のフォルダ・検索条件で保存済みを読み込む。reset なら 1 ページ目から、そうでなければ続きを足す。
 * 検索の連続入力などで古い応答が後から届いたら捨てる。
 */
async function loadKeptPage(reset: boolean): Promise<void> {
  const requestId = ++keptRequestId;
  const response = await sendMessage({
    action: 'list_kept',
    folder: openFolder,
    query: searchQuery,
    offset: reset ? 0 : keptPosts.length,
    limit: KEPT_PAGE_SIZE
  });
  if (requestId !== keptRequestId) return;

  keptPosts = reset ? response.posts : [...keptPosts, ...response.posts];
  keptTotal = response.total;
  renderKeptList();
}

function reloadKeptList(): void {
  void loadKeptPage(true).catch(logUnexpected);
}

function updateKeptMore(): void {
  const moreBtn = document.getElementById('kept-more') as HTMLButtonElement | null;
  if (!moreBtn) return;
  const remaining = keptTotal - keptPosts.length;
  moreBtn.hidden = remaining <= 0;
  if (remaining > 0) {
    moreBtn.innerText = `さらに表示（残り ${remaining}）`;
  }
}

function renderKeptHeading(): void {
  const heading = document.getElementById('kept-heading');
  if (!heading) return;

  const query = searchQuery.trim();
  heading.innerText = query ? `「${query}」の検索結果` : openFolder;
}

function createKeptFolderSelect(selectedFolder: string): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'kept-folder';
  select.dataset.role = 'folder';
  populateFolderSelect(select, selectedFolder);
  return select;
}

function renderKeptList(): void {
  const listEl = document.getElementById('kept-list');
  const emptyEl = document.getElementById('kept-empty');
  const emptyTitle = emptyEl?.querySelector('.empty-title');
  const emptySub = emptyEl?.querySelector('.empty-sub');
  if (!listEl || !emptyEl) return;

  const query = searchQuery.trim();

  renderKeptHeading();
  emptyEl.hidden = keptPosts.length > 0;
  if (emptyTitle instanceof HTMLElement) {
    emptyTitle.innerText = query ? '一致するツイートはありません' : 'このフォルダは空です';
  }
  if (emptySub instanceof HTMLElement) {
    emptySub.innerText = query
      ? '別のキーワードを試してください'
      : '選別タブで → を押すと、選択中のフォルダに保存されます';
  }

  listEl.replaceChildren();
  const fragment = document.createDocumentFragment();
  const showBadge = query.length > 0;

  for (const post of keptPosts) {
    const row = document.createElement('div');
    row.className = 'kept-row';
    row.dataset.id = post.id;
    row.dataset.url = post.url;

    const head = document.createElement('div');
    head.className = 'kept-head';

    const author = document.createElement('div');
    author.className = 'author';
    fillAuthor(author, post.author);

    const openHint = document.createElement('span');
    openHint.className = 'kept-open';
    openHint.title = 'Twitterで開く';
    openHint.appendChild(createIcon('open'));

    head.append(author, openHint);

    const text = document.createElement('div');
    text.className = 'kept-text';
    const collapsed = post.text.replace(/\s+/g, ' ');
    if (collapsed) {
      fillTextWithLinks(text, collapsed);
    } else {
      text.innerText = '(本文なし)';
    }

    const folderSelect = createKeptFolderSelect(post.folder);
    folderSelect.setAttribute('aria-label', 'フォルダを移動');
    const edit = document.createElement('div');
    edit.className = 'kept-edit';
    edit.append(folderSelect);

    row.append(head, text);
    if (post.linkCard) {
      const previewWrap = document.createElement('div');
      previewWrap.className = 'link-preview-wrap';
      renderLinkPreview(previewWrap, post.linkCard);
      row.appendChild(previewWrap);
    }
    if (showBadge) {
      const badge = document.createElement('span');
      badge.className = 'kept-folder-badge';
      badge.innerText = post.folder;
      row.appendChild(badge);
    }
    row.appendChild(edit);
    fragment.appendChild(row);
  }

  listEl.appendChild(fragment);
  updateKeptMore();
}

async function persistKeptFolder(id: string, folder: string): Promise<void> {
  const post = keptPosts.find((item) => item.id === id);
  if (!post || post.folder === folder) return;

  // DB を先に更新してから一覧を詰める。次ページの offset がずれないようにするため
  await sendMessage({ action: 'update_bookmark', id, changes: { folder } });
  adjustFolderCount(post.folder, -1);
  adjustFolderCount(folder, 1);

  if (searchQuery.trim()) {
    // 検索結果は全フォルダ横断なので、行は残してバッジだけ変える
    post.folder = folder;
  } else {
    keptPosts = keptPosts.filter((item) => item.id !== id);
    keptTotal = Math.max(0, keptTotal - 1);
  }
  renderFolderList();
  renderKeptList();
}

/** フォルダ一覧と、開いているフォルダの 1 ページ目を読み込み直す */
export async function loadKeptView(): Promise<void> {
  await loadFolders();
  // 開いていたフォルダが消えていたら既定のフォルダに戻す
  if (!state.folders.some((folder) => folder.name === openFolder)) {
    openFolder = DEFAULT_FOLDER;
  }
  renderFolderList();
  await loadKeptPage(true);
}

/** 入力欄の名前でフォルダを追加する。selectAfterAdd なら追加したフォルダを開き、選別先にもする */
export async function addFolderFromInput(input: HTMLInputElement | null, selectAfterAdd: boolean): Promise<void> {
  const name = input?.value ?? '';
  const response = await sendMessage({
    action: 'add_folder',
    name
  });

  state.folders = response.folders;
  if (!response.ok) {
    window.alert(response.error || 'フォルダを追加できませんでした');
    return;
  }

  if (input) input.value = '';
  const addedName = sanitizeFolderName(name);
  const exists = state.folders.some((folder) => folder.name === addedName);
  if (exists && selectAfterAdd) {
    openFolder = addedName;
    saveLastFolder(addedName);
  }

  const sortSelect = sortFolderSelect();
  if (sortSelect) {
    populateFolderSelect(sortSelect, exists && selectAfterAdd ? addedName : sortSelect.value);
  }
  renderFolderList();
  if (state.viewMode === 'kept') await loadKeptPage(true);
}

async function removeFolder(name: string): Promise<void> {
  const confirmed = confirm(`フォルダ「${name}」を削除します。中のポストは「${DEFAULT_FOLDER}」へ移します。よろしいですか？`);
  if (!confirmed) return;

  const response = await sendMessage({
    action: 'delete_folder',
    name
  });

  if (!response.ok) {
    window.alert(response.error || 'フォルダを削除できませんでした');
    return;
  }

  state.folders = response.folders;
  if (openFolder === name) openFolder = DEFAULT_FOLDER;

  const sortSelect = sortFolderSelect();
  if (sortSelect) {
    const nextFolder = sortSelect.value === name ? DEFAULT_FOLDER : sortSelect.value;
    populateFolderSelect(sortSelect, nextFolder);
    if (nextFolder === DEFAULT_FOLDER) saveLastFolder(DEFAULT_FOLDER);
  }

  renderFolderList();
  await loadKeptPage(true);
}

/** 保存済み画面のフォルダ一覧・検索・一覧の操作を登録する */
export function bindKeptView(): void {
  document.getElementById('folder-list')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const deleteBtn = target?.closest('[data-action="delete-folder"]');
    if (deleteBtn instanceof HTMLElement && deleteBtn.dataset.folder) {
      e.preventDefault();
      e.stopPropagation();
      void removeFolder(deleteBtn.dataset.folder).catch(logUnexpected);
      return;
    }

    const item = target?.closest('.folder-item');
    if (!(item instanceof HTMLElement) || !item.dataset.folder) return;

    openFolder = item.dataset.folder;
    clearSearchInput();
    searchQuery = '';
    renderFolderList();
    reloadKeptList();
  });

  document.getElementById('kept-search')?.addEventListener('input', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = target.value;
      reloadKeptList();
    }, SEARCH_DEBOUNCE_MS);
  });

  document.getElementById('kept-more')?.addEventListener('click', () => {
    void runExclusive(() => loadKeptPage(false));
  });

  document.getElementById('kept-list')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('select, input, .kept-edit, .field, a')) return;

    const row = target?.closest('[data-url]');
    if (row instanceof HTMLElement && row.dataset.url) {
      openTweet(row.dataset.url);
    }
  });

  document.getElementById('kept-list')?.addEventListener('change', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLSelectElement) || target.dataset.role !== 'folder') return;

    const row = target.closest('[data-id]');
    const id = row instanceof HTMLElement ? row.dataset.id : undefined;
    if (!id) return;

    if (state.isBusy) {
      // 処理中で受け付けられないときは、プルダウンの表示を元に戻す
      renderKeptList();
      return;
    }
    void runExclusive(() => persistKeptFolder(id, target.value));
  });
}
