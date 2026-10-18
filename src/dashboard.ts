import { DEFAULT_FOLDER, type BookmarkPost } from './db';
import type { BookmarkChanges, ExportData, ExtensionRequest, FolderInfo, UnbookmarkFailure } from './messages';
import { isHttpUrl } from './urls';

type ViewMode = 'sort' | 'kept';
type UndoEntry =
  | { type: 'kept' | 'discarded'; post: BookmarkPost }
  | { type: 'skipped'; post: BookmarkPost };

const MAX_UNDO = 30;
const DISCARD_CONFIRM_MS = 2000;
const SEARCH_DEBOUNCE_MS = 150;
const PREFETCH_SIZE = 8;
const KEPT_PAGE_SIZE = 40;
const LAST_FOLDER_KEY = 'lastSortFolder';

let currentPost: BookmarkPost | null = null;
let isBusy = false;
let viewMode: ViewMode = 'sort';
const skippedIds = new Set<string>();
const undoStack: UndoEntry[] = [];
const postQueue: BookmarkPost[] = [];
let refillPromise: Promise<void> | null = null;
// 保存済みは「いま読み込んだページ分」だけを持つ。全件は background 側にある
let keptPosts: BookmarkPost[] = [];
let keptTotal = 0;
let keptRequestId = 0;
let folders: FolderInfo[] = [];
let openFolder = DEFAULT_FOLDER;
let searchQuery = '';
let discardArmedId: string | null = null;
let discardArmTimer: ReturnType<typeof setTimeout> | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function isContextInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Extension context invalidated');
}

function isExtensionAlive(): boolean {
  try {
    return typeof chrome.runtime.id === 'string';
  } catch {
    return false;
  }
}

function sendMessage<T>(message: ExtensionRequest): Promise<T> {
  if (!isExtensionAlive()) {
    return Promise.reject(new Error('Extension context invalidated'));
  }

  try {
    return Promise.resolve(chrome.runtime.sendMessage(message) as Promise<T>);
  } catch (error) {
    return Promise.reject(error);
  }
}

function sendQuietly(message: ExtensionRequest): void {
  void sendMessage(message).catch((error: unknown) => {
    if (!isContextInvalidatedError(error)) {
      console.error(error);
    }
  });
}

function clonePost(post: BookmarkPost): BookmarkPost {
  return {
    ...post,
    images: [...post.images],
    linkCard: post.linkCard ? { ...post.linkCard } : undefined
  };
}

function peelUrl(raw: string): { url: string; trailing: string } {
  const url = raw.replace(/[.,;:!?、。，．！？)）\]】」』]+$/u, '');
  return { url, trailing: raw.slice(url.length) };
}

function fillTextWithLinks(container: HTMLElement, text: string): void {
  container.replaceChildren();
  if (!text) return;

  const urlRe = /https?:\/\/[^\s<>"']+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const { url, trailing } = peelUrl(match[0]);
    if (isHttpUrl(url)) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = url;
      container.appendChild(link);
      if (trailing) {
        container.appendChild(document.createTextNode(trailing));
      }
    } else {
      container.appendChild(document.createTextNode(match[0]));
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function createLinkPreview(card: NonNullable<BookmarkPost['linkCard']>): HTMLAnchorElement | null {
  if (!isHttpUrl(card.url)) return null;

  const preview = document.createElement('a');
  preview.className = 'link-preview';
  preview.href = card.url;
  preview.target = '_blank';
  preview.rel = 'noopener noreferrer';
  preview.title = card.title || card.domain || card.url;

  if (card.image && isHttpUrl(card.image)) {
    const img = document.createElement('img');
    img.className = 'link-preview-image';
    img.src = card.image;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    preview.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'link-preview-body';

  const domain = document.createElement('div');
  domain.className = 'link-preview-domain';
  domain.innerText = card.domain || hostnameFallback(card.url);

  const title = document.createElement('div');
  title.className = 'link-preview-title';
  title.innerText = card.title || card.url;

  body.append(domain, title);
  preview.appendChild(body);
  return preview;
}

function hostnameFallback(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || url;
  } catch {
    return url;
  }
}

function renderLinkPreview(container: HTMLElement | null, card: BookmarkPost['linkCard'] | undefined): void {
  if (!container) return;
  container.replaceChildren();
  if (!card) return;
  const preview = createLinkPreview(card);
  if (preview) container.appendChild(preview);
}

function parseAuthorLine(author: string): { displayName: string; meta: string } {
  const trimmed = author.trim();
  const match = trimmed.match(/^(.*?)\s+(@\S+)(?:\s*[·•]\s*(.*))?$/);
  if (!match) {
    return { displayName: trimmed || '不明', meta: '' };
  }

  const handle = match[2];
  const date = (match[3] ?? '').trim();
  return {
    displayName: match[1].trim() || trimmed,
    meta: date ? `${handle} · ${date}` : handle
  };
}

function fillAuthor(container: HTMLElement, author: string): void {
  const parsed = parseAuthorLine(author);
  container.replaceChildren();

  const name = document.createElement('span');
  name.className = 'author-name';
  name.innerText = parsed.displayName;
  container.appendChild(name);

  if (parsed.meta) {
    const meta = document.createElement('span');
    meta.className = 'author-meta';
    meta.innerText = parsed.meta;
    container.appendChild(meta);
  }
}

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

function createIcon(kind: 'trash' | 'open'): SVGSVGElement {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false'
  }) as SVGSVGElement;

  if (kind === 'trash') {
    svg.append(
      svgEl('path', { d: 'M4 7h16' }),
      svgEl('path', { d: 'M10 11v6' }),
      svgEl('path', { d: 'M14 11v6' }),
      svgEl('path', { d: 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12' }),
      svgEl('path', { d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' })
    );
  } else {
    svg.append(
      svgEl('path', { d: 'M14 5h5v5' }),
      svgEl('path', { d: 'M20 4l-9 9' }),
      svgEl('path', { d: 'M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5' })
    );
  }

  return svg;
}

function resetLocalState(): void {
  currentPost = null;
  skippedIds.clear();
  undoStack.length = 0;
  postQueue.length = 0;
  keptPosts = [];
  keptTotal = 0;
  keptRequestId++;
  searchQuery = '';
  openFolder = DEFAULT_FOLDER;
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  clearDiscardArm();

  const searchInput = document.getElementById('kept-search') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';
}

function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function setDiscardArmedUi(armed: boolean): void {
  document.getElementById('tweet-card')?.classList.toggle('confirm-discard', armed);
  document.getElementById('btn-discard')?.classList.toggle('armed', armed);
}

function clearDiscardArm(): void {
  discardArmedId = null;
  if (discardArmTimer) {
    clearTimeout(discardArmTimer);
    discardArmTimer = null;
  }
  setDiscardArmedUi(false);
}

function armDiscard(): void {
  if (!currentPost) return;
  discardArmedId = currentPost.id;
  setDiscardArmedUi(true);
  if (discardArmTimer) clearTimeout(discardArmTimer);
  discardArmTimer = setTimeout(() => {
    if (discardArmedId === currentPost?.id) clearDiscardArm();
  }, DISCARD_CONFIRM_MS);
}

function isDiscardArmed(): boolean {
  return discardArmedId !== null && discardArmedId === currentPost?.id;
}

function openTweet(url: string): void {
  if (!url || !isHttpUrl(url)) return;
  try {
    void chrome.tabs.create({ url }).catch((error: unknown) => {
      if (!isContextInvalidatedError(error)) {
        console.error(error);
      }
    });
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      console.error(error);
    }
  }
}

function scheduleUnbookmark(post: BookmarkPost): void {
  if (!post.url) return;
  sendQuietly({ action: 'unbookmark', tweetUrl: post.url });
}

function cancelScheduledUnbookmark(post: BookmarkPost): void {
  if (!post.url) return;
  sendQuietly({ action: 'cancel_unbookmark', tweetUrl: post.url });
}

function queueExcludeIds(excludeCurrent: boolean): string[] {
  const ids = [...skippedIds];
  if (excludeCurrent && currentPost) ids.push(currentPost.id);
  for (const queued of postQueue) ids.push(queued.id);
  return ids;
}

async function refillQueue(excludeCurrent = true): Promise<void> {
  if (refillPromise) {
    await refillPromise;
    if (postQueue.length >= PREFETCH_SIZE) return;
  }

  refillPromise = (async () => {
    try {
      while (postQueue.length < PREFETCH_SIZE) {
        const needed = PREFETCH_SIZE - postQueue.length;
        const response = await sendMessage<{ posts: BookmarkPost[] }>({
          action: 'get_unprocessed',
          excludeIds: queueExcludeIds(excludeCurrent),
          limit: needed
        });
        const posts = response.posts.filter(
          (post) =>
            (excludeCurrent ? post.id !== currentPost?.id : true) &&
            !skippedIds.has(post.id) &&
            !postQueue.some((queued) => queued.id === post.id)
        );
        if (posts.length === 0) break;
        postQueue.push(...posts);
        if (posts.length < needed) break;
      }
    } finally {
      refillPromise = null;
    }
  })();

  return refillPromise;
}

async function takeNextPost(): Promise<BookmarkPost | null> {
  if (postQueue.length === 0) await refillQueue(true);

  if (postQueue.length === 0 && skippedIds.size > 0) {
    skippedIds.clear();
    await refillQueue(false);
  }

  return postQueue.shift() ?? null;
}

async function loadNextPost(): Promise<void> {
  const next = await takeNextPost();

  if (!next) {
    currentPost = null;
    clearDiscardArm();
    showEmptyState(true);
    await updateCount();
    return;
  }

  currentPost = next;
  clearDiscardArm();
  showEmptyState(false);
  renderCard(currentPost);
  void refillQueue().catch((error: unknown) => {
    if (!isContextInvalidatedError(error)) {
      console.error(error);
    }
  });
  await updateCount();
}

function showEmptyState(empty: boolean): void {
  const emptyEl = document.getElementById('card-empty');
  const bodyEl = document.getElementById('card-body');
  const actionsEl = document.getElementById('sort-actions');
  if (emptyEl) emptyEl.hidden = !empty;
  if (bodyEl) bodyEl.hidden = empty;
  if (actionsEl) actionsEl.hidden = empty;
}

function renderImages(urls: string[]): void {
  const imagesEl = document.getElementById('card-images');
  if (!imagesEl) return;

  const visible = urls.filter((url) => isHttpUrl(url)).slice(0, 4);
  imagesEl.replaceChildren();
  imagesEl.dataset.count = String(visible.length);

  for (const url of visible) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    imagesEl.appendChild(img);
  }
}

function renderCard(post: BookmarkPost): void {
  const authorEl = document.getElementById('card-author');
  const textEl = document.getElementById('card-text');
  const openLink = document.getElementById('card-open-link') as HTMLAnchorElement | null;

  if (authorEl) fillAuthor(authorEl, post.author);
  if (textEl) fillTextWithLinks(textEl, post.text);
  renderImages(post.images);
  renderLinkPreview(document.getElementById('card-link-preview'), post.linkCard);

  if (openLink) {
    const safe = post.url && isHttpUrl(post.url);
    openLink.href = safe ? post.url : '#';
    openLink.hidden = !safe;
  }
}

async function updateCount(): Promise<void> {
  const counts = await sendMessage<{ unprocessed: number; kept: number }>({ action: 'get_counts' });
  const remainingEl = document.getElementById('remaining-count');
  const keptEl = document.getElementById('kept-count');
  if (remainingEl) remainingEl.innerText = String(counts.unprocessed);
  if (keptEl) keptEl.innerText = String(counts.kept);
}

async function updateCurrent(changes: BookmarkChanges): Promise<void> {
  if (!currentPost) return;
  await sendMessage({
    action: 'update_bookmark',
    id: currentPost.id,
    changes
  });
}

function selectedSortFolder(): string {
  const folderSelect = document.getElementById('folder-select') as HTMLSelectElement | null;
  return folderSelect?.value || DEFAULT_FOLDER;
}

async function keepCurrentPost(): Promise<void> {
  if (!currentPost) return;

  skippedIds.delete(currentPost.id);
  const folder = selectedSortFolder();
  saveLastFolder(folder);
  pushUndo({ type: 'kept', post: clonePost(currentPost) });
  await updateCurrent({ folder, status: 'kept' });
}

async function discardCurrentPost(): Promise<void> {
  if (!currentPost) return;

  skippedIds.delete(currentPost.id);
  const snapshot = clonePost(currentPost);
  pushUndo({ type: 'discarded', post: snapshot });
  await updateCurrent({ status: 'discarded' });
  scheduleUnbookmark(snapshot);
}

async function skipCurrentPost(): Promise<void> {
  if (!currentPost) return;
  pushUndo({ type: 'skipped', post: clonePost(currentPost) });
  skippedIds.add(currentPost.id);
}

function showPost(post: BookmarkPost): void {
  currentPost = post;
  clearDiscardArm();
  showEmptyState(false);
  renderCard(post);
}

async function undoLast(): Promise<void> {
  const entry = undoStack.pop();
  if (!entry) return;

  if (currentPost && currentPost.id !== entry.post.id) {
    const displaced = currentPost;
    const without = postQueue.filter((post) => post.id !== displaced.id && post.id !== entry.post.id);
    postQueue.length = 0;
    postQueue.push(displaced, ...without);
  } else {
    const without = postQueue.filter((post) => post.id !== entry.post.id);
    postQueue.length = 0;
    postQueue.push(...without);
  }

  if (entry.type === 'skipped') {
    skippedIds.delete(entry.post.id);
    showPost(entry.post);
    await updateCount();
    return;
  }

  if (entry.type === 'discarded') {
    cancelScheduledUnbookmark(entry.post);
  }

  skippedIds.delete(entry.post.id);
  await sendMessage({
    action: 'update_bookmark',
    id: entry.post.id,
    changes: {
      status: 'unprocessed',
      folder: entry.post.folder
    }
  });
  showPost(entry.post);
  await updateCount();
}

function setView(mode: ViewMode): void {
  if (mode !== 'sort') clearDiscardArm();
  viewMode = mode;
  const sortView = document.getElementById('sort-view');
  const keptView = document.getElementById('kept-view');
  const tabSort = document.getElementById('tab-sort');
  const tabKept = document.getElementById('tab-kept');

  if (sortView) sortView.hidden = mode !== 'sort';
  if (keptView) keptView.hidden = mode !== 'kept';
  tabSort?.classList.toggle('active', mode === 'sort');
  tabKept?.classList.toggle('active', mode === 'kept');

  if (mode === 'kept') {
    void loadKeptView().catch((error: unknown) => {
      if (!isContextInvalidatedError(error)) {
        console.error(error);
      }
    });
  }
}

function saveLastFolder(name: string): void {
  if (!name || !isExtensionAlive()) return;
  try {
    void chrome.storage.local.set({ [LAST_FOLDER_KEY]: name }).catch((error: unknown) => {
      if (!isContextInvalidatedError(error)) {
        console.error(error);
      }
    });
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      console.error(error);
    }
  }
}

async function loadLastFolder(): Promise<string | null> {
  if (!isExtensionAlive()) return null;
  try {
    const stored = await chrome.storage.local.get(LAST_FOLDER_KEY);
    const value = stored[LAST_FOLDER_KEY];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function applySortFolder(name: string): boolean {
  const sortSelect = document.getElementById('folder-select') as HTMLSelectElement | null;
  if (!sortSelect) return false;
  if (![...sortSelect.options].some((option) => option.value === name)) return false;
  sortSelect.value = name;
  saveLastFolder(name);
  return true;
}

function selectFolderByShortcut(index: number): boolean {
  const folder = folders[index];
  return folder ? applySortFolder(folder.name) : false;
}

function populateFolderSelect(select: HTMLSelectElement, selected: string): void {
  const previous = selected || select.value || DEFAULT_FOLDER;
  const withShortcuts = select.id === 'folder-select';
  select.replaceChildren();

  folders.forEach((folder, index) => {
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

function adjustFolderCount(name: string, delta: number): void {
  folders = folders.map((folder) =>
    folder.name === name ? { ...folder, count: Math.max(0, folder.count + delta) } : folder
  );
}

function renderFolderList(): void {
  const listEl = document.getElementById('folder-list');
  if (!listEl) return;

  listEl.replaceChildren();
  const fragment = document.createDocumentFragment();

  for (const folder of folders) {
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
  const response = await sendMessage<{ posts: BookmarkPost[]; total: number }>({
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
  void loadKeptPage(true).catch((error: unknown) => {
    if (!isContextInvalidatedError(error)) console.error(error);
  });
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

async function loadFolders(): Promise<void> {
  const response = await sendMessage<{ folders: FolderInfo[] }>({ action: 'list_folders' });
  folders = response.folders;
  if (!folders.some((folder) => folder.name === openFolder)) {
    openFolder = DEFAULT_FOLDER;
  }

  const sortSelect = document.getElementById('folder-select') as HTMLSelectElement | null;
  if (sortSelect) populateFolderSelect(sortSelect, sortSelect.value || DEFAULT_FOLDER);
}

async function loadKeptView(): Promise<void> {
  await loadFolders();
  renderFolderList();
  await loadKeptPage(true);
}

async function addFolderFromInput(input: HTMLInputElement | null, selectAfterAdd: boolean): Promise<void> {
  const name = input?.value ?? '';
  const response = await sendMessage<{ ok: boolean; error?: string; folders: FolderInfo[] }>({
    action: 'add_folder',
    name
  });

  folders = response.folders;
  if (!response.ok) {
    window.alert(response.error || 'フォルダを追加できませんでした');
    return;
  }

  if (input) input.value = '';
  const addedName = name.trim().replace(/\s+/g, ' ').slice(0, 40);
  const exists = folders.some((folder) => folder.name === addedName);
  if (exists && selectAfterAdd) {
    openFolder = addedName;
    saveLastFolder(addedName);
  }

  const sortSelect = document.getElementById('folder-select') as HTMLSelectElement | null;
  if (sortSelect) {
    populateFolderSelect(sortSelect, exists && selectAfterAdd ? addedName : sortSelect.value);
  }
  renderFolderList();
  if (viewMode === 'kept') await loadKeptPage(true);
}

async function removeFolder(name: string): Promise<void> {
  const confirmed = confirm(`フォルダ「${name}」を削除します。中のポストは「${DEFAULT_FOLDER}」へ移します。よろしいですか？`);
  if (!confirmed) return;

  const response = await sendMessage<{ ok: boolean; error?: string; folders: FolderInfo[] }>({
    action: 'delete_folder',
    name
  });

  if (!response.ok) {
    window.alert(response.error || 'フォルダを削除できませんでした');
    return;
  }

  folders = response.folders;
  if (openFolder === name) openFolder = DEFAULT_FOLDER;

  const sortSelect = document.getElementById('folder-select') as HTMLSelectElement | null;
  if (sortSelect) {
    const nextFolder = sortSelect.value === name ? DEFAULT_FOLDER : sortSelect.value;
    populateFolderSelect(sortSelect, nextFolder);
    if (nextFolder === DEFAULT_FOLDER) saveLastFolder(DEFAULT_FOLDER);
  }

  renderFolderList();
  await loadKeptPage(true);
}

async function clearAllData(): Promise<void> {
  const confirmed = confirm('すべてのブックマークデータを消去します。この操作は取り消せません。よろしいですか？');
  if (!confirmed) return;

  await sendMessage({ action: 'clear_bookmarks' });
  resetLocalState();
  await loadFolders();
  await loadNextPost();
  if (viewMode === 'kept') await loadKeptView();
}

async function updateUnbookmarkFailures(): Promise<void> {
  const btn = document.getElementById('unbookmark-failed-btn');
  if (!btn) return;
  const { failures } = await sendMessage<{ failures: UnbookmarkFailure[] }>({ action: 'list_unbookmark_failures' });
  btn.hidden = failures.length === 0;
  btn.innerText = `解除失敗 ${failures.length}件 · 再試行`;
}

async function retryUnbookmarkFailures(): Promise<void> {
  const { queued } = await sendMessage<{ queued: number }>({ action: 'retry_unbookmark_failures' });
  await updateUnbookmarkFailures();
  window.alert(queued > 0 ? `${queued}件の解除を再試行します` : '再試行が必要なポストはありません');
}

function localDateStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

async function exportAllData(): Promise<void> {
  const data = await sendMessage<ExportData>({ action: 'export_data' });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `bookmark-sorter-${localDateStamp(new Date())}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function importFromFile(file: File): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    window.alert('JSON として読み込めませんでした');
    return;
  }

  const confirmed = confirm(
    'ファイルの内容を読み込みます。同じポストがすでにある場合は、ファイルの内容（状態・フォルダ）で上書きします。よろしいですか？'
  );
  if (!confirmed) return;

  const response = await sendMessage<{ ok: boolean; error?: string; imported: number }>({
    action: 'import_data',
    data
  });
  if (!response.ok) {
    window.alert(response.error || 'インポートできませんでした');
    return;
  }

  resetLocalState();
  await loadFolders();
  await loadNextPost();
  if (viewMode === 'kept') await loadKeptView();
  window.alert(`${response.imported}件を読み込みました`);
}

async function runExclusive(task: () => Promise<void>): Promise<void> {
  if (isBusy) return;
  isBusy = true;
  try {
    await task();
  } catch (error) {
    if (!isContextInvalidatedError(error)) {
      throw error;
    }
  } finally {
    isBusy = false;
  }
}

document.getElementById('folder-select')?.addEventListener('change', (e) => {
  const target = e.target;
  if (target instanceof HTMLSelectElement && target.value) {
    saveLastFolder(target.value);
  }
});

document.getElementById('tab-sort')?.addEventListener('click', () => setView('sort'));
document.getElementById('tab-kept')?.addEventListener('click', () => setView('kept'));
document.getElementById('clear-all-btn')?.addEventListener('click', () => {
  void runExclusive(clearAllData);
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
  void runExclusive(() => importFromFile(file));
});

// 解除キューは background で進むので、失敗件数はときどき取り直す
setInterval(() => {
  if (document.hidden) return;
  void updateUnbookmarkFailures().catch((error: unknown) => {
    if (!isContextInvalidatedError(error)) console.error(error);
  });
}, 10_000);

document.getElementById('card-open-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  if (currentPost?.url) openTweet(currentPost.url);
});

document.getElementById('btn-keep')?.addEventListener('click', () => {
  if (!currentPost) return;
  clearDiscardArm();
  void runExclusive(async () => {
    await keepCurrentPost();
    await loadNextPost();
  });
});

document.getElementById('btn-skip')?.addEventListener('click', () => {
  if (!currentPost) return;
  clearDiscardArm();
  void runExclusive(async () => {
    await skipCurrentPost();
    await loadNextPost();
  });
});

document.getElementById('btn-discard')?.addEventListener('click', () => {
  if (!currentPost) return;
  if (!isDiscardArmed()) {
    armDiscard();
    return;
  }
  clearDiscardArm();
  void runExclusive(async () => {
    await discardCurrentPost();
    await loadNextPost();
  });
});

document.getElementById('folder-list')?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const deleteBtn = target?.closest('[data-action="delete-folder"]');
  if (deleteBtn instanceof HTMLElement && deleteBtn.dataset.folder) {
    e.preventDefault();
    e.stopPropagation();
    void removeFolder(deleteBtn.dataset.folder).catch((error: unknown) => {
      if (!isContextInvalidatedError(error)) {
        console.error(error);
      }
    });
    return;
  }

  const item = target?.closest('.folder-item');
  if (!(item instanceof HTMLElement) || !item.dataset.folder) return;

  openFolder = item.dataset.folder;
  const searchInput = document.getElementById('kept-search') as HTMLInputElement | null;
  if (searchInput) searchInput.value = '';
  searchQuery = '';
  renderFolderList();
  reloadKeptList();
});

document.getElementById('add-folder-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('add-folder-input') as HTMLInputElement | null;
  void addFolderFromInput(input, true).catch((error: unknown) => {
    if (!isContextInvalidatedError(error)) {
      console.error(error);
    }
  });
});

document.getElementById('sort-add-folder-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('sort-add-folder-input') as HTMLInputElement | null;
  void addFolderFromInput(input, true).catch((error: unknown) => {
    if (!isContextInvalidatedError(error)) {
      console.error(error);
    }
  });
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

  if (isBusy) {
    // 処理中で受け付けられないときは、プルダウンの表示を元に戻す
    renderKeptList();
    return;
  }
  void runExclusive(() => persistKeptFolder(id, target.value));
});

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (viewMode !== 'sort' || isBusy) return;
  // 押しっぱなしのリピートで ← の2回押し確認をすり抜けないようにする。
  // 修飾キー付き（Ctrl+1 のタブ切替など）はブラウザに任せる。
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;

  const activeEl = document.activeElement;
  const isInputActive = activeEl instanceof HTMLInputElement || activeEl instanceof HTMLSelectElement;

  if (isInputActive) {
    if (activeEl instanceof HTMLElement && activeEl.closest('.add-folder-form')) {
      return;
    }
    if (e.key === 'Enter' && currentPost) {
      e.preventDefault();
      clearDiscardArm();
      void runExclusive(async () => {
        await keepCurrentPost();
        await loadNextPost();
      });
    }
    return;
  }

  if (e.key === 'Escape') {
    if (isDiscardArmed()) {
      e.preventDefault();
      clearDiscardArm();
    }
    return;
  }

  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    clearDiscardArm();
    void runExclusive(undoLast);
    return;
  }

  if (e.key >= '1' && e.key <= '9') {
    e.preventDefault();
    clearDiscardArm();
    selectFolderByShortcut(Number(e.key) - 1);
    return;
  }

  if (!currentPost) return;

  if (e.key === 'o' || e.key === 'O') {
    e.preventDefault();
    openTweet(currentPost.url);
    return;
  }

  if (e.key === 'ArrowRight') {
    e.preventDefault();
    clearDiscardArm();
    void runExclusive(async () => {
      await keepCurrentPost();
      await loadNextPost();
    });
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (!isDiscardArmed()) {
      armDiscard();
      return;
    }
    clearDiscardArm();
    void runExclusive(async () => {
      await discardCurrentPost();
      await loadNextPost();
    });
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    clearDiscardArm();
    void runExclusive(async () => {
      await skipCurrentPost();
      await loadNextPost();
    });
  }
});

void loadFolders()
  .then(async () => {
    const last = await loadLastFolder();
    if (last && folders.some((folder) => folder.name === last)) {
      const sortSelect = document.getElementById('folder-select') as HTMLSelectElement | null;
      if (sortSelect) sortSelect.value = last;
    }
    await updateUnbookmarkFailures();
    return loadNextPost();
  })
  .catch((error: unknown) => {
    if (!isContextInvalidatedError(error)) {
      console.error(error);
    }
  });
