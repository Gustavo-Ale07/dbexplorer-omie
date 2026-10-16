import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  isWeakPassword,
  isWeakSecret,
  loadConfig,
  maskSecret,
  secretValues,
} from './config';

const STRONG_SECRET = 'q8Vt2Lm9Xc4Vb8Nz1Kp5Rt3Wy6Hd0Jf7Gs';
const PROD = {
  NODE_ENV: 'production',
  APP_URL: 'https://sql.example.com',
  DATABASE_URL: 'postgres://app:Xy7-strong-db-pass@db:5432/app',
  SESSION_SECRET: STRONG_SECRET,
};

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

describe('loadConfig', () => {
  it('uses safe defaults: mock mode, read-only, writes disabled, AI disabled', () => {
    const c = loadConfig({});
    expect(c.omie).toMatchObject({
      mode: 'mock',
      readOnly: true,
      allowInsert: false,
      allowUpdate: false,
      allowDelete: false,
      maxRows: 1000,
      maxApiCalls: 100,
      maxWriteRows: 50,
      concurrency: 4,
      timeoutMs: 60000,
    });
    expect(c.ai).toMatchObject({ provider: 'disabled', shareResultData: false });
    expect(c.port).toBe(3001);
    expect(c.session.hours).toBe(12);
    expect(c.session.secureCookie).toBe(false);
  });

  it('accepts a sound production configuration and hardens cookies', () => {
    const c = loadConfig(PROD);
    expect(c.isProduction).toBe(true);
    expect(c.session.cookieName).toBe('__Host-dbx_session');
    expect(c.session.secureCookie).toBe(true);
  });

  it('refuses to boot in production with placeholder or weak secrets', () => {
    expect(problemsOf({ ...PROD, SESSION_SECRET: undefined as unknown as string }).join()).toMatch(
      /SESSION_SECRET/,
    );
    expect(
      problemsOf({
        ...PROD,
        SESSION_SECRET: 'change-me-to-a-long-random-string-at-least-32-chars',
      }).join(),
    ).toMatch(/SESSION_SECRET/);
    expect(problemsOf({ ...PROD, SESSION_SECRET: 'short' }).join()).toMatch(/SESSION_SECRET/);
    expect(problemsOf({ ...PROD, SESSION_SECRET: 'a'.repeat(64) }).join()).toMatch(
      /SESSION_SECRET/,
    );
  });

  it('refuses the placeholder bootstrap password, pglite, http APP_URL and debug logs in production', () => {
    const p = problemsOf({
      ...PROD,
      BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'ChangeMe!2026',
      DATABASE_URL: 'pglite:memory',
      APP_URL: 'http://sql.example.com',
      LOG_LEVEL: 'debug',
    }).join('\n');
    expect(p).toMatch(/BOOTSTRAP_ADMIN_PASSWORD/);
    expect(p).toMatch(/DATABASE_URL/);
    expect(p).toMatch(/APP_URL/);
    expect(p).toMatch(/LOG_LEVEL/);
    expect(
      problemsOf({ ...PROD, DATABASE_URL: 'postgres://u:change-me-db-password@db/x' }).join(),
    ).toMatch(/DATABASE_URL/);
  });

  it('refuses a hop-count TRUST_PROXY when the app is published on a public address', () => {
    expect(problemsOf({ ...PROD, APP_BIND: '0.0.0.0', TRUST_PROXY: '1' }).join()).toMatch(
      /TRUST_PROXY/,
    );
    expect(problemsOf({ ...PROD, APP_BIND: '0.0.0.0', TRUST_PROXY: 'true' }).join()).toMatch(
      /TRUST_PROXY/,
    );
    expect(problemsOf({ ...PROD, APP_BIND: '0.0.0.0', TRUST_PROXY: 'false' })).toEqual([]);
    expect(problemsOf({ ...PROD, APP_BIND: '0.0.0.0', TRUST_PROXY: '10.0.0.10' })).toEqual([]);
    expect(problemsOf({ ...PROD, APP_BIND: '127.0.0.1', TRUST_PROXY: '1' })).toEqual([]);
  });

  it('requires credentials in live mode and the official Omie host in production', () => {
    expect(problemsOf({ OMIE_MODE: 'live' }).join()).toMatch(/OMIE_APP_KEY/);
    const p = problemsOf({
      ...PROD,
      OMIE_MODE: 'live',
      OMIE_APP_KEY: 'k'.repeat(13),
      OMIE_APP_SECRET: 's'.repeat(32),
      OMIE_BASE_URL: 'https://evil.example/api/v1',
    }).join();
    expect(p).toMatch(/OMIE_BASE_URL/);
    expect(
      problemsOf({
        OMIE_MODE: 'live',
        OMIE_APP_KEY: 'k1',
        OMIE_APP_SECRET: 's1',
        OMIE_BASE_URL: 'http://10.0.0.5/api',
      }).join(),
    ).toMatch(/OMIE_BASE_URL/);
  });

  it('requires AI keys for the chosen provider and bootstrap email+password together', () => {
    expect(problemsOf({ AI_PROVIDER: 'openai' }).join()).toMatch(/OPENAI_API_KEY/);
    expect(problemsOf({ AI_PROVIDER: 'anthropic' }).join()).toMatch(/ANTHROPIC_API_KEY/);
    expect(problemsOf({ BOOTSTRAP_ADMIN_EMAIL: 'a@example.com' }).join()).toMatch(/together/);
  });

  it('reports invalid values by variable name without echoing secrets', () => {
    const p = problemsOf({ ...PROD, OMIE_MAX_ROWS: 'lots', SESSION_SECRET: 'change-me' });
    expect(p.join()).toMatch(/OMIE_MAX_ROWS/);
    expect(p.join()).not.toContain('change-me');
  });
});

describe('secret helpers', () => {
  it('classifies weak secrets and passwords', () => {
    expect(isWeakSecret(STRONG_SECRET)).toBe(false);
    expect(isWeakSecret('dev-session-secret-not-for-production-use-0000')).toBe(true);
    expect(isWeakPassword('ChangeMe!2026')).toBe(true);
    expect(isWeakPassword('alllowercaseletters')).toBe(true);
    expect(isWeakPassword('Str0ng!Passw0rd#x')).toBe(false);
  });

  it('masks secrets and lists configured secret values', () => {
    expect(maskSecret(undefined)).toBe('(not set)');
    expect(maskSecret('abcdefghijkl')).toBe('****ijkl');
    expect(maskSecret('short')).toBe('****');
    const c = loadConfig({
      OMIE_MODE: 'live',
      OMIE_APP_KEY: 'key-123456',
      OMIE_APP_SECRET: 'secret-abcdef',
    });
    expect(secretValues(c)).toEqual(expect.arrayContaining(['key-123456', 'secret-abcdef']));
  });
});
