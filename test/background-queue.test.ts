import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// background.ts は import した時点でリスナー登録とキューの復元を始めるので、
// 必要な chrome.* だけを持つ偽物を用意してから、テストごとに読み込み直す。

type Listener = (...args: never[]) => unknown;

function createEvent() {
  const listeners: Listener[] = [];
  return {
    listeners,
    addListener: vi.fn((fn: Listener) => listeners.push(fn)),
    removeListener: vi.fn((fn: Listener) => {
      const index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    })
  };
}

function createStorageArea(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    })
  };
}

function createFakeChrome(localInitial: Record<string, unknown> = {}) {
  let nextTabId = 100;
  const alarms = new Map<string, unknown>();
  return {
    alarms: {
      byName: alarms,
      create: vi.fn(async (name: string, info: unknown) => {
        alarms.set(name, info);
      }),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      onAlarm: createEvent()
    },
    storage: {
      local: createStorageArea(localInitial),
      session: createStorageArea()
    },
    runtime: {
      lastError: undefined,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: createEvent(),
      onStartup: createEvent()
    },
    tabs: {
      create: vi.fn((props: { url: string }, callback?: (tab: { id: number; url: string }) => void) => {
        const tab = { id: nextTabId++, url: props.url };
        callback?.(tab);
        return Promise.resolve(tab);
      }),
      remove: vi.fn((_tabId: number, callback?: () => void) => callback?.()),
      query: vi.fn(async () => []),
      update: vi.fn(async () => ({}))
    },
    windows: { update: vi.fn(async () => ({})) },
    action: { onClicked: createEvent() }
  };
}

type FakeChrome = ReturnType<typeof createFakeChrome>;

const TWEET_URL = 'https://x.com/jack/status/20';
const ALARM = 'unbookmark-queue';

let fake: FakeChrome;

async function loadBackground(localInitial: Record<string, unknown> = {}): Promise<void> {
  fake = createFakeChrome(localInitial);
  vi.stubGlobal('chrome', fake);
  vi.resetModules();
  await import('../src/background');
}

/** 解除用に開いたタブの content script が「解除できた」と知らせる */
function reportUnbookmarkDone(tabId: number): void {
  const sender = { tab: { id: tabId, url: TWEET_URL }, url: TWEET_URL };
  for (const listener of [...fake.runtime.onMessage.listeners]) {
    (listener as (m: unknown, s: unknown, r: (v: unknown) => void) => unknown)(
      { action: 'unbookmark_done', ok: true },
      sender,
      () => {}
    );
  }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('解除キューの再開', () => {
  it('起こすためのリスナーを読み込み時に同期的に登録する', async () => {
    await loadBackground();
    expect(fake.alarms.onAlarm.addListener).toHaveBeenCalledTimes(1);
    expect(fake.runtime.onStartup.addListener).toHaveBeenCalledTimes(1);
  });

  it('保存済みのキューを復元してアラームを張り、解除を始める', async () => {
    await loadBackground({ unbookmarkQueue: [{ url: TWEET_URL, earliest: 0 }] });

    await vi.waitFor(() => expect(fake.tabs.create).toHaveBeenCalled());
    expect(fake.tabs.create.mock.calls[0]?.[0]).toMatchObject({ url: TWEET_URL, active: false });
    expect(fake.alarms.byName.has(ALARM)).toBe(true);
  });

  it('解除が終わってキューが空になったらアラームを外す', async () => {
    await loadBackground({ unbookmarkQueue: [{ url: TWEET_URL, earliest: 0 }] });
    await vi.waitFor(() => expect(fake.tabs.create).toHaveBeenCalled());

    const tab = await fake.tabs.create.mock.results[0]?.value;
    reportUnbookmarkDone(tab.id);

    await vi.waitFor(() => expect(fake.storage.local.data.unbookmarkQueue).toEqual([]));
    expect(fake.alarms.byName.has(ALARM)).toBe(false);
    expect(fake.tabs.remove).toHaveBeenCalledWith(tab.id, expect.any(Function));
  });

  it('キューが空なら、前回のアラームが残っていても外す', async () => {
    await loadBackground({ unbookmarkQueue: [] });
    await vi.waitFor(() => expect(fake.alarms.clear).toHaveBeenCalledWith(ALARM));
    expect(fake.tabs.create).not.toHaveBeenCalled();
  });

  it('アラームやブラウザ起動で呼ばれても、実行中の解除を重複して始めない', async () => {
    await loadBackground({ unbookmarkQueue: [{ url: TWEET_URL, earliest: 0 }] });
    await vi.waitFor(() => expect(fake.tabs.create).toHaveBeenCalledTimes(1));

    for (const listener of fake.alarms.onAlarm.listeners) {
      (listener as (alarm: { name: string }) => void)({ name: ALARM });
    }
    for (const listener of fake.runtime.onStartup.listeners) {
      (listener as () => void)();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fake.tabs.create).toHaveBeenCalledTimes(1);
  });
});

/** background にメッセージを送り、返信の中身を受け取る */
function send(message: unknown, sender: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    for (const listener of [...fake.runtime.onMessage.listeners]) {
      (listener as (m: unknown, s: unknown, r: (v: unknown) => void) => unknown)(message, sender, (reply) =>
        resolve((reply as { data?: unknown }).data)
      );
    }
  });
}

const DASHBOARD = { url: 'chrome-extension://test/index.html' };

describe('解除用タブの判定', () => {
  it('解除のために開いたタブにだけ「解除する」と答える', async () => {
    await loadBackground({ unbookmarkQueue: [{ url: TWEET_URL, earliest: 0 }] });
    await vi.waitFor(() => expect(fake.tabs.create).toHaveBeenCalled());
    const tab = await fake.tabs.create.mock.results[0]?.value;

    const ask = (tabId: number, statusId: string) =>
      send({ action: 'get_unbookmark_task', statusId }, { tab: { id: tabId, url: TWEET_URL }, url: TWEET_URL });

    expect(await ask(tab.id, '20')).toEqual({ pending: true });
    // 利用者が自分で開いた同じポストのタブ
    expect(await ask(tab.id + 1, '20')).toEqual({ pending: false });
    // 同じタブでも別のポストに移っていたら解除しない
    expect(await ask(tab.id, '21')).toEqual({ pending: false });

    reportUnbookmarkDone(tab.id);
    await vi.waitFor(() => expect(fake.storage.local.data.unbookmarkQueue).toEqual([]));
    expect(await ask(tab.id, '20')).toEqual({ pending: false });
  });
});

describe('フォルダの並べ替えとまとめて移動', () => {
  type Folders = { folders: { name: string }[] };
  const names = (result: unknown) => (result as Folders).folders.map((folder) => folder.name);

  it('指定した順に並べ、新しいフォルダは末尾に足す', async () => {
    await loadBackground();
    await send({ action: 'clear_bookmarks' }, DASHBOARD);
    await send({ action: 'add_folder', name: 'い' }, DASHBOARD);
    await send({ action: 'add_folder', name: 'あ' }, DASHBOARD);
    expect(names(await send({ action: 'list_folders' }, DASHBOARD))).toEqual(['未分類', 'い', 'あ']);

    const reordered = await send({ action: 'reorder_folders', names: ['あ', '未分類', '存在しない'] }, DASHBOARD);
    expect(names(reordered)).toEqual(['あ', '未分類', 'い']);

    await send({ action: 'add_folder', name: 'う' }, DASHBOARD);
    expect(names(await send({ action: 'list_folders' }, DASHBOARD))).toEqual(['あ', '未分類', 'い', 'う']);

    const exported = (await send({ action: 'export_data' }, DASHBOARD)) as { folders: string[] };
    expect(exported.folders).toEqual(['あ', '未分類', 'い', 'う']);
  });

  it('選んだポストをまとめて別のフォルダへ移す', async () => {
    await loadBackground();
    await send({ action: 'clear_bookmarks' }, DASHBOARD);
    await send({ action: 'add_folder', name: '技術' }, DASHBOARD);
    const post = (id: string) => ({
      id,
      url: `https://x.com/a/status/${id}`,
      author: 'a',
      text: id,
      images: [],
      folder: '未分類',
      status: 'kept',
      savedAt: '2026-01-01T00:00:00.000Z'
    });
    await send({ action: 'import_data', data: { format: 'x-bookmark-sorter', version: 1, bookmarks: [post('1'), post('2'), post('3')], folders: [] } }, DASHBOARD);

    const result = (await send({ action: 'move_bookmarks', ids: ['1', '3'], folder: '技術' }, DASHBOARD)) as {
      ok: boolean;
      moved: number;
      folders: { name: string; count: number }[];
    };
    expect(result.ok).toBe(true);
    expect(result.moved).toBe(2);
    expect(result.folders.find((folder) => folder.name === '技術')?.count).toBe(2);
    expect(result.folders.find((folder) => folder.name === '未分類')?.count).toBe(1);

    // 無いフォルダへは移さない
    const missing = (await send({ action: 'move_bookmarks', ids: ['2'], folder: 'なし' }, DASHBOARD)) as { ok: boolean };
    expect(missing.ok).toBe(false);
  });
});

describe('フォルダ名の変更とまとめて削除', () => {
  const post = (id: string, folder: string) => ({
    id,
    url: `https://x.com/a/status/${id}`,
    author: 'a',
    text: id,
    images: [],
    folder,
    status: 'kept',
    savedAt: '2026-01-01T00:00:00.000Z'
  });

  async function setup(): Promise<void> {
    await loadBackground();
    await send({ action: 'clear_bookmarks' }, DASHBOARD);
    await send({ action: 'add_folder', name: '技術' }, DASHBOARD);
    await send({ action: 'add_folder', name: '料理' }, DASHBOARD);
    await send(
      {
        action: 'import_data',
        data: { format: 'x-bookmark-sorter', version: 1, bookmarks: [post('1', '技術'), post('2', '技術'), post('3', '料理')], folders: [] }
      },
      DASHBOARD
    );
  }

  type Result = { ok: boolean; error?: string; folders: { name: string; count: number }[] };

  it('名前を変えると、中のポストも付いていき、並び順も変わらない', async () => {
    await setup();
    const result = (await send({ action: 'rename_folder', name: '技術', newName: ' 開発 ' }, DASHBOARD)) as Result;
    expect(result.ok).toBe(true);
    expect(result.folders.map((folder) => [folder.name, folder.count])).toEqual([
      ['未分類', 0],
      ['開発', 2],
      ['料理', 1]
    ]);
  });

  it('同じ名前・未分類・空の名前には変えられない', async () => {
    await setup();
    expect(((await send({ action: 'rename_folder', name: '技術', newName: '料理' }, DASHBOARD)) as Result).error).toBe(
      '同じ名前のフォルダがあります'
    );
    expect(((await send({ action: 'rename_folder', name: '未分類', newName: 'x' }, DASHBOARD)) as Result).ok).toBe(false);
    expect(((await send({ action: 'rename_folder', name: '技術', newName: '  ' }, DASHBOARD)) as Result).ok).toBe(false);
  });

  it('まとめて削除すると解除をまとめて予約し、取り消すと予約ごと戻す', async () => {
    await setup();
    const discarded = (await send({ action: 'discard_bookmarks', ids: ['1', '3', 'nope'] }, DASHBOARD)) as {
      discarded: number;
      folders: { name: string; count: number }[];
    };
    expect(discarded.discarded).toBe(2);
    expect(discarded.folders.find((folder) => folder.name === '技術')?.count).toBe(1);

    const queued = () => (fake.storage.local.data.unbookmarkQueue as { url: string }[]).map((job) => job.url);
    expect(queued()).toEqual(['https://x.com/a/status/1', 'https://x.com/a/status/3']);

    const restored = (await send({ action: 'restore_bookmarks', ids: ['1', '3'] }, DASHBOARD)) as {
      restored: number;
      folders: { name: string; count: number }[];
    };
    expect(restored.restored).toBe(2);
    expect(queued()).toEqual([]);
    expect(restored.folders.find((folder) => folder.name === '料理')?.count).toBe(1);
  });
});

describe('見直しで直した点', () => {
  const kept = (id: string) => ({
    id,
    url: `https://x.com/a/status/${id}`,
    author: 'a',
    text: id,
    images: [],
    folder: '未分類',
    status: 'kept',
    savedAt: '2026-01-01T00:00:00.000Z'
  });
  const names = (result: unknown) => (result as { folders: { name: string }[] }).folders.map((folder) => folder.name);

  it('並び順の無い以前のフォルダがあっても、追加したフォルダは末尾に入る', async () => {
    await loadBackground();
    const { db } = await import('../src/db');
    await db.bookmarks.clear();
    await db.folders.clear();
    await db.folders.bulkAdd([{ name: 'b' }, { name: '未分類' }, { name: 'a' }]);

    const result = await send({ action: 'add_folder', name: '新規' }, DASHBOARD);
    expect(names(result)).toEqual(['未分類', 'a', 'b', '新規']);
  });

  it('削除したポストを update_bookmark で戻すと、予約済みの解除も取り消す', async () => {
    await loadBackground();
    await send({ action: 'clear_bookmarks' }, DASHBOARD);
    await send({ action: 'import_data', data: { format: 'x-bookmark-sorter', version: 1, bookmarks: [kept('1')], folders: [] } }, DASHBOARD);
    await send({ action: 'discard_bookmarks', ids: ['1'] }, DASHBOARD);
    expect(fake.storage.local.data.unbookmarkQueue).toHaveLength(1);

    await send({ action: 'update_bookmark', id: '1', changes: { status: 'unprocessed' } }, DASHBOARD);
    expect(fake.storage.local.data.unbookmarkQueue).toEqual([]);
  });

  it('解除が始まっていたものを戻すと、Twitter では戻せなかった件数を返す', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await loadBackground();
      await send({ action: 'clear_bookmarks' }, DASHBOARD);
      await send(
        { action: 'import_data', data: { format: 'x-bookmark-sorter', version: 1, bookmarks: [kept('1'), kept('2')], folders: [] } },
        DASHBOARD
      );
      await send({ action: 'discard_bookmarks', ids: ['1', '2'] }, DASHBOARD);
      // 待ち時間を過ぎて 1 件目の解除が始まる
      await vi.advanceTimersByTimeAsync(13_000);
      expect(fake.tabs.create).toHaveBeenCalledTimes(1);

      const result = (await send({ action: 'restore_bookmarks', ids: ['1', '2'] }, DASHBOARD)) as {
        restored: number;
        unbookmarked: number;
      };
      expect(result).toMatchObject({ restored: 2, unbookmarked: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('整形前の名前のフォルダ', () => {
  it('前後に空白がある古いフォルダも、名前の変更と削除ができる', async () => {
    await loadBackground();
    const { db } = await import('../src/db');
    await db.bookmarks.clear();
    await db.folders.clear();
    await db.folders.bulkAdd([{ name: '未分類', order: 0 }, { name: ' 古い ', order: 1 }, { name: ' 消す ', order: 2 }]);
    await db.bookmarks.add({
      id: '9',
      url: 'https://x.com/a/status/9',
      author: 'a',
      text: '',
      images: [],
      folder: ' 古い ',
      status: 'kept',
      savedAt: '2026-01-01T00:00:00.000Z'
    });

    const renamed = (await send({ action: 'rename_folder', name: ' 古い ', newName: '新しい' }, DASHBOARD)) as {
      ok: boolean;
      folders: { name: string; count: number }[];
    };
    expect(renamed.ok).toBe(true);
    expect(renamed.folders.find((folder) => folder.name === '新しい')?.count).toBe(1);

    const deleted = (await send({ action: 'delete_folder', name: ' 消す ' }, DASHBOARD)) as { folders: { name: string }[] };
    expect(deleted.folders.map((folder) => folder.name)).toEqual(['未分類', '新しい']);
  });
});
