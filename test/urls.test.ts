import { describe, expect, it } from 'vitest';
import {
  isHttpUrl,
  isXHostUrl,
  isXStatusUrl,
  normalizeImageUrls,
  statusIdFromUrl,
  toLargeImageUrl
} from '../src/urls';

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

describe('toLargeImageUrl', () => {
  it('pbs.twimg.com/media の縮小版を name=large にする', () => {
    expect(toLargeImageUrl('https://pbs.twimg.com/media/AbC123?format=jpg&name=small')).toBe(
      'https://pbs.twimg.com/media/AbC123?format=jpg&name=large'
    );
    expect(toLargeImageUrl('https://pbs.twimg.com/media/AbC123?format=png&name=360x360')).toBe(
      'https://pbs.twimg.com/media/AbC123?format=png&name=large'
    );
  });

  it('旧形式 xxx.jpg:small も新形式に直す', () => {
    expect(toLargeImageUrl('https://pbs.twimg.com/media/AbC123.jpg:small')).toBe(
      'https://pbs.twimg.com/media/AbC123?format=jpg&name=large'
    );
  });

  it('media 以外の画像はそのまま', () => {
    const thumb = 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg';
    const card = 'https://pbs.twimg.com/card_img/1/x?format=jpg&name=small';
    expect(toLargeImageUrl(thumb)).toBe(thumb);
    expect(toLargeImageUrl(card)).toBe(card);
    expect(toLargeImageUrl('https://example.com/media/a?name=small')).toBe('https://example.com/media/a?name=small');
  });
});

describe('normalizeImageUrls', () => {
  it('http(s) 以外を落とし、大きいサイズにしたうえで重複を除く', () => {
    expect(
      normalizeImageUrls([
        'https://pbs.twimg.com/media/A?format=jpg&name=small',
        'https://pbs.twimg.com/media/A?format=jpg&name=medium',
        'javascript:alert(1)',
        42
      ])
    ).toEqual(['https://pbs.twimg.com/media/A?format=jpg&name=large']);
  });
});
