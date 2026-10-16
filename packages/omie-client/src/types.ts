import type { ErrorCode } from '@dbx/shared';

export type OmieMode = 'mock' | 'live';

/** `read` calls may be retried on transient failures; `write` calls never are. */
export type OmieCallKind = 'read' | 'write';

export interface OmieRequest {
  /** Service path relative to the base URL, e.g. `geral/clientes`. */
  endpoint: string;
  /** Omie method name, e.g. `ListarClientes`. */
  call: string;
  /** The single request object; it is wrapped in the `param` array on the wire. */
  param: Record<string, unknown>;
  kind: OmieCallKind;
}

/** Raw outcome of one HTTP exchange (or one mock dispatch). */
export interface TransportResponse {
  httpStatus: number;
  /** Parsed JSON body, or `undefined` when the body was not valid JSON. */
  body: unknown;
  /** First bytes of the raw body when JSON parsing failed (already redacted by the client). */
  rawSnippet?: string;
  retryAfterSeconds?: number;
}

export interface OmieTransport {
  readonly mode: OmieMode;
  /** Performs exactly one attempt. Throws only on network-level failures or abort. */
  send(request: OmieRequest, signal: AbortSignal): Promise<TransportResponse>;
  /** Wire envelope as it would be sent, with credentials replaced by placeholders. */
  describeEnvelope(request: OmieRequest): Record<string, unknown>;
}

export interface OmieCallTrace {
  id: string;
  endpoint: string;
  call: string;
  kind: OmieCallKind;
  startedAt: string;
  durationMs: number;
  attempts: number;
  ok: boolean;
  httpStatus?: number;
  errorCode?: ErrorCode;
  errorMessage?: string;
  /** Redacted request envelope (credentials never included). */
  request: unknown;
  /** Redacted response body, possibly truncated. */
  response?: unknown;
  responseTruncated?: boolean;
}

export interface CallContext {
  signal?: AbortSignal;
  onTrace?: (trace: OmieCallTrace) => void;
}
