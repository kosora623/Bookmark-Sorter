// background とのやりとりと、ダッシュボードから直接使う chrome.* をまとめる
import type { ExtensionRequest, ResponseOf } from '../messages';
import { isExtensionAlive, logUnexpected, unwrapReply } from '../runtime';
import { isHttpUrl } from '../urls';

const LAST_FOLDER_KEY = 'lastSortFolder';

/** 応答の型は action から決まる（messages.ts の ExtensionResponses）。background 側の失敗は例外になる */
export async function sendMessage<M extends ExtensionRequest>(message: M): Promise<ResponseOf<M['action']>> {
  if (!isExtensionAlive()) throw new Error('Extension context invalidated');
  return unwrapReply<ResponseOf<M['action']>>(await chrome.runtime.sendMessage(message));
}

export function sendQuietly(message: ExtensionRequest): void {
  void sendMessage(message).catch(logUnexpected);
}

export function openTweet(url: string): void {
  if (!url || !isHttpUrl(url)) return;
  try {
    void chrome.tabs.create({ url }).catch(logUnexpected);
  } catch (error) {
    logUnexpected(error);
  }
}

/** 選別で最後に選んだフォルダを覚えておく */
export function saveLastFolder(name: string): void {
  if (!name || !isExtensionAlive()) return;
  try {
    void chrome.storage.local.set({ [LAST_FOLDER_KEY]: name }).catch(logUnexpected);
  } catch (error) {
    logUnexpected(error);
  }
}

export async function loadLastFolder(): Promise<string | null> {
  if (!isExtensionAlive()) return null;
  try {
    const stored = await chrome.storage.local.get(LAST_FOLDER_KEY);
    const value = stored[LAST_FOLDER_KEY];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
