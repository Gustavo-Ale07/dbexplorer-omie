export const ERROR_HTTP_STATUS = {
  AUTH_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  SESSION_EXPIRED: 401,
  ACCOUNT_LOCKED: 423,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  RESOURCE_NOT_FOUND: 400,
  COLUMN_NOT_FOUND: 400,
  AMBIGUOUS_COLUMN: 400,
  SQL_PARSE_ERROR: 400,
  SQL_UNSUPPORTED: 400,
  OPERATION_NOT_SUPPORTED: 400,
  COLUMN_NOT_WRITABLE: 400,
  REQUIRED_COLUMN_MISSING: 400,
  READ_ONLY_MODE: 403,
  INSERT_DISABLED: 403,
  UPDATE_DISABLED: 403,
  DELETE_DISABLED: 403,
  WHERE_REQUIRED: 400,
  WRITE_ROW_LIMIT_EXCEEDED: 400,
  WRITE_NO_TARGETS: 400,
  CONFIRMATION_REQUIRED: 428,
  CONFIRMATION_INVALID: 400,
  CONFIRMATION_EXPIRED: 410,
  CONFIRMATION_USED: 409,
  TARGETS_CHANGED: 409,
  QUERY_ROW_LIMIT_EXCEEDED: 400,
  QUERY_LIMIT_EXCEEDED: 400,
  API_CALL_LIMIT_EXCEEDED: 400,
  JOIN_CARDINALITY_LIMIT: 400,
  QUERY_TIMEOUT: 504,
  QUERY_CANCELLED: 499,
  OMIE_AUTH_ERROR: 502,
  OMIE_RATE_LIMITED: 429,
  OMIE_BLOCKED: 503,
  OMIE_API_ERROR: 502,
  OMIE_UNAVAILABLE: 503,
  OMIE_BAD_RESPONSE: 502,
  OMIE_NOT_CONFIGURED: 503,
  AI_PROVIDER_DISABLED: 400,
  AI_PROVIDER_ERROR: 502,
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
    this.details = details;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
    details?: ErrorDetails;
  };
}

/** Converts any thrown value to a client-safe payload. Unknown errors never leak their message. */
export function toErrorPayload(err: unknown, requestId?: string): ErrorPayload {
  if (isAppError(err)) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(requestId ? { requestId } : {}),
        ...(err.details ? { details: err.details } : {}),
      },
    };
  }
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected internal error',
      ...(requestId ? { requestId } : {}),
    },
  };
}
