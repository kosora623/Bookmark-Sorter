import { DEFAULT_FOLDER } from './constants';
import type { BookmarkPost } from './db';

const INSTANCE_ID = Math.random().toString(36).slice(2);
const BATCH_LIMIT = 100;
const NORMAL_SCROLL_INTERVAL_MS = 1500;
const SKIP_SCROLL_INTERVAL_MS = 280;
const BOTTOM_DETECT_COUNT = 5;
const SKIP_BOTTOM_DETECT_COUNT = 18;

let isCollecting = false;
let isSkipMode = false;
let collectedCount = 0;
let lastScrollY = -1;            // スクロール位置の記憶用
let sameScrollCount = 0;         // スクロールしても画面が動かなかった回数
let overlayCreated = false;
let unbookmarkAttempted = false;
let tornDown = false;
let pageCheckTimer: ReturnType<typeof setInterval> | null = null;
let collectTimer: ReturnType<typeof setTimeout> | null = null;

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

function teardown(): void {
  if (tornDown) return;
  tornDown = true;
  isCollecting = false;
  isSkipMode = false;

  if (pageCheckTimer !== null) {
    clearInterval(pageCheckTimer);
    pageCheckTimer = null;
  }
  if (collectTimer !== null) {
    clearTimeout(collectTimer);
    collectTimer = null;
  }

  const overlay = document.getElementById('x-bm-sorter-overlay');
  if (overlay?.dataset.instance === INSTANCE_ID) {
    overlay.remove();
    overlayCreated = false;
  }
}

async function sendRuntimeMessage(message: object): Promise<unknown> {
  if (!isExtensionAlive()) {
    teardown();
    return undefined;
  }

  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      teardown();
      return undefined;
    }
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PENDING_UNBOOKMARK_KEY = 'pendingUnbookmark';

function isNestedTweet(el: HTMLElement): boolean {
  if (el.closest('[data-testid="quoteTweet"]')) return true;
  return el.parentElement?.closest('[data-testid="tweet"]') != null;
}

function isOwnDescendant(node: Element, root: HTMLElement): boolean {
  const nestedTweet = node.closest('[data-testid="tweet"]');
  if (nestedTweet && nestedTweet !== root) return false;
  if (node.closest('[data-testid="quoteTweet"]')) return false;
  return true;
}

function queryOwn<T extends Element>(root: HTMLElement, selector: string): T | null {
  const matches = root.querySelectorAll<T>(selector);
  for (const el of matches) {
    if (isOwnDescendant(el, root)) return el;
  }
  return null;
}

function queryOwnAll<T extends Element>(root: HTMLElement, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)].filter((el) => isOwnDescendant(el, root));
}

function findPrimaryTweet(): HTMLElement | null {
  const tweets = document.querySelectorAll<HTMLElement>('article[data-testid="tweet"]');
  for (const tweet of tweets) {
    if (!isNestedTweet(tweet)) return tweet;
  }
  return tweets[0] ?? null;
}

function findRemoveBookmarkButton(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-testid="removeBookmark"]');
}

function statusIdFromLocation(): string | undefined {
  return location.pathname.match(/\/status\/(\d+)/)?.[1];
}

async function isPendingUnbookmark(): Promise<boolean> {
  const statusId = statusIdFromLocation();
  if (!statusId || !isExtensionAlive()) return false;

  try {
    const stored = await chrome.storage.session.get(PENDING_UNBOOKMARK_KEY);
    const pending = stored[PENDING_UNBOOKMARK_KEY];
    return (
      typeof pending === 'object' &&
      pending !== null &&
      (pending as { statusId?: string }).statusId === statusId
    );
  } catch {
    return false;
  }
}

async function tryAutoUnbookmark(): Promise<void> {
  if (unbookmarkAttempted) return;
  if (!(await isPendingUnbookmark())) return;
  unbookmarkAttempted = true;

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isExtensionAlive()) {
      teardown();
      return;
    }
    const tweetEl = findPrimaryTweet();
    if (tweetEl) {
      const removeBtn = findRemoveBookmarkButton(tweetEl);
      if (removeBtn) {
        removeBtn.click();
        break;
      }
      if (queryOwn(tweetEl, '[data-testid="bookmark"]')) break;
    }
    await sleep(200);
  }

  await sendRuntimeMessage({ action: 'unbookmark_done' });
}

function createOverlayUI(): void {
  if (overlayCreated) return;

  const existing = document.getElementById('x-bm-sorter-overlay');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.id = 'x-bm-sorter-overlay';
  container.dataset.instance = INSTANCE_ID;
  container.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 99999;
    background: #1e2732;
    color: #fff;
    padding: 12px 16px;
    border-radius: 8px;
    border: 1px solid #38444d;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    font-family: sans-serif;
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  `;

  container.innerHTML = `
    <div style="font-weight: bold; color: #1d9bf0;">Bookmark Sorter</div>
    <div>今回取得: <span id="x-bm-count">0</span> / ${BATCH_LIMIT} 件</div>
    <div id="x-bm-status" style="font-size: 12px; color: #8899a6;">停止中</div>
    <button id="x-bm-toggle-btn" style="
      background: #1d9bf0; color: #fff; border: none; padding: 6px 12px;
      border-radius: 4px; cursor: pointer; font-weight: bold;
    ">100件を取得開始</button>
    <button id="x-bm-open-dash-btn" style="
      background: transparent; color: #1d9bf0; border: 1px solid #1d9bf0;
      padding: 6px 12px; border-radius: 4px; cursor: pointer;
    ">ダッシュボードを開く</button>
  `;

  document.body.appendChild(container);
  overlayCreated = true;

  const toggleBtn = container.querySelector('#x-bm-toggle-btn') as HTMLButtonElement;
  const openDashBtn = container.querySelector('#x-bm-open-dash-btn') as HTMLButtonElement;
  openDashBtn.addEventListener('click', () => {
    void sendRuntimeMessage({ action: 'open_dashboard' });
  });
  toggleBtn.addEventListener('click', () => {
    isCollecting = !isCollecting;
    if (isCollecting) {
      collectedCount = 0;
      sameScrollCount = 0;
      lastScrollY = -1;
      isSkipMode = false;
      updateStatus('未保存ポストを探してスクロール中...', '#1d9bf0');
      toggleBtn.innerText = '一時停止';
      toggleBtn.style.background = '#f4212e';
      void startAutoCollect().catch((error: unknown) => {
        if (!isContextInvalidatedError(error)) {
          console.error(error);
        }
      });
    } else {
      stopCollect('一時停止しました');
    }
  });
}

function updateStatus(text: string, color: string): void {
  const statusEl = document.getElementById('x-bm-status');
  if (statusEl) {
    statusEl.innerText = text;
    statusEl.style.color = color;
  }
}

function stopCollect(reason: string): void {
  isCollecting = false;
  isSkipMode = false;
  const toggleBtn = document.getElementById('x-bm-toggle-btn') as HTMLButtonElement | null;
  if (toggleBtn) {
    toggleBtn.innerText = '追加で100件取得';
    toggleBtn.style.background = '#1d9bf0';
  }
  updateStatus(reason, '#00ba7c');
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function hostnameOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    if (!host || host === 't.co') return undefined;
    return host;
  } catch {
    return undefined;
  }
}

function looksLikeDomain(text: string): boolean {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(text.trim());
}

function extractBackgroundImageUrl(el: HTMLElement): string | undefined {
  const fromStyle = el.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
  if (fromStyle?.[1] && isHttpUrl(fromStyle[1])) return fromStyle[1];
  return undefined;
}

function extractCardImage(wrapper: HTMLElement): string | undefined {
  const img = wrapper.querySelector('img');
  if (img instanceof HTMLImageElement) {
    const src = img.currentSrc || img.src;
    if (src && isHttpUrl(src) && !src.startsWith('data:')) return src;
  }

  const media =
    wrapper.querySelector<HTMLElement>('[data-testid="card.layoutSmall.media"]') ??
    wrapper.querySelector<HTMLElement>('[data-testid="card.layoutLarge.media"]') ??
    wrapper.querySelector<HTMLElement>('[data-testid$=".media"]');
  if (media) {
    const fromMedia = extractBackgroundImageUrl(media);
    if (fromMedia) return fromMedia;
    const nested = media.querySelectorAll<HTMLElement>('[style*="background-image"]');
    for (const node of nested) {
      const fromNested = extractBackgroundImageUrl(node);
      if (fromNested) return fromNested;
    }
  }

  return undefined;
}

function extractCardTexts(wrapper: HTMLElement): { domain?: string; title?: string } {
  const detail =
    wrapper.querySelector('[data-testid="card.layoutSmall.detail"]') ??
    wrapper.querySelector('[data-testid="card.layoutLarge.detail"]') ??
    wrapper.querySelector('[data-testid$=".detail"]');

  const blocks: string[] = [];
  if (detail) {
    for (const child of Array.from(detail.children)) {
      const text = (child as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
      if (text && !blocks.includes(text)) blocks.push(text);
    }
  }

  if (blocks.length === 0) {
    const anchor = wrapper.querySelector('a[href]');
    const labeled = anchor?.getAttribute('aria-label')?.trim();
    if (labeled) {
      for (const part of labeled.split(/\n+/)) {
        const text = part.replace(/\s+/g, ' ').trim();
        if (text && !blocks.includes(text)) blocks.push(text);
      }
    }
  }

  let domain: string | undefined;
  let title: string | undefined;

  if (blocks[0] && looksLikeDomain(blocks[0])) {
    domain = blocks[0];
    title = blocks[1];
  } else {
    title = blocks[0];
    domain = blocks.find((block, index) => index > 0 && looksLikeDomain(block));
  }

  return { domain, title };
}

function findOwnCardWrapper(tweetEl: HTMLElement): HTMLElement | null {
  const wrappers = tweetEl.querySelectorAll<HTMLElement>('[data-testid="card.wrapper"]');
  for (const wrapper of wrappers) {
    if (wrapper.closest('[data-testid="quoteTweet"]')) continue;
    const nestedTweet = wrapper.closest('[data-testid="tweet"]');
    if (nestedTweet && nestedTweet !== tweetEl) continue;
    return wrapper;
  }
  return null;
}

function parseLinkCard(tweetEl: HTMLElement): BookmarkPost['linkCard'] | undefined {
  const wrapper = findOwnCardWrapper(tweetEl);
  if (!wrapper) return undefined;

  const anchor = wrapper.querySelector('a[href]');
  const href = anchor instanceof HTMLAnchorElement ? anchor.href : '';
  if (!href || !isHttpUrl(href)) return undefined;

  const { domain: visibleDomain, title } = extractCardTexts(wrapper);
  const domain = visibleDomain || hostnameOf(href);
  const image = extractCardImage(wrapper);

  const card: NonNullable<BookmarkPost['linkCard']> = { url: href };
  if (title) card.title = title;
  if (domain) card.domain = domain;
  if (image) card.image = image;
  return card;
}

function parseTweetElement(tweetEl: HTMLElement): BookmarkPost | null {
  try {
    const timeEl = queryOwn(tweetEl, 'time');
    const linkEl = timeEl ? timeEl.closest('a') : null;
    const url = linkEl instanceof HTMLAnchorElement ? linkEl.href : '';
    const idMatch = url.match(/\/status\/(\d+)/);
    const id = idMatch ? idMatch[1] : '';

    if (!id) return null;

    const userEl = queryOwn<HTMLElement>(tweetEl, '[data-testid="User-Name"]');
    const author = userEl ? userEl.innerText.replace(/\n/g, ' ') : '不明';

    const textEl = queryOwn<HTMLElement>(tweetEl, '[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText : '';

    const images: string[] = [];
    for (const img of queryOwnAll<HTMLImageElement>(tweetEl, '[data-testid="tweetPhoto"] img')) {
      const src = img.src;
      if (src && isHttpUrl(src) && !src.startsWith('data:')) images.push(src);
    }

    const linkCard = parseLinkCard(tweetEl);

    const post: BookmarkPost = {
      id,
      url,
      author,
      text,
      images,
      folder: DEFAULT_FOLDER,
      status: 'unprocessed',
      savedAt: new Date().toISOString()
    };
    if (linkCard) post.linkCard = linkCard;
    return post;
  } catch (err) {
    console.error('ポスト解析エラー:', err);
    return null;
  }
}

async function collectVisibleTweets(): Promise<{ newAdded: number; visibleCount: number }> {
  const tweetElements = document.querySelectorAll<HTMLElement>('[data-testid="tweet"]');
  const postsToSave: BookmarkPost[] = [];

  for (const tweetEl of tweetElements) {
    if (isNestedTweet(tweetEl)) continue;
    const postData = parseTweetElement(tweetEl);
    if (postData) {
      postsToSave.push(postData);
    }
  }

  const visibleCount = postsToSave.length;
  if (visibleCount === 0) return { newAdded: 0, visibleCount: 0 };

  const response = (await sendRuntimeMessage({
    action: 'save_posts',
    posts: postsToSave
  })) as { savedCount?: number } | undefined;

  if (!response) return { newAdded: 0, visibleCount };

  const newAdded = response.savedCount || 0;
  collectedCount += newAdded;

  const countEl = document.getElementById('x-bm-count');
  if (countEl) countEl.innerText = collectedCount.toString();

  return { newAdded, visibleCount };
}

async function startAutoCollect(): Promise<void> {
  if (!isCollecting || tornDown) return;
  if (!isExtensionAlive()) {
    teardown();
    return;
  }

  try {
    const { newAdded, visibleCount } = await collectVisibleTweets();
    if (tornDown || !isCollecting) return;

    const wasSkipMode = isSkipMode;
    if (newAdded > 0) {
      isSkipMode = false;
    } else if (visibleCount > 0) {
      isSkipMode = true;
    } else {
      isSkipMode = false;
    }

    if (isSkipMode !== wasSkipMode) {
      sameScrollCount = 0;
      if (isSkipMode) {
        updateStatus('保存済みエリアを高速通過中...', '#8899a6');
      } else {
        updateStatus('未保存ポストを収集中...', '#1d9bf0');
      }
    }

    // 1. 目標の100件に到達したら自動停止
    if (collectedCount >= BATCH_LIMIT) {
      stopCollect(`${BATCH_LIMIT}件の取得が完了しました！`);
      return;
    }

    // 2. スクロール位置チェック（ページの最下部に達したかどうかの判定）
    const currentScrollY = window.scrollY;
    const bottomDetectCount = isSkipMode ? SKIP_BOTTOM_DETECT_COUNT : BOTTOM_DETECT_COUNT;
    if (currentScrollY === lastScrollY) {
      sameScrollCount++;

      if (sameScrollCount >= bottomDetectCount) {
        stopCollect('ブックマークの最下部に到達しました');
        return;
      }
    } else {
      sameScrollCount = 0;
      lastScrollY = currentScrollY;
    }

    window.scrollBy({ top: 1200, behavior: 'smooth' });

    const intervalMs = isSkipMode ? SKIP_SCROLL_INTERVAL_MS : NORMAL_SCROLL_INTERVAL_MS;
    collectTimer = setTimeout(() => {
      collectTimer = null;
      if (isCollecting && !tornDown) {
        void startAutoCollect();
      }
    }, intervalMs);
  } catch (error) {
    if (isContextInvalidatedError(error)) {
      teardown();
      return;
    }
    console.error(error);
  }
}

function isBookmarksPage(): boolean {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return path === '/i/history' || path.startsWith('/i/history/') || path.includes('/bookmarks');
}

function checkPage(): void {
  if (!isExtensionAlive()) {
    teardown();
    return;
  }

  if (!unbookmarkAttempted && /\/status\/\d+/.test(location.pathname)) {
    void tryAutoUnbookmark().catch((error: unknown) => {
      if (!isContextInvalidatedError(error)) {
        console.error(error);
      }
    });
  }

  if (isBookmarksPage()) {
    createOverlayUI();
  } else {
    const overlay = document.getElementById('x-bm-sorter-overlay');
    if (overlay?.dataset.instance === INSTANCE_ID) {
      overlay.remove();
      overlayCreated = false;
    }
  }
}

checkPage();
pageCheckTimer = setInterval(checkPage, 1000);