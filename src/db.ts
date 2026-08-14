import { Dexie, type Table } from 'dexie';
import { DEFAULT_FOLDER } from './constants';

export { DEFAULT_FOLDER };

export interface BookmarkPost {
  id: string;
  url: string;
  author: string;
  text: string;
  images: string[];
  folder: string;
  status: 'unprocessed' | 'kept' | 'discarded';
  savedAt: string;
  linkCard?: {
    url: string;
    title?: string;
    domain?: string;
    image?: string;
  };
}

export interface FolderRecord {
  name: string;
}

export class BookmarkDatabase extends Dexie {
  bookmarks!: Table<BookmarkPost, string>;
  folders!: Table<FolderRecord, string>;

  constructor() {
    super('XBookmarkDB');
    this.version(1).stores({
      bookmarks: 'id, folder, *tags, status, savedAt'
    });
    this.version(2).stores({
      bookmarks: 'id, folder, *tags, status, savedAt',
      folders: 'name'
    });
    this.version(3)
      .stores({
        bookmarks: 'id, folder, status, savedAt',
        folders: 'name'
      })
      .upgrade(async (tx) => {
        await tx
          .table('bookmarks')
          .toCollection()
          .modify((post: BookmarkPost & { tags?: unknown }) => {
            delete post.tags;
          });
      });
    this.version(4).stores({
      bookmarks: 'id, folder, status, savedAt, [status+savedAt]',
      folders: 'name'
    });
  }
}

export const db = new BookmarkDatabase();
