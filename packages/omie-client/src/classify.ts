import type { ErrorCode } from '@dbx/shared';
import type { TransportResponse } from './types';

export type Classification =
  | { ok: true; body: Record<string, unknown> }
  | {
      ok: false;
      code: ErrorCode;
      message: string;
      /** Whether a read may be retried after backoff. Writes are never retried. */
      retryable: boolean;
      /** Omie answered "no records for this page" — callers treat this as an empty page. */
      noRecords?: boolean;
      faultCode?: string;
    };

interface Fault {
  message: string;
  faultCode?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asText(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (typeof v === 'number') return String(v);
  return undefined;
}

/**
 * Extracts an error from the known Omie error shapes:
 * - `{ faultstring, faultcode }` (SOAP-style JSON fault)
 * - `{ omie_fail: { code, description, referer, fatal } }` (documented type)
 * - `{ status, message }` (e.g. GET misuse)
 * - business status fields on write responses (`codigo_status` / `cCodStatus` != "0")
 */
function extractFault(body: Record<string, unknown>): Fault | undefined {
  const faultstring = asText(body.faultstring);
  if (faultstring) {
    const faultCode = asText(body.faultcode);
    return faultCode ? { message: faultstring, faultCode } : { message: faultstring };
  }
  if (isRecord(body.omie_fail)) {
    const fail = body.omie_fail;
    const message = asText(fail.description) ?? 'Omie returned an error';
    const faultCode = asText(fail.code);
    return faultCode ? { message, faultCode } : { message };
  }
  if (asText(body.status) && asText(body.message) && Object.keys(body).length <= 3) {
    const status = asText(body.status);
    if (status && status !== '0' && status !== '200') {
      return { message: asText(body.message) ?? 'Omie returned an error', faultCode: status };
    }
  }
  for (const [codeKey, descKey] of [
    ['codigo_status', 'descricao_status'],
    ['cCodStatus', 'cDesStatus'],
  ] as const) {
    const code = asText(body[codeKey]);
    if (code !== undefined && code !== '0' && /^\d+$/.test(code) && Number(code) > 0) {
      return {
        message: asText(body[descKey]) ?? `Omie returned status ${code}`,
        faultCode: code,
      };
    }
  }
  return undefined;
}

const NO_RECORDS = /n[ãa]o existem registros/i;
const REDUNDANT = /redundante|j[áa] foi (realizada|efetuada|feita)|consumo redundante/i;
const RATE =
  /too many requests|limite de requisi|requisi[çc][õo]es por minuto|aguarde .* segundos/i;
const AUTH =
  /app_key|app_secret|chave de acesso|aplicativo .*(inv[áa]lid|suspens|bloquead)|n[ãa]o autorizad/i;
const BLOCKED = /bloquead[ao] por consumo indevido|consumo indevido/i;
const UNSTABLE = /PROTO_BYEBYE|broken pipe|tente novamente mais tarde|servi[çc]o indispon[íi]vel/i;

export function classifyResponse(res: TransportResponse): Classification {
  const { httpStatus } = res;

  if (httpStatus === 425) {
    return {
      ok: false,
      code: 'OMIE_BLOCKED',
      message:
        'Omie blocked this app/method for misuse (HTTP 425). Omie lifts the block after about 30 minutes.',
      retryable: false,
    };
  }

  if (res.body === undefined) {
    if (httpStatus >= 500) {
      return {
        ok: false,
        code: 'OMIE_UNAVAILABLE',
        message: `Omie returned HTTP ${httpStatus}`,
        retryable: true,
      };
    }
    return {
      ok: false,
      code: 'OMIE_BAD_RESPONSE',
      message: `Omie returned a non-JSON response (HTTP ${httpStatus})`,
      retryable: false,
    };
  }

  if (!isRecord(res.body)) {
    return {
      ok: false,
      code: 'OMIE_BAD_RESPONSE',
      message: 'Omie returned an unexpected JSON shape',
      retryable: false,
    };
  }

  const fault = extractFault(res.body);
  if (fault) {
    const base = fault.faultCode ? { faultCode: fault.faultCode } : {};
    const message = `Omie: ${fault.message}`;
    if (NO_RECORDS.test(fault.message)) {
      return {
        ok: false,
        code: 'OMIE_API_ERROR',
        message,
        retryable: false,
        noRecords: true,
        ...base,
      };
    }
    if (BLOCKED.test(fault.message)) {
      return { ok: false, code: 'OMIE_BLOCKED', message, retryable: false, ...base };
    }
    if (REDUNDANT.test(fault.message)) {
      return {
        ok: false,
        code: 'OMIE_RATE_LIMITED',
        message: `${message} (redundant request: Omie ignores repeated requests for the same record within 60 seconds)`,
        retryable: false,
        ...base,
      };
    }
    if (httpStatus === 429 || RATE.test(fault.message)) {
      return { ok: false, code: 'OMIE_RATE_LIMITED', message, retryable: true, ...base };
    }
    if (AUTH.test(fault.message) || httpStatus === 401 || httpStatus === 403) {
      return { ok: false, code: 'OMIE_AUTH_ERROR', message, retryable: false, ...base };
    }
    if (UNSTABLE.test(fault.message)) {
      return { ok: false, code: 'OMIE_UNAVAILABLE', message, retryable: true, ...base };
    }
    return { ok: false, code: 'OMIE_API_ERROR', message, retryable: false, ...base };
  }

  if (httpStatus === 429) {
    return {
      ok: false,
      code: 'OMIE_RATE_LIMITED',
      message: 'Omie rate limit reached (HTTP 429)',
      retryable: true,
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      ok: false,
      code: 'OMIE_AUTH_ERROR',
      message: `Omie rejected the credentials (HTTP ${httpStatus})`,
      retryable: false,
    };
  }
  if (httpStatus >= 500) {
    return {
      ok: false,
      code: 'OMIE_UNAVAILABLE',
      message: `Omie returned HTTP ${httpStatus}`,
      retryable: true,
    };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      ok: false,
      code: 'OMIE_API_ERROR',
      message: `Omie returned HTTP ${httpStatus}`,
      retryable: false,
    };
  }

  return { ok: true, body: res.body };
}
