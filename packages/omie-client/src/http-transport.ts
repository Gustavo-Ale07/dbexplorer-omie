import { REDACTED } from '@dbx/shared';
import type { OmieRequest, OmieTransport, TransportResponse } from './types';

export interface HttpTransportOptions {
  baseUrl: string;
  appKey: string;
  appSecret: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Maximum accepted response body size in bytes. */
  maxResponseBytes?: number;
}

/** Endpoint paths come from the resource registry; this guards against path tricks anyway. */
const ENDPOINT_PATTERN = /^[a-z]+(\/[a-z]+)+$/;
const CALL_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export function assertSafeRequest(req: OmieRequest): void {
  if (!ENDPOINT_PATTERN.test(req.endpoint))
    throw new Error(`Invalid Omie endpoint: ${req.endpoint}`);
  if (!CALL_PATTERN.test(req.call)) throw new Error(`Invalid Omie call: ${req.call}`);
}

export function createHttpTransport(options: HttpTransportOptions): OmieTransport {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    mode: 'live',

    describeEnvelope(req) {
      return { call: req.call, app_key: REDACTED, app_secret: REDACTED, param: [req.param] };
    },

    async send(req, signal): Promise<TransportResponse> {
      assertSafeRequest(req);
      const url = `${baseUrl}/${req.endpoint}/`;
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          call: req.call,
          app_key: options.appKey,
          app_secret: options.appSecret,
          param: [req.param],
        }),
        signal,
        redirect: 'error',
      });

      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > maxBytes) {
        await res.body?.cancel();
        return { httpStatus: res.status, body: undefined, rawSnippet: '[response too large]' };
      }
      const text = await res.text();
      if (text.length > maxBytes) {
        return { httpStatus: res.status, body: undefined, rawSnippet: '[response too large]' };
      }

      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfter = retryAfterHeader !== null ? Number(retryAfterHeader) : NaN;
      const extra = Number.isFinite(retryAfter) ? { retryAfterSeconds: retryAfter } : {};

      try {
        return { httpStatus: res.status, body: JSON.parse(text) as unknown, ...extra };
      } catch {
        return {
          httpStatus: res.status,
          body: undefined,
          rawSnippet: text.slice(0, 500),
          ...extra,
        };
      }
    },
  };
}
