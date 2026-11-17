// データ全体の操作（エクスポート・インポート・全消去）と、解除に失敗したポストの表示
import { sendMessage } from './api';
import { localDateStamp } from './dom';
import { confirmDialog, showToast } from './notify';

export async function updateUnbookmarkFailures(): Promise<void> {
  const btn = document.getElementById('unbookmark-failed-btn');
  if (!btn) return;
  const { failures } = await sendMessage({ action: 'list_unbookmark_failures' });
  btn.hidden = failures.length === 0;
  btn.innerText = `解除失敗 ${failures.length}件 · 再試行`;
}

export async function retryUnbookmarkFailures(): Promise<void> {
  const { queued } = await sendMessage({ action: 'retry_unbookmark_failures' });
  await updateUnbookmarkFailures();
  showToast(queued > 0 ? `${queued}件の解除を再試行します` : '再試行が必要なポストはありません');
}

export async function exportAllData(): Promise<void> {
  const data = await sendMessage({ action: 'export_data' });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `bookmark-sorter-${localDateStamp(new Date())}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 確認のうえファイルを読み込む。読み込んだ件数を返し、やめた・失敗したときは null */
export async function importFromFile(file: File): Promise<number | null> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showToast('JSON として読み込めませんでした', 'error');
    return null;
  }

  const confirmed = await confirmDialog({
    message:
      'ファイルの内容を読み込みます。同じポストがすでにある場合は、ファイルの内容（状態・フォルダ）で上書きします。よろしいですか？',
    confirmLabel: '読み込む'
  });
  if (!confirmed) return null;

  const response = await sendMessage({
    action: 'import_data',
    data
  });
  if (!response.ok) {
    showToast(response.error || 'インポートできませんでした', 'error');
    return null;
  }

  return response.imported;
}

/** 確認のうえ全データを消す。消したら true */
export async function clearAllData(): Promise<boolean> {
  const confirmed = await confirmDialog({
    message: 'すべてのブックマークデータを消去します。この操作は取り消せません。よろしいですか？',
    confirmLabel: '全消去する',
    danger: true
  });
  if (!confirmed) return false;

  await sendMessage({ action: 'clear_bookmarks' });
  return true;
}
