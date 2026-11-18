// content script 専用の DOM ヘルパー（X のページからポストを読み取る）。content.ts からだけ import するので
// content.js に同梱され、web_accessible_resources に新しいチャンクを足す必要はない。
// chrome.* には触らないので、jsdom でテストできる。

import { DEFAULT_FOLDER } from './constants';
import type { BookmarkPost } from './db';
import { isHttpUrl } from './urls';

/**
 * innerText だと絵文字（<img alt>）が消え、URL は「example.com/…」に省略される。
 * DOM をたどって絵文字は alt、URL リンクは隠し部分を含む全文で組み立てる。
 */
export function extractTweetText(root: Node): string {
  let out = '';
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
    } else if (node instanceof HTMLImageElement) {
      out += node.alt;
    } else if (node instanceof HTMLBRElement) {
      out += '\n';
    } else if (node instanceof HTMLAnchorElement) {
      const full = (node.textContent ?? '').replace(/…$/, '').trim();
      out += /^https?:\/\/\S+$/.test(full) ? full : extractTweetText(node);
    } else if (node instanceof HTMLElement) {
      out += extractTweetText(node);
    }
  }
  return out;
}

export function isBookmarksPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return ['/i/history', '/i/bookmarks'].some((base) => path === base || path.startsWith(`${base}/`));
}

/** 引用ポストなど、別のポストの中に入っているポストか */
export function isNestedTweet(el: HTMLElement): boolean {
  if (el.closest('[data-testid="quoteTweet"]')) return true;
  return el.parentElement?.closest('[data-testid="tweet"]') != null;
}

/** root 自身の要素か（引用ポストや入れ子のポストの中の要素は除く） */
function isOwnDescendant(node: Element, root: HTMLElement): boolean {
  const nestedTweet = node.closest('[data-testid="tweet"]');
  if (nestedTweet && nestedTweet !== root) return false;
  if (node.closest('[data-testid="quoteTweet"]')) return false;
  return true;
}

export function queryOwn<T extends Element>(root: HTMLElement, selector: string): T | null {
  const matches = root.querySelectorAll<T>(selector);
  for (const el of matches) {
    if (isOwnDescendant(el, root)) return el;
  }
  return null;
}

export function queryOwnAll<T extends Element>(root: HTMLElement, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)].filter((el) => isOwnDescendant(el, root));
}

/** ポストの日時リンク（本人のポストへのリンク）から status ID を読む */
function ownStatusId(tweet: HTMLElement): string | undefined {
  const link = queryOwn(tweet, 'time')?.closest('a');
  return link?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
}

/**
 * ポスト単体ページで、引用などではない本体のポストを返す。
 * 返信のページでは返信先のポストが上に並ぶので、statusId があればそれと一致するものを選ぶ。
 * 本体のポストは日時がリンクにならないことがあるので、一致するものが無ければ、
 * 別のポストへの日時リンクを持たない最初のポストにする。
 */
export function findPrimaryTweet(statusId?: string, root: ParentNode = document): HTMLElement | null {
  const tweets = [...root.querySelectorAll<HTMLElement>('article[data-testid="tweet"]')].filter(
    (tweet) => !isNestedTweet(tweet)
  );
  if (!statusId) return tweets[0] ?? null;

  const exact = tweets.find((tweet) => ownStatusId(tweet) === statusId);
  if (exact) return exact;
  return tweets.find((tweet) => ownStatusId(tweet) === undefined) ?? null;
}

/** root 自身の「ブックマーク解除」ボタン（引用ポストの中のものは除く） */
export function findRemoveBookmarkButton(root: HTMLElement): HTMLElement | null {
  return queryOwn<HTMLElement>(root, '[data-testid="removeBookmark"]');
}

function hostnameOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    if (!host || host === 't.co') return undefined;
    return host;
  } catch {
    return undefined;
  }
}

function looksLikeDomain(text: string): boolean {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(text.trim());
}

function extractBackgroundImageUrl(el: HTMLElement): string | undefined {
  const fromStyle = el.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/);
  if (fromStyle?.[1] && isHttpUrl(fromStyle[1])) return fromStyle[1];
  return undefined;
}

function extractCardImage(wrapper: HTMLElement): string | undefined {
  const img = wrapper.querySelector('img');
  if (img instanceof HTMLImageElement) {
    const src = img.currentSrc || img.src;
    if (src && isHttpUrl(src) && !src.startsWith('data:')) return src;
  }

  const media =
    wrapper.querySelector<HTMLElement>('[data-testid="card.layoutSmall.media"]') ??
    wrapper.querySelector<HTMLElement>('[data-testid="card.layoutLarge.media"]') ??
    wrapper.querySelector<HTMLElement>('[data-testid$=".media"]');
  if (media) {
    const fromMedia = extractBackgroundImageUrl(media);
    if (fromMedia) return fromMedia;
    const nested = media.querySelectorAll<HTMLElement>('[style*="background-image"]');
    for (const node of nested) {
      const fromNested = extractBackgroundImageUrl(node);
      if (fromNested) return fromNested;
    }
  }

  return undefined;
}

function extractCardTexts(wrapper: HTMLElement): { domain?: string; title?: string } {
  const detail =
    wrapper.querySelector('[data-testid="card.layoutSmall.detail"]') ??
    wrapper.querySelector('[data-testid="card.layoutLarge.detail"]') ??
    wrapper.querySelector('[data-testid$=".detail"]');

  const blocks: string[] = [];
  if (detail) {
    for (const child of Array.from(detail.children)) {
      const text = (child as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
      if (text && !blocks.includes(text)) blocks.push(text);
    }
  }

  if (blocks.length === 0) {
    const anchor = wrapper.querySelector('a[href]');
    const labeled = anchor?.getAttribute('aria-label')?.trim();
    if (labeled) {
      for (const part of labeled.split(/\n+/)) {
        const text = part.replace(/\s+/g, ' ').trim();
        if (text && !blocks.includes(text)) blocks.push(text);
      }
    }
  }

  let domain: string | undefined;
  let title: string | undefined;

  if (blocks[0] && looksLikeDomain(blocks[0])) {
    domain = blocks[0];
    title = blocks[1];
  } else {
    title = blocks[0];
    domain = blocks.find((block, index) => index > 0 && looksLikeDomain(block));
  }

  return { domain, title };
}

export function parseLinkCard(tweetEl: HTMLElement): BookmarkPost['linkCard'] | undefined {
  const wrapper = queryOwn<HTMLElement>(tweetEl, '[data-testid="card.wrapper"]');
  if (!wrapper) return undefined;

  const anchor = wrapper.querySelector('a[href]');
  const href = anchor instanceof HTMLAnchorElement ? anchor.href : '';
  if (!href || !isHttpUrl(href)) return undefined;

  const { domain: visibleDomain, title } = extractCardTexts(wrapper);
  const domain = visibleDomain || hostnameOf(href);
  const image = extractCardImage(wrapper);

  const card: NonNullable<BookmarkPost['linkCard']> = { url: href };
  if (title) card.title = title;
  if (domain) card.domain = domain;
  if (image) card.image = image;
  return card;
}

/** タイムライン上の 1 ポストを読み取る。ポスト URL が取れなければ null */
export function parseTweetElement(tweetEl: HTMLElement, savedAt = new Date().toISOString()): BookmarkPost | null {
  try {
    const timeEl = queryOwn(tweetEl, 'time');
    const linkEl = timeEl ? timeEl.closest('a') : null;
    const url = linkEl instanceof HTMLAnchorElement ? linkEl.href : '';
    const id = url.match(/\/status\/(\d+)/)?.[1];

    if (!id) return null;

    const userEl = queryOwn<HTMLElement>(tweetEl, '[data-testid="User-Name"]');
    const author = userEl ? userEl.innerText.replace(/\n/g, ' ') : '不明';

    const textEl = queryOwn<HTMLElement>(tweetEl, '[data-testid="tweetText"]');
    const text = textEl ? extractTweetText(textEl) : '';

    const postedAt = timeEl?.getAttribute('datetime') ?? undefined;

    const images: string[] = [];
    for (const img of queryOwnAll<HTMLImageElement>(tweetEl, '[data-testid="tweetPhoto"] img')) {
      const src = img.src;
      if (src && isHttpUrl(src) && !src.startsWith('data:')) images.push(src);
    }

    // 動画は blob: で配信されて後から再生できないので、サムネイル（poster）と「動画あり」だけ持つ
    const hasVideo =
      queryOwn(tweetEl, '[data-testid="videoPlayer"], [data-testid="videoComponent"], video') != null;
    for (const video of queryOwnAll<HTMLVideoElement>(tweetEl, 'video')) {
      const poster = video.poster;
      if (poster && isHttpUrl(poster) && !images.includes(poster)) images.push(poster);
    }

    const linkCard = parseLinkCard(tweetEl);

    const post: BookmarkPost = {
      id,
      url,
      author,
      text,
      images,
      folder: DEFAULT_FOLDER,
      status: 'unprocessed',
      savedAt
    };
    if (linkCard) post.linkCard = linkCard;
    if (postedAt && !Number.isNaN(Date.parse(postedAt))) post.postedAt = postedAt;
    if (hasVideo) post.hasVideo = true;
    return post;
  } catch (err) {
    console.error('ポスト解析エラー:', err);
    return null;
  }
}

/** 画面に出ている（入れ子ではない）ポストをすべて読み取る */
export function parseVisibleTweets(root: ParentNode = document, savedAt = new Date().toISOString()): BookmarkPost[] {
  const posts: BookmarkPost[] = [];
  for (const tweetEl of root.querySelectorAll<HTMLElement>('[data-testid="tweet"]')) {
    if (isNestedTweet(tweetEl)) continue;
    const post = parseTweetElement(tweetEl, savedAt);
    if (post) posts.push(post);
  }
  return posts;
}
