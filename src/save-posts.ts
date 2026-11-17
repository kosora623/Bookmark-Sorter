import type { BookmarkDatabase, BookmarkPost } from './db';
import { isBookmarkPost, toBookmarkPost } from './normalize';

/**
 * 保存済みのポストに、新しく読み取った内容から後付けで補う項目を返す。補うものが無ければ undefined。
 * 状態・フォルダ・本文などユーザーが整理した結果や元の内容は上書きしない。
 */
export function enrichmentFor(stored: BookmarkPost, incoming: BookmarkPost): Partial<BookmarkPost> | undefined {
  const changes: Partial<BookmarkPost> = {};
  if (stored.linkCard == null && incoming.linkCard != null) changes.linkCard = incoming.linkCard;
  if (!stored.hasVideo && incoming.hasVideo) {
    // 動画ありを記録する前は、サムネイルが images に入っていなかった
    changes.hasVideo = true;
    changes.images = incoming.images;
  }
  if (stored.postedAt == null && incoming.postedAt != null) changes.postedAt = incoming.postedAt;
  return Object.keys(changes).length > 0 ? changes : undefined;
}

/**
 * content script が読み取ったポストを保存する。新しいものは追加し、既存のものは足りない項目だけ補う。
 * savedCount は新しく追加した件数。
 */
export async function savePosts(db: BookmarkDatabase, posts: unknown): Promise<{ savedCount: number }> {
  if (!Array.isArray(posts)) return { savedCount: 0 };

  const unique = new Map<string, BookmarkPost>();
  for (const post of posts) {
    if (!isBookmarkPost(post)) continue;
    const normalized = toBookmarkPost(post);
    if (!normalized.url) continue;
    unique.set(normalized.id, normalized);
  }

  const candidates = [...unique.values()];
  if (candidates.length === 0) return { savedCount: 0 };

  const existing = await db.bookmarks.bulkGet(candidates.map((post) => post.id));
  const toAdd = candidates.filter((_, index) => existing[index] == null);
  if (toAdd.length > 0) {
    await db.bookmarks.bulkAdd(toAdd);
  }

  const enrichments: { id: string; changes: Partial<BookmarkPost> }[] = [];
  candidates.forEach((post, index) => {
    const stored = existing[index];
    const changes = stored ? enrichmentFor(stored, post) : undefined;
    if (changes) enrichments.push({ id: post.id, changes });
  });
  if (enrichments.length > 0) {
    await Promise.all(enrichments.map(({ id, changes }) => db.bookmarks.update(id, changes)));
  }

  return { savedCount: toAdd.length };
}
