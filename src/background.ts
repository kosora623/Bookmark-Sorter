import { DEFAULT_FOLDER, db, type BookmarkPost } from './db';
import {
  isExtensionRequest,
  type ExportData,
  type FolderInfo,
  type UnbookmarkFailure
} from './messages';
import { MAX_KEPT_PAGE_LIMIT, listKept } from './kept-query';
import {
  isBookmarkPost,
  parseImportData,
  sanitizeChanges,
  sanitizeFolderName,
  toBookmarkPost
} from './normalize';
import {
  PENDING_UNBOOKMARK_KEY,
  UNBOOKMARK_INFLIGHT_KEY,
  isXHostUrl,
  isXStatusUrl,
  statusIdFromUrl,
  type InflightUnbookmark,
  type PendingUnbookmark
} from './urls';

// content 側はボタン探索 10 秒 + 解除確認 6 秒まで待つので、それより長くとる
const UNBOOKMARK_TIMEOUT_MS = 25_000;
const UNBOOKMARK_DELAY_MS = 2_000;
const UNBOOKMARK_RETRY_DELAY_MS = 5_000;
const MAX_UNBOOKMARK_ATTEMPTS = 3;
const MAX_UNBOOKMARK_FAILURES = 500;
const UNBOOKMARK_STORAGE_KEY = 'unbookmarkQueue';
const UNBOOKMARK_FAILED_KEY = 'unbookmarkFailed';
const MAX_UNPROCESSED_LIMIT = 50;

interface UnbookmarkJob {
  url: string;
  earliest: number;
  attempts?: number;
}

let unbookmarkQueue: UnbookmarkJob[] = [];
let unbookmarkRunning = false;
let wakeQueueWait: (() => void) | null = null;

function isUnbookmarkJob(value: unknown): value is UnbookmarkJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<UnbookmarkJob>;
  return (
    typeof job.url === 'string' &&
    isXStatusUrl(job.url) &&
    typeof job.earliest === 'number' &&
    (job.attempts === undefined || typeof job.attempts === 'number')
  );
}

function isUnbookmarkFailure(value: unknown): value is UnbookmarkFailure {
  if (typeof value !== 'object' || value === null) return false;
  const failure = value as Partial<UnbookmarkFailure>;
  return typeof failure.url === 'string' && isXStatusUrl(failure.url) && typeof failure.failedAt === 'string';
}

async function loadUnbookmarkFailures(): Promise<UnbookmarkFailure[]> {
  const stored = await chrome.storage.local.get(UNBOOKMARK_FAILED_KEY);
  const raw = stored[UNBOOKMARK_FAILED_KEY];
  return Array.isArray(raw) ? raw.filter(isUnbookmarkFailure) : [];
}

async function saveUnbookmarkFailures(failures: UnbookmarkFailure[]): Promise<void> {
  await chrome.storage.local.set({ [UNBOOKMARK_FAILED_KEY]: failures.slice(-MAX_UNBOOKMARK_FAILURES) });
}

async function recordUnbookmarkFailure(url: string): Promise<void> {
  const failures = (await loadUnbookmarkFailures()).filter((failure) => failure.url !== url);
  failures.push({ url, failedAt: new Date().toISOString() });
  await saveUnbookmarkFailures(failures);
}

async function removeUnbookmarkFailure(url: string): Promise<void> {
  const failures = await loadUnbookmarkFailures();
  const next = failures.filter((failure) => failure.url !== url);
  if (next.length !== failures.length) await saveUnbookmarkFailures(next);
}

async function listUnbookmarkFailures(): Promise<{ failures: UnbookmarkFailure[] }> {
  return { failures: await loadUnbookmarkFailures() };
}

async function retryUnbookmarkFailures(): Promise<{ queued: number }> {
  await queueReady;
  const failures = await loadUnbookmarkFailures();
  await saveUnbookmarkFailures([]);

  let queued = 0;
  for (const failure of failures) {
    // 失敗後に Undo されたポストは解除しない
    const id = statusIdFromUrl(failure.url);
    const post = id ? await db.bookmarks.get(id) : undefined;
    if (post?.status !== 'discarded') continue;
    if (unbookmarkQueue.some((job) => job.url === failure.url)) continue;
    unbookmarkQueue.push({ url: failure.url, earliest: Date.now() });
    queued++;
  }

  if (queued > 0) {
    await persistUnbookmarkQueue();
    void processUnbookmarkQueue();
  }
  return { queued };
}

async function persistUnbookmarkQueue(): Promise<void> {
  await chrome.storage.local.set({ [UNBOOKMARK_STORAGE_KEY]: unbookmarkQueue });
}

function wakeQueue(): void {
  if (!wakeQueueWait) return;
  const wake = wakeQueueWait;
  wakeQueueWait = null;
  wake();
}

function waitForQueue(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeQueueWait = null;
      resolve();
    }, ms);
    wakeQueueWait = () => {
      clearTimeout(timer);
      wakeQueueWait = null;
      resolve();
    };
  });
}

async function savePosts(posts: unknown): Promise<{ savedCount: number }> {
  if (!Array.isArray(posts)) return { savedCount: 0 };

  const unique = new Map<string, BookmarkPost>();
  for (const post of posts) {
    if (!isBookmarkPost(post)) continue;
    const normalized = toBookmarkPost(post);
    if (!normalized.url) continue;
    unique.set(normalized.id, normalized);
  }

  const candidates = [...unique.values()];
  if (candidates.length === 0) return { savedCount: 0 };

  const existing = await db.bookmarks.bulkGet(candidates.map((post) => post.id));
  const toAdd = candidates.filter((_, index) => existing[index] == null);
  if (toAdd.length > 0) {
    await db.bookmarks.bulkAdd(toAdd);
  }

  // 既存データに無い項目（リンクカード・投稿日時）だけ後から補う
  const enrichments: { id: string; changes: Partial<BookmarkPost> }[] = [];
  candidates.forEach((post, index) => {
    const stored = existing[index];
    if (stored == null) return;
    const changes: Partial<BookmarkPost> = {};
    if (stored.linkCard == null && post.linkCard != null) changes.linkCard = post.linkCard;
    if (!stored.hasVideo && post.hasVideo) {
      changes.hasVideo = true;
      changes.images = post.images;
    }
    if (stored.postedAt == null && post.postedAt != null) changes.postedAt = post.postedAt;
    if (Object.keys(changes).length > 0) enrichments.push({ id: post.id, changes });
  });
  if (enrichments.length > 0) {
    await Promise.all(enrichments.map(({ id, changes }) => db.bookmarks.update(id, changes)));
  }

  return { savedCount: toAdd.length };
}

async function getUnprocessed(excludeIds: string[] = [], rawLimit = 1): Promise<{ posts: BookmarkPost[] }> {
  const exclude = new Set(excludeIds);
  const limit = Math.min(MAX_UNPROCESSED_LIMIT, Math.max(1, Math.floor(rawLimit) || 1));
  const posts = await db.bookmarks
    .where('[status+savedAt]')
    .between(['unprocessed', ''], ['unprocessed', '\uffff'], true, true)
    .reverse()
    .filter((item) => !exclude.has(item.id))
    .limit(limit)
    .toArray();

  return { posts };
}

async function getCounts(): Promise<{ unprocessed: number; kept: number }> {
  const [unprocessed, kept] = await Promise.all([
    db.bookmarks.where('status').equals('unprocessed').count(),
    db.bookmarks.where('status').equals('kept').count()
  ]);
  return { unprocessed, kept };
}

function sortFolderNames(names: string[]): string[] {
  return [...names].sort((a, b) => {
    if (a === DEFAULT_FOLDER) return -1;
    if (b === DEFAULT_FOLDER) return 1;
    return a.localeCompare(b, 'ja');
  });
}

async function ensureFolders(): Promise<void> {
  const existing = await db.folders.toArray();
  const names = new Set(existing.map((folder) => folder.name));
  names.add(DEFAULT_FOLDER);

  const folderKeys = await db.bookmarks.orderBy('folder').uniqueKeys();
  for (const key of folderKeys) {
    if (typeof key === 'string' && key) names.add(key);
  }

  const missing = [...names].filter((name) => !existing.some((folder) => folder.name === name));
  if (missing.length > 0) {
    await db.folders.bulkAdd(missing.map((name) => ({ name })));
  }
}

async function listFolders(): Promise<{ folders: FolderInfo[] }> {
  await ensureFolders();
  const folderRows = await db.folders.toArray();
  const names = sortFolderNames(folderRows.map((folder) => folder.name));
  const counts = await Promise.all(
    names.map((name) => db.bookmarks.where('[status+folder]').equals(['kept', name]).count())
  );

  return {
    folders: names.map((name, index) => ({
      name,
      count: counts[index] ?? 0,
      locked: name === DEFAULT_FOLDER
    }))
  };
}

async function addFolder(rawName: string): Promise<{ ok: boolean; error?: string; folders: FolderInfo[] }> {
  const name = sanitizeFolderName(rawName);
  if (!name) {
    const listed = await listFolders();
    return { ok: false, error: 'フォルダ名を入力してください', folders: listed.folders };
  }

  await ensureFolders();
  const existing = await db.folders.get(name);
  if (existing) {
    const listed = await listFolders();
    return { ok: false, error: '同じ名前のフォルダがあります', folders: listed.folders };
  }

  await db.folders.add({ name });
  const listed = await listFolders();
  return { ok: true, folders: listed.folders };
}

async function deleteFolder(rawName: string): Promise<{ ok: boolean; error?: string; folders: FolderInfo[] }> {
  const name = sanitizeFolderName(rawName);
  if (!name || name === DEFAULT_FOLDER) {
    const listed = await listFolders();
    return { ok: false, error: 'このフォルダは削除できません', folders: listed.folders };
  }

  await db.bookmarks.where('folder').equals(name).modify({ folder: DEFAULT_FOLDER });
  await db.folders.delete(name);
  const listed = await listFolders();
  return { ok: true, folders: listed.folders };
}

async function exportData(): Promise<ExportData> {
  const [bookmarks, folderRows] = await Promise.all([db.bookmarks.toArray(), db.folders.toArray()]);
  return {
    format: 'x-bookmark-sorter',
    version: 1,
    exportedAt: new Date().toISOString(),
    bookmarks,
    folders: folderRows.map((folder) => folder.name)
  };
}

async function importData(data: unknown): Promise<{ ok: boolean; error?: string; imported: number }> {
  const parsed = parseImportData(data);
  if (!parsed.ok) return { ok: false, error: parsed.error, imported: 0 };

  await db.transaction('rw', db.bookmarks, db.folders, async () => {
    if (parsed.posts.length > 0) await db.bookmarks.bulkPut(parsed.posts);
    if (parsed.folders.length > 0) await db.folders.bulkPut(parsed.folders.map((name) => ({ name })));
  });
  await ensureFolders();
  return { ok: true, imported: parsed.posts.length };
}

async function clearBookmarks(): Promise<{ ok: true }> {
  await queueReady;
  unbookmarkQueue = [];
  wakeQueue();
  await persistUnbookmarkQueue();
  await saveUnbookmarkFailures([]);
  await chrome.storage.session.remove([PENDING_UNBOOKMARK_KEY, UNBOOKMARK_INFLIGHT_KEY]);
  await db.bookmarks.clear();
  await db.folders.clear();
  await db.folders.add({ name: DEFAULT_FOLDER });
  return { ok: true };
}

function closeTabQuietly(tabId: number): void {
  chrome.tabs.remove(tabId, () => {
    void chrome.runtime.lastError;
  });
}

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  const base = chrome.runtime.getURL('');
  if (typeof sender.url === 'string' && sender.url.startsWith(base)) return true;
  return typeof sender.tab?.url === 'string' && sender.tab.url.startsWith(base);
}

function isXContentScript(sender: chrome.runtime.MessageSender): boolean {
  if (!sender.tab?.id) return false;
  const url = sender.url ?? sender.tab.url;
  return typeof url === 'string' && isXHostUrl(url);
}

function sanitizeStatusUrl(url: string): string | undefined {
  if (!isXStatusUrl(url)) return undefined;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

async function setPendingUnbookmark(url: string): Promise<void> {
  const statusId = statusIdFromUrl(url);
  if (!statusId) return;
  const pending: PendingUnbookmark = { statusId, url };
  await chrome.storage.session.set({ [PENDING_UNBOOKMARK_KEY]: pending });
}

async function clearPendingUnbookmark(): Promise<void> {
  await chrome.storage.session.remove(PENDING_UNBOOKMARK_KEY);
}

async function setInflight(inflight: InflightUnbookmark | null): Promise<void> {
  if (!inflight) {
    await chrome.storage.session.remove(UNBOOKMARK_INFLIGHT_KEY);
    return;
  }
  await chrome.storage.session.set({ [UNBOOKMARK_INFLIGHT_KEY]: inflight });
}

async function closeInflightTab(): Promise<void> {
  const stored = await chrome.storage.session.get(UNBOOKMARK_INFLIGHT_KEY);
  const inflight = stored[UNBOOKMARK_INFLIGHT_KEY] as InflightUnbookmark | undefined;
  if (typeof inflight?.tabId === 'number') {
    closeTabQuietly(inflight.tabId);
  }
  await setInflight(null);
  await clearPendingUnbookmark();
}

async function openDashboard(): Promise<void> {
  const url = chrome.runtime.getURL('index.html');
  const existing = await chrome.tabs.query({ url });
  const tab = existing[0];

  if (tab?.id) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url });
}

async function enqueueUnbookmark(tweetUrl: string): Promise<void> {
  await queueReady;
  const url = sanitizeStatusUrl(tweetUrl);
  if (!url || unbookmarkQueue.some((job) => job.url === url)) return;
  unbookmarkQueue.push({ url, earliest: Date.now() + UNBOOKMARK_DELAY_MS });
  await persistUnbookmarkQueue();
  void processUnbookmarkQueue();
}

async function cancelQueuedUnbookmark(tweetUrl: string): Promise<void> {
  await queueReady;
  const url = sanitizeStatusUrl(tweetUrl) ?? tweetUrl;
  const before = unbookmarkQueue.length;
  unbookmarkQueue = unbookmarkQueue.filter((job) => job.url !== url && job.url !== tweetUrl);
  if (unbookmarkQueue.length !== before) await persistUnbookmarkQueue();
  wakeQueue();
  await removeUnbookmarkFailure(url);
}

/** 解除できたら true。タブを開けない・タイムアウト・content からの失敗報告は false */
function runOneUnbookmark(tweetUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    void (async () => {
      await setPendingUnbookmark(tweetUrl);
      await setInflight({ url: tweetUrl });

      chrome.tabs.create({ url: tweetUrl, active: false }, (tab) => {
        if (chrome.runtime.lastError || !tab?.id) {
          void clearPendingUnbookmark();
          void setInflight(null);
          resolve(false);
          return;
        }

        const tabId = tab.id;
        void setInflight({ url: tweetUrl, tabId });
        let finished = false;

        const finish = (ok: boolean): void => {
          if (finished) return;
          finished = true;
          chrome.runtime.onMessage.removeListener(listener);
          closeTabQuietly(tabId);
          void clearPendingUnbookmark();
          void setInflight(null);
          resolve(ok);
        };

        const listener = (message: unknown, sender: chrome.runtime.MessageSender): void => {
          if (!isExtensionRequest(message)) return;
          if (message.action === 'unbookmark_done' && sender.tab?.id === tabId) {
            finish(message.ok === true);
          }
        };

        chrome.runtime.onMessage.addListener(listener);
        setTimeout(() => finish(false), UNBOOKMARK_TIMEOUT_MS);
      });
    })();
  });
}

async function processUnbookmarkQueue(): Promise<void> {
  if (unbookmarkRunning) return;
  unbookmarkRunning = true;

  while (unbookmarkQueue.length > 0) {
    const job = unbookmarkQueue[0];
    if (!job) break;

    const wait = job.earliest - Date.now();
    if (wait > 0) {
      await waitForQueue(wait);
      continue;
    }

    const ok = await runOneUnbookmark(job.url);
    // 実行中に Undo や全消去でキューから外れていたら、結果は捨てる
    if (unbookmarkQueue[0] !== job) continue;
    unbookmarkQueue.shift();

    if (!ok) {
      const attempts = (job.attempts ?? 0) + 1;
      if (attempts < MAX_UNBOOKMARK_ATTEMPTS) {
        unbookmarkQueue.push({ url: job.url, earliest: Date.now() + UNBOOKMARK_RETRY_DELAY_MS, attempts });
      } else {
        await recordUnbookmarkFailure(job.url);
      }
    }
    await persistUnbookmarkQueue();
  }

  unbookmarkRunning = false;
  if (unbookmarkQueue.length > 0) void processUnbookmarkQueue();
}

async function restoreUnbookmarkQueue(): Promise<void> {
  try {
    await closeInflightTab();
    const stored = await chrome.storage.local.get(UNBOOKMARK_STORAGE_KEY);
    const raw = stored[UNBOOKMARK_STORAGE_KEY];
    unbookmarkQueue = Array.isArray(raw) ? raw.filter(isUnbookmarkJob) : [];
  } catch (error) {
    console.error(error);
  }
}

// Service Worker 起動直後に届いたメッセージが、復元前の空キューを上書きしないよう待ち合わせる
const queueReady = restoreUnbookmarkQueue();
void queueReady.then(() => processUnbookmarkQueue());

chrome.action.onClicked.addListener(() => {
  void openDashboard();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionRequest(message)) return;

  if (message.action === 'save_posts') {
    if (!isXContentScript(sender)) return;
    void savePosts(message.posts).then(sendResponse);
    return true;
  }

  if (message.action === 'unbookmark') {
    if (!isExtensionPage(sender)) return;
    if (message.tweetUrl) {
      void enqueueUnbookmark(message.tweetUrl).then(() => sendResponse({ status: 'ok' }));
      return true;
    }
    sendResponse({ status: 'ok' });
    return;
  }

  if (message.action === 'cancel_unbookmark') {
    if (!isExtensionPage(sender)) return;
    if (!message.tweetUrl) {
      sendResponse({ ok: true });
      return;
    }
    void cancelQueuedUnbookmark(message.tweetUrl).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'list_unbookmark_failures') {
    if (!isExtensionPage(sender)) return;
    void listUnbookmarkFailures().then(sendResponse);
    return true;
  }

  if (message.action === 'retry_unbookmark_failures') {
    if (!isExtensionPage(sender)) return;
    void retryUnbookmarkFailures().then(sendResponse);
    return true;
  }

  if (message.action === 'export_data') {
    if (!isExtensionPage(sender)) return;
    void exportData().then(sendResponse);
    return true;
  }

  if (message.action === 'import_data') {
    if (!isExtensionPage(sender)) return;
    void importData(message.data).then(sendResponse);
    return true;
  }

  if (message.action === 'unbookmark_done') {
    if (!isXContentScript(sender)) return;
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'get_unprocessed') {
    if (!isExtensionPage(sender)) return;
    const excludeIds = Array.isArray(message.excludeIds)
      ? message.excludeIds.filter((id): id is string => typeof id === 'string')
      : [];
    const limit = typeof message.limit === 'number' ? message.limit : 1;
    void getUnprocessed(excludeIds, limit).then(sendResponse);
    return true;
  }

  if (message.action === 'update_bookmark') {
    if (!isExtensionPage(sender)) return;
    if (typeof message.id !== 'string' || !message.changes) {
      sendResponse({ ok: false });
      return;
    }
    const changes = sanitizeChanges(message.changes);
    void db.bookmarks.update(message.id, changes).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === 'get_counts') {
    if (!isExtensionPage(sender)) return;
    void getCounts().then(sendResponse);
    return true;
  }

  if (message.action === 'list_kept') {
    if (!isExtensionPage(sender)) return;
    void listKept(db, {
      folder: typeof message.folder === 'string' && message.folder ? message.folder : DEFAULT_FOLDER,
      query: typeof message.query === 'string' ? message.query : '',
      offset: typeof message.offset === 'number' ? message.offset : 0,
      limit: typeof message.limit === 'number' ? message.limit : MAX_KEPT_PAGE_LIMIT
    }).then(sendResponse);
    return true;
  }

  if (message.action === 'list_folders') {
    if (!isExtensionPage(sender)) return;
    void listFolders().then(sendResponse);
    return true;
  }

  if (message.action === 'add_folder') {
    if (!isExtensionPage(sender)) return;
    void addFolder(typeof message.name === 'string' ? message.name : '').then(sendResponse);
    return true;
  }

  if (message.action === 'delete_folder') {
    if (!isExtensionPage(sender)) return;
    void deleteFolder(typeof message.name === 'string' ? message.name : '').then(sendResponse);
    return true;
  }

  if (message.action === 'clear_bookmarks') {
    if (!isExtensionPage(sender)) return;
    void clearBookmarks().then(sendResponse);
    return true;
  }

  if (message.action === 'open_dashboard') {
    if (!isXContentScript(sender) && !isExtensionPage(sender)) return;
    void openDashboard().then(() => sendResponse({ ok: true }));
    return true;
  }

  return;
});
