import type { OmieTrace, QueryResult, WritePreview, WriteResult } from '../api/types';
import { ApiError } from '../api/client';

export type RunState =
  | { status: 'idle' }
  | { status: 'running'; sql: string; executionId: string; startedAt: number }
  | { status: 'result'; sql: string; result: QueryResult }
  | { status: 'preview'; sql: string; preview: WritePreview }
  | { status: 'write'; sql: string; preview: WritePreview; write: WriteResult }
  | { status: 'error'; sql: string; error: unknown; traces: OmieTrace[] };

export function tracesOf(run: RunState): OmieTrace[] {
  switch (run.status) {
    case 'result':
      return run.result.traces;
    case 'preview':
      return run.preview.traces;
    case 'write':
      return [...run.write.traces];
    case 'error':
      return run.traces;
    default:
      return [];
  }
}

/** Omie calls made before a failure travel in error.details.traces. */
export function errorTraces(err: unknown): OmieTrace[] {
  if (err instanceof ApiError && Array.isArray(err.details?.traces))
    return err.details.traces as OmieTrace[];
  return [];
}
