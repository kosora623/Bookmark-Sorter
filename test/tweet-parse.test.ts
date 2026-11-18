// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_FOLDER } from '../src/constants';
import {
  findPrimaryTweet,
  findRemoveBookmarkButton,
  parseTweetElement,
  parseVisibleTweets
} from '../src/tweet-dom';
import { installInnerText } from './helpers/inner-text';

// X の DOM を模した HTML で、ポストの読み取りを確かめる。
// data-testid の名前は content script が前提にしているものに合わせている。

const SAVED_AT = '2026-01-01T00:00:00.000Z';

beforeAll(() => {
  installInnerText();
});

beforeEach(() => {
  // X のポストのリンクは相対パスなので、x.com を基準に解決させる
  document.head.innerHTML = '<base href="https://x.com/">';
  document.body.innerHTML = '';
});

interface TweetFixture {
  id: string;
  handle?: string;
  name?: string;
  datetime?: string;
  text?: string;
  /** 本文の後ろに入れる任意の HTML（写真・動画・カード・引用など） */
  body?: string;
  /** 時刻のリンクを出さない */
  noTimeLink?: boolean;
  bookmarked?: boolean;
}

function tweetHtml(f: TweetFixture): string {
  return `<article data-testid="tweet">${tweetInnerHtml(f)}</article>`;
}

function tweetInnerHtml(f: TweetFixture): string {
  const handle = f.handle ?? 'jack';
  const time = f.noTimeLink
    ? ''
    : `<div><a href="/${handle}/status/${f.id}"><time datetime="${f.datetime ?? '2025-05-01T12:00:00.000Z'}">5月1日</time></a></div>`;
  const bookmark = f.bookmarked === undefined
    ? ''
    : `<button data-testid="${f.bookmarked ? 'removeBookmark' : 'bookmark'}"></button>`;
  return `
      <div data-testid="User-Name">
        <div><span>${f.name ?? 'Jack'}</span></div>
        <div><span>@${handle}</span></div>
        <div>·</div>
        ${time}
      </div>
      <div data-testid="tweetText"><span>${f.text ?? ''}</span></div>
      ${f.body ?? ''}
      ${bookmark}`;
}

/**
 * 引用ポスト。X では article で包まれない形と包まれる形があり、content script は両方を除外している。
 * 既定は包まない形（quoteTweet の判定だけが頼り）。
 */
function quoteHtml(f: TweetFixture, { asArticle = false } = {}): string {
  return `<div data-testid="quoteTweet">${asArticle ? tweetHtml(f) : tweetInnerHtml(f)}</div>`;
}

function photoHtml(src: string): string {
  return `<div data-testid="tweetPhoto"><img src="${src}"></div>`;
}

function mountTweet(f: TweetFixture): HTMLElement {
  document.body.innerHTML = tweetHtml(f);
  const el = document.querySelector<HTMLElement>('article[data-testid="tweet"]');
  if (!el) throw new Error('fixture が組み立てられませんでした');
  return el;
}

describe('parseTweetElement', () => {
  it('ID・URL・投稿者・本文・投稿日時を読み取る', () => {
    const post = parseTweetElement(
      mountTweet({ id: '123', handle: 'jack', name: 'Jack', text: 'こんにちは' }),
      SAVED_AT
    );

    expect(post).toEqual({
      id: '123',
      url: 'https://x.com/jack/status/123',
      author: 'Jack @jack · 5月1日',
      text: 'こんにちは',
      images: [],
      folder: DEFAULT_FOLDER,
      status: 'unprocessed',
      savedAt: SAVED_AT,
      postedAt: '2025-05-01T12:00:00.000Z'
    });
  });

  it('時刻のリンクが無ければ読み取らない', () => {
    expect(parseTweetElement(mountTweet({ id: '123', noTimeLink: true }), SAVED_AT)).toBeNull();
  });

  it('日付として読めない datetime は postedAt に入れない', () => {
    const post = parseTweetElement(mountTweet({ id: '123', datetime: 'yesterday' }), SAVED_AT);
    expect(post?.postedAt).toBeUndefined();
  });

  it('写真は自分のものだけ集め、data: URL は除く', () => {
    const post = parseTweetElement(
      mountTweet({
        id: '1',
        body:
          photoHtml('https://pbs.twimg.com/media/A?format=jpg&name=small') +
          photoHtml('data:image/png;base64,AAAA') +
          quoteHtml({ id: '2', handle: 'other', body: photoHtml('https://pbs.twimg.com/media/Q?format=jpg&name=small') })
      }),
      SAVED_AT
    );

    expect(post?.images).toEqual(['https://pbs.twimg.com/media/A?format=jpg&name=small']);
  });

  it('引用ポストの ID・投稿者・本文を取り違えない', () => {
    const post = parseTweetElement(
      mountTweet({
        id: '1',
        handle: 'jack',
        text: '本体',
        body: quoteHtml({ id: '2', handle: 'other', name: 'Other', text: '引用' })
      }),
      SAVED_AT
    );

    expect(post?.id).toBe('1');
    expect(post?.author).toBe('Jack @jack · 5月1日');
    expect(post?.text).toBe('本体');
  });

  it('article で包まれた引用ポストも取り違えない', () => {
    const post = parseTweetElement(
      mountTweet({
        id: '1',
        text: '本体',
        body: quoteHtml(
          { id: '2', handle: 'other', text: '引用', body: photoHtml('https://pbs.twimg.com/media/Q') },
          { asArticle: true }
        )
      }),
      SAVED_AT
    );

    expect(post?.id).toBe('1');
    expect(post?.text).toBe('本体');
    expect(post?.images).toEqual([]);
  });

  it('動画はサムネイルを images に入れ、hasVideo を立てる', () => {
    const poster = 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/x.jpg';
    const post = parseTweetElement(
      mountTweet({
        id: '1',
        body: `<div data-testid="videoPlayer"><video poster="${poster}"></video></div>`
      }),
      SAVED_AT
    );

    expect(post?.hasVideo).toBe(true);
    expect(post?.images).toEqual([poster]);
  });

  it('引用ポストの動画では hasVideo を立てない', () => {
    const post = parseTweetElement(
      mountTweet({
        id: '1',
        body: quoteHtml({ id: '2', body: '<div data-testid="videoPlayer"><video poster="https://pbs.twimg.com/t.jpg"></video></div>' })
      }),
      SAVED_AT
    );

    expect(post).not.toHaveProperty('hasVideo');
    expect(post?.images).toEqual([]);
  });
});

describe('parseTweetElement のリンクカード', () => {
  it('大きいカード: ドメイン・タイトル・画像を読み取る', () => {
    const post = parseTweetElement(
      mountTweet({
        id: '1',
        body: `
          <div data-testid="card.wrapper">
            <div data-testid="card.layoutLarge.media">
              <a href="https://t.co/abc"><img src="https://pbs.twimg.com/card_img/1/x?format=jpg&name=small"></a>
            </div>
            <div data-testid="card.layoutLarge.detail">
              <div><span>example.com</span></div>
              <div><span>記事の   タイトル</span></div>
            </div>
          </div>`
      }),
      SAVED_AT
    );

    expect(post?.linkCard).toEqual({
      url: 'https://t.co/abc',
      domain: 'example.com',
      title: '記事の タイトル',
      image: 'https://pbs.twimg.com/card_img/1/x?format=jpg&name=small'
    });
  });

  it('小さいカード: 背景画像を拾い、ドメインの表示が無ければリンク先から補う', () => {
    const post = parseTweetElement(
      mountTweet({
        id: '1',
        body: `
          <div data-testid="card.wrapper">
            <a href="https://www.example.org/page">
              <div data-testid="card.layoutSmall.media">
                <div style="background-image: url('https://pbs.twimg.com/card_img/2/y')"></div>
              </div>
            </a>
            <div data-testid="card.layoutSmall.detail"><div>タイトルだけ</div></div>
          </div>`
      }),
      SAVED_AT
    );

    expect(post?.linkCard).toEqual({
      url: 'https://www.example.org/page',
      domain: 'example.org',
      title: 'タイトルだけ',
      image: 'https://pbs.twimg.com/card_img/2/y'
    });
  });

  it('リンク先が t.co でドメイン表示も無ければ domain は入れない', () => {
    const post = parseTweetElement(
      mountTweet({
        id: '1',
        body: `
          <div data-testid="card.wrapper">
            <a href="https://t.co/abc"></a>
            <div data-testid="card.layoutSmall.detail"><div>タイトル</div></div>
          </div>`
      }),
      SAVED_AT
    );

    expect(post?.linkCard).toEqual({ url: 'https://t.co/abc', title: 'タイトル' });
  });

  it('引用ポストの中のカードは拾わない', () => {
    const post = parseTweetElement(
      mountTweet({
        id: '1',
        body: quoteHtml({
          id: '2',
          body: '<div data-testid="card.wrapper"><a href="https://example.com/"></a></div>'
        })
      }),
      SAVED_AT
    );

    expect(post).not.toHaveProperty('linkCard');
  });
});

describe('parseVisibleTweets', () => {
  it('入れ子ではないポストだけを読み取る', () => {
    document.body.innerHTML =
      tweetHtml({ id: '1', body: quoteHtml({ id: '9', handle: 'other' }, { asArticle: true }) }) +
      tweetHtml({ id: '2' }) +
      tweetHtml({ id: '3', noTimeLink: true });

    const posts = parseVisibleTweets(document, SAVED_AT);
    expect(posts.map((post) => post.id)).toEqual(['1', '2']);
    expect(posts.every((post) => post.savedAt === SAVED_AT)).toBe(true);
  });
});

describe('findPrimaryTweet / findRemoveBookmarkButton', () => {
  it('引用ではない本体のポストと、その解除ボタンを見つける', () => {
    document.body.innerHTML = tweetHtml({
      id: '1',
      bookmarked: true,
      body: quoteHtml({ id: '2', handle: 'other' }, { asArticle: true })
    });

    const primary = findPrimaryTweet();
    expect(primary?.querySelector('time')?.closest('a')?.getAttribute('href')).toBe('/jack/status/1');
    expect(primary && findRemoveBookmarkButton(primary)).not.toBeNull();
  });

  it('解除済みなら解除ボタンは無い', () => {
    document.body.innerHTML = tweetHtml({ id: '1', bookmarked: false });
    const primary = findPrimaryTweet();
    expect(primary && findRemoveBookmarkButton(primary)).toBeNull();
  });
});

describe('findPrimaryTweet（返信のページ）', () => {
  it('上に並ぶ返信先ではなく、URL のポストを選ぶ', () => {
    document.body.innerHTML =
      tweetHtml({ id: '1', handle: 'parent', bookmarked: false }) + tweetHtml({ id: '2', bookmarked: true });

    const primary = findPrimaryTweet('2');
    expect(primary?.querySelector('time')?.closest('a')?.getAttribute('href')).toBe('/jack/status/2');
    expect(primary && findRemoveBookmarkButton(primary)).not.toBeNull();
  });

  it('日時がリンクでない本体のポストにも落とせる', () => {
    document.body.innerHTML =
      tweetHtml({ id: '1', handle: 'parent', bookmarked: false }) +
      tweetHtml({ id: '2', noTimeLink: true, bookmarked: true });
    expect(findPrimaryTweet('2') && findRemoveBookmarkButton(findPrimaryTweet('2') as HTMLElement)).not.toBeNull();
  });

  it('引用ポストの中の解除ボタンは本体のものとみなさない', () => {
    document.body.innerHTML = tweetHtml({
      id: '1',
      bookmarked: false,
      body: quoteHtml({ id: '2', handle: 'other', bookmarked: true }, { asArticle: true })
    });
    const primary = findPrimaryTweet('1');
    expect(primary && findRemoveBookmarkButton(primary)).toBeNull();
  });
});
