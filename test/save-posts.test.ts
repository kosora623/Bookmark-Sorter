import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BookmarkDatabase, type BookmarkPost } from '../src/db';
import { enrichmentFor, savePosts } from '../src/save-posts';

function post(id: string, overrides: Partial<BookmarkPost> = {}): BookmarkPost {
  return {
    id,
    url: `https://x.com/a/status/${id}`,
    author: 'A @a',
    text: `post ${id}`,
    images: [],
    folder: '未分類',
    status: 'unprocessed',
    savedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('enrichmentFor', () => {
  it('保存済みに無い項目だけ返す', () => {
    const card = { url: 'https://example.com/' };
    expect(
      enrichmentFor(post('1'), post('1', { linkCard: card, postedAt: '2025-01-01T00:00:00.000Z' }))
    ).toEqual({ linkCard: card, postedAt: '2025-01-01T00:00:00.000Z' });
  });

  it('動画ありを新たに知ったら、サムネイル入りの images に差し替える', () => {
    const thumb = 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg';
    expect(enrichmentFor(post('1'), post('1', { hasVideo: true, images: [thumb] }))).toEqual({
      hasVideo: true,
      images: [thumb]
    });
  });

  it('すでにある項目は上書きせず、補うものが無ければ undefined', () => {
    const stored = post('1', {
      linkCard: { url: 'https://old.example/' },
      postedAt: '2024-01-01T00:00:00.000Z',
      hasVideo: true
    });
    const incoming = post('1', {
      linkCard: { url: 'https://new.example/' },
      postedAt: '2025-01-01T00:00:00.000Z',
      hasVideo: true,
      images: ['https://pbs.twimg.com/media/X']
    });
    expect(enrichmentFor(stored, incoming)).toBeUndefined();
  });
});

describe('savePosts', () => {
  let db: BookmarkDatabase;

  beforeEach(() => {
    db = new BookmarkDatabase();
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('新しいポストだけ追加し、その件数を返す', async () => {
    await db.bookmarks.add(post('1'));
    const result = await savePosts(db, [post('1'), post('2'), post('3')]);
    expect(result).toEqual({ savedCount: 2 });
    expect(await db.bookmarks.count()).toBe(3);
  });

  it('既存のポストは整理結果を保ったまま、足りない項目だけ補う', async () => {
    await db.bookmarks.add(post('1', { status: 'kept', folder: '技術', text: '元の本文' }));
    await savePosts(db, [
      post('1', { status: 'unprocessed', folder: '未分類', text: '新しい本文', postedAt: '2025-01-01T00:00:00.000Z' })
    ]);

    const stored = await db.bookmarks.get('1');
    expect(stored).toMatchObject({ status: 'kept', folder: '技術', text: '元の本文', postedAt: '2025-01-01T00:00:00.000Z' });
  });

  it('不正なものと X 以外の URL は保存しない', async () => {
    const result = await savePosts(db, [
      post('1', { url: 'https://example.com/a/status/1' }),
      { id: 'abc' },
      null,
      post('2')
    ]);
    expect(result).toEqual({ savedCount: 1 });
    expect((await db.bookmarks.toArray()).map((p) => p.id)).toEqual(['2']);
  });

  it('同じ ID が複数あれば後のものを使う', async () => {
    await savePosts(db, [post('1', { text: '先' }), post('1', { text: '後' })]);
    expect((await db.bookmarks.get('1'))?.text).toBe('後');
  });

  it('配列でなければ何もしない', async () => {
    expect(await savePosts(db, 'broken')).toEqual({ savedCount: 0 });
  });
});
