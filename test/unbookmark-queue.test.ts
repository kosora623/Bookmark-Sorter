import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnbookmarkQueue, isUnbookmarkJob, type UnbookmarkJob } from '../src/unbookmark-queue';

const A = 'https://x.com/a/status/1';
const B = 'https://x.com/b/status/2';
const RETRY_DELAY = 5_000;

/** run の結果をテストから決められるようにした解除処理 */
function controllableRun() {
  const pending = new Map<string, (ok: boolean) => void>();
  const run = vi.fn(
    (url: string) =>
      new Promise<boolean>((resolve) => {
        pending.set(url, resolve);
      })
  );
  const finish = (url: string, ok: boolean): void => {
    const resolve = pending.get(url);
    if (!resolve) throw new Error(`${url} は実行中ではありません`);
    pending.delete(url);
    resolve(ok);
  };
  return { run, finish };
}

function createQueue(run: (url: string) => Promise<boolean>) {
  const persisted: UnbookmarkJob[][] = [];
  const giveUp = vi.fn(async (_url: string) => {});
  const queue = new UnbookmarkQueue({
    run,
    persist: async (jobs) => {
      persisted.push([...jobs]);
    },
    giveUp,
    maxAttempts: 3,
    retryDelayMs: RETRY_DELAY
  });
  return { queue, persisted, giveUp };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UnbookmarkQueue', () => {
  it('待ち時間が過ぎてから順に解除し、終わったら空で保存する', async () => {
    const { run, finish } = controllableRun();
    const { queue, persisted } = createQueue(run);

    await queue.enqueue(A, 2_000);
    await queue.enqueue(B, 2_000);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith(A);

    finish(A, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenLastCalledWith(B);

    finish(B, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.size).toBe(0);
    expect(persisted.at(-1)).toEqual([]);
  });

  it('同じ URL は二重に入れない', async () => {
    const { queue } = createQueue(controllableRun().run);
    expect(await queue.enqueue(A, 1_000)).toBe(true);
    expect(await queue.enqueue(A, 1_000)).toBe(false);
    expect(queue.size).toBe(1);
  });

  it('失敗したら待ってから再試行し、規定回数で諦めて記録する', async () => {
    const { run, finish } = controllableRun();
    const { queue, giveUp } = createQueue(run);

    await queue.enqueue(A, 0);
    await vi.advanceTimersByTimeAsync(0);
    finish(A, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.snapshot()).toEqual([{ url: A, earliest: Date.now() + RETRY_DELAY, attempts: 1 }]);

    // 再試行までは実行しない
    await vi.advanceTimersByTimeAsync(RETRY_DELAY - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    finish(A, false);

    await vi.advanceTimersByTimeAsync(RETRY_DELAY);
    expect(run).toHaveBeenCalledTimes(3);
    finish(A, false);
    await vi.advanceTimersByTimeAsync(0);

    expect(giveUp).toHaveBeenCalledWith(A);
    expect(queue.size).toBe(0);
  });

  it('待っている間に取り消されたら、待たずに次へ進む', async () => {
    const { run } = controllableRun();
    const { queue } = createQueue(run);

    await queue.enqueue(A, 60_000);
    await queue.enqueue(B, 0);
    await queue.cancel([A]);
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith(B);
  });

  it('実行中に取り消されたら、結果は捨てて再試行も記録もしない', async () => {
    const { run, finish } = controllableRun();
    const { queue, giveUp } = createQueue(run);

    await queue.enqueue(A, 0);
    await vi.advanceTimersByTimeAsync(0);
    await queue.cancel([A]);
    finish(A, false);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY * 2);

    expect(run).toHaveBeenCalledTimes(1);
    expect(giveUp).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  it('process を重ねて呼んでも同時に 2 件は走らない', async () => {
    const { run } = controllableRun();
    const { queue } = createQueue(run);

    queue.load([{ url: A, earliest: 0 }, { url: B, earliest: 0 }]);
    void queue.process();
    void queue.process();
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('clear で空にして保存する', async () => {
    const { queue, persisted } = createQueue(controllableRun().run);
    await queue.enqueue(A, 60_000);
    await queue.clear();
    expect(queue.size).toBe(0);
    expect(persisted.at(-1)).toEqual([]);
  });

  it('load は壊れた要素を捨てる', () => {
    const { queue } = createQueue(controllableRun().run);
    queue.load([{ url: A, earliest: 1 }, { url: 'https://example.com/a/status/1', earliest: 1 }, { url: B }, null]);
    expect(queue.snapshot()).toEqual([{ url: A, earliest: 1 }]);

    queue.load('broken');
    expect(queue.size).toBe(0);
  });
});

describe('isUnbookmarkJob', () => {
  it('X のポスト URL と数値の earliest を持つものだけ通す', () => {
    expect(isUnbookmarkJob({ url: A, earliest: 0 })).toBe(true);
    expect(isUnbookmarkJob({ url: A, earliest: 0, attempts: 2 })).toBe(true);
    expect(isUnbookmarkJob({ url: A, earliest: '0' })).toBe(false);
    expect(isUnbookmarkJob({ url: A, earliest: 0, attempts: '2' })).toBe(false);
    expect(isUnbookmarkJob({ url: 'https://x.com/home', earliest: 0 })).toBe(false);
  });
});
