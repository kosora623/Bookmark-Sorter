// 選別・保存済みの両方の画面から参照する状態
import type { FolderInfo } from '../messages';
import { isContextInvalidatedError } from '../runtime';

export type ViewMode = 'sort' | 'kept';

export const state: {
  viewMode: ViewMode;
  /** runExclusive で処理中か。処理中はキー操作などを受け付けない */
  isBusy: boolean;
  folders: FolderInfo[];
} = {
  viewMode: 'sort',
  isBusy: false,
  folders: []
};

/** 処理中でなければ task を実行する。失敗したら知らせる（拡張機能の再読み込みによるものは除く） */
export async function runExclusive(task: () => Promise<void>): Promise<void> {
  if (state.isBusy) return;
  state.isBusy = true;
  try {
    await task();
  } catch (error) {
    if (isContextInvalidatedError(error)) return;
    console.error(error);
    const detail = error instanceof Error ? error.message : String(error);
    window.alert(`処理に失敗しました: ${detail}`);
  } finally {
    state.isBusy = false;
  }
}
