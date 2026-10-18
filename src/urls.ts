export const PENDING_UNBOOKMARK_KEY = 'pendingUnbookmark';
export const UNBOOKMARK_INFLIGHT_KEY = 'unbookmarkInflight';

export interface PendingUnbookmark {
  statusId: string;
  url: string;
}

export interface InflightUnbookmark {
  url: string;
  tabId?: number;
}

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function statusIdFromUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'x.com' && host !== 'twitter.com') return undefined;
    const match = parsed.pathname.match(/\/status\/(\d+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function isXStatusUrl(value: string): boolean {
  return statusIdFromUrl(value) !== undefined;
}

/**
 * タイムラインの画像は name=small / 360x360 などの縮小版なので、pbs.twimg.com/media の画像は
 * name=large に揃える。それ以外（カード画像・動画サムネイル）はそのまま返す。
 */
export function toLargeImageUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.hostname !== 'pbs.twimg.com' || !parsed.pathname.startsWith('/media/')) return value;

    // 旧形式 /media/xxx.jpg:small → /media/xxx.jpg?format=jpg&name=large
    const legacy = parsed.pathname.match(/^(\/media\/[^/.:]+)\.(\w+)(?::\w+)?$/);
    if (legacy) {
      parsed.pathname = legacy[1] ?? parsed.pathname;
      if (!parsed.searchParams.has('format')) parsed.searchParams.set('format', legacy[2] ?? 'jpg');
    }
    parsed.searchParams.set('name', 'large');
    return parsed.toString();
  } catch {
    return value;
  }
}

/** http(s) の画像だけ残し、大きいサイズに揃えて重複を除く */
export function normalizeImageUrls(urls: unknown[]): string[] {
  const result: string[] = [];
  for (const url of urls) {
    if (typeof url !== 'string' || !isHttpUrl(url)) continue;
    const large = toLargeImageUrl(url);
    if (!result.includes(large)) result.push(large);
  }
  return result;
}

export function isXHostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
    return host === 'x.com' || host === 'twitter.com';
  } catch {
    return false;
  }
}
