import { describe, expect, it } from 'vitest';
import { nextFolderOrder, reorderFolderRecords, sortFolderRecords } from '../src/folder-order';
import { movedFolderNames } from '../src/dashboard/kept-view';

describe('sortFolderRecords', () => {
  it('order の順に並べ、order の無い古いフォルダは未分類を先頭に名前順で後ろへ置く', () => {
    const sorted = sortFolderRecords([
      { name: 'b' },
      { name: '技術', order: 1 },
      { name: '未分類' },
      { name: 'a' },
      { name: '料理', order: 0 }
    ]);
    expect(sorted.map((folder) => folder.name)).toEqual(['料理', '技術', '未分類', 'a', 'b']);
  });
});

describe('nextFolderOrder', () => {
  it('今ある最大の order の次を返す', () => {
    expect(nextFolderOrder([])).toBe(0);
    expect(nextFolderOrder([{ name: 'a', order: 3 }, { name: 'b' }])).toBe(4);
  });
});

describe('reorderFolderRecords', () => {
  it('指定の順に並べ、指定に無いものは今の並びで後ろに続け、知らない名前と重複は無視する', () => {
    const records = [
      { name: '未分類', order: 0 },
      { name: 'a', order: 1 },
      { name: 'b', order: 2 },
      { name: 'c', order: 3 }
    ];
    expect(reorderFolderRecords(records, ['c', 'x', 'a', 'c'])).toEqual([
      { name: 'c', order: 0 },
      { name: 'a', order: 1 },
      { name: '未分類', order: 2 },
      { name: 'b', order: 3 }
    ]);
  });
});

describe('movedFolderNames', () => {
  const names = ['未分類', 'a', 'b', 'c'];
  it('落とし先の前か後ろに動かす', () => {
    expect(movedFolderNames(names, 'c', 'a', false)).toEqual(['未分類', 'c', 'a', 'b']);
    expect(movedFolderNames(names, '未分類', 'b', true)).toEqual(['a', 'b', '未分類', 'c']);
  });
  it('知らない名前なら並びを変えない', () => {
    expect(movedFolderNames(names, 'x', 'a', false)).toEqual(names);
  });
});
