// jsdom は innerText を実装していない。ブラウザではブロック要素ごとに改行されるので、
// その部分だけ真似た簡易版を入れる（CSS による表示・非表示は考慮しない）。

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'ARTICLE', 'SECTION']);

function approximateInnerText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof HTMLBRElement) return '\n';
  const inner = Array.from(node.childNodes).map(approximateInnerText).join('');
  return node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName) ? `\n${inner}\n` : inner;
}

export function installInnerText(): void {
  if ('innerText' in HTMLElement.prototype) return;
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      // ブラウザ同様、行内の連続する空白はまとめ、空行は詰める
      return approximateInnerText(this)
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
    },
    set(this: HTMLElement, value: string) {
      this.textContent = value;
    }
  });
}
