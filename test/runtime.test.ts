import { describe, expect, it } from 'vitest';
import { isContextInvalidatedError, unwrapReply } from '../src/runtime';

describe('unwrapReply', () => {
  it('data を取り出す', () => {
    expect(unwrapReply({ data: { savedCount: 3 } })).toEqual({ savedCount: 3 });
    // data が falsy でも中身として返す
    expect(unwrapReply({ data: 0 })).toBe(0);
  });

  it('error は例外にする', () => {
    expect(() => unwrapReply({ error: 'DB が壊れています' })).toThrow('DB が壊れています');
  });

  it('形式が違う・応答が無いときも例外にする', () => {
    expect(() => unwrapReply(undefined)).toThrow();
    expect(() => unwrapReply({ savedCount: 3 })).toThrow();
  });
});

describe('isContextInvalidatedError', () => {
  it('拡張機能の再読み込みによるエラーだけ true', () => {
    expect(isContextInvalidatedError(new Error('Extension context invalidated.'))).toBe(true);
    expect(isContextInvalidatedError(new Error('other'))).toBe(false);
  });
});
