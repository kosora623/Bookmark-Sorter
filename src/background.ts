import { DEFAULT_FOLDER } from './constants';
import { db, type BookmarkPost } from './db';
import {
  isExtensionRequest,
  type ExportData,
  type ExtensionAction,
  type ExtensionReply,
  type FolderInfo,
  type FolderMutationResult,
  type RequestOf,
  type ResponseOf,
  type UnbookmarkFailure
} from './messages';
import { MAX_KEPT_PAGE_LIMIT, listKept } from './kept-query';
import { parseImportData, sanitizeChanges, sanitizeFolderName } from './normalize';
import { savePosts } from './save-posts';
import { UnbookmarkQueue, type UnbookmarkJob } from './unbookmark-queue';
import {
  PENDING_UNBOOKMARK_KEY,
  UNBOOKMARK_INFLIGHT_KEY,
  isXHostUrl,
  isXStatusUrl,
  sanitizeStatusUrl,
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
// キューが残っている間だけ張っておくアラーム。Service Worker が止まっても、これで起こして再開する。
// chrome.alarms の最短間隔は 30 秒なので、通常の待ち合わせは setTimeout で行い、アラームは保険にとどめる
const UNBOOKMARK_ALARM = 'unbookmark-queue';
const UNBOOKMARK_ALARM_PERIOD_MINUTES = 1;
const MAX_UNPROCESSED_LIMIT = 50;

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
    if (await unbookmarkQueue.enqueue(failure.url, 0)) queued++;
  }
  return { queued };
}

async function persistUnbookmarkQueue(jobs: readonly UnbookmarkJob[]): Promise<void> {
  await chrome.storage.local.set({ [UNBOOKMARK_STORAGE_KEY]: jobs });
  await syncQueueAlarm(jobs.length);
}

/**
 * キューが残っていればアラームを張り直し、空なら外す。
 * 張り直すたびに発火が先送りされるので、処理が進んでいる間は発火せず、止まったときだけ発火する。
 */
async function syncQueueAlarm(queuedCount: number): Promise<void> {
  if (queuedCount === 0) {
    await chrome.alarms.clear(UNBOOKMARK_ALARM);
    return;
  }
  await chrome.alarms.create(UNBOOKMARK_ALARM, {
    delayInMinutes: UNBOOKMARK_ALARM_PERIOD_MINUTES,
    periodInMinutes: UNBOOKMARK_ALARM_PERIOD_MINUTES
  });
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

/** 成否にかかわらず最新のフォルダ一覧を添えて返す */
async function folderMutationResult(error?: string): Promise<FolderMutationResult> {
  const { folders } = await listFolders();
  return error ? { ok: false, error, folders } : { ok: true, folders };
}

async function addFolder(rawName: string): Promise<FolderMutationResult> {
  const name = sanitizeFolderName(rawName);
  if (!name) return folderMutationResult('フォルダ名を入力してください');

  await ensureFolders();
  if (await db.folders.get(name)) return folderMutationResult('同じ名前のフォルダがあります');

  await db.folders.add({ name });
  return folderMutationResult();
}

async function deleteFolder(rawName: string): Promise<FolderMutationResult> {
  const name = sanitizeFolderName(rawName);
  if (!name || name === DEFAULT_FOLDER) return folderMutationResult('このフォルダは削除できません');

  await db.bookmarks.where('folder').equals(name).modify({ folder: DEFAULT_FOLDER });
  await db.folders.delete(name);
  return folderMutationResult();
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
  await unbookmarkQueue.clear();
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
  if (url) await unbookmarkQueue.enqueue(url, UNBOOKMARK_DELAY_MS);
}

async function cancelQueuedUnbookmark(tweetUrl: string): Promise<void> {
  await queueReady;
  const url = sanitizeStatusUrl(tweetUrl) ?? tweetUrl;
  await unbookmarkQueue.cancel([url, tweetUrl]);
  await removeUnbookmarkFailure(url);
}

/** 解除できたら true。タブを開けない・タイムアウト・content からの失敗報告は false */
function runOneUnbookmark(tweetUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    void (async () => {
      try {
        await setPendingUnbookmark(tweetUrl);
        await setInflight({ url: tweetUrl });
      } catch (error) {
        // ここで止まるとキュー全体が進まなくなるので、失敗として扱って再試行に回す
        console.error(error);
        resolve(false);
        return;
      }

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

const unbookmarkQueue = new UnbookmarkQueue({
  run: runOneUnbookmark,
  persist: persistUnbookmarkQueue,
  giveUp: recordUnbookmarkFailure,
  maxAttempts: MAX_UNBOOKMARK_ATTEMPTS,
  retryDelayMs: UNBOOKMARK_RETRY_DELAY_MS
});

async function restoreUnbookmarkQueue(): Promise<void> {
  try {
    await closeInflightTab();
    const stored = await chrome.storage.local.get(UNBOOKMARK_STORAGE_KEY);
    unbookmarkQueue.load(stored[UNBOOKMARK_STORAGE_KEY]);
    // 前回の Service Worker が張ったアラームを、復元したキューの状態に合わせる
    await syncQueueAlarm(unbookmarkQueue.size);
  } catch (error) {
    console.error(error);
  }
}

// Service Worker 起動直後に届いたメッセージが、復元前の空キューを上書きしないよう待ち合わせる
const queueReady = restoreUnbookmarkQueue();

function resumeUnbookmarkQueue(): void {
  void queueReady.then(() => unbookmarkQueue.process());
}

// どのイベントで起きても、まずキューの続きを始める（実行中なら process は何もしない）
resumeUnbookmarkQueue();

// 以下の 2 つは Service Worker を起こすためのきっかけ。リスナーはトップレベルで同期的に登録する必要がある
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UNBOOKMARK_ALARM) resumeUnbookmarkQueue();
});
// アラームはブラウザの再起動で消えることがあるので、起動時にも再開する
chrome.runtime.onStartup.addListener(resumeUnbookmarkQueue);

chrome.action.onClicked.addListener(() => {
  void openDashboard();
});

type Sender = chrome.runtime.MessageSender;

interface Route<A extends ExtensionAction> {
  /** 送信元の確認。通らなければ応答しない */
  allow: (sender: Sender) => boolean;
  handle: (message: RequestOf<A>) => ResponseOf<A> | Promise<ResponseOf<A>>;
}

const fromXOrExtensionPage = (sender: Sender): boolean => isXContentScript(sender) || isExtensionPage(sender);

const stringOr = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);
const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback);

// action ごとの処理。型で全 action を網羅させる
const routes: { [A in ExtensionAction]: Route<A> } = {
  save_posts: { allow: isXContentScript, handle: (m) => savePosts(db, m.posts) },
  // 実際の完了通知は runOneUnbookmark の listener が受け取る。ここでは応答だけ返す
  unbookmark_done: { allow: isXContentScript, handle: () => ({ ok: true }) },
  open_dashboard: {
    allow: fromXOrExtensionPage,
    handle: async () => {
      await openDashboard();
      return { ok: true };
    }
  },
  unbookmark: {
    allow: isExtensionPage,
    handle: async (m) => {
      if (m.tweetUrl) await enqueueUnbookmark(m.tweetUrl);
      return { ok: true };
    }
  },
  cancel_unbookmark: {
    allow: isExtensionPage,
    handle: async (m) => {
      if (m.tweetUrl) await cancelQueuedUnbookmark(m.tweetUrl);
      return { ok: true };
    }
  },
  list_unbookmark_failures: { allow: isExtensionPage, handle: listUnbookmarkFailures },
  retry_unbookmark_failures: { allow: isExtensionPage, handle: retryUnbookmarkFailures },
  export_data: { allow: isExtensionPage, handle: exportData },
  import_data: { allow: isExtensionPage, handle: (m) => importData(m.data) },
  get_unprocessed: {
    allow: isExtensionPage,
    handle: (m) => {
      const excludeIds = Array.isArray(m.excludeIds)
        ? m.excludeIds.filter((id): id is string => typeof id === 'string')
        : [];
      return getUnprocessed(excludeIds, numberOr(m.limit, 1));
    }
  },
  update_bookmark: {
    allow: isExtensionPage,
    handle: async (m) => {
      if (typeof m.id !== 'string' || !m.changes) return { ok: false };
      await db.bookmarks.update(m.id, sanitizeChanges(m.changes));
      return { ok: true };
    }
  },
  get_counts: { allow: isExtensionPage, handle: getCounts },
  list_kept: {
    allow: isExtensionPage,
    handle: (m) =>
      listKept(db, {
        folder: stringOr(m.folder, '') || DEFAULT_FOLDER,
        query: stringOr(m.query, ''),
        offset: numberOr(m.offset, 0),
        limit: numberOr(m.limit, MAX_KEPT_PAGE_LIMIT)
      })
  },
  list_folders: { allow: isExtensionPage, handle: listFolders },
  add_folder: { allow: isExtensionPage, handle: (m) => addFolder(stringOr(m.name, '')) },
  delete_folder: { allow: isExtensionPage, handle: (m) => deleteFolder(stringOr(m.name, '')) },
  clear_bookmarks: { allow: isExtensionPage, handle: clearBookmarks }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionRequest(message)) return;

  const route = routes[message.action] as Route<ExtensionAction>;
  if (!route.allow(sender)) return;

  // 例外でも必ず返信する。返さないと送信側の await が終わらず、ダッシュボードが操作を受け付けなくなる
  void (async (): Promise<ExtensionReply<unknown>> => {
    try {
      return { data: await route.handle(message) };
    } catch (error) {
      console.error(`${message.action} の処理に失敗しました`, error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })().then(sendResponse);
  return true;
});
