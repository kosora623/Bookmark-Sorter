// @vitest-environment jsdom
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { BookmarkPost } from '../src/db';
import type { ExtensionRequest, FolderInfo } from '../src/messages';
import { installInnerText } from './helpers/inner-text';

// 本物の index.html と、メモリ上で動く偽の background でダッシュボード全体を起動し、
// 画面をまたぐ配線（イベント登録・状態の受け渡し）が切れていないことを確かめる。

const DEFAULT_FOLDER = '未分類';

function post(id: string): BookmarkPost {
  return {
    id,
    url: `https://x.com/a/status/${id}`,
    author: `User${id} @user${id}`,
    text: `post ${id}`,
    images: [],
    folder: DEFAULT_FOLDER,
    status: 'unprocessed',
    // id が大きいほど新しい
    savedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id))).toISOString()
  };
}

const posts = new Map<string, BookmarkPost>(['1', '2', '3'].map((id) => [id, post(id)]));
const folderNames = [DEFAULT_FOLDER, '技術'];
const sent: ExtensionRequest[] = [];

function folderInfos(): FolderInfo[] {
  return folderNames.map((name) => ({
    name,
    count: [...posts.values()].filter((p) => p.status === 'kept' && p.folder === name).length,
    locked: name === DEFAULT_FOLDER
  }));
}

/** background の代わり。ダッシュボードが使う action だけ実装する */
function fakeBackground(message: ExtensionRequest): unknown {
  sent.push(message);
  const newestFirst = (list: BookmarkPost[]): BookmarkPost[] =>
    [...list].sort((a, b) => b.savedAt.localeCompare(a.savedAt));

  switch (message.action) {
    case 'list_folders':
      return { folders: folderInfos() };
    case 'get_unprocessed': {
      const exclude = new Set(message.excludeIds ?? []);
      const list = newestFirst([...posts.values()].filter((p) => p.status === 'unprocessed' && !exclude.has(p.id)));
      return { posts: list.slice(0, message.limit ?? 1).map((p) => structuredClone(p)) };
    }
    case 'get_counts': {
      const all = [...posts.values()];
      return {
        unprocessed: all.filter((p) => p.status === 'unprocessed').length,
        kept: all.filter((p) => p.status === 'kept').length
      };
    }
    case 'update_bookmark': {
      const stored = posts.get(message.id);
      if (stored) Object.assign(stored, message.changes);
      return { ok: true };
    }
    case 'list_kept': {
      const list = newestFirst(
        [...posts.values()].filter((p) => p.status === 'kept' && p.folder === (message.folder || DEFAULT_FOLDER))
      );
      return { posts: list.map((p) => structuredClone(p)), total: list.length };
    }
    case 'list_unbookmark_failures':
      return { failures: [] };
    case 'unbookmark':
    case 'cancel_unbookmark':
      return { ok: true };
    case 'add_folder': {
      const name = message.name.trim();
      if (!name) return { ok: false, error: 'フォルダ名を入力してください', folders: folderInfos() };
      if (folderNames.includes(name)) return { ok: false, error: '同じ名前のフォルダがあります', folders: folderInfos() };
      folderNames.push(name);
      return { ok: true, folders: folderInfos() };
    }
    case 'delete_folder': {
      folderNames.splice(folderNames.indexOf(message.name), 1);
      for (const p of posts.values()) if (p.folder === message.name) p.folder = DEFAULT_FOLDER;
      return { ok: true, folders: folderInfos() };
    }
    case 'move_bookmarks': {
      let moved = 0;
      for (const id of message.ids) {
        const stored = posts.get(id);
        if (stored && folderNames.includes(message.folder)) {
          stored.folder = message.folder;
          moved++;
        }
      }
      return { ok: moved > 0, moved, folders: folderInfos() };
    }
    case 'rename_folder': {
      const newName = message.newName.trim();
      if (folderNames.includes(newName)) return { ok: false, error: '同じ名前のフォルダがあります', folders: folderInfos() };
      folderNames[folderNames.indexOf(message.name)] = newName;
      for (const p of posts.values()) if (p.folder === message.name) p.folder = newName;
      return { ok: true, folders: folderInfos() };
    }
    case 'discard_bookmarks': {
      let discarded = 0;
      for (const id of message.ids) {
        const stored = posts.get(id);
        if (stored?.status === 'kept') {
          stored.status = 'discarded';
          discarded++;
        }
      }
      return { discarded, folders: folderInfos() };
    }
    case 'restore_bookmarks': {
      let restored = 0;
      for (const id of message.ids) {
        const stored = posts.get(id);
        if (stored?.status === 'discarded') {
          stored.status = 'kept';
          restored++;
        }
      }
      return { restored, unbookmarked: 0, folders: folderInfos() };
    }
    case 'reorder_folders': {
      const next = message.names.filter((name) => folderNames.includes(name));
      folderNames.splice(0, folderNames.length, ...next, ...folderNames.filter((name) => !next.includes(name)));
      return { ok: true, folders: folderInfos() };
    }
    default:
      throw new Error(`テストで用意していない action: ${message.action}`);
  }
}

function lastSent<A extends ExtensionRequest['action']>(action: A): Extract<ExtensionRequest, { action: A }> | undefined {
  return sent.filter((m): m is Extract<ExtensionRequest, { action: A }> => m.action === action).at(-1);
}

function press(key: string): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function toastTexts(): string[] {
  return [...document.querySelectorAll('.toast')].map((t) => t.textContent ?? '');
}

function folderItems(): string[] {
  return [...document.querySelectorAll<HTMLElement>('#folder-list .folder-item')].map((el) => el.dataset.folder ?? '');
}

function cardText(): string {
  return document.getElementById('card-text')?.textContent ?? '';
}

beforeAll(async () => {
  installInnerText();

  const html = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');

  const storage: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      sendMessage: async (message: ExtensionRequest) => {
        try {
          return { data: fakeBackground(message) };
        } catch (error) {
          return { error: String(error) };
        }
      }
    },
    storage: {
      local: {
        get: async (key: string) => (key in storage ? { [key]: storage[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.assign(storage, items);
        }
      }
    },
    tabs: { create: vi.fn(async () => ({})) }
  });

  await import('../src/dashboard');
  await vi.waitFor(() => expect(cardText()).toBe('post 3'));
});

describe('ダッシュボード', () => {
  it('起動すると新しい順に未整理のポストと件数を出す', () => {
    expect(document.getElementById('card-author')?.textContent).toContain('User3');
    expect(document.getElementById('remaining-count')?.textContent).toBe('3');
  });

  it('数字キーでそのフォルダに保存して次へ進む', async () => {
    press('2');
    await vi.waitFor(() => expect(cardText()).toBe('post 2'));
    expect(lastSent('update_bookmark')).toEqual({
      action: 'update_bookmark',
      id: '3',
      changes: { folder: '技術', status: 'kept' }
    });
    await vi.waitFor(() => expect(document.getElementById('kept-count')?.textContent).toBe('1'));
  });

  it('z で取り消すと、元のフォルダの未整理に戻して表示する', async () => {
    press('z');
    await vi.waitFor(() => expect(cardText()).toBe('post 3'));
    expect(lastSent('update_bookmark')).toEqual({
      action: 'update_bookmark',
      id: '3',
      changes: { status: 'unprocessed', folder: DEFAULT_FOLDER }
    });
  });

  it('← の 1 回で削除し、ブックマーク解除を予約する', async () => {
    press('ArrowLeft');
    await vi.waitFor(() => expect(cardText()).toBe('post 2'));
    expect(lastSent('update_bookmark')?.changes).toEqual({ status: 'discarded' });
    expect(lastSent('unbookmark')).toEqual({ action: 'unbookmark', tweetUrl: 'https://x.com/a/status/3' });
    expect(document.querySelector('.after-actions')?.classList.contains('counting')).toBe(true);
  });

  it('棚のフォルダをクリックすると、そのフォルダに保存して次へ進む', async () => {
    const slot = document.querySelector<HTMLElement>('#folder-rack .slot[data-folder="技術"]');
    slot?.click();
    await vi.waitFor(() => expect(cardText()).toBe('post 1'));
    expect(lastSent('update_bookmark')).toEqual({
      action: 'update_bookmark',
      id: '2',
      changes: { folder: '技術', status: 'kept' }
    });
    press('z');
    await vi.waitFor(() => expect(cardText()).toBe('post 2'));
  });

  it('破棄を取り消すと、解除の予約も取り消す', async () => {
    press('z');
    await vi.waitFor(() => expect(cardText()).toBe('post 3'));
    expect(lastSent('cancel_unbookmark')).toEqual({
      action: 'cancel_unbookmark',
      tweetUrl: 'https://x.com/a/status/3'
    });
  });

  it('保存済みタブに切り替えると、フォルダ一覧と保存済みを読み込む', async () => {
    // 1 件残しておく
    press('2');
    await vi.waitFor(() => expect(cardText()).toBe('post 2'));

    document.getElementById('tab-kept')?.click();
    expect(document.getElementById('kept-view')?.hidden).toBe(false);
    expect(document.getElementById('sort-view')?.hidden).toBe(true);

    await vi.waitFor(() => expect(document.querySelectorAll('#folder-list .folder-item')).toHaveLength(2));
    expect(lastSent('list_kept')).toMatchObject({ folder: DEFAULT_FOLDER, query: '', offset: 0 });

    // 選別のキー操作は保存済みタブでは効かない
    const before = sent.length;
    press('1');
    expect(sent.length).toBe(before);
  });

  it('フォルダを選ぶと、そのフォルダの保存済みを出す', async () => {
    const item = [...document.querySelectorAll<HTMLElement>('#folder-list .folder-item')].find(
      (el) => el.dataset.folder === '技術'
    );
    item?.click();

    await vi.waitFor(() => expect(document.querySelectorAll('#kept-list .kept-row')).toHaveLength(1));
    expect(lastSent('list_kept')).toMatchObject({ folder: '技術' });
    expect(document.getElementById('kept-heading')?.textContent).toBe('技術');
  });

  it('同じ名前のフォルダは追加できず、理由をトーストで知らせる', async () => {
    const input = document.getElementById('add-folder-input') as HTMLInputElement;
    input.value = '技術';
    document.getElementById('add-folder-form')?.dispatchEvent(new Event('submit', { cancelable: true }));

    await vi.waitFor(() => expect(toastTexts()).toContain('同じ名前のフォルダがあります'));
    expect(document.querySelector('.toast-error')).not.toBeNull();
    expect(folderItems()).toEqual([DEFAULT_FOLDER, '技術']);
  });

  it('フォルダを追加すると一覧に出て、そのフォルダを開く', async () => {
    const input = document.getElementById('add-folder-input') as HTMLInputElement;
    input.value = '料理';
    document.getElementById('add-folder-form')?.dispatchEvent(new Event('submit', { cancelable: true }));

    await vi.waitFor(() => expect(folderItems()).toEqual([DEFAULT_FOLDER, '技術', '料理']));
    expect(input.value).toBe('');
    await vi.waitFor(() => expect(lastSent('list_kept')).toMatchObject({ folder: '料理' }));
  });

  it('フォルダの削除は確認ダイアログを挟み、キャンセルなら何もしない', async () => {
    const deleteButton = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('#folder-list [data-action="delete-folder"][data-folder="料理"]');

    deleteButton()?.click();
    await vi.waitFor(() => expect(document.querySelector('.modal')).not.toBeNull());
    expect(document.querySelector('.modal')?.textContent).toContain('フォルダ「料理」を削除します');
    document.querySelector<HTMLButtonElement>('.modal button[data-role="cancel"]')?.click();
    await vi.waitFor(() => expect(document.querySelector('.modal')).toBeNull());
    expect(lastSent('delete_folder')).toBeUndefined();

    deleteButton()?.click();
    await vi.waitFor(() => expect(document.querySelector('.modal')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('.modal button[data-role="confirm"]')?.click();

    await vi.waitFor(() => expect(folderItems()).toEqual([DEFAULT_FOLDER, '技術']));
    expect(lastSent('delete_folder')).toEqual({ action: 'delete_folder', name: '料理' });
  });

  it('チェックを入れたポストを、帯の操作で別のフォルダへまとめて移す', async () => {
    [...document.querySelectorAll<HTMLElement>('#folder-list .folder-item')].find((el) => el.dataset.folder === '技術')?.click();
    await vi.waitFor(() => expect(document.querySelectorAll('#kept-list .kept-row').length).toBeGreaterThan(0));
    const bar = document.getElementById('kept-selection') as HTMLFormElement;
    expect(bar.hidden).toBe(true);

    const row = document.querySelector<HTMLElement>('#kept-list .kept-row');
    const id = row?.dataset.id;
    row?.querySelector<HTMLInputElement>('.kept-check')?.click();
    expect(bar.hidden).toBe(false);
    expect(document.getElementById('kept-selection-count')?.textContent).toBe('1件を選択中');
    // 開いているフォルダ以外が移動先に選ばれている
    expect((document.getElementById('kept-move-target') as HTMLSelectElement).value).toBe(DEFAULT_FOLDER);

    bar.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(lastSent('move_bookmarks')).toEqual({ action: 'move_bookmarks', ids: [id], folder: DEFAULT_FOLDER }));
    await vi.waitFor(() => expect(document.querySelector(`#kept-list .kept-row[data-id="${id}"]`)).toBeNull());
    expect(bar.hidden).toBe(true);
    expect(toastTexts().some((text) => text.includes(`「${DEFAULT_FOLDER}」に移動しました`))).toBe(true);
  });

  it('Alt+↓ でフォルダを 1 つ下へ並べ替える', async () => {
    const item = document.querySelector<HTMLElement>(`#folder-list .folder-item[data-folder="${DEFAULT_FOLDER}"]`);
    item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));

    await vi.waitFor(() => expect(folderItems()).toEqual(['技術', DEFAULT_FOLDER]));
    expect(lastSent('reorder_folders')).toEqual({ action: 'reorder_folders', names: ['技術', DEFAULT_FOLDER] });
    // 選別画面の棚（数字キーの順）も同じ並びになる
    const slots = [...document.querySelectorAll<HTMLElement>('#folder-rack .slot')].map((el) => el.dataset.folder);
    expect(slots).toEqual(['技術', DEFAULT_FOLDER]);
  });

  it('鉛筆ボタンでフォルダ名をその場で変え、Enter で確定する', async () => {
    document.querySelector<HTMLElement>('#folder-list [data-action="rename-folder"][data-folder="技術"]')?.click();
    const input = document.querySelector<HTMLInputElement>('#folder-list .folder-rename-input');
    expect(input?.value).toBe('技術');

    input!.value = '開発';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(folderItems()).toEqual(['開発', DEFAULT_FOLDER]));
    expect(lastSent('rename_folder')).toEqual({ action: 'rename_folder', name: '技術', newName: '開発' });
    expect(document.querySelector('#folder-list .folder-rename-input')).toBeNull();
  });

  it('Esc なら名前を変えずに戻す', () => {
    const before = sent.length;
    document.querySelector<HTMLElement>('#folder-list [data-action="rename-folder"][data-folder="開発"]')?.click();
    const input = document.querySelector<HTMLInputElement>('#folder-list .folder-rename-input');
    input!.value = 'xxx';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(folderItems()).toEqual(['開発', DEFAULT_FOLDER]);
    expect(sent.slice(before).some((m) => m.action === 'rename_folder')).toBe(false);
  });

  it('選んだポストを確認のうえまとめて削除し、トーストから取り消せる', async () => {
    document.querySelector<HTMLElement>(`#folder-list .folder-item[data-folder="${DEFAULT_FOLDER}"]`)?.click();
    await vi.waitFor(() => expect(document.querySelectorAll('#kept-list .kept-row').length).toBeGreaterThan(0));
    const ids = [...document.querySelectorAll<HTMLElement>('#kept-list .kept-row')].map((row) => row.dataset.id);

    document.querySelector<HTMLInputElement>('#kept-list .kept-check')?.click();
    document.getElementById('kept-select-all')?.click();
    document.getElementById('kept-discard')?.click();
    await vi.waitFor(() => expect(document.querySelector('.modal')).not.toBeNull());
    expect(document.querySelector('.modal')?.textContent).toContain(`${ids.length}件を削除し`);
    document.querySelector<HTMLButtonElement>('.modal button[data-role="confirm"]')?.click();

    await vi.waitFor(() => expect(lastSent('discard_bookmarks')).toEqual({ action: 'discard_bookmarks', ids }));
    await vi.waitFor(() => expect(document.querySelectorAll('#kept-list .kept-row')).toHaveLength(0));

    const undo = [...document.querySelectorAll<HTMLButtonElement>('.toast-action')].at(-1);
    expect(undo?.textContent).toBe('取り消す');
    undo?.click();
    await vi.waitFor(() => expect(lastSent('restore_bookmarks')).toEqual({ action: 'restore_bookmarks', ids }));
    await vi.waitFor(() => expect(document.querySelectorAll('#kept-list .kept-row')).toHaveLength(ids.length));
  });
});
