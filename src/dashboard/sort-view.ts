// 選別画面: 未整理のポストを 1 件ずつ出し、残す・破棄・スキップ・取り消しを扱う
import type { BookmarkPost } from '../db';
import type { BookmarkChanges } from '../messages';
import { logUnexpected } from '../runtime';
import { isHttpUrl } from '../urls';
import { openTweet, saveLastFolder, sendMessage, sendQuietly } from './api';
import { clonePost, fillAuthor, fillTextWithLinks, renderLinkPreview } from './dom';
import { selectFolderByShortcut, selectedSortFolder } from './folders';
import { runExclusive, state } from './state';

const MAX_UNDO = 30;
const DISCARD_CONFIRM_MS = 2000;
const PREFETCH_SIZE = 8;

type UndoEntry =
  | { type: 'kept' | 'discarded'; post: BookmarkPost }
  | { type: 'skipped'; post: BookmarkPost };

let currentPost: BookmarkPost | null = null;
const skippedIds = new Set<string>();
const undoStack: UndoEntry[] = [];
// 次に出すポストの先読み
const postQueue: BookmarkPost[] = [];
let refillPromise: Promise<void> | null = null;
let discardArmedId: string | null = null;
let discardArmTimer: ReturnType<typeof setTimeout> | null = null;

/** データの全消去・インポートの後に、選別の状態を捨てる */
export function resetSortState(): void {
  currentPost = null;
  skippedIds.clear();
  undoStack.length = 0;
  postQueue.length = 0;
  clearDiscardArm();
}

function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function setDiscardArmedUi(armed: boolean): void {
  document.getElementById('tweet-card')?.classList.toggle('confirm-discard', armed);
  document.getElementById('btn-discard')?.classList.toggle('armed', armed);
}

export function clearDiscardArm(): void {
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
        const response = await sendMessage({
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

/** 次のポストを出す。無ければ空の表示にする */
export async function loadNextPost(): Promise<void> {
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
  void refillQueue().catch(logUnexpected);
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
  const videoBadge = document.getElementById('card-video');
  if (videoBadge) videoBadge.hidden = post.hasVideo !== true;
  renderLinkPreview(document.getElementById('card-link-preview'), post.linkCard);

  if (openLink) {
    const safe = post.url && isHttpUrl(post.url);
    openLink.href = safe ? post.url : '#';
    openLink.hidden = !safe;
  }
}

async function updateCount(): Promise<void> {
  const counts = await sendMessage({ action: 'get_counts' });
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

  // 表示中のポストはキューの先頭に戻し、取り消したポストはキューから外す
  const displaced = currentPost && currentPost.id !== entry.post.id ? currentPost : null;
  const rest = postQueue.filter((post) => post.id !== entry.post.id && post.id !== displaced?.id);
  postQueue.splice(0, postQueue.length, ...(displaced ? [displaced] : []), ...rest);
  skippedIds.delete(entry.post.id);

  if (entry.type !== 'skipped') {
    if (entry.type === 'discarded') cancelScheduledUnbookmark(entry.post);
    await sendMessage({
      action: 'update_bookmark',
      id: entry.post.id,
      changes: {
        status: 'unprocessed',
        folder: entry.post.folder
      }
    });
  }

  showPost(entry.post);
  await updateCount();
}

function keepAndNext(): void {
  clearDiscardArm();
  void runExclusive(async () => {
    await keepCurrentPost();
    await loadNextPost();
  });
}

function skipAndNext(): void {
  clearDiscardArm();
  void runExclusive(async () => {
    await skipCurrentPost();
    await loadNextPost();
  });
}

/** 破棄は 2 回押しで確定する。1 回目は確認状態にするだけ */
function discardOrArm(): void {
  if (!isDiscardArmed()) {
    armDiscard();
    return;
  }
  clearDiscardArm();
  void runExclusive(async () => {
    await discardCurrentPost();
    await loadNextPost();
  });
}

/** 選別画面のボタン・キー操作を登録する */
export function bindSortView(): void {
  document.getElementById('folder-select')?.addEventListener('change', (e) => {
    const target = e.target;
    if (target instanceof HTMLSelectElement && target.value) {
      saveLastFolder(target.value);
    }
  });

  document.getElementById('card-open-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (currentPost?.url) openTweet(currentPost.url);
  });

  document.getElementById('btn-keep')?.addEventListener('click', () => {
    if (currentPost) keepAndNext();
  });

  document.getElementById('btn-skip')?.addEventListener('click', () => {
    if (currentPost) skipAndNext();
  });

  document.getElementById('btn-discard')?.addEventListener('click', () => {
    if (currentPost) discardOrArm();
  });

  document.addEventListener('keydown', handleKeydown);
}

function handleKeydown(e: KeyboardEvent): void {
  if (state.viewMode !== 'sort' || state.isBusy) return;
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
      keepAndNext();
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
    keepAndNext();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    discardOrArm();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    skipAndNext();
  }
}
