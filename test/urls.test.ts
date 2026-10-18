import { describe, expect, it } from 'vitest';
import { isHttpUrl, isXHostUrl, isXStatusUrl, statusIdFromUrl } from '../src/urls';

describe('statusIdFromUrl', () => {
  it('x.com と twitter.com のポスト URL から ID を取り出す', () => {
    expect(statusIdFromUrl('https://x.com/jack/status/20')).toBe('20');
    expect(statusIdFromUrl('https://twitter.com/jack/status/20')).toBe('20');
    expect(statusIdFromUrl('https://www.x.com/jack/status/20?s=20#top')).toBe('20');
    expect(statusIdFromUrl('https://X.COM/jack/status/1234567890123456789/photo/1')).toBe('1234567890123456789');
  });

  it('X 以外のホストや status の無い URL は undefined', () => {
    expect(statusIdFromUrl('https://example.com/jack/status/20')).toBeUndefined();
    expect(statusIdFromUrl('https://x.com.evil.example/jack/status/20')).toBeUndefined();
    expect(statusIdFromUrl('https://x.com/jack')).toBeUndefined();
    expect(statusIdFromUrl('not a url')).toBeUndefined();
  });
});

describe('isXStatusUrl / isXHostUrl / isHttpUrl', () => {
  it('判定が URL の種類に合う', () => {
    expect(isXStatusUrl('https://x.com/a/status/1')).toBe(true);
    expect(isXStatusUrl('https://x.com/i/bookmarks')).toBe(false);
    expect(isXHostUrl('https://twitter.com/home')).toBe(true);
    expect(isXHostUrl('https://t.co/abc')).toBe(false);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:image/png;base64,AAAA')).toBe(false);
  });
});
