import { AppError } from '@dbx/shared';

interface Running {
  userId: string;
  controller: AbortController;
}

/** In-flight read statements, so their owner (or an admin) can cancel them. */
export class ExecutionRegistry {
  private readonly running = new Map<string, Running>();
  private readonly writers = new Set<string>();

  start(executionId: string, userId: string): AbortController {
    if (this.running.has(executionId))
      throw new AppError('CONFLICT', 'An execution with this id is already running');
    const controller = new AbortController();
    this.running.set(executionId, { userId, controller });
    return controller;
  }

  finish(executionId: string): void {
    this.running.delete(executionId);
  }

  /** Returns false when unknown or not owned (indistinguishable to the caller). */
  cancel(executionId: string, userId: string, isAdmin: boolean): boolean {
    const r = this.running.get(executionId);
    if (!r || (r.userId !== userId && !isAdmin)) return false;
    r.controller.abort(new AppError('QUERY_CANCELLED', 'The query was cancelled by the user'));
    return true;
  }

  /** One write at a time per user: avoids racing confirmations from several tabs. */
  async exclusiveWrite<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    if (this.writers.has(userId))
      throw new AppError('CONFLICT', 'Another write of yours is still running');
    this.writers.add(userId);
    try {
      return await fn();
    } finally {
      this.writers.delete(userId);
    }
  }

  get size(): number {
    return this.running.size;
  }

  abortAll(): void {
    for (const r of this.running.values())
      r.controller.abort(new AppError('QUERY_CANCELLED', 'The server is shutting down'));
  }
}
