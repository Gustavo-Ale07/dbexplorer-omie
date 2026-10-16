import { randomUUID } from 'node:crypto';
import { AppError, isAppError, redact } from '@dbx/shared';
import { classifyResponse } from './classify';
import { ConcurrencyLimiter, abortError } from './limiter';
import type {
  CallContext,
  OmieCallTrace,
  OmieMode,
  OmieRequest,
  OmieTransport,
  TransportResponse,
} from './types';

export interface RetryPolicy {
  /** Extra attempts after the first one (reads only). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface OmieClientOptions {
  transport: OmieTransport;
  /** Process-wide cap on in-flight Omie requests (Omie allows 4 per IP + app + method). */
  concurrency: number;
  /** Per-attempt timeout. */
  timeoutMs: number;
  retry?: Partial<RetryPolicy>;
  /** Scrubs secrets from traces and errors; defaults to key-based redaction. */
  redactor?: (value: unknown) => unknown;
  /** Max serialized size of a response kept in a trace. */
  maxTraceResponseChars?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface OmieCallResult {
  body: Record<string, unknown>;
  /** True when Omie answered "no records for this page" (treated as an empty list page). */
  noRecords: boolean;
  trace: OmieCallTrace;
}

const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8000 };

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class OmieClient {
  readonly mode: OmieMode;
  private readonly limiter: ConcurrencyLimiter;
  private readonly retry: RetryPolicy;
  private readonly redactor: (value: unknown) => unknown;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly maxTraceChars: number;

  constructor(private readonly options: OmieClientOptions) {
    this.mode = options.transport.mode;
    this.limiter = new ConcurrencyLimiter(options.concurrency);
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.redactor = options.redactor ?? redact;
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    this.maxTraceChars = options.maxTraceResponseChars ?? 200_000;
  }

  /** Redacted wire envelope for display (API Request tab / inspector). */
  describe(request: OmieRequest): unknown {
    return this.redactor(this.options.transport.describeEnvelope(request));
  }

  /**
   * Performs one logical Omie call: concurrency-limited, timed out per attempt,
   * retried with jittered backoff for transient read failures only. Writes are
   * attempted exactly once; an ambiguous write failure is reported as such.
   */
  async call(request: OmieRequest, ctx: CallContext = {}): Promise<OmieCallResult> {
    const trace: OmieCallTrace = {
      id: randomUUID(),
      endpoint: request.endpoint,
      call: request.call,
      kind: request.kind,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      attempts: 0,
      ok: false,
      request: this.describe(request),
    };
    const started = performance.now();
    const finish = (patch: Partial<OmieCallTrace>) => {
      Object.assign(trace, patch, { durationMs: Math.round(performance.now() - started) });
      ctx.onTrace?.(trace);
    };

    const maxAttempts = request.kind === 'read' ? 1 + this.retry.maxRetries : 1;
    let lastError: AppError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (ctx.signal?.aborted) {
        const err = abortError(ctx.signal);
        finish({ errorCode: err.code, errorMessage: err.message });
        throw err;
      }
      trace.attempts = attempt;

      let response: TransportResponse;
      try {
        response = await this.limiter.run(() => this.attempt(request, ctx.signal), ctx.signal);
      } catch (err) {
        if (ctx.signal?.aborted) {
          const e = abortError(ctx.signal);
          finish({ errorCode: e.code, errorMessage: e.message });
          throw e;
        }
        lastError = this.networkError(request, err);
        if (attempt < maxAttempts) {
          await this.backoff(attempt, undefined, ctx.signal);
          continue;
        }
        finish({ errorCode: lastError.code, errorMessage: lastError.message });
        throw lastError;
      }

      const classification = classifyResponse(response);
      const responseForTrace = this.traceBody(response);
      if (classification.ok) {
        finish({ ok: true, httpStatus: response.httpStatus, ...responseForTrace });
        return { body: classification.body, noRecords: false, trace };
      }

      if (classification.noRecords && request.kind === 'read') {
        finish({ ok: true, httpStatus: response.httpStatus, ...responseForTrace });
        return { body: {}, noRecords: true, trace };
      }

      lastError = new AppError(classification.code, this.scrub(classification.message), {
        endpoint: request.endpoint,
        call: request.call,
        httpStatus: response.httpStatus,
        ...(classification.faultCode ? { faultCode: classification.faultCode } : {}),
      });

      if (classification.retryable && attempt < maxAttempts) {
        await this.backoff(attempt, response.retryAfterSeconds, ctx.signal);
        continue;
      }
      finish({
        httpStatus: response.httpStatus,
        errorCode: lastError.code,
        errorMessage: lastError.message,
        ...responseForTrace,
      });
      throw lastError;
    }

    /* c8 ignore next */
    throw lastError ?? new AppError('OMIE_UNAVAILABLE', 'Omie call failed');
  }

  private async attempt(request: OmieRequest, outer?: AbortSignal): Promise<TransportResponse> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
    try {
      return await this.options.transport.send(request, signal);
    } catch (err) {
      if (timeout.aborted && !outer?.aborted) {
        throw new OmieTimeoutError(this.options.timeoutMs);
      }
      throw err;
    }
  }

  private networkError(request: OmieRequest, err: unknown): AppError {
    if (isAppError(err)) return err;
    const timedOut = err instanceof OmieTimeoutError;
    const what = timedOut ? `timed out after ${this.options.timeoutMs} ms` : 'could not be reached';
    const suffix =
      request.kind === 'write'
        ? ' The outcome of this write is UNKNOWN: verify the record in Omie before trying again.'
        : '';
    return new AppError('OMIE_UNAVAILABLE', `Omie ${what} (${request.call}).${suffix}`, {
      endpoint: request.endpoint,
      call: request.call,
      ...(request.kind === 'write' ? { writeOutcomeUnknown: true } : {}),
    });
  }

  private async backoff(
    attempt: number,
    retryAfterSeconds: number | undefined,
    signal?: AbortSignal,
  ) {
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    const jittered = Math.round(exp / 2 + this.random() * (exp / 2));
    const hinted =
      retryAfterSeconds !== undefined
        ? Math.min(this.retry.maxDelayMs, retryAfterSeconds * 1000)
        : 0;
    await this.sleep(Math.max(jittered, hinted), signal);
  }

  private scrub(message: string): string {
    const out = this.redactor(message);
    return typeof out === 'string' ? out : message;
  }

  private traceBody(res: TransportResponse): Pick<OmieCallTrace, 'response' | 'responseTruncated'> {
    const value = res.body === undefined ? { nonJsonBody: res.rawSnippet ?? '' } : res.body;
    const redacted = this.redactor(value);
    const serialized = JSON.stringify(redacted) ?? '';
    if (serialized.length > this.maxTraceChars) {
      return {
        response: { truncated: true, preview: serialized.slice(0, this.maxTraceChars) },
        responseTruncated: true,
      };
    }
    return { response: redacted };
  }
}

class OmieTimeoutError extends Error {
  constructor(ms: number) {
    super(`Omie request timed out after ${ms} ms`);
    this.name = 'OmieTimeoutError';
  }
}
