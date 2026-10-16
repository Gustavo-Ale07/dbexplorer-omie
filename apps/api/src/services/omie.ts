import { OmieClient, createHttpTransport, createMockTransport } from '@dbx/omie-client';
import type { OmieCallTrace, OmieTransport } from '@dbx/omie-client';
import { createRedactor } from '@dbx/shared';
import { SqlEngine } from '@dbx/sql-engine';
import type { WritePolicy } from '@dbx/sql-engine';
import type { AppConfig } from '../config';
import { secretValues } from '../config';

export interface OmieRuntime {
  engine: SqlEngine;
  client: OmieClient;
  mode: 'mock' | 'live';
  policy: WritePolicy;
  redactor: (value: unknown) => unknown;
}

export function createOmieRuntime(
  config: AppConfig,
  transportOverride?: OmieTransport,
): OmieRuntime {
  const redactor = createRedactor(secretValues(config));
  const transport =
    transportOverride ??
    (config.omie.mode === 'live'
      ? createHttpTransport({
          baseUrl: config.omie.baseUrl,
          appKey: config.omie.appKey ?? '',
          appSecret: config.omie.appSecret ?? '',
        })
      : createMockTransport({ seed: 42, latencyMs: config.omie.mockLatencyMs }));
  const client = new OmieClient({
    transport,
    concurrency: config.omie.concurrency,
    timeoutMs: config.omie.timeoutMs,
    redactor,
  });
  const engine = new SqlEngine({
    client,
    limits: {
      maxRows: config.omie.maxRows,
      maxApiCalls: config.omie.maxApiCalls,
      maxWriteRows: config.omie.maxWriteRows,
      concurrency: config.omie.concurrency,
      queryTimeoutMs: config.omie.queryTimeoutMs,
    },
  });
  return {
    engine,
    client,
    mode: transport.mode,
    redactor,
    policy: {
      readOnly: config.omie.readOnly,
      allowInsert: config.omie.allowInsert,
      allowUpdate: config.omie.allowUpdate,
      allowDelete: config.omie.allowDelete,
    },
  };
}

/** Trace shape sent to the browser (already redacted by the client). */
export function publicTrace(t: OmieCallTrace) {
  return {
    id: t.id,
    endpoint: t.endpoint,
    call: t.call,
    kind: t.kind,
    startedAt: t.startedAt,
    durationMs: t.durationMs,
    attempts: t.attempts,
    ok: t.ok,
    httpStatus: t.httpStatus ?? null,
    errorCode: t.errorCode ?? null,
    errorMessage: t.errorMessage ?? null,
    request: t.request,
    response: t.response ?? null,
    responseTruncated: t.responseTruncated ?? false,
  };
}

/** Compact, body-free summary of Omie calls for the audit log. */
export function auditTrace(t: OmieCallTrace) {
  return {
    id: t.id,
    endpoint: t.endpoint,
    call: t.call,
    kind: t.kind,
    ok: t.ok,
    httpStatus: t.httpStatus ?? null,
    durationMs: t.durationMs,
    attempts: t.attempts,
    errorCode: t.errorCode ?? null,
  };
}
