// 選別画面: 未整理のポストを 1 件ずつ出し、フォルダへの保存・削除・スキップ・取り消しを扱う
import type { BookmarkPost } from '../db';
import type { BookmarkChanges } from '../messages';
import { logUnexpected } from '../runtime';
import { isHttpUrl } from '../urls';
import { openTweet, sendMessage, sendQuietly } from './api';
import { clonePost, fillAuthor, fillTextWithLinks, renderLinkPreview } from './dom';
import {
  adjustFolderCount,
  bindFolderRack,
  flashFolderSlot,
  folderByShortcut,
  loadFolders,
  renderFolderRack
} from './folders';
import { runExclusive, state } from './state';

const MAX_UNDO = 30;
/** 削除してから Twitter 側の解除が始まるまで（background.ts の UNBOOKMARK_DELAY_MS と合わせる） */
const UNBOOKMARK_GRACE_MS = 5000;
/** 画面下の「保存しました・取り消す」を出しておく時間 */
const LAST_ACTION_VISIBLE_MS = 4000;
const PREFETCH_SIZE = 8;

type UndoEntry =
  | { type: 'kept'; post: BookmarkPost; folder: string }
  | { type: 'discarded' | 'skipped'; post: BookmarkPost };

type ActionType = UndoEntry['type'];

let currentPost: BookmarkPost | null = null;
const skippedIds = new Set<string>();
const undoStack: UndoEntry[] = [];
// 次に出すポストの先読み
const postQueue: BookmarkPost[] = [];
let refillPromise: Promise<void> | null = null;
let countdownTimer: ReturnType<typeof setTimeout> | null = null;
// この画面を開いてから整理した件数（取り消すと減る）
const session: Record<ActionType, number> = { kept: 0, discarded: 0, skipped: 0 };

/** データの全消去・インポートの後に、選別の状態を捨てる */
export function resetSortState(): void {
  currentPost = null;
  skippedIds.clear();
  undoStack.length = 0;
  postQueue.length = 0;
  session.kept = 0;
  session.discarded = 0;
  session.skipped = 0;
  setLastAction('');
}

function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  session[entry.type]++;
  setLastAction(describeAction(entry), entry.type === 'discarded');
}

function describeAction(entry: UndoEntry): string {
  switch (entry.type) {
    case 'kept':
      return `「${entry.folder}」に保存しました`;
    case 'discarded':
      return '削除しました';
    case 'skipped':
      return 'スキップしました（あとでもう一度出ます）';
  }
}

/** 直前の操作と取り消しボタンを画面下に出す。しばらくすると消える（Z での取り消しはその後もできる） */
function setLastAction(message: string, countdown = false): void {
  const last = document.getElementById('last-action');
  const undoBtn = document.getElementById('btn-undo');
  if (last) last.innerText = message;
  if (undoBtn) undoBtn.hidden = undoStack.length === 0;

  const area = last?.parentElement;
  if (countdownTimer) {
    clearTimeout(countdownTimer);
    countdownTimer = null;
  }
  if (!area) return;
  area.toggleAttribute('data-empty', message === '');
  area.classList.remove('counting');
  if (message === '') return;

  if (!countdown) {
    countdownTimer = setTimeout(() => setLastAction(''), LAST_ACTION_VISIBLE_MS);
    return;
  }
  void area.offsetWidth; // 続けて削除したときもバーを最初からやり直す
  area.style.setProperty('--undo-ms', `${UNBOOKMARK_GRACE_MS}ms`);
  area.classList.add('counting');
  countdownTimer = setTimeout(() => {
    area.classList.remove('counting');
    if (last) last.innerText = '削除しました（Twitter の解除も始めました）';
    countdownTimer = setTimeout(() => setLastAction(''), LAST_ACTION_VISIBLE_MS);
  }, UNBOOKMARK_GRACE_MS);
}

function renderSessionSummary(remaining: number): void {
  const fill = document.getElementById('progress-fill');
  if (!fill) return;
  const done = session.kept + session.discarded;
  const total = done + remaining;
  fill.style.width = total > 0 ? `${(done / total) * 100}%` : '0%';
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
    showEmptyState(true);
    const counts = await updateCount();
    renderEmptyMessage(counts.kept === 0 && session.kept + session.discarded === 0);
    return;
  }

  currentPost = next;
  showEmptyState(false);
  renderCard(currentPost);
  void refillQueue().catch(logUnexpected);
  await updateCount();
}

/** 何も取り込んでいないときは取り込み方を、選別し終えたときは結果を出す */
function renderEmptyMessage(nothingCollected: boolean): void {
  const title = document.getElementById('empty-title');
  const sub = document.getElementById('empty-sub');
  if (!title || !sub) return;

  sub.replaceChildren();
  if (nothingCollected) {
    title.innerText = 'まだブックマークを取り込んでいません';
    const link = document.createElement('a');
    link.href = 'https://x.com/i/bookmarks';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.innerText = 'Twitter のブックマーク';
    sub.append(link, ' を開き、右下の「100件を取得開始」で取り込むと、ここに 1 件ずつ出てきます');
    return;
  }

  const done = session.kept + session.discarded;
  title.innerText = '未整理のポストはありません';
  const breakdown = [`保存 ${session.kept}`, `削除 ${session.discarded}`];
  if (session.skipped > 0) breakdown.push(`スキップ ${session.skipped}`);
  sub.innerText =
    done > 0
      ? `今回は ${done} 件を整理しました（${breakdown.join('・')}）。保存したポストは「保存済み」から見返せます`
      : '保存したポストは「保存済み」から見返せます';
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

  const card = document.getElementById('tweet-card');
  if (card) {
    card.classList.remove('entering');
    void card.offsetWidth; // 連続で出したときもアニメーションをやり直す
    card.classList.add('entering');
  }
}

/** 未整理・保存済みの件数を取り直して表示する */
export async function updateCount(): Promise<{ unprocessed: number; kept: number }> {
  const counts = await sendMessage({ action: 'get_counts' });
  const remainingEl = document.getElementById('remaining-count');
  const keptEl = document.getElementById('kept-count');
  if (remainingEl) remainingEl.innerText = String(counts.unprocessed);
  if (keptEl) keptEl.innerText = String(counts.kept);
  renderSessionSummary(counts.unprocessed);
  return counts;
}

async function updateCurrent(changes: BookmarkChanges): Promise<void> {
  if (!currentPost) return;
  await sendMessage({
    action: 'update_bookmark',
    id: currentPost.id,
    changes
  });
}

async function keepCurrentPost(folder: string): Promise<void> {
  if (!currentPost) return;

  skippedIds.delete(currentPost.id);
  await updateCurrent({ folder, status: 'kept' });
  pushUndo({ type: 'kept', post: clonePost(currentPost), folder });
  adjustFolderCount(folder, 1);
  renderFolderRack();
  flashFolderSlot(folder);
}

async function discardCurrentPost(): Promise<void> {
  if (!currentPost) return;

  skippedIds.delete(currentPost.id);
  const snapshot = clonePost(currentPost);
  await updateCurrent({ status: 'discarded' });
  pushUndo({ type: 'discarded', post: snapshot });
  scheduleUnbookmark(snapshot);
}

async function skipCurrentPost(): Promise<void> {
  if (!currentPost) return;
  pushUndo({ type: 'skipped', post: clonePost(currentPost) });
  skippedIds.add(currentPost.id);
}

function showPost(post: BookmarkPost): void {
  currentPost = post;
  showEmptyState(false);
  renderCard(post);
}

async function undoLast(): Promise<void> {
  const entry = undoStack.pop();
  if (!entry) {
    setLastAction('取り消せる操作はありません');
    return;
  }
  session[entry.type] = Math.max(0, session[entry.type] - 1);

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
    if (entry.type === 'kept') {
      // 保存済み画面で移動・名前変更・削除されていることがあるので、件数は取り直す
      await loadFolders();
    }
  }

  showPost(entry.post);
  setLastAction('取り消しました');
  await updateCount();
}

/** 指定のフォルダに保存して次へ */
function keepAndNext(folder: string): void {
  void runExclusive(async () => {
    await keepCurrentPost(folder);
    await loadNextPost();
  });
}

function skipAndNext(): void {
  void runExclusive(async () => {
    await skipCurrentPost();
    await loadNextPost();
  });
}

/** 削除は 1 回で確定する。Twitter 側の解除は少し待ってから始まるので、その間は Z で解除ごと取り消せる */
function discardAndNext(): void {
  void runExclusive(async () => {
    await discardCurrentPost();
    await loadNextPost();
  });
}

/** 選別画面のボタン・キー操作を登録する */
export function bindSortView(): void {
  bindFolderRack((folder) => {
    if (currentPost && !state.isBusy) keepAndNext(folder);
  });

  document.getElementById('btn-undo')?.addEventListener('click', () => {
    void runExclusive(undoLast);
  });

  document.getElementById('card-open-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (currentPost?.url) openTweet(currentPost.url);
  });

  document.getElementById('btn-skip')?.addEventListener('click', () => {
    if (currentPost) skipAndNext();
  });

  document.getElementById('btn-discard')?.addEventListener('click', () => {
    if (currentPost) discardAndNext();
  });

  document.addEventListener('keydown', handleKeydown);
}

function handleKeydown(e: KeyboardEvent): void {
  if (state.viewMode !== 'sort' || state.isBusy) return;
  // 押しっぱなしのリピートで何件も続けて振り分けないようにする。
  // 修飾キー付き（Ctrl+1 のタブ切替など）はブラウザに任せる。
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;

  // フォルダ名の入力中などは、文字入力を優先する
  const activeEl = document.activeElement;
  if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLSelectElement) return;

  if (e.key === 'z' || e.key === 'Z') {
    e.preventDefault();
    void runExclusive(undoLast);
    return;
  }

  if (!currentPost) return;

  if (e.key >= '1' && e.key <= '9') {
    const folder = folderByShortcut(Number(e.key) - 1);
    if (folder) {
      e.preventDefault();
      keepAndNext(folder);
    }
    return;
  }

  if (e.key === 'o' || e.key === 'O') {
    e.preventDefault();
    openTweet(currentPost.url);
    return;
  }

  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    discardAndNext();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    skipAndNext();
  }
}
