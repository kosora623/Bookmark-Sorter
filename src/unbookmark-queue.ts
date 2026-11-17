import { isXStatusUrl } from './urls';

// 裏タブでの自動解除を 1 件ずつ順に進めるキュー。
// chrome.* には触らず、実際の解除・保存・失敗の記録は外から渡す（background.ts が chrome につなぐ）。

export interface UnbookmarkJob {
  url: string;
  /** これより前には実行しない（Date.now() の値） */
  earliest: number;
  /** これまでに失敗した回数 */
  attempts?: number;
}

export function isUnbookmarkJob(value: unknown): value is UnbookmarkJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<UnbookmarkJob>;
  return (
    typeof job.url === 'string' &&
    isXStatusUrl(job.url) &&
    typeof job.earliest === 'number' &&
    (job.attempts === undefined || typeof job.attempts === 'number')
  );
}

export interface UnbookmarkQueueOptions {
  /** 1 件解除する。解除できたら true */
  run: (url: string) => Promise<boolean>;
  /** キューが変わるたびに呼ぶ（保存とアラームの張り直し） */
  persist: (jobs: readonly UnbookmarkJob[]) => Promise<void>;
  /** 規定回数失敗して諦めたときに呼ぶ */
  giveUp: (url: string) => Promise<void>;
  maxAttempts: number;
  retryDelayMs: number;
  now?: () => number;
}

export class UnbookmarkQueue {
  private jobs: UnbookmarkJob[] = [];
  private running = false;
  private wakeWait: (() => void) | null = null;
  private readonly options: UnbookmarkQueueOptions;
  private readonly now: () => number;

  constructor(options: UnbookmarkQueueOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.jobs.length;
  }

  has(url: string): boolean {
    return this.jobs.some((job) => job.url === url);
  }

  snapshot(): readonly UnbookmarkJob[] {
    return [...this.jobs];
  }

  /** 保存しておいたキューを読み込む。壊れた要素は捨てる。保存はし直さない */
  load(raw: unknown): void {
    this.jobs = Array.isArray(raw) ? raw.filter(isUnbookmarkJob) : [];
  }

  /** delayMs 後に解除する。すでに入っていれば何もせず false */
  async enqueue(url: string, delayMs: number): Promise<boolean> {
    if (this.has(url)) return false;
    this.jobs.push({ url, earliest: this.now() + delayMs });
    await this.options.persist(this.jobs);
    void this.process();
    return true;
  }

  /** 指定の URL を取り除く（Undo 用）。実行中のものは、終わったときに結果を捨てる */
  async cancel(urls: readonly string[]): Promise<void> {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => !urls.includes(job.url));
    if (this.jobs.length !== before) await this.options.persist(this.jobs);
    // 取り除いたものを待っていたなら、待たずに次へ進ませる
    this.wake();
  }

  async clear(): Promise<void> {
    this.jobs = [];
    this.wake();
    await this.options.persist(this.jobs);
  }

  /** 先頭から順に処理する。すでに動いていれば何もしない */
  async process(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (this.jobs.length > 0) {
        const job = this.jobs[0];
        if (!job) break;

        const wait = job.earliest - this.now();
        if (wait > 0) {
          await this.wait(wait);
          continue;
        }

        const ok = await this.options.run(job.url);
        // 実行中に Undo や全消去でキューから外れていたら、結果は捨てる
        if (this.jobs[0] !== job) continue;
        this.jobs.shift();

        if (!ok) {
          const attempts = (job.attempts ?? 0) + 1;
          if (attempts < this.options.maxAttempts) {
            this.jobs.push({ url: job.url, earliest: this.now() + this.options.retryDelayMs, attempts });
          } else {
            await this.options.giveUp(job.url);
          }
        }
        await this.options.persist(this.jobs);
      }
    } finally {
      this.running = false;
    }

    if (this.jobs.length > 0) void this.process();
  }

  private wake(): void {
    const wake = this.wakeWait;
    this.wakeWait = null;
    wake?.();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeWait = null;
        resolve();
      }, ms);
      this.wakeWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
