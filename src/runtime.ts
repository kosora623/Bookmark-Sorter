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

/** 拡張機能の再読み込みによるエラーは想定内なので出さず、それ以外だけログに残す */
export function logUnexpected(error: unknown): void {
  if (!isContextInvalidatedError(error)) console.error(error);
}
