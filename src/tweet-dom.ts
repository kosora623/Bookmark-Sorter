// content script 専用の DOM ヘルパー。content.ts からだけ import するので content.js に同梱され、
// web_accessible_resources に新しいチャンクを足す必要はない。

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
