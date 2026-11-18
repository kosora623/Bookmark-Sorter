// @vitest-environment jsdom
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import { afterEach, describe, expect, it } from 'vitest';
import { applyTheme, bindThemeMenu, loadTheme } from '../src/dashboard/theme';

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.body.innerHTML = '';
});

describe('テーマ', () => {
  it('何も選んでいなければ自動で、data-theme は付けない', () => {
    expect(loadTheme()).toBe('auto');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('選んだテーマを data-theme に入れて覚え、自動に戻すと外す', () => {
    applyTheme('black');
    expect(document.documentElement.dataset.theme).toBe('black');
    expect(loadTheme()).toBe('black');

    applyTheme('auto');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(loadTheme()).toBe('auto');
  });

  it('表示メニューのラジオボタンは今のテーマを指し、選ぶとすぐ切り替わる', () => {
    applyTheme('dim');
    document.body.innerHTML = ['auto', 'light', 'dim', 'black']
      .map((value) => `<input type="radio" name="theme" value="${value}">`)
      .join('');
    bindThemeMenu();

    const radio = (value: string) => document.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
    expect(radio('dim').checked).toBe(true);

    radio('light').checked = true;
    radio('light').dispatchEvent(new Event('change'));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(loadTheme()).toBe('light');
  });

  it('描画前に読む public/theme-init.js も、同じ保存先からテーマを当てる', () => {
    applyTheme('black');
    delete document.documentElement.dataset.theme;

    const script = readFileSync(resolve(__dirname, '../public/theme-init.js'), 'utf-8');
    runInNewContext(script, { localStorage, document });
    expect(document.documentElement.dataset.theme).toBe('black');
  });
});
