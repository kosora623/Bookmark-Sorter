// 保存済み画面: フォルダごとの一覧・検索・フォルダの移動（1 件・まとめて）と、フォルダの追加・削除・並べ替え
import { DEFAULT_FOLDER } from '../constants';
import type { BookmarkPost } from '../db';
import { sanitizeFolderName } from '../normalize';
import { logUnexpected } from '../runtime';
import { isHttpUrl } from '../urls';
import { openTweet, sendMessage } from './api';
import { createIcon, fillAuthor, fillTextWithLinks, renderLinkPreview } from './dom';
import { adjustFolderCount, loadFolders, populateFolderSelect, renderFolderRack } from './folders';
import { confirmDialog, showToast } from './notify';
import { updateCount } from './sort-view';
import { runExclusive, state } from './state';

const SEARCH_DEBOUNCE_MS = 150;
const KEPT_PAGE_SIZE = 40;
/** まとめて削除の「取り消す」を出しておく時間。background はこれより長く（12 秒）待ってから解除を始める */
const UNDO_TOAST_MS = 10_000;

// 保存済みは「いま読み込んだページ分」だけを持つ。全件は background 側にある
let keptPosts: BookmarkPost[] = [];
let keptTotal = 0;
let keptRequestId = 0;
let openFolder = DEFAULT_FOLDER;
let searchQuery = '';
let searchTimer: ReturnType<typeof setTimeout> | null = null;
/** チェックを入れたポストの ID。フォルダや検索を切り替えたら空にする */
const selectedIds = new Set<string>();
/** Shift+クリックで範囲を選ぶときの起点 */
let lastCheckedId: string | null = null;

// ドラッグの中身の種類。フォルダの並べ替えと、ポストのフォルダ移動を見分ける
const DRAG_FOLDER = 'application/x-bms-folder';
const DRAG_POSTS = 'application/x-bms-posts';

/** データの全消去・インポートの後に、保存済み画面の状態を捨てる */
export function resetKeptState(): void {
  keptPosts = [];
  keptTotal = 0;
  keptRequestId++;
  searchQuery = '';
  openFolder = DEFAULT_FOLDER;
  clearSelection();
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
    item.draggable = true;
    item.dataset.folder = folder.name;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `folder-item${folder.name === openFolder ? ' active' : ''}`;
    button.dataset.folder = folder.name;
    button.title = 'ドラッグか Alt+↑↓ で並べ替え';
    button.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');

    const name = document.createElement('span');
    name.className = 'folder-item-name';
    name.innerText = folder.name;

    const count = document.createElement('span');
    count.className = 'folder-item-count';
    count.innerText = String(folder.count);

    button.append(name, count);
    item.appendChild(button);

    if (!folder.locked) {
      const tools = document.createElement('span');
      tools.className = 'folder-tools';

      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'folder-tool folder-rename';
      rename.dataset.action = 'rename-folder';
      rename.dataset.folder = folder.name;
      rename.title = '名前を変更（ダブルクリックでも）';
      rename.setAttribute('aria-label', `フォルダ「${folder.name}」の名前を変更`);
      rename.appendChild(createIcon('edit'));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'folder-tool folder-delete';
      remove.dataset.action = 'delete-folder';
      remove.dataset.folder = folder.name;
      remove.title = '削除';
      remove.setAttribute('aria-label', `フォルダ「${folder.name}」を削除`);
      remove.appendChild(createIcon('trash'));

      tools.append(rename, remove);
      item.appendChild(tools);
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
  const total = document.getElementById('kept-total');
  if (total) total.innerText = keptTotal > 0 ? `${keptTotal}件` : '';
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
      : '選別画面でフォルダを選ぶと、ここに入ります';
  }

  listEl.replaceChildren();
  const fragment = document.createDocumentFragment();
  const showBadge = query.length > 0;

  for (const post of keptPosts) {
    const row = document.createElement('div');
    const selected = selectedIds.has(post.id);
    row.className = `kept-row${selected ? ' selected' : ''}`;
    row.dataset.id = post.id;
    row.dataset.url = post.url;
    row.draggable = true;

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'kept-check';
    check.dataset.role = 'select';
    check.checked = selected;
    check.setAttribute('aria-label', '選択');

    const head = document.createElement('div');
    head.className = 'kept-head';

    const author = document.createElement('div');
    author.className = 'author';
    fillAuthor(author, post.author);

    head.append(author);

    const openLink = document.createElement('a');
    openLink.className = 'kept-open';
    openLink.href = isHttpUrl(post.url) ? post.url : '#';
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.append('元ポスト', createIcon('open'));

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
    edit.append(openLink, folderSelect);

    const body = document.createElement('div');
    body.className = 'kept-body';
    body.append(head, text);
    if (post.linkCard) {
      const previewWrap = document.createElement('div');
      previewWrap.className = 'link-preview-wrap';
      renderLinkPreview(previewWrap, post.linkCard);
      body.appendChild(previewWrap);
    }
    if (showBadge) {
      const badge = document.createElement('span');
      badge.className = 'kept-folder-badge';
      badge.innerText = post.folder;
      body.appendChild(badge);
    }
    row.append(check, body, edit);
    fragment.appendChild(row);
  }

  listEl.appendChild(fragment);
  updateKeptMore();
  renderSelectionBar();
}

function clearSelection(): void {
  selectedIds.clear();
  lastCheckedId = null;
}

/** 選択中の件数と、まとめて移動する操作の帯を出す */
function renderSelectionBar(): void {
  const bar = document.getElementById('kept-selection');
  if (!bar) return;

  // 読み込み直しで画面から消えたポストは選択からも外す
  const visible = new Set(keptPosts.map((post) => post.id));
  for (const id of selectedIds) if (!visible.has(id)) selectedIds.delete(id);

  bar.hidden = selectedIds.size === 0;
  const count = document.getElementById('kept-selection-count');
  if (count) count.innerText = `${selectedIds.size}件を選択中`;

  const all = document.getElementById('kept-select-all') as HTMLButtonElement | null;
  if (all) all.hidden = keptPosts.length === 0 || selectedIds.size >= keptPosts.length;

  const select = document.getElementById('kept-move-target') as HTMLSelectElement | null;
  if (select && !bar.hidden) {
    // 名前の変更や削除で消えたフォルダが選ばれたまま残らないようにする
    const current = state.folders.some((folder) => folder.name === select.value) ? select.value : '';
    populateFolderSelect(select, current);
    // 開いているフォルダへは移せないので、別のフォルダを選んでおく
    if (!searchQuery.trim() && select.value === openFolder) {
      const other = state.folders.find((folder) => folder.name !== openFolder);
      if (other) select.value = other.name;
    }
  }
}

function setRowSelected(id: string, selected: boolean): void {
  if (selected) selectedIds.add(id);
  else selectedIds.delete(id);
  const row = [...document.querySelectorAll<HTMLElement>('#kept-list .kept-row')].find((el) => el.dataset.id === id);
  row?.classList.toggle('selected', selected);
  const check = row?.querySelector<HTMLInputElement>('.kept-check');
  if (check) check.checked = selected;
}

/** クリックで 1 件、Shift+クリックで直前に選んだ行からの範囲をまとめて切り替える */
function toggleRow(id: string, selected: boolean, range: boolean): void {
  const ids = keptPosts.map((post) => post.id);
  const from = range && lastCheckedId ? ids.indexOf(lastCheckedId) : -1;
  const to = ids.indexOf(id);
  if (from >= 0 && to >= 0) {
    const [start, end] = from < to ? [from, to] : [to, from];
    for (const rangeId of ids.slice(start, end + 1)) setRowSelected(rangeId, selected);
  } else {
    setRowSelected(id, selected);
  }
  lastCheckedId = id;
  renderSelectionBar();
}

function deselectAll(): void {
  for (const id of [...selectedIds]) setRowSelected(id, false);
  lastCheckedId = null;
  renderSelectionBar();
}

/** ids のポストを folder へまとめて移す */
async function moveSelected(ids: string[], folder: string): Promise<void> {
  const targets = ids.filter((id) => keptPosts.some((post) => post.id === id && post.folder !== folder));
  if (targets.length === 0) return;

  const response = await sendMessage({ action: 'move_bookmarks', ids: targets, folder });
  state.folders = response.folders;
  if (!response.ok) {
    renderFolderList();
    showToast('移動できませんでした', 'error');
    return;
  }

  const moved = new Set(targets);
  if (searchQuery.trim()) {
    // 検索結果は全フォルダ横断なので、行は残してバッジだけ変える
    for (const post of keptPosts) if (moved.has(post.id)) post.folder = folder;
  } else {
    keptPosts = keptPosts.filter((post) => !moved.has(post.id));
    keptTotal = Math.max(0, keptTotal - moved.size);
  }
  for (const id of moved) selectedIds.delete(id);

  renderFolderRack();
  renderFolderList();
  renderKeptList();
  showToast(`${response.moved}件を「${folder}」に移動しました`, 'success');

  // 表示していた分を全部移したら、続きのページを読み込む
  if (!searchQuery.trim() && keptPosts.length === 0 && keptTotal > 0) await loadKeptPage(true);
}

/** 選んだポストを確認のうえまとめて削除し、Twitter 側の解除を予約する。少しの間は取り消せる */
async function discardSelected(): Promise<void> {
  const ids = keptPosts.filter((post) => selectedIds.has(post.id)).map((post) => post.id);
  if (ids.length === 0) return;

  const confirmed = await confirmDialog({
    message: `${ids.length}件を削除し、Twitter のブックマークも解除します。解除は 1 件ずつ順に進み、始まったものは Twitter 側では元に戻せません。よろしいですか？`,
    confirmLabel: `${ids.length}件を削除`,
    danger: true
  });
  if (!confirmed) return;

  const response = await sendMessage({ action: 'discard_bookmarks', ids });
  state.folders = response.folders;

  const removed = new Set(ids);
  keptPosts = keptPosts.filter((post) => !removed.has(post.id));
  keptTotal = Math.max(0, keptTotal - response.discarded);
  for (const id of ids) selectedIds.delete(id);
  lastCheckedId = null;

  renderFolderRack();
  renderFolderList();
  renderKeptList();
  await updateCount();
  showToast(`${response.discarded}件を削除しました`, 'info', {
    label: '取り消す',
    durationMs: UNDO_TOAST_MS,
    // 取り消しは、ほかの処理中でも捨てずに必ず実行する（捨てると、そのまま解除が始まってしまう）
    onClick: () => {
      void restoreDiscarded(ids).catch((error: unknown) => {
        logUnexpected(error);
        showToast('元に戻せませんでした。もう一度削除の取り消しはできません', 'error');
      });
    }
  });

  if (!searchQuery.trim() && keptPosts.length === 0 && keptTotal > 0) await loadKeptPage(true);
}

async function restoreDiscarded(ids: string[]): Promise<void> {
  const response = await sendMessage({ action: 'restore_bookmarks', ids });
  state.folders = response.folders;
  renderFolderRack();
  renderFolderList();
  await updateCount();
  await loadKeptPage(true);
  showToast(
    response.unbookmarked > 0
      ? `${response.restored}件を元に戻しました。うち ${response.unbookmarked}件は Twitter 側の解除が始まっていたため、Twitter のブックマークには戻りません`
      : `${response.restored}件を元に戻しました`,
    response.unbookmarked > 0 ? 'info' : 'success'
  );
}

/** フォルダ名の行を入力欄に替えて、その場で名前を変えられるようにする */
function startRename(name: string): void {
  const row = [...document.querySelectorAll<HTMLElement>('#folder-list .folder-row')].find(
    (el) => el.dataset.folder === name
  );
  const button = row?.querySelector<HTMLElement>('.folder-item');
  if (!row || !button || row.querySelector('.folder-rename-input')) return;

  row.draggable = false;
  row.classList.add('renaming');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'folder-rename-input';
  input.value = name;
  input.maxLength = 40;
  input.setAttribute('aria-label', `フォルダ「${name}」の新しい名前`);
  button.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save: boolean): void => {
    if (done) return;
    done = true;
    const newName = input.value;
    if (!save || sanitizeFolderName(newName) === name || !sanitizeFolderName(newName)) {
      renderFolderList();
      focusFolderItem(name);
      return;
    }
    if (state.isBusy) {
      // runExclusive に渡しても捨てられ、入力欄が残ってしまうので、ここで戻して知らせる
      renderFolderList();
      showToast('ほかの処理中のため、名前を変更できませんでした。もう一度お試しください', 'error');
      return;
    }
    void runExclusive(() => renameFolder(name, newName));
  };

  input.addEventListener('keydown', (e) => {
    // 保存済み画面の Esc（選択解除）などに届かないようにする
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  // 一覧の作り直しで入力欄が外されたときは保存しない
  input.addEventListener('blur', () => {
    if (input.isConnected) finish(true);
  });
}

async function renameFolder(name: string, rawNewName: string): Promise<void> {
  const response = await sendMessage({ action: 'rename_folder', name, newName: rawNewName });
  state.folders = response.folders;
  if (!response.ok) {
    renderFolderList();
    showToast(response.error || '名前を変更できませんでした', 'error');
    return;
  }

  const newName = sanitizeFolderName(rawNewName);
  if (openFolder === name) openFolder = newName;
  for (const post of keptPosts) if (post.folder === name) post.folder = newName;

  renderFolderRack();
  renderFolderList();
  renderKeptList();
  focusFolderItem(newName);
}

/** フォルダの並びを names の順にする */
async function saveFolderOrder(names: string[]): Promise<void> {
  const before = state.folders;
  // 先に並べ替えて見せ、失敗したら戻す
  state.folders = names.flatMap((name) => before.filter((folder) => folder.name === name));
  renderFolderList();
  renderFolderRack();

  try {
    const response = await sendMessage({ action: 'reorder_folders', names });
    state.folders = response.folders;
    if (!response.ok) showToast(response.error || '並べ替えできませんでした', 'error');
  } catch (error) {
    state.folders = before;
    throw error;
  } finally {
    renderFolderList();
    renderFolderRack();
  }
}

/** name を target の前（after なら後ろ）に動かした並びを返す */
export function movedFolderNames(names: readonly string[], name: string, target: string, after: boolean): string[] {
  const rest = names.filter((item) => item !== name);
  const index = rest.indexOf(target);
  if (index < 0 || !names.includes(name)) return [...names];
  rest.splice(after ? index + 1 : index, 0, name);
  return rest;
}

function folderNames(): string[] {
  return state.folders.map((folder) => folder.name);
}

function focusFolderItem(name: string): void {
  for (const item of document.querySelectorAll<HTMLElement>('#folder-list .folder-item')) {
    if (item.dataset.folder === name) item.focus();
  }
}

function clearDropMarks(): void {
  for (const el of document.querySelectorAll('#folder-list .folder-row')) {
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  }
}

function folderRowOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('.folder-row') : null;
}

/** フォルダ一覧: ドラッグか Alt+↑↓ で並べ替え、ポストをドロップするとそのフォルダへ移す */
function bindFolderDrag(listEl: HTMLElement): void {
  let draggingFolder: string | null = null;

  listEl.addEventListener('dragstart', (e) => {
    const row = folderRowOf(e.target);
    if (!row?.dataset.folder || !e.dataTransfer) return;
    draggingFolder = row.dataset.folder;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_FOLDER, row.dataset.folder);
    row.classList.add('dragging');
  });

  listEl.addEventListener('dragend', () => {
    draggingFolder = null;
    clearDropMarks();
    for (const el of listEl.querySelectorAll('.dragging')) el.classList.remove('dragging');
  });

  listEl.addEventListener('dragover', (e) => {
    const types = e.dataTransfer?.types ?? [];
    const row = folderRowOf(e.target);
    if (!row?.dataset.folder) return;

    if (types.includes(DRAG_FOLDER)) {
      if (row.dataset.folder === draggingFolder) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      clearDropMarks();
      row.classList.add(after ? 'drop-after' : 'drop-before');
    } else if (types.includes(DRAG_POSTS)) {
      if (!searchQuery.trim() && row.dataset.folder === openFolder) return;
      e.preventDefault();
      clearDropMarks();
      row.classList.add('drop-into');
    }
  });

  listEl.addEventListener('dragleave', (e) => {
    const row = folderRowOf(e.target);
    if (row && !row.contains(e.relatedTarget as Node | null)) {
      row.classList.remove('drop-before', 'drop-after', 'drop-into');
    }
  });

  listEl.addEventListener('drop', (e) => {
    const row = folderRowOf(e.target);
    const target = row?.dataset.folder;
    const after = row?.classList.contains('drop-after') ?? false;
    clearDropMarks();
    if (!target || !e.dataTransfer) return;
    e.preventDefault();

    const folder = e.dataTransfer.getData(DRAG_FOLDER);
    if (folder) {
      if (folder !== target) {
        void runExclusive(() => saveFolderOrder(movedFolderNames(folderNames(), folder, target, after)));
      }
      return;
    }

    const ids = e.dataTransfer.getData(DRAG_POSTS).split(',').filter(Boolean);
    if (ids.length > 0) void runExclusive(() => moveSelected(ids, target));
  });

  listEl.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const name = (e.target as HTMLElement | null)?.closest<HTMLElement>('.folder-item')?.dataset.folder;
    if (!name) return;
    e.preventDefault();

    const names = folderNames();
    const index = names.indexOf(name);
    const neighbor = names[e.key === 'ArrowUp' ? index - 1 : index + 1];
    if (index < 0 || neighbor === undefined) return;
    void runExclusive(async () => {
      await saveFolderOrder(movedFolderNames(names, name, neighbor, e.key === 'ArrowDown'));
      focusFolderItem(name);
    });
  });
}

/** 保存済み一覧: チェックで選び、帯の操作かフォルダへのドラッグでまとめて移す */
function bindKeptSelection(listEl: HTMLElement): void {
  listEl.addEventListener('dragstart', (e) => {
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>('.kept-row') : null;
    const id = row?.dataset.id;
    if (!id || !e.dataTransfer) return;
    // 選んでいる行をつかんだら選択中のものすべて、そうでなければその 1 件を運ぶ
    const ids = selectedIds.has(id) ? [...selectedIds] : [id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_POSTS, ids.join(','));
    e.dataTransfer.setData('text/plain', `${ids.length}件`);
  });

  document.getElementById('kept-select-all')?.addEventListener('click', () => {
    for (const post of keptPosts) setRowSelected(post.id, true);
    renderSelectionBar();
  });

  document.getElementById('kept-select-clear')?.addEventListener('click', deselectAll);

  document.getElementById('kept-discard')?.addEventListener('click', () => {
    void runExclusive(discardSelected);
  });

  document.getElementById('kept-selection')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const folder = (document.getElementById('kept-move-target') as HTMLSelectElement | null)?.value;
    if (folder) void runExclusive(() => moveSelected([...selectedIds], folder));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || state.viewMode !== 'kept' || selectedIds.size === 0) return;
    if (document.querySelector('dialog[open]')) return;
    deselectAll();
  });
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

/** 入力欄の名前でフォルダを追加する。selectAfterAdd なら保存済み画面で追加したフォルダを開く */
export async function addFolderFromInput(input: HTMLInputElement | null, selectAfterAdd: boolean): Promise<void> {
  const name = input?.value ?? '';
  const response = await sendMessage({
    action: 'add_folder',
    name
  });

  state.folders = response.folders;
  if (!response.ok) {
    showToast(response.error || 'フォルダを追加できませんでした', 'error');
    return;
  }

  if (input) input.value = '';
  const addedName = sanitizeFolderName(name);
  const exists = state.folders.some((folder) => folder.name === addedName);
  if (exists && selectAfterAdd) openFolder = addedName;

  renderFolderRack();
  renderFolderList();
  if (state.viewMode === 'kept') await loadKeptPage(true);
}

async function removeFolder(name: string): Promise<void> {
  const confirmed = await confirmDialog({
    message: `フォルダ「${name}」を削除します。中のポストは「${DEFAULT_FOLDER}」へ移します。よろしいですか？`,
    confirmLabel: '削除する',
    danger: true
  });
  if (!confirmed) return;

  const response = await sendMessage({
    action: 'delete_folder',
    name
  });

  if (!response.ok) {
    showToast(response.error || 'フォルダを削除できませんでした', 'error');
    return;
  }

  state.folders = response.folders;
  if (openFolder === name) openFolder = DEFAULT_FOLDER;

  renderFolderRack();
  renderFolderList();
  await loadKeptPage(true);
}

/** 保存済み画面のフォルダ一覧・検索・一覧の操作を登録する */
export function bindKeptView(): void {
  const folderListEl = document.getElementById('folder-list');
  if (folderListEl) bindFolderDrag(folderListEl);
  const keptListEl = document.getElementById('kept-list');
  if (keptListEl) bindKeptSelection(keptListEl);

  document.getElementById('folder-list')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const renameBtn = target?.closest('[data-action="rename-folder"]');
    if (renameBtn instanceof HTMLElement && renameBtn.dataset.folder) {
      e.preventDefault();
      e.stopPropagation();
      startRename(renameBtn.dataset.folder);
      return;
    }

    const deleteBtn = target?.closest('[data-action="delete-folder"]');
    if (deleteBtn instanceof HTMLElement && deleteBtn.dataset.folder) {
      e.preventDefault();
      e.stopPropagation();
      void removeFolder(deleteBtn.dataset.folder).catch(logUnexpected);
      return;
    }

    const item = target?.closest('.folder-item');
    if (!(item instanceof HTMLElement) || !item.dataset.folder) return;
    // 開いているフォルダをもう一度押したときは作り直さない（ダブルクリックで名前を変えられるように）
    if (item.dataset.folder === openFolder && !searchQuery.trim()) return;

    openFolder = item.dataset.folder;
    clearSearchInput();
    searchQuery = '';
    clearSelection();
    renderFolderList();
    reloadKeptList();
  });

  document.getElementById('folder-list')?.addEventListener('dblclick', (e) => {
    const item = (e.target as HTMLElement | null)?.closest<HTMLElement>('.folder-item');
    const folder = state.folders.find((info) => info.name === item?.dataset.folder);
    if (folder && !folder.locked) startRename(folder.name);
  });

  document.getElementById('kept-search')?.addEventListener('input', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = target.value;
      clearSelection();
      reloadKeptList();
    }, SEARCH_DEBOUNCE_MS);
  });

  document.getElementById('kept-more')?.addEventListener('click', () => {
    void runExclusive(() => loadKeptPage(false));
  });

  document.getElementById('kept-list')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>('.kept-row');
    const id = row?.dataset.id;

    if (target instanceof HTMLInputElement && target.dataset.role === 'select') {
      if (id) toggleRow(id, target.checked, e.shiftKey);
      return;
    }
    if (target?.closest('select, input, .kept-edit, .field, a')) return;
    if (!row || !id) return;

    // 1 件でも選んでいる間は、行のクリックで選択を切り替える（Twitter は開かない）
    if (selectedIds.size > 0) {
      toggleRow(id, !selectedIds.has(id), e.shiftKey);
      return;
    }
    if (row.dataset.url) openTweet(row.dataset.url);
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
