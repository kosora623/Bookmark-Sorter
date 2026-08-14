import { DEFAULT_FOLDER, db, type BookmarkPost } from './db';
import { isExtensionRequest, type BookmarkChanges, type FolderInfo } from './messages';
import {
  PENDING_UNBOOKMARK_KEY,
  UNBOOKMARK_INFLIGHT_KEY,
  isHttpUrl,
  isXHostUrl,
  isXStatusUrl,
  statusIdFromUrl,
  type InflightUnbookmark,
  type PendingUnbookmark
} from './urls';

const UNBOOKMARK_TIMEOUT_MS = 15_000;
const UNBOOKMARK_DELAY_MS = 2_000;
const UNBOOKMARK_STORAGE_KEY = 'unbookmarkQueue';
const MAX_UNPROCESSED_LIMIT = 50;
const STATUSES: ReadonlySet<BookmarkPost['status']> = new Set(['unprocessed', 'kept', 'discarded']);

interface UnbookmarkJob {
  url: string;
  earliest: number;
}

let unbookmarkQueue: UnbookmarkJob[] = [];
let unbookmarkRunning = false;
let wakeQueueWait: (() => void) | null = null;

function isBookmarkPost(value: unknown): value is BookmarkPost {
  if (typeof value !== 'object' || value === null) return false;
  const post = value as Partial<BookmarkPost>;
  return typeof post.id === 'string' && /^\d+$/.test(post.id);
}

function toLinkCard(value: BookmarkPost['linkCard']): BookmarkPost['linkCard'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (typeof value.url !== 'string' || !isHttpUrl(value.url)) return undefined;

  const card: NonNullable<BookmarkPost['linkCard']> = { url: value.url };
  if (typeof value.title === 'string' && value.title) card.title = value.title;
  if (typeof value.domain === 'string' && value.domain) card.domain = value.domain;
  if (typeof value.image === 'string' && value.image && isHttpUrl(value.image)) card.image = value.image;
  return card;
}

function toBookmarkPost(post: BookmarkPost): BookmarkPost {
  const images = Array.isArray(post.images)
    ? post.images.filter((url): url is string => typeof url === 'string' && isHttpUrl(url))
    : [];
  const status = post.status && STATUSES.has(post.status) ? post.status : 'unprocessed';
  const linkCard = toLinkCard(post.linkCard);
  const url = typeof post.url === 'string' && isXStatusUrl(post.url) ? post.url : '';

  const result: BookmarkPost = {
    id: post.id,
    url,
    author: typeof post.author === 'string' ? post.author : '不明',
    text: typeof post.text === 'string' ? post.text : '',
    images,
    folder: typeof post.folder === 'string' && post.folder ? post.folder : DEFAULT_FOLDER,
    status,
    savedAt: typeof post.savedAt === 'string' ? post.savedAt : new Date().toISOString()
  };
  if (linkCard) result.linkCard = linkCard;
  return result;
}

function sanitizeChanges(changes: BookmarkChanges): BookmarkChanges {
  const next: BookmarkChanges = {};
  if (typeof changes.folder === 'string') next.folder = changes.folder;
  if (changes.status && STATUSES.has(changes.status)) {
    next.status = changes.status;
  }
  return next;
}

function isUnbookmarkJob(value: unknown): value is UnbookmarkJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<UnbookmarkJob>;
  return typeof job.url === 'string' && isXStatusUrl(job.url) && typeof job.earliest === 'number';
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

  const toEnrich = candidates.filter((post, index) => {
    const stored = existing[index];
    return stored != null && stored.linkCard == null && post.linkCard != null;
  });
  if (toEnrich.length > 0) {
    await Promise.all(
      toEnrich.map((post) => {
        const linkCard = post.linkCard;
        return linkCard ? db.bookmarks.update(post.id, { linkCard }) : Promise.resolve(0);
      })
    );
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

async function listKept(): Promise<{ posts: BookmarkPost[] }> {
  const posts = await db.bookmarks.where('status').equals('kept').sortBy('savedAt');
  posts.reverse();
  return { posts };
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
  const [folderRows, kept] = await Promise.all([
    db.folders.toArray(),
    db.bookmarks.where('status').equals('kept').toArray()
  ]);

  const counts = new Map<string, number>();
  for (const post of kept) {
    counts.set(post.folder, (counts.get(post.folder) ?? 0) + 1);
  }

  const names = sortFolderNames(folderRows.map((folder) => folder.name));
  return {
    folders: names.map((name) => ({
      name,
      count: counts.get(name) ?? 0,
      locked: name === DEFAULT_FOLDER
    }))
  };
}

function sanitizeFolderName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 40);
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

async function clearBookmarks(): Promise<{ ok: true }> {
  unbookmarkQueue = [];
  wakeQueue();
  await persistUnbookmarkQueue();
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
  const url = sanitizeStatusUrl(tweetUrl);
  if (!url || unbookmarkQueue.some((job) => job.url === url)) return;
  unbookmarkQueue.push({ url, earliest: Date.now() + UNBOOKMARK_DELAY_MS });
  await persistUnbookmarkQueue();
  void processUnbookmarkQueue();
}

function cancelQueuedUnbookmark(tweetUrl: string): void {
  const url = sanitizeStatusUrl(tweetUrl) ?? tweetUrl;
  const before = unbookmarkQueue.length;
  unbookmarkQueue = unbookmarkQueue.filter((job) => job.url !== url && job.url !== tweetUrl);
  if (unbookmarkQueue.length !== before) void persistUnbookmarkQueue();
  wakeQueue();
}

function runOneUnbookmark(tweetUrl: string): Promise<void> {
  return new Promise((resolve) => {
    void (async () => {
      await setPendingUnbookmark(tweetUrl);
      await setInflight({ url: tweetUrl });

      chrome.tabs.create({ url: tweetUrl, active: false }, (tab) => {
        if (chrome.runtime.lastError || !tab?.id) {
          void clearPendingUnbookmark();
          void setInflight(null);
          resolve();
          return;
        }

        const tabId = tab.id;
        void setInflight({ url: tweetUrl, tabId });
        let finished = false;

        const finish = (): void => {
          if (finished) return;
          finished = true;
          chrome.runtime.onMessage.removeListener(listener);
          closeTabQuietly(tabId);
          void clearPendingUnbookmark();
          void setInflight(null);
          resolve();
        };

        const listener = (message: unknown, sender: chrome.runtime.MessageSender): void => {
          if (!isExtensionRequest(message)) return;
          if (message.action === 'unbookmark_done' && sender.tab?.id === tabId) {
            finish();
          }
        };

        chrome.runtime.onMessage.addListener(listener);
        setTimeout(finish, UNBOOKMARK_TIMEOUT_MS);
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

    await runOneUnbookmark(job.url);
    if (unbookmarkQueue[0] === job) {
      unbookmarkQueue.shift();
      await persistUnbookmarkQueue();
    }
  }

  unbookmarkRunning = false;
  if (unbookmarkQueue.length > 0) void processUnbookmarkQueue();
}

async function restoreUnbookmarkQueue(): Promise<void> {
  await closeInflightTab();
  const stored = await chrome.storage.local.get(UNBOOKMARK_STORAGE_KEY);
  const raw = stored[UNBOOKMARK_STORAGE_KEY];
  unbookmarkQueue = Array.isArray(raw) ? raw.filter(isUnbookmarkJob) : [];
  void processUnbookmarkQueue();
}

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
    if (message.tweetUrl) cancelQueuedUnbookmark(message.tweetUrl);
    sendResponse({ ok: true });
    return;
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
    void listKept().then(sendResponse);
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

void restoreUnbookmarkQueue();
