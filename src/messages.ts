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
  | { action: 'get_unbookmark_task'; statusId: string }
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
  | { action: 'rename_folder'; name: string; newName: string }
  | { action: 'reorder_folders'; names: string[] }
  | { action: 'discard_bookmarks'; ids: string[] }
  | { action: 'restore_bookmarks'; ids: string[] }
  | { action: 'move_bookmarks'; ids: string[]; folder: string }
  | { action: 'clear_bookmarks' }
  | { action: 'open_dashboard' };

export type ExtensionAction = ExtensionRequest['action'];
export type RequestOf<A extends ExtensionAction> = Extract<ExtensionRequest, { action: A }>;

export interface FolderMutationResult {
  ok: boolean;
  error?: string;
  folders: FolderInfo[];
}

/** action ごとの応答。background の戻り値と送信側の受け取りの両方をこの型で縛る */
export interface ExtensionResponses {
  save_posts: { savedCount: number };
  unbookmark: { ok: true };
  cancel_unbookmark: { ok: true };
  unbookmark_done: { ok: true };
  get_unbookmark_task: { pending: boolean };
  list_unbookmark_failures: { failures: UnbookmarkFailure[] };
  retry_unbookmark_failures: { queued: number };
  export_data: ExportData;
  import_data: { ok: boolean; error?: string; imported: number };
  get_unprocessed: { posts: BookmarkPost[] };
  update_bookmark: { ok: boolean };
  get_counts: { unprocessed: number; kept: number };
  list_kept: { posts: BookmarkPost[]; total: number };
  list_folders: { folders: FolderInfo[] };
  add_folder: FolderMutationResult;
  delete_folder: FolderMutationResult;
  rename_folder: FolderMutationResult;
  reorder_folders: FolderMutationResult;
  discard_bookmarks: { discarded: number; folders: FolderInfo[] };
  /** unbookmarked: すでに Twitter 側の解除が始まっていて、Twitter では戻せなかった件数 */
  restore_bookmarks: { restored: number; unbookmarked: number; folders: FolderInfo[] };
  move_bookmarks: { ok: boolean; moved: number; folders: FolderInfo[] };
  clear_bookmarks: { ok: true };
  open_dashboard: { ok: true };
}

export type ResponseOf<A extends ExtensionAction> = ExtensionResponses[A];

/**
 * background からの返信。処理中に例外が起きても必ず error で返すので、送信側が待ち続けることはない。
 * 中身は runtime.ts の unwrapReply で取り出す。
 */
export type ExtensionReply<T> = { data: T } | { error: string };

// Record にして、ExtensionRequest に action を足したときに書き漏れを型エラーで気づけるようにする
const ACTIONS: Record<ExtensionAction, true> = {
  save_posts: true,
  unbookmark: true,
  cancel_unbookmark: true,
  unbookmark_done: true,
  get_unbookmark_task: true,
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
  rename_folder: true,
  reorder_folders: true,
  discard_bookmarks: true,
  restore_bookmarks: true,
  move_bookmarks: true,
  clear_bookmarks: true,
  open_dashboard: true
};

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (typeof value !== 'object' || value === null) return false;
  if (!('action' in value)) return false;
  const action = value.action;
  return typeof action === 'string' && Object.hasOwn(ACTIONS, action);
}
