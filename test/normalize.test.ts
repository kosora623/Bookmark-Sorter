import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLDER } from '../src/constants';
import type { BookmarkPost } from '../src/db';
import {
  isBookmarkPost,
  parseImportData,
  sanitizeChanges,
  sanitizeFolderName,
  toBookmarkPost
} from '../src/normalize';

function post(overrides: Partial<BookmarkPost> = {}): BookmarkPost {
  return {
    id: '100',
    url: 'https://x.com/a/status/100',
    author: 'A @a',
    text: 'hello',
    images: [],
    folder: DEFAULT_FOLDER,
    status: 'unprocessed',
    savedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('isBookmarkPost', () => {
  it('数字だけの id を持つオブジェクトだけ通す', () => {
    expect(isBookmarkPost(post())).toBe(true);
    expect(isBookmarkPost({ id: 'abc' })).toBe(false);
    expect(isBookmarkPost({ id: 100 })).toBe(false);
    expect(isBookmarkPost(null)).toBe(false);
  });
});

describe('toBookmarkPost', () => {
  it('不正な値を既定値に置き換える', () => {
    const raw = {
      id: '100',
      url: 'https://example.com/a/status/100',
      author: 1,
      text: null,
      images: ['https://pbs.twimg.com/media/a.jpg', 'javascript:alert(1)', 3],
      folder: '',
      status: 'bogus',
      savedAt: undefined
    } as unknown as BookmarkPost;

    const result = toBookmarkPost(raw);
    expect(result.url).toBe('');
    expect(result.author).toBe('不明');
    expect(result.text).toBe('');
    expect(result.images).toEqual(['https://pbs.twimg.com/media/a.jpg']);
    expect(result.folder).toBe(DEFAULT_FOLDER);
    expect(result.status).toBe('unprocessed');
    expect(Number.isNaN(Date.parse(result.savedAt))).toBe(false);
  });

  it('postedAt は日付として読めるときだけ残す', () => {
    expect(toBookmarkPost(post({ postedAt: '2025-05-01T12:00:00.000Z' })).postedAt).toBe('2025-05-01T12:00:00.000Z');
    expect(toBookmarkPost(post({ postedAt: 'yesterday' })).postedAt).toBeUndefined();
  });

  it('linkCard は http(s) の URL だけ受け付け、余計なキーを落とす', () => {
    const withCard = toBookmarkPost(
      post({
        linkCard: { url: 'https://example.com', title: 'T', image: 'javascript:x', extra: 1 } as never
      })
    );
    expect(withCard.linkCard).toEqual({ url: 'https://example.com', title: 'T' });

    const badCard = toBookmarkPost(post({ linkCard: { url: 'javascript:x' } }));
    expect(badCard.linkCard).toBeUndefined();
  });

  it('知らないフィールドは捨てる', () => {
    const result = toBookmarkPost({ ...post(), injected: true } as BookmarkPost);
    expect('injected' in result).toBe(false);
  });
});

describe('sanitizeChanges', () => {
  it('folder と正しい status だけ残す', () => {
    expect(sanitizeChanges({ folder: 'A', status: 'kept' })).toEqual({ folder: 'A', status: 'kept' });
    expect(sanitizeChanges({ status: 'bogus' } as never)).toEqual({});
    expect(sanitizeChanges({ folder: 1 } as never)).toEqual({});
  });
});

describe('sanitizeFolderName', () => {
  it('前後の空白を落とし、連続空白をまとめ、40 文字で切る', () => {
    expect(sanitizeFolderName('  a   b  ')).toBe('a b');
    expect(sanitizeFolderName('x'.repeat(50))).toHaveLength(40);
  });
});

describe('parseImportData', () => {
  it('形式が違うものは拒否する', () => {
    expect(parseImportData(null)).toMatchObject({ ok: false });
    expect(parseImportData({ bookmarks: [] })).toMatchObject({ ok: false });
    expect(parseImportData({ format: 'x-bookmark-sorter', bookmarks: 'x' })).toMatchObject({ ok: false });
  });

  it('正しいポストとフォルダだけ取り出し、重複をまとめる', () => {
    const parsed = parseImportData({
      format: 'x-bookmark-sorter',
      version: 1,
      bookmarks: [
        post({ id: '1', url: 'https://x.com/a/status/1', status: 'kept', folder: '技術' }),
        post({ id: '1', url: 'https://x.com/a/status/1', status: 'discarded' }),
        post({ id: '2', url: 'https://example.com/nope' }),
        { id: 'bad' }
      ],
      folders: ['技術', ' 技術 ', '', 3, '料理']
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.posts.map((p) => p.id)).toEqual(['1']);
    // 同じ ID は後勝ち
    expect(parsed.posts[0]?.status).toBe('discarded');
    expect(parsed.folders).toEqual(['技術', '料理']);
  });
});
