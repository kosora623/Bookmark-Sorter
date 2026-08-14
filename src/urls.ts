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

export function isXHostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
    return host === 'x.com' || host === 'twitter.com';
  } catch {
    return false;
  }
}
