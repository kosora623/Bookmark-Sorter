// window.alert / confirm の代わり。alert と confirm は画面全体を止めてしまい、見た目も揃わないので、
// 画面内に出すトーストと確認ダイアログにする。

export type ToastKind = 'info' | 'success' | 'error';

const TOAST_MS: Record<ToastKind, number> = { info: 4_000, success: 4_000, error: 7_000 };
const MAX_TOASTS = 3;

function toastArea(): HTMLElement {
  let area = document.getElementById('toast-area');
  if (!area) {
    area = document.createElement('div');
    area.id = 'toast-area';
    area.className = 'toast-area';
    document.body.appendChild(area);
  }
  return area;
}

/** 画面の隅に短いメッセージを出す。しばらくすると消え、クリックでもすぐ消せる */
export function showToast(message: string, kind: ToastKind = 'info'): void {
  const area = toastArea();
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  // エラーはすぐ読み上げ、それ以外は区切りのよいところで読み上げる
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toast.textContent = message;

  const close = (): void => {
    clearTimeout(timer);
    toast.remove();
  };
  const timer = setTimeout(close, TOAST_MS[kind]);
  toast.addEventListener('click', close);

  area.appendChild(toast);
  while (area.children.length > MAX_TOASTS) area.firstElementChild?.remove();
}

export interface ConfirmOptions {
  message: string;
  /** 実行するボタンの文言（「削除する」など） */
  confirmLabel: string;
  /** 取り消せない操作なら true。ボタンを赤くし、最初のフォーカスをキャンセル側に置く */
  danger?: boolean;
}

/**
 * 確認ダイアログを出し、実行なら true、キャンセルなら false で解決する。
 * 開いている間は、選別のショートカットなど画面のキー操作に届かないようにする。
 */
export function confirmDialog({ message, confirmLabel, danger = false }: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'modal';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    const text = document.createElement('p');
    text.className = 'modal-message';
    text.id = 'modal-message';
    text.textContent = message;
    dialog.setAttribute('aria-describedby', text.id);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'modal-btn';
    cancelBtn.dataset.role = 'cancel';
    cancelBtn.textContent = 'キャンセル';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = `modal-btn ${danger ? 'modal-btn-danger' : 'modal-btn-primary'}`;
    confirmBtn.dataset.role = 'confirm';
    confirmBtn.textContent = confirmLabel;

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    actions.append(cancelBtn, confirmBtn);
    dialog.append(text, actions);
    backdrop.appendChild(dialog);

    const close = (result: boolean): void => {
      window.removeEventListener('keydown', onKeydown, true);
      backdrop.remove();
      previousFocus?.focus();
      resolve(result);
    };

    const onKeydown = (e: KeyboardEvent): void => {
      // 画面側のショートカットに届かないようにする（Enter・Tab の既定の動きはそのまま）
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Tab') {
        // フォーカスをダイアログの中に閉じ込める
        e.preventDefault();
        (document.activeElement === confirmBtn ? cancelBtn : confirmBtn).focus();
      }
    };

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });
    window.addEventListener('keydown', onKeydown, true);

    document.body.appendChild(backdrop);
    (danger ? cancelBtn : confirmBtn).focus();
  });
}
