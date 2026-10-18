import { DEFAULT_FOLDER } from './constants';
import type { BookmarkPost } from './db';
import type { BookmarkChanges, ExportData } from './messages';
import { isHttpUrl, isXStatusUrl, normalizeImageUrls } from './urls';

// 外部（content script・インポートファイル）から来たデータを DB に入れる前に整える関数群。
// Dexie を読み込まないので、テストから直接呼べる。

const STATUSES: ReadonlySet<BookmarkPost['status']> = new Set(['unprocessed', 'kept', 'discarded']);
const MAX_FOLDER_NAME_LENGTH = 40;

export function isBookmarkPost(value: unknown): value is BookmarkPost {
  if (typeof value !== 'object' || value === null) return false;
  const post = value as Partial<BookmarkPost>;
  return typeof post.id === 'string' && /^\d+$/.test(post.id);
}

function toLinkCard(value: BookmarkPost['linkCard']): BookmarkPost['linkCard'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (typeof value.url !== 'string' || !isHttpUrl(value.url)) return undefined;

  const card: NonNullable<BookmarkPost['linkCard']> = { url: value.url };
  if (typeof value.title === 'string' && value.title) card.title = value.title;
  if (typeof value.domain === 'string' && value.domain) card.domain = value.domain;
  if (typeof value.image === 'string' && value.image && isHttpUrl(value.image)) card.image = value.image;
  return card;
}

export function toBookmarkPost(post: BookmarkPost): BookmarkPost {
  const images = Array.isArray(post.images) ? normalizeImageUrls(post.images) : [];
  const status = post.status && STATUSES.has(post.status) ? post.status : 'unprocessed';
  const linkCard = toLinkCard(post.linkCard);
  const url = typeof post.url === 'string' && isXStatusUrl(post.url) ? post.url : '';

  const result: BookmarkPost = {
    id: post.id,
    url,
    author: typeof post.author === 'string' ? post.author : '不明',
    text: typeof post.text === 'string' ? post.text : '',
    images,
    folder: typeof post.folder === 'string' && post.folder ? post.folder : DEFAULT_FOLDER,
    status,
    savedAt: typeof post.savedAt === 'string' ? post.savedAt : new Date().toISOString()
  };
  if (typeof post.postedAt === 'string' && !Number.isNaN(Date.parse(post.postedAt))) {
    result.postedAt = post.postedAt;
  }
  if (post.hasVideo === true) result.hasVideo = true;
  if (linkCard) result.linkCard = linkCard;
  return result;
}

export function sanitizeChanges(changes: BookmarkChanges): BookmarkChanges {
  const next: BookmarkChanges = {};
  if (typeof changes.folder === 'string') next.folder = changes.folder;
  if (changes.status && STATUSES.has(changes.status)) {
    next.status = changes.status;
  }
  return next;
}

export function sanitizeFolderName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_FOLDER_NAME_LENGTH);
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** 本文・投稿者名の部分一致（大文字小文字は区別しない）。query は normalizeQuery 済みのもの */
export function matchesQuery(post: Pick<BookmarkPost, 'author' | 'text'>, query: string): boolean {
  if (!query) return true;
  return post.author.toLowerCase().includes(query) || post.text.toLowerCase().includes(query);
}

export type ParsedImport =
  | { ok: true; posts: BookmarkPost[]; folders: string[] }
  | { ok: false; error: string };

export function parseImportData(data: unknown): ParsedImport {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'ファイルの形式が正しくありません' };
  }
  const payload = data as Partial<ExportData>;
  if (payload.format !== 'x-bookmark-sorter' || !Array.isArray(payload.bookmarks)) {
    return { ok: false, error: 'Bookmark Sorter のエクスポートファイルではありません' };
  }

  const posts = new Map<string, BookmarkPost>();
  for (const raw of payload.bookmarks) {
    if (!isBookmarkPost(raw)) continue;
    const post = toBookmarkPost(raw);
    if (post.url) posts.set(post.id, post);
  }

  const folders = Array.isArray(payload.folders)
    ? [
        ...new Set(
          payload.folders
            .filter((name): name is string => typeof name === 'string')
            .map(sanitizeFolderName)
            .filter(Boolean)
        )
      ]
    : [];

  return { ok: true, posts: [...posts.values()], folders };
}
