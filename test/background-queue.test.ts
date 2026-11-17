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
