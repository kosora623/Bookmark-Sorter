// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmDialog, showToast } from '../src/dashboard/notify';

function dialog(): HTMLElement | null {
  return document.querySelector('.modal');
}

function button(role: 'confirm' | 'cancel'): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`.modal button[data-role="${role}"]`);
  if (!el) throw new Error('ダイアログのボタンがありません');
  return el;
}

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '<button id="opener">開く</button>';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('showToast', () => {
  it('メッセージを出し、時間がたつと消える。エラーは長めに出す', () => {
    vi.useFakeTimers();
    showToast('保存しました', 'success');
    showToast('失敗しました', 'error');

    const toasts = [...document.querySelectorAll('.toast')];
    expect(toasts.map((t) => t.textContent)).toEqual(['保存しました', '失敗しました']);
    expect(toasts.map((t) => t.getAttribute('role'))).toEqual(['status', 'alert']);

    vi.advanceTimersByTime(4_000);
    expect([...document.querySelectorAll('.toast')].map((t) => t.textContent)).toEqual(['失敗しました']);
    vi.advanceTimersByTime(3_000);
    expect(document.querySelectorAll('.toast')).toHaveLength(0);
  });

  it('クリックで消え、たまりすぎたら古いものから消す', () => {
    for (let i = 1; i <= 5; i++) showToast(`通知${i}`);
    const toasts = [...document.querySelectorAll<HTMLElement>('.toast')];
    expect(toasts.map((t) => t.textContent)).toEqual(['通知3', '通知4', '通知5']);

    toasts[0]?.click();
    expect(document.querySelectorAll('.toast')).toHaveLength(2);
  });

  it('メッセージを HTML として解釈しない', () => {
    showToast('<img src=x>');
    expect(document.querySelector('.toast img')).toBeNull();
  });
});

describe('confirmDialog', () => {
  it('実行ボタンで true になり、ダイアログを閉じて元の場所にフォーカスを戻す', async () => {
    document.getElementById('opener')?.focus();
    const result = confirmDialog({ message: '消しますか？', confirmLabel: '消す' });

    expect(dialog()?.textContent).toContain('消しますか？');
    expect(button('confirm').textContent).toBe('消す');
    button('confirm').click();

    await expect(result).resolves.toBe(true);
    expect(dialog()).toBeNull();
    expect(document.activeElement?.id).toBe('opener');
  });

  it('キャンセル・Escape・背景のクリックでは false', async () => {
    const byCancel = confirmDialog({ message: 'a', confirmLabel: 'OK' });
    button('cancel').click();
    await expect(byCancel).resolves.toBe(false);

    const byEscape = confirmDialog({ message: 'b', confirmLabel: 'OK' });
    press('Escape');
    await expect(byEscape).resolves.toBe(false);

    const byBackdrop = confirmDialog({ message: 'c', confirmLabel: 'OK' });
    document.querySelector<HTMLElement>('.modal-backdrop')?.click();
    await expect(byBackdrop).resolves.toBe(false);
  });

  it('取り消せない操作では、最初のフォーカスをキャンセル側に置く', async () => {
    const dangerous = confirmDialog({ message: 'a', confirmLabel: '全消去', danger: true });
    expect(document.activeElement).toBe(button('cancel'));
    expect(button('confirm').classList.contains('modal-btn-danger')).toBe(true);
    button('cancel').click();
    await dangerous;

    const normal = confirmDialog({ message: 'b', confirmLabel: '読み込む' });
    expect(document.activeElement).toBe(button('confirm'));
    button('cancel').click();
    await normal;
  });

  it('Tab でフォーカスがダイアログの外に出ない', async () => {
    const result = confirmDialog({ message: 'a', confirmLabel: 'OK' });
    expect(document.activeElement).toBe(button('confirm'));
    press('Tab');
    expect(document.activeElement).toBe(button('cancel'));
    press('Tab');
    expect(document.activeElement).toBe(button('confirm'));
    button('cancel').click();
    await result;
  });

  it('開いている間は、画面側のキー操作にキーが届かない', async () => {
    const pageHandler = vi.fn();
    document.addEventListener('keydown', pageHandler);

    const result = confirmDialog({ message: 'a', confirmLabel: 'OK' });
    press('ArrowRight');
    press('z');
    expect(pageHandler).not.toHaveBeenCalled();

    button('cancel').click();
    await result;
    press('ArrowRight');
    expect(pageHandler).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', pageHandler);
  });
});
