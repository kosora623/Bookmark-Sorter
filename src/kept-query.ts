import type { BookmarkDatabase, BookmarkPost } from './db';
import { matchesQuery, normalizeQuery } from './normalize';

export const MAX_KEPT_PAGE_LIMIT = 200;

export interface KeptQuery {
  folder: string;
  query: string;
  offset: number;
  limit: number;
}

/**
 * 保存済みを新しい順に 1 ページ分返す。query があれば全フォルダから検索、なければ folder の中だけ。
 * total は条件に合う全件数（「さらに表示」の残り件数に使う）。
 */
export async function listKept(
  db: BookmarkDatabase,
  options: KeptQuery
): Promise<{ posts: BookmarkPost[]; total: number }> {
  const offset = Math.max(0, Math.floor(options.offset) || 0);
  const limit = Math.min(MAX_KEPT_PAGE_LIMIT, Math.max(1, Math.floor(options.limit) || 1));
  const query = normalizeQuery(options.query);

  const collection = query
    ? db.bookmarks
        .where('[status+savedAt]')
        .between(['kept', ''], ['kept', '￿'], true, true)
        .reverse()
        .filter((post) => matchesQuery(post, query))
    : db.bookmarks
        .where('[status+folder+savedAt]')
        .between(['kept', options.folder, ''], ['kept', options.folder, '￿'], true, true)
        .reverse();

  const [total, posts] = await Promise.all([
    collection.clone().count(),
    collection.clone().offset(offset).limit(limit).toArray()
  ]);
  return { posts, total };
}
