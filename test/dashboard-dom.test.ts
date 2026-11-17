// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { fillTextWithLinks, localDateStamp, parseAuthorLine, peelUrl } from '../src/dashboard/dom';
import { installInnerText } from './helpers/inner-text';

beforeAll(() => {
  installInnerText();
});

describe('parseAuthorLine', () => {
  it('表示名と「@handle · 日時」に分ける', () => {
    expect(parseAuthorLine('Jack @jack · 5月1日')).toEqual({ displayName: 'Jack', meta: '@jack · 5月1日' });
    expect(parseAuthorLine('ジャック ドーシー @jack')).toEqual({ displayName: 'ジャック ドーシー', meta: '@jack' });
  });

  it('形が違えば全体を名前として扱い、空なら「不明」', () => {
    expect(parseAuthorLine('名前だけ')).toEqual({ displayName: '名前だけ', meta: '' });
    expect(parseAuthorLine('   ')).toEqual({ displayName: '不明', meta: '' });
  });
});

describe('peelUrl', () => {
  it('末尾の句読点や閉じ括弧を URL から外す', () => {
    expect(peelUrl('https://example.com/a。')).toEqual({ url: 'https://example.com/a', trailing: '。' });
    expect(peelUrl('https://example.com/a)」')).toEqual({ url: 'https://example.com/a', trailing: ')」' });
    expect(peelUrl('https://example.com/a?b=1')).toEqual({ url: 'https://example.com/a?b=1', trailing: '' });
  });
});

describe('fillTextWithLinks', () => {
  it('URL だけをリンクにし、前後の文字はそのまま残す', () => {
    const el = document.createElement('div');
    fillTextWithLinks(el, '見て https://example.com/a。 と http://b.example');

    const links = [...el.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a', 'http://b.example']);
    expect(links.every((a) => a.target === '_blank' && a.rel === 'noopener noreferrer')).toBe(true);
    expect(el.textContent).toBe('見て https://example.com/a。 と http://b.example');
  });

  it('HTML として解釈しない', () => {
    const el = document.createElement('div');
    fillTextWithLinks(el, '<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('localDateStamp', () => {
  it('ファイル名用に「年月日-時分」にする', () => {
    expect(localDateStamp(new Date(2026, 0, 2, 3, 4))).toBe('20260102-0304');
  });
});
