import { z } from 'zod';

/** Values shipped in .env.example; production refuses to boot with them. */
export const PLACEHOLDER_SECRETS = new Set([
  'change-me-to-a-long-random-string-at-least-32-chars',
  'change-me',
  'changeme',
  'secret',
  'dev-session-secret-not-for-production-use-0000',
]);
export const PLACEHOLDER_PASSWORDS = new Set([
  'ChangeMe!2026',
  'change-me',
  'changeme',
  'admin',
  'password',
  'admin123',
]);

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? fallback : v === 'true' || v === '1' || v === 'yes',
    );

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(3001, 1, 65535),
  APP_URL: z.url().default('http://localhost:5173'),
  TRUST_PROXY: z.string().default('false'),
  /** Host address compose publishes the port on (read only to catch an unsafe TRUST_PROXY). */
  APP_BIND: optionalText,
  DATABASE_URL: z.string().min(1).default('pglite:memory'),
  MIGRATIONS_DIR: optionalText,
  STATIC_DIR: optionalText,

  SESSION_SECRET: z.string().default('dev-session-secret-not-for-production-use-0000'),
  SESSION_HOURS: int(12, 1, 24 * 30),
  LOGIN_MAX_ATTEMPTS: int(5, 1, 100),
  LOGIN_LOCK_MINUTES: int(15, 1, 24 * 60),
  WRITE_CONFIRMATION_TTL_SECONDS: int(120, 15, 900),

  BOOTSTRAP_ADMIN_EMAIL: optionalText,
  BOOTSTRAP_ADMIN_PASSWORD: optionalText,
  BOOTSTRAP_ADMIN_NAME: z.string().default('Administrador'),

  OMIE_MODE: z.enum(['mock', 'live']).default('mock'),
  OMIE_BASE_URL: z.url().default('https://app.omie.com.br/api/v1'),
  OMIE_APP_KEY: optionalText,
  OMIE_APP_SECRET: optionalText,
  OMIE_TIMEOUT_MS: int(60_000, 1000, 600_000),
  OMIE_QUERY_TIMEOUT_MS: int(120_000, 1000, 1_800_000),
  OMIE_READ_ONLY: bool(true),
  OMIE_ALLOW_INSERT: bool(false),
  OMIE_ALLOW_UPDATE: bool(false),
  OMIE_ALLOW_DELETE: bool(false),
  OMIE_MAX_ROWS: int(1000, 1, 100_000),
  OMIE_MAX_API_CALLS: int(100, 1, 10_000),
  OMIE_MAX_WRITE_ROWS: int(50, 1, 1000),
  OMIE_CONCURRENCY: int(4, 1, 4),
  OMIE_MAX_CALLS_PER_MINUTE: int(240, 1, 2000),
  OMIE_MOCK_LATENCY_MS: int(0, 0, 5000),

  AI_PROVIDER: z.enum(['disabled', 'mock', 'openai', 'anthropic']).default('disabled'),
  AI_SHARE_RESULT_DATA: bool(false),
  AI_TIMEOUT_MS: int(30_000, 1000, 300_000),
  OPENAI_API_KEY: optionalText,
  OPENAI_MODEL: z.string().default('gpt-5-mini'),
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  ANTHROPIC_API_KEY: optionalText,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  ANTHROPIC_BASE_URL: z.url().default('https://api.anthropic.com/v1'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_VERSION: optionalText,
  GIT_COMMIT: optionalText,
});

export type Env = z.output<typeof envSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  host: string;
  port: number;
  appUrl: string;
  appOrigin: string;
  trustProxy: boolean | number | string;
  databaseUrl: string;
  migrationsDir?: string;
  staticDir?: string;
  session: {
    secret: string;
    hours: number;
    cookieName: string;
    secureCookie: boolean;
    loginMaxAttempts: number;
    loginLockMinutes: number;
  };
  writeConfirmationTtlSeconds: number;
  bootstrapAdmin?: { email: string; password: string; name: string };
  omie: {
    mode: 'mock' | 'live';
    baseUrl: string;
    appKey?: string;
    appSecret?: string;
    timeoutMs: number;
    queryTimeoutMs: number;
    readOnly: boolean;
    allowInsert: boolean;
    allowUpdate: boolean;
    allowDelete: boolean;
    maxRows: number;
    maxApiCalls: number;
    maxWriteRows: number;
    concurrency: number;
    maxCallsPerMinute: number;
    mockLatencyMs: number;
  };
  ai: {
    provider: 'disabled' | 'mock' | 'openai' | 'anthropic';
    shareResultData: boolean;
    timeoutMs: number;
    openai: { apiKey?: string; model: string; baseUrl: string };
    anthropic: { apiKey?: string; model: string; baseUrl: string };
  };
  logLevel: Env['LOG_LEVEL'];
  version: string;
  commit: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

function isLoopback(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

function parseTrustProxy(value: string): boolean | number | string {
  const v = value.trim();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // comma-separated list of trusted addresses / CIDRs
}

/** Rough strength check: length plus character variety, so "aaaa…" or a word list fails. */
export function isWeakSecret(secret: string): boolean {
  if (secret.length < 32) return true;
  if (PLACEHOLDER_SECRETS.has(secret)) return true;
  if (/change[-_ ]?me/i.test(secret)) return true;
  return new Set(secret).size < 12;
}

export function isWeakPassword(password: string): boolean {
  if (password.length < 12) return true;
  if (PLACEHOLDER_PASSWORDS.has(password)) return true;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  return classes < 3;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const problems: string[] = [];
  const isProduction = e.NODE_ENV === 'production';
  const appUrl = new URL(e.APP_URL);

  if (isProduction) {
    if (isWeakSecret(e.SESSION_SECRET)) {
      problems.push(
        'SESSION_SECRET is missing, a placeholder or too weak (use at least 32 random characters)',
      );
    }
    if (e.DATABASE_URL.startsWith('pglite:'))
      problems.push('DATABASE_URL must point to PostgreSQL in production');
    if (/change-?me/i.test(e.DATABASE_URL))
      problems.push('DATABASE_URL still contains the placeholder database password');
    if (appUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(appUrl.hostname)) {
      problems.push('APP_URL must use https:// in production');
    }
    if (e.BOOTSTRAP_ADMIN_PASSWORD && isWeakPassword(e.BOOTSTRAP_ADMIN_PASSWORD)) {
      problems.push(
        'BOOTSTRAP_ADMIN_PASSWORD is a placeholder or too weak (12+ characters mixing upper, lower, digits, symbols)',
      );
    }
    if (e.LOG_LEVEL === 'trace' || e.LOG_LEVEL === 'debug')
      problems.push('LOG_LEVEL debug/trace is not allowed in production');
    const trust = parseTrustProxy(e.TRUST_PROXY);
    if (e.APP_BIND && !isLoopback(e.APP_BIND) && (trust === true || typeof trust === 'number'))
      problems.push(
        'TRUST_PROXY must be false or a list of proxy addresses when APP_BIND exposes the app directly (clients could spoof their IP)',
      );
  }

  const omieUrl = new URL(e.OMIE_BASE_URL);
  if (e.OMIE_MODE === 'live') {
    if (!e.OMIE_APP_KEY || !e.OMIE_APP_SECRET)
      problems.push('OMIE_APP_KEY and OMIE_APP_SECRET are required when OMIE_MODE=live');
    const local = ['localhost', '127.0.0.1'].includes(omieUrl.hostname);
    if (isProduction && (omieUrl.protocol !== 'https:' || omieUrl.hostname !== 'app.omie.com.br')) {
      problems.push('OMIE_BASE_URL must be https://app.omie.com.br/... in production');
    } else if (!isProduction && omieUrl.protocol !== 'https:' && !local) {
      problems.push(
        'OMIE_BASE_URL must use https:// (plain http is only accepted for localhost test servers)',
      );
    }
  }

  if (e.BOOTSTRAP_ADMIN_EMAIL && !z.email().safeParse(e.BOOTSTRAP_ADMIN_EMAIL).success) {
    problems.push('BOOTSTRAP_ADMIN_EMAIL is not a valid e-mail');
  }
  if (Boolean(e.BOOTSTRAP_ADMIN_EMAIL) !== Boolean(e.BOOTSTRAP_ADMIN_PASSWORD)) {
    problems.push('BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together');
  }
  if (e.AI_PROVIDER === 'openai' && !e.OPENAI_API_KEY)
    problems.push('OPENAI_API_KEY is required when AI_PROVIDER=openai');
  if (e.AI_PROVIDER === 'anthropic' && !e.ANTHROPIC_API_KEY) {
    problems.push('ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic');
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    env: e.NODE_ENV,
    isProduction,
    host: e.HOST,
    port: e.PORT,
    appUrl: e.APP_URL,
    appOrigin: appUrl.origin,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    databaseUrl: e.DATABASE_URL,
    ...(e.MIGRATIONS_DIR ? { migrationsDir: e.MIGRATIONS_DIR } : {}),
    ...(e.STATIC_DIR ? { staticDir: e.STATIC_DIR } : {}),
    session: {
      secret: e.SESSION_SECRET,
      hours: e.SESSION_HOURS,
      // __Host- prefix forces Secure, Path=/ and no Domain in browsers.
      cookieName: isProduction ? '__Host-dbx_session' : 'dbx_session',
      secureCookie: isProduction,
      loginMaxAttempts: e.LOGIN_MAX_ATTEMPTS,
      loginLockMinutes: e.LOGIN_LOCK_MINUTES,
    },
    writeConfirmationTtlSeconds: e.WRITE_CONFIRMATION_TTL_SECONDS,
    ...(e.BOOTSTRAP_ADMIN_EMAIL && e.BOOTSTRAP_ADMIN_PASSWORD
      ? {
          bootstrapAdmin: {
            email: e.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),
            password: e.BOOTSTRAP_ADMIN_PASSWORD,
            name: e.BOOTSTRAP_ADMIN_NAME,
          },
        }
      : {}),
    omie: {
      mode: e.OMIE_MODE,
      baseUrl: e.OMIE_BASE_URL.replace(/\/+$/, ''),
      ...(e.OMIE_APP_KEY ? { appKey: e.OMIE_APP_KEY } : {}),
      ...(e.OMIE_APP_SECRET ? { appSecret: e.OMIE_APP_SECRET } : {}),
      timeoutMs: e.OMIE_TIMEOUT_MS,
      queryTimeoutMs: e.OMIE_QUERY_TIMEOUT_MS,
      readOnly: e.OMIE_READ_ONLY,
      allowInsert: e.OMIE_ALLOW_INSERT,
      allowUpdate: e.OMIE_ALLOW_UPDATE,
      allowDelete: e.OMIE_ALLOW_DELETE,
      maxRows: e.OMIE_MAX_ROWS,
      maxApiCalls: e.OMIE_MAX_API_CALLS,
      maxWriteRows: e.OMIE_MAX_WRITE_ROWS,
      concurrency: e.OMIE_CONCURRENCY,
      maxCallsPerMinute: e.OMIE_MAX_CALLS_PER_MINUTE,
      mockLatencyMs: e.OMIE_MOCK_LATENCY_MS,
    },
    ai: {
      provider: e.AI_PROVIDER,
      shareResultData: e.AI_SHARE_RESULT_DATA,
      timeoutMs: e.AI_TIMEOUT_MS,
      openai: {
        ...(e.OPENAI_API_KEY ? { apiKey: e.OPENAI_API_KEY } : {}),
        model: e.OPENAI_MODEL,
        baseUrl: e.OPENAI_BASE_URL,
      },
      anthropic: {
        ...(e.ANTHROPIC_API_KEY ? { apiKey: e.ANTHROPIC_API_KEY } : {}),
        model: e.ANTHROPIC_MODEL,
        baseUrl: e.ANTHROPIC_BASE_URL,
      },
    },
    logLevel: e.LOG_LEVEL,
    version: e.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0',
    commit: e.GIT_COMMIT ?? 'dev',
  };
}

/** Every configured secret value, for value-based redaction in logs and traces. */
export function secretValues(config: AppConfig): string[] {
  return [
    config.session.secret,
    config.omie.appKey,
    config.omie.appSecret,
    config.ai.openai.apiKey,
    config.ai.anthropic.apiKey,
    config.bootstrapAdmin?.password,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Masks a secret for display: never more than the last 4 characters. */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return '(not set)';
  return secret.length <= 8 ? '****' : `****${secret.slice(-4)}`;
}
