// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractTweetText, isBookmarksPath } from '../src/tweet-dom';

function fromHtml(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('extractTweetText', () => {
  it('絵文字の img を alt に置き換える', () => {
    const el = fromHtml('<span>おはよう</span><img alt="😀" src="https://abs-0.twimg.com/emoji/1f600.svg"><span>!</span>');
    expect(extractTweetText(el)).toBe('おはよう😀!');
  });

  it('省略表示された URL を隠し部分も含めて復元する', () => {
    // X のリンク表示: 「https://」と末尾が非表示、末尾に「…」
    const el = fromHtml(
      '見て <a href="https://t.co/abc">' +
        '<span style="display:none">https://</span>example.com/very/lo' +
        '<span style="display:none">ng/path</span><span>…</span></a> です'
    );
    expect(extractTweetText(el)).toBe('見て https://example.com/very/long/path です');
  });

  it('メンションやハッシュタグのリンクはそのまま', () => {
    const el = fromHtml('<a href="/jack">@jack</a> <a href="/hashtag/test">#test</a>');
    expect(extractTweetText(el)).toBe('@jack #test');
  });

  it('改行を保つ', () => {
    const el = fromHtml('<span>1行目\n2行目</span><br><span>3行目</span>');
    expect(extractTweetText(el)).toBe('1行目\n2行目\n3行目');
  });
});

describe('isBookmarksPath', () => {
  it('ブックマークページだけ true', () => {
    expect(isBookmarksPath('/i/bookmarks')).toBe(true);
    expect(isBookmarksPath('/i/bookmarks/')).toBe(true);
    expect(isBookmarksPath('/i/bookmarks/123')).toBe(true);
    expect(isBookmarksPath('/i/history')).toBe(true);
  });

  it('ユーザー名に bookmarks を含むページなどは false', () => {
    expect(isBookmarksPath('/bookmarksfan/status/1')).toBe(false);
    expect(isBookmarksPath('/home')).toBe(false);
    expect(isBookmarksPath('/i/bookmarksx')).toBe(false);
  });
});
