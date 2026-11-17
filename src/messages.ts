import type { BookmarkPost } from './db';

export type BookmarkChanges = Partial<Pick<BookmarkPost, 'folder' | 'status'>>;

export interface FolderInfo {
  name: string;
  count: number;
  locked: boolean;
}

export interface UnbookmarkFailure {
  url: string;
  failedAt: string;
}

export interface ExportData {
  format: 'x-bookmark-sorter';
  version: 1;
  exportedAt: string;
  bookmarks: BookmarkPost[];
  folders: string[];
}

export type ExtensionRequest =
  | { action: 'save_posts'; posts: BookmarkPost[] }
  | { action: 'unbookmark'; tweetUrl: string }
  | { action: 'cancel_unbookmark'; tweetUrl: string }
  | { action: 'unbookmark_done'; ok?: boolean }
  | { action: 'list_unbookmark_failures' }
  | { action: 'retry_unbookmark_failures' }
  | { action: 'export_data' }
  | { action: 'import_data'; data: unknown }
  | { action: 'get_unprocessed'; excludeIds?: string[]; limit?: number }
  | { action: 'update_bookmark'; id: string; changes: BookmarkChanges }
  | { action: 'get_counts' }
  | { action: 'list_kept'; folder?: string; query?: string; offset?: number; limit?: number }
  | { action: 'list_folders' }
  | { action: 'add_folder'; name: string }
  | { action: 'delete_folder'; name: string }
  | { action: 'clear_bookmarks' }
  | { action: 'open_dashboard' };

// Record にして、ExtensionRequest に action を足したときに書き漏れを型エラーで気づけるようにする
const ACTIONS: Record<ExtensionRequest['action'], true> = {
  save_posts: true,
  unbookmark: true,
  cancel_unbookmark: true,
  unbookmark_done: true,
  list_unbookmark_failures: true,
  retry_unbookmark_failures: true,
  export_data: true,
  import_data: true,
  get_unprocessed: true,
  update_bookmark: true,
  get_counts: true,
  list_kept: true,
  list_folders: true,
  add_folder: true,
  delete_folder: true,
  clear_bookmarks: true,
  open_dashboard: true
};

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (typeof value !== 'object' || value === null) return false;
  if (!('action' in value)) return false;
  const action = value.action;
  return typeof action === 'string' && Object.hasOwn(ACTIONS, action);
}
