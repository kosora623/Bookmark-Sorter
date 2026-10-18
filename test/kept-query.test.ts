import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BookmarkDatabase, type BookmarkPost } from '../src/db';
import { listKept } from '../src/kept-query';

let db: BookmarkDatabase;

function post(id: number, overrides: Partial<BookmarkPost> = {}): BookmarkPost {
  return {
    id: String(id),
    url: `https://x.com/a/status/${id}`,
    author: `user${id} @user${id}`,
    text: `post ${id}`,
    images: [],
    folder: '技術',
    status: 'kept',
    // id が大きいほど新しい
    savedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
    ...overrides
  };
}

beforeEach(async () => {
  db = new BookmarkDatabase();
  await db.bookmarks.bulkAdd([
    ...Array.from({ length: 25 }, (_, i) => post(i + 1)),
    post(101, { folder: '料理', text: 'カレーの作り方' }),
    post(102, { folder: '料理', text: 'Curry recipe' }),
    post(103, { folder: '技術', status: 'unprocessed', text: 'カレー（未整理）' }),
    post(104, { folder: '技術', status: 'discarded' })
  ]);
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe('listKept', () => {
  it('フォルダ内を新しい順にページ分けして返す', async () => {
    const first = await listKept(db, { folder: '技術', query: '', offset: 0, limit: 10 });
    expect(first.total).toBe(25);
    expect(first.posts.map((p) => p.id)).toEqual(['25', '24', '23', '22', '21', '20', '19', '18', '17', '16']);

    const last = await listKept(db, { folder: '技術', query: '', offset: 20, limit: 10 });
    expect(last.total).toBe(25);
    expect(last.posts.map((p) => p.id)).toEqual(['5', '4', '3', '2', '1']);
  });

  it('kept 以外と他フォルダは含めない', async () => {
    const result = await listKept(db, { folder: '料理', query: '', offset: 0, limit: 50 });
    expect(result.posts.map((p) => p.id)).toEqual(['102', '101']);
  });

  it('検索はフォルダをまたぎ、大文字小文字を区別しない', async () => {
    const result = await listKept(db, { folder: '技術', query: '  CURRY ', offset: 0, limit: 50 });
    expect(result.total).toBe(1);
    expect(result.posts.map((p) => p.id)).toEqual(['102']);

    const jp = await listKept(db, { folder: '技術', query: 'カレー', offset: 0, limit: 50 });
    // 未整理の 103 は出さない
    expect(jp.posts.map((p) => p.id)).toEqual(['101']);
  });

  it('検索結果もページ分けできる', async () => {
    const page = await listKept(db, { folder: '', query: 'post', offset: 5, limit: 3 });
    expect(page.total).toBe(25);
    expect(page.posts.map((p) => p.id)).toEqual(['20', '19', '18']);
  });

  it('不正な offset / limit は丸める', async () => {
    const result = await listKept(db, { folder: '技術', query: '', offset: -5, limit: 0 });
    expect(result.posts.map((p) => p.id)).toEqual(['25']);
  });
});
