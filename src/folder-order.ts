import { DEFAULT_FOLDER } from './constants';
import type { FolderRecord } from './db';

// フォルダの並び順。chrome.* にも Dexie にも触らないので、テストから直接呼べる。
// order を持たない古いフォルダは、以前の並び（未分類が先頭、あとは名前順）で order 付きのものの後ろに置く。

function legacyCompare(a: string, b: string): number {
  if (a === DEFAULT_FOLDER) return -1;
  if (b === DEFAULT_FOLDER) return 1;
  return a.localeCompare(b, 'ja');
}

export function sortFolderRecords(records: readonly FolderRecord[]): FolderRecord[] {
  return [...records].sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : null;
    const bo = typeof b.order === 'number' ? b.order : null;
    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return -1;
    if (ao === null && bo !== null) return 1;
    return legacyCompare(a.name, b.name);
  });
}

/** 次に足すフォルダの order（今ある最大 + 1） */
export function nextFolderOrder(records: readonly FolderRecord[]): number {
  let max = -1;
  for (const record of records) {
    if (typeof record.order === 'number' && record.order > max) max = record.order;
  }
  return max + 1;
}

/**
 * requested の順に並べ直した結果を 0 始まりの order 付きで返す。
 * requested に無い既存のフォルダは、今の並びのまま後ろに続ける。存在しない名前と重複は無視する。
 */
export function reorderFolderRecords(records: readonly FolderRecord[], requested: readonly string[]): FolderRecord[] {
  const current = sortFolderRecords(records);
  const existing = new Set(current.map((record) => record.name));
  const seen = new Set<string>();
  const names: string[] = [];

  for (const name of requested) {
    if (!existing.has(name) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  for (const record of current) {
    if (!seen.has(record.name)) names.push(record.name);
  }

  return names.map((name, order) => ({ name, order }));
}
