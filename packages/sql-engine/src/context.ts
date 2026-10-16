/**
 * Per-execution state: API call budget, response cache, traces and the
 * materialization guard. A new context is created for every statement so
 * concurrent queries never share budgets or cached data.
 */
import { AppError, isAppError } from '@dbx/shared';
import type { OmieCallTrace, OmieClient, OmieRequest } from '@dbx/omie-client';

export interface EngineLimits {
  /** Max rows returned by a SELECT (implicit LIMIT). */
  maxRows: number;
  /** Max Omie calls a single statement may perform. */
  maxApiCalls: number;
  /** Max records affected by one UPDATE / DELETE. */
  maxWriteRows: number;
  /** Parallel Omie calls per statement (the client also caps process-wide). */
  concurrency: number;
  /** Wall-clock limit for one statement. */
  queryTimeoutMs: number;
  /** Max rows held in memory while evaluating a statement. */
  maxMaterializedRows: number;
  /** Max distinct keys resolved with Consultar* lookups (PK lookup / join lookup). */
  lookupMaxKeys: number;
  /** Max values of an IN list split into separate filtered scans. */
  partitionMaxValues: number;
  /** Max keys sent in one multi-value filter request. */
  inChunkSize: number;
  /** Full request/response bodies kept for the first N traces. */
  maxDetailedTraces: number;
}

export const DEFAULT_LIMITS: EngineLimits = {
  maxRows: 1000,
  maxApiCalls: 100,
  maxWriteRows: 50,
  concurrency: 4,
  queryTimeoutMs: 120_000,
  maxMaterializedRows: 50_000,
  lookupMaxKeys: 50,
  partitionMaxValues: 10,
  inChunkSize: 50,
  maxDetailedTraces: 20,
};

export interface CallOutcome {
  body: Record<string, unknown>;
  noRecords: boolean;
}

export class ExecutionContext {
  apiCalls = 0;
  materialized = 0;
  readonly traces: OmieCallTrace[] = [];
  private readonly cache = new Map<string, Promise<CallOutcome>>();

  constructor(
    readonly client: OmieClient,
    readonly limits: EngineLimits,
    readonly signal: AbortSignal,
    private readonly observer?: (trace: OmieCallTrace) => void,
  ) {}

  /** Read call with per-execution de-duplication and budget accounting. */
  read(request: Omit<OmieRequest, 'kind'>): Promise<CallOutcome> {
    const key = `${request.endpoint}:${request.call}:${JSON.stringify(request.param)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const promise = this.invoke({ ...request, kind: 'read' });
    this.cache.set(key, promise);
    promise.catch(() => this.cache.delete(key));
    return promise;
  }

  /** Write call: never cached, never retried (the client enforces single attempt). */
  write(request: Omit<OmieRequest, 'kind'>): Promise<CallOutcome> {
    return this.invoke({ ...request, kind: 'write' });
  }

  private async invoke(request: OmieRequest): Promise<CallOutcome> {
    if (this.apiCalls >= this.limits.maxApiCalls) {
      throw new AppError(
        'API_CALL_LIMIT_EXCEEDED',
        `This statement needs more than ${this.limits.maxApiCalls} Omie API calls (OMIE_MAX_API_CALLS). Add filters or a smaller LIMIT.`,
        { maxApiCalls: this.limits.maxApiCalls },
      );
    }
    this.apiCalls += 1;
    const { body, noRecords } = await this.client.call(request, {
      signal: this.signal,
      onTrace: (trace) => this.addTrace(trace),
    });
    return { body, noRecords };
  }

  private addTrace(trace: OmieCallTrace): void {
    this.observer?.(trace);
    if (this.traces.length >= this.limits.maxDetailedTraces && trace.response !== undefined) {
      const { response: _dropped, ...rest } = trace;
      this.traces.push({ ...rest, responseTruncated: true });
      return;
    }
    this.traces.push(trace);
  }

  materialize(count: number): void {
    this.materialized += count;
    if (this.materialized > this.limits.maxMaterializedRows) {
      throw new AppError(
        'QUERY_LIMIT_EXCEEDED',
        `This statement would hold more than ${this.limits.maxMaterializedRows} rows in memory. Add filters to reduce the data read from Omie.`,
      );
    }
  }

  throwIfAborted(): void {
    if (this.signal.aborted) {
      const reason: unknown = this.signal.reason;
      if (isAppError(reason)) throw reason;
      if (reason instanceof DOMException && reason.name === 'TimeoutError') {
        throw new AppError('QUERY_TIMEOUT', 'The query exceeded its time limit');
      }
      throw new AppError('QUERY_CANCELLED', 'The query was cancelled');
    }
  }
}
