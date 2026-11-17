// 画面の部品を組み立てる関数。状態を持たず、chrome にも触らない
import type { BookmarkPost } from '../db';
import { isHttpUrl } from '../urls';

export function clonePost(post: BookmarkPost): BookmarkPost {
  return {
    ...post,
    images: [...post.images],
    linkCard: post.linkCard ? { ...post.linkCard } : undefined
  };
}

export function peelUrl(raw: string): { url: string; trailing: string } {
  const url = raw.replace(/[.,;:!?、。，．！？)）\]】」』]+$/u, '');
  return { url, trailing: raw.slice(url.length) };
}

/** 本文中の http(s) URL をリンクにして container に入れる。末尾の句読点や閉じ括弧はリンクに含めない */
export function fillTextWithLinks(container: HTMLElement, text: string): void {
  container.replaceChildren();
  if (!text) return;

  const urlRe = /https?:\/\/[^\s<>"']+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const { url, trailing } = peelUrl(match[0]);
    if (isHttpUrl(url)) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = url;
      container.appendChild(link);
      if (trailing) {
        container.appendChild(document.createTextNode(trailing));
      }
    } else {
      container.appendChild(document.createTextNode(match[0]));
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    container.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function hostnameFallback(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || url;
  } catch {
    return url;
  }
}

function createLinkPreview(card: NonNullable<BookmarkPost['linkCard']>): HTMLAnchorElement | null {
  if (!isHttpUrl(card.url)) return null;

  const preview = document.createElement('a');
  preview.className = 'link-preview';
  preview.href = card.url;
  preview.target = '_blank';
  preview.rel = 'noopener noreferrer';
  preview.title = card.title || card.domain || card.url;

  if (card.image && isHttpUrl(card.image)) {
    const img = document.createElement('img');
    img.className = 'link-preview-image';
    img.src = card.image;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    preview.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'link-preview-body';

  const domain = document.createElement('div');
  domain.className = 'link-preview-domain';
  domain.innerText = card.domain || hostnameFallback(card.url);

  const title = document.createElement('div');
  title.className = 'link-preview-title';
  title.innerText = card.title || card.url;

  body.append(domain, title);
  preview.appendChild(body);
  return preview;
}

export function renderLinkPreview(container: HTMLElement | null, card: BookmarkPost['linkCard'] | undefined): void {
  if (!container) return;
  container.replaceChildren();
  if (!card) return;
  const preview = createLinkPreview(card);
  if (preview) container.appendChild(preview);
}

/** 「表示名 @handle · 日時」の形の投稿者表示を、名前とそれ以外に分ける */
export function parseAuthorLine(author: string): { displayName: string; meta: string } {
  const trimmed = author.trim();
  const match = trimmed.match(/^(.*?)\s+(@\S+)(?:\s*[·•]\s*(.*))?$/);
  if (!match) {
    return { displayName: trimmed || '不明', meta: '' };
  }

  const handle = match[2];
  const date = (match[3] ?? '').trim();
  return {
    displayName: match[1].trim() || trimmed,
    meta: date ? `${handle} · ${date}` : handle
  };
}

export function fillAuthor(container: HTMLElement, author: string): void {
  const parsed = parseAuthorLine(author);
  container.replaceChildren();

  const name = document.createElement('span');
  name.className = 'author-name';
  name.innerText = parsed.displayName;
  container.appendChild(name);

  if (parsed.meta) {
    const meta = document.createElement('span');
    meta.className = 'author-meta';
    meta.innerText = parsed.meta;
    container.appendChild(meta);
  }
}

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

export function createIcon(kind: 'trash' | 'open'): SVGSVGElement {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false'
  }) as SVGSVGElement;

  if (kind === 'trash') {
    svg.append(
      svgEl('path', { d: 'M4 7h16' }),
      svgEl('path', { d: 'M10 11v6' }),
      svgEl('path', { d: 'M14 11v6' }),
      svgEl('path', { d: 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12' }),
      svgEl('path', { d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' })
    );
  } else {
    svg.append(
      svgEl('path', { d: 'M14 5h5v5' }),
      svgEl('path', { d: 'M20 4l-9 9' }),
      svgEl('path', { d: 'M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5' })
    );
  }

  return svg;
}

export function localDateStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
