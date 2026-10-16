import { AppError } from '@dbx/shared';

export type Release = () => void;

/** Counting semaphore with FIFO fairness and abort support. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<{ resolve: (r: Release) => void; reject: (e: unknown) => void }> =
    [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  }

  get pending(): number {
    return this.queue.length;
  }

  get running(): number {
    return this.active;
  }

  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<Release>((resolve, reject) => {
      const entry = {
        resolve: (r: Release) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(r);
        },
        reject,
      };
      const onAbort = () => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next.resolve(this.makeRelease());
      else this.active -= 1;
    };
  }
}

/** Maps an abort reason to the matching typed error. */
export function abortError(signal: AbortSignal | undefined): AppError {
  const reason: unknown = signal?.reason;
  if (reason instanceof AppError) return reason;
  if (reason instanceof DOMException && reason.name === 'TimeoutError') {
    return new AppError('QUERY_TIMEOUT', 'The query exceeded its time limit');
  }
  return new AppError('QUERY_CANCELLED', 'The query was cancelled');
}

/** Maps `items` through `fn` with at most `concurrency` in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      if (signal?.aborted) throw abortError(signal);
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker);
  await Promise.all(workers);
  return results;
}
