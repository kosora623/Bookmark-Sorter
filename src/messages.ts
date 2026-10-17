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
  | { action: 'list_kept' }
  | { action: 'list_folders' }
  | { action: 'add_folder'; name: string }
  | { action: 'delete_folder'; name: string }
  | { action: 'clear_bookmarks' }
  | { action: 'open_dashboard' };

const ACTIONS: ReadonlySet<ExtensionRequest['action']> = new Set([
  'save_posts',
  'unbookmark',
  'cancel_unbookmark',
  'unbookmark_done',
  'list_unbookmark_failures',
  'retry_unbookmark_failures',
  'export_data',
  'import_data',
  'get_unprocessed',
  'update_bookmark',
  'get_counts',
  'list_kept',
  'list_folders',
  'add_folder',
  'delete_folder',
  'clear_bookmarks',
  'open_dashboard'
]);

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (typeof value !== 'object' || value === null) return false;
  if (!('action' in value)) return false;
  const action = value.action;
  return typeof action === 'string' && ACTIONS.has(action as ExtensionRequest['action']);
}
