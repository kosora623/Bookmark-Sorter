// background とのやりとりと、ダッシュボードから直接使う chrome.* をまとめる
import type { ExtensionRequest, ResponseOf } from '../messages';
import { isExtensionAlive, logUnexpected, unwrapReply } from '../runtime';
import { isHttpUrl } from '../urls';

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
