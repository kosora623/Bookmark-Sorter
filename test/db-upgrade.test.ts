import 'fake-indexeddb/auto';
import { Dexie } from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { BookmarkDatabase } from '../src/db';

const DB_NAME = 'XBookmarkDB';

afterEach(async () => {
  await Dexie.delete(DB_NAME);
});

describe('DB v7 への移行', () => {
  it('保存済みの画像 URL を name=large に書き換える', async () => {
    // v6 の状態を作る
    const old = new Dexie(DB_NAME);
    old.version(6).stores({
      bookmarks: 'id, folder, status, savedAt, [status+savedAt], [status+folder], [status+folder+savedAt]',
      folders: 'name'
    });
    await old.table('bookmarks').add({
      id: '1',
      url: 'https://x.com/a/status/1',
      author: 'a',
      text: '',
      images: [
        'https://pbs.twimg.com/media/A?format=jpg&name=small',
        'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg'
      ],
      folder: '未分類',
      status: 'kept',
      savedAt: '2026-01-01T00:00:00.000Z'
    });
    old.close();

    const db = new BookmarkDatabase();
    const post = await db.bookmarks.get('1');
    expect(post?.images).toEqual([
      'https://pbs.twimg.com/media/A?format=jpg&name=large',
      'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg'
    ]);
    db.close();
  });
});
