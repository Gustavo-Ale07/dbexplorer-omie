export const REDACTED = '***REDACTED***';

/**
 * Key names (normalized: lowercase, no separators) whose values must never be
 * emitted to logs, audit records, the API inspector or HTTP responses.
 */
const SENSITIVE_EXACT = new Set([
  'appkey',
  'appsecret',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwordhash',
  'newpassword',
  'currentpassword',
  'token',
  'apikey',
  'xapikey',
  'secret',
  'sessionsecret',
  'sessionid',
  'sid',
]);

const SENSITIVE_SUFFIXES = ['token', 'apikey', 'secret', 'password'];

const MIN_SECRET_VALUE_LENGTH = 6;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const k = normalizeKey(key);
  if (SENSITIVE_EXACT.has(k)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => k.endsWith(suffix));
}

type StringScrubber = (s: string) => string;

function walk(value: unknown, scrub: StringScrubber, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => walk(item, scrub, seen));

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = isSensitiveKey(key) ? REDACTED : walk(child, scrub, seen);
  }
  return out;
}

/** Deep-copies `value`, replacing values of sensitive keys. Never mutates input. */
export function redact<T>(value: T): unknown {
  return walk(value, (s) => s, new WeakSet());
}

/**
 * Builds a redactor that, besides sensitive keys, also scrubs occurrences of
 * known secret values (e.g. OMIE_APP_SECRET) embedded anywhere in strings.
 */
export function createRedactor(secretValues: readonly string[]): <T>(value: T) => unknown {
  const secrets = [...new Set(secretValues)]
    .filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_VALUE_LENGTH)
    .sort((a, b) => b.length - a.length);

  const scrub: StringScrubber = (s) => {
    let out = s;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  };

  return (value) => walk(value, scrub, new WeakSet());
}
