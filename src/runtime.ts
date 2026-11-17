// content script とダッシュボードで共通の、拡張機能コンテキストまわりのヘルパー。
// 共有チャンク（vite.config.ts の manualChunks）に入るので content script からも import できる。

export function isContextInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Extension context invalidated');
}

/** 拡張機能の再読み込み後は chrome.runtime.id が消える（アクセス自体が例外になることもある） */
export function isExtensionAlive(): boolean {
  try {
    return typeof chrome.runtime.id === 'string';
  } catch {
    return false;
  }
}

/** background からの返信（ExtensionReply）の中身を取り出す。error なら例外にする */
export function unwrapReply<T>(reply: unknown): T {
  if (typeof reply === 'object' && reply !== null) {
    if ('error' in reply) throw new Error(String(reply.error));
    if ('data' in reply) return reply.data as T;
  }
  throw new Error('拡張機能から応答がありませんでした');
}

/** 拡張機能の再読み込みによるエラーは想定内なので出さず、それ以外だけログに残す */
export function logUnexpected(error: unknown): void {
  if (!isContextInvalidatedError(error)) console.error(error);
}
