import type { ExtensionRequest, ResponseOf } from './messages';
import { isContextInvalidatedError, isExtensionAlive, logUnexpected, unwrapReply } from './runtime';
import {
  findPrimaryTweet,
  findRemoveBookmarkButton,
  isBookmarksPath,
  parseVisibleTweets,
  queryOwn
} from './tweet-dom';

const INSTANCE_ID = Math.random().toString(36).slice(2);
const BATCH_LIMIT = 100;
const NORMAL_SCROLL_INTERVAL_MS = 1500;
const SKIP_SCROLL_INTERVAL_MS = 280;
const BOTTOM_DETECT_COUNT = 5;
const SKIP_BOTTOM_DETECT_COUNT = 18;
const PAGE_CHECK_FALLBACK_MS = 5000;
const UNBOOKMARK_FIND_TIMEOUT_MS = 10_000;
const UNBOOKMARK_CONFIRM_TIMEOUT_MS = 6_000;
const UNBOOKMARK_POLL_MS = 200;
const OVERLAY_ID = 'x-bm-sorter-overlay';

let isCollecting = false;
let isSkipMode = false;
let collectedCount = 0;
let lastScrollY = -1;            // スクロール位置の記憶用
let sameScrollCount = 0;         // スクロールしても画面が動かなかった回数
let overlayCreated = false;
let unbookmarkAttempted = false;
/** 解除の問い合わせをしたパス。同じページで何度も background を起こさないようにする */
let unbookmarkAskedPath = '';
let tornDown = false;
let pageCheckTimer: ReturnType<typeof setInterval> | null = null;
let titleObserver: MutationObserver | null = null;
let collectTimer: ReturnType<typeof setTimeout> | null = null;

/** このインスタンスが作ったオーバーレイだけ消す（再注入された別インスタンスのものは残す） */
function removeOwnOverlay(): void {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay?.dataset.instance === INSTANCE_ID) {
    overlay.remove();
    overlayCreated = false;
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
  titleObserver?.disconnect();
  titleObserver = null;
  window.removeEventListener('popstate', checkPageIfNavigated);
  if (collectTimer !== null) {
    clearTimeout(collectTimer);
    collectTimer = null;
  }

  removeOwnOverlay();
}

/** 拡張機能が再読み込みされていたら後片付けして undefined を返す。background 側の失敗は例外になる */
async function sendRuntimeMessage<M extends ExtensionRequest>(message: M): Promise<ResponseOf<M['action']> | undefined> {
  if (!isExtensionAlive()) {
    teardown();
    return undefined;
  }

  try {
    return unwrapReply<ResponseOf<M['action']>>(await chrome.runtime.sendMessage(message));
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

function statusIdFromLocation(): string | undefined {
  return location.pathname.match(/\/status\/(\d+)/)?.[1];
}

/**
 * このタブが background の開いた解除用の裏タブか。
 * chrome.storage.session は既定で content script から読めないので、background に問い合わせる。
 */
async function isPendingUnbookmark(statusId: string): Promise<boolean> {
  try {
    const response = await sendRuntimeMessage({ action: 'get_unbookmark_task', statusId });
    return response?.pending === true;
  } catch {
    return false;
  }
}

async function waitForBookmarkCleared(statusId: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (!isExtensionAlive()) return false;
    const tweetEl = findPrimaryTweet(statusId);
    // ボタンが「ブックマークに追加」へ切り替われば、X 側の解除リクエストが通っている
    if (tweetEl && !findRemoveBookmarkButton(tweetEl) && queryOwn(tweetEl, '[data-testid="bookmark"]')) {
      return true;
    }
    await sleep(UNBOOKMARK_POLL_MS);
  }
  return false;
}

async function tryAutoUnbookmark(): Promise<void> {
  if (unbookmarkAttempted) return;
  const statusId = statusIdFromLocation();
  if (!statusId || unbookmarkAskedPath === location.pathname) return;
  unbookmarkAskedPath = location.pathname;
  if (!(await isPendingUnbookmark(statusId))) return;
  unbookmarkAttempted = true;

  let ok = false;
  const deadline = Date.now() + UNBOOKMARK_FIND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isExtensionAlive()) {
      teardown();
      return;
    }
    const tweetEl = findPrimaryTweet(statusId);
    if (tweetEl) {
      const removeBtn = findRemoveBookmarkButton(tweetEl);
      if (removeBtn) {
        removeBtn.click();
        ok = await waitForBookmarkCleared(statusId, Date.now() + UNBOOKMARK_CONFIRM_TIMEOUT_MS);
        break;
      }
      if (queryOwn(tweetEl, '[data-testid="bookmark"]')) {
        // すでに解除済み
        ok = true;
        break;
      }
    }
    await sleep(UNBOOKMARK_POLL_MS);
  }

  await sendRuntimeMessage({ action: 'unbookmark_done', ok });
}

function createOverlayUI(): void {
  if (overlayCreated && document.getElementById(OVERLAY_ID)) return;

  document.getElementById(OVERLAY_ID)?.remove();

  const container = document.createElement('div');
  container.id = OVERLAY_ID;
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
    ">${BATCH_LIMIT}件を取得開始</button>
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
      void startAutoCollect().catch(logUnexpected);
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
    toggleBtn.innerText = `追加で${BATCH_LIMIT}件取得`;
    toggleBtn.style.background = '#1d9bf0';
  }
  updateStatus(reason, '#00ba7c');
}

async function collectVisibleTweets(): Promise<{ newAdded: number; visibleCount: number }> {
  const postsToSave = parseVisibleTweets();
  const visibleCount = postsToSave.length;
  if (visibleCount === 0) return { newAdded: 0, visibleCount: 0 };

  const response = await sendRuntimeMessage({ action: 'save_posts', posts: postsToSave });
  if (!response) return { newAdded: 0, visibleCount };

  const newAdded = response.savedCount;
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
    // 次のスクロールは予約されないので、ボタンの表示も止まった状態に戻す
    stopCollect('エラーで停止しました');
  }
}

function checkPage(): void {
  if (!isExtensionAlive()) {
    teardown();
    return;
  }

  if (!unbookmarkAttempted && statusIdFromLocation()) {
    void tryAutoUnbookmark().catch(logUnexpected);
  }

  if (isBookmarksPath(location.pathname)) {
    createOverlayUI();
  } else {
    removeOwnOverlay();
  }
}

// X は SPA なので、ページ遷移はタイトルの書き換えと popstate で拾う。
// content script からは history.pushState を直接フックできない（ページ側の world で動くため）。
let lastCheckedPath = '';

function checkPageIfNavigated(): void {
  if (location.pathname === lastCheckedPath) return;
  lastCheckedPath = location.pathname;
  checkPage();
}

titleObserver = new MutationObserver(checkPageIfNavigated);
titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
window.addEventListener('popstate', checkPageIfNavigated);

checkPageIfNavigated();
// 取りこぼし（タイトルが変わらない遷移など）と拡張の再読み込み検知のための保険
pageCheckTimer = setInterval(checkPage, PAGE_CHECK_FALLBACK_MS);