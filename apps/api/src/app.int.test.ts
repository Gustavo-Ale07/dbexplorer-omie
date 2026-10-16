import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { createHttpTransport } from '@dbx/omie-client';
import type { Role } from '@dbx/shared';
import { buildApp } from './app';
import type { BuildAppOptions } from './app';
import { loadConfig } from './config';
import { createMockProvider } from './ai/providers';
import { loggerOptions } from './logger';
import { secretValues } from './config';
import { UsersService } from './services/users';

const ORIGIN = 'http://localhost:5173';
const ADMIN = { email: 'admin@example.com', password: 'Adm1n!Strong#Pass' };
const PASSWORD = 'User!Strong#Pass9';
const FAKE_APP_KEY = '9988776655443';
const FAKE_APP_SECRET = 'fake0secret0value0for0tests0only0zz';

const BASE_ENV = {
  NODE_ENV: 'test',
  APP_URL: ORIGIN,
  DATABASE_URL: 'pglite:memory',
  SESSION_SECRET: 'integration-test-secret-7Hq2Lm9Xc4Vb8Nz1Kp5Rt3Wy6',
  BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
  BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
  LOG_LEVEL: 'silent',
};

const WRITABLE_ENV = {
  OMIE_READ_ONLY: 'false',
  OMIE_ALLOW_INSERT: 'true',
  OMIE_ALLOW_UPDATE: 'true',
};

interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  logs: string[];
  login(email?: string, password?: string): Promise<string>;
  createUser(role: Role, email?: string): Promise<string>;
  call(
    cookie: string | null,
    opts: InjectOptions,
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
}

const open: Harness[] = [];

async function setup(
  env: Record<string, string> = {},
  extra: Partial<BuildAppOptions> = {},
): Promise<Harness> {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const database = await createDatabase(config.databaseUrl);
  await database.migrate();
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const app = await buildApp({
    config,
    database,
    logger: { ...(loggerOptions('trace', secretValues(config)) as object), stream },
    ...extra,
  });
  await app.services.users.bootstrapAdmin(config.bootstrapAdmin);
  // Most tests act as an admin who already replaced the bootstrap password.
  const admin = await app.services.users.findByEmail(ADMIN.email);
  if (admin) await app.services.users.setPassword(admin.id, ADMIN.password, false);

  const call: Harness['call'] = (cookie, opts) =>
    app.inject({
      ...opts,
      headers: {
        origin: ORIGIN,
        ...(cookie ? { cookie: `${config.session.cookieName}=${cookie}` } : {}),
        ...(opts.headers ?? {}),
      },
    });

  const login = async (email = ADMIN.email, password = ADMIN.password) => {
    const res = await call(null, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode, res.body).toBe(200);
    const c = res.cookies.find((x) => x.name === config.session.cookieName);
    expect(c?.httpOnly).toBe(true);
    return c!.value;
  };

  let n = 0;
  const createUser = async (role: Role, email = `user${++n}-${role.toLowerCase()}@example.com`) => {
    await app.services.users.create({ email, name: role, password: PASSWORD, role });
    return login(email, PASSWORD);
  };

  const h = { app, database, logs, login, createUser, call };
  open.push(h);
  return h;
}

afterEach(async () => {
  while (open.length) {
    const h = open.pop()!;
    await h.app.close();
    await h.database.close();
  }
});

const query = (h: Harness, cookie: string, sql: string) =>
  h.call(cookie, { method: 'POST', url: '/api/query', payload: { sql } });

const codeOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code: string } }).error?.code;

describe('health and meta', () => {
  it('serves liveness, readiness and public meta without auth', async () => {
    const h = await setup();
    expect((await h.call(null, { method: 'GET', url: '/health/live' })).json()).toEqual({
      status: 'ok',
    });
    const ready = await h.call(null, { method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ok',
      checks: { database: 'ok', registry: 'ok' },
    });
    const meta = await h.call(null, { method: 'GET', url: '/api/meta' });
    expect(meta.json()).toMatchObject({ name: 'Omie SQL Explorer', omieMode: 'mock' });
  });

  it('sets security headers and a request id', async () => {
    const h = await setup();
    const res = await h.call(null, { method: 'GET', url: '/api/meta' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('authentication', () => {
  it('requires a session for protected routes', async () => {
    const h = await setup();
    const res = await h.call(null, {
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SHOW TABLES' },
    });
    expect(res.statusCode).toBe(401);
    expect(codeOf(res)).toBe('AUTH_REQUIRED');
  });

  it('logs in, returns the user and logs out (session revoked)', async () => {
    const h = await setup();
    const cookie = await h.login();
    const me = await h.call(cookie, { method: 'GET', url: '/api/auth/me' });
    expect(me.json()).toMatchObject({ user: { email: ADMIN.email, role: 'ADMIN' } });
    expect(JSON.stringify(me.json())).not.toContain('passwordHash');
    await h.call(cookie, { method: 'POST', url: '/api/auth/logout', payload: {} });
    expect((await h.call(cookie, { method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
  });

  it('rejects wrong passwords with a generic error and locks after repeated failures', async () => {
    const h = await setup({ LOGIN_MAX_ATTEMPTS: '3' });
    const attempt = (password: string) =>
      h.call(null, {
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: ADMIN.email, password },
      });
    const first = await attempt('wrong-password');
    expect(first.statusCode).toBe(401);
    expect(codeOf(first)).toBe('INVALID_CREDENTIALS');
    expect(codeOf(await attempt('nobody'))).toBe('INVALID_CREDENTIALS');
    const third = await attempt('again-wrong');
    expect(codeOf(third)).toBe('ACCOUNT_LOCKED');
    // Even the right password is refused while locked (brute force protection).
    expect(codeOf(await attempt(ADMIN.password))).toBe('ACCOUNT_LOCKED');
    const unknown = await h.call(null, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@example.com', password: 'x' },
    });
    expect(codeOf(unknown)).toBe('INVALID_CREDENTIALS');
  });

  it('rate limits login attempts per IP', async () => {
    const h = await setup({ LOGIN_MAX_ATTEMPTS: '100' });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await h.call(null, {
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: `x${i}@example.com`, password: 'nope' },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toContain(429);
  });

  it('rejects forged and expired sessions', async () => {
    const h = await setup();
    const forged = await h.call('A'.repeat(43), { method: 'GET', url: '/api/auth/me' });
    expect(forged.statusCode).toBe(401);
    const cookie = await h.login();
    // Expire every session in the database.
    await h.database.db.execute(
      `UPDATE sessions SET expires_at = now() - interval '1 minute'` as never,
    );
    const expired = await h.call(cookie, { method: 'GET', url: '/api/auth/me' });
    expect(expired.statusCode).toBe(401);
  });

  it('rotates the session on login (session fixation)', async () => {
    const h = await setup();
    const first = await h.login();
    const res = await h.call(first, {
      method: 'POST',
      url: '/api/auth/login',
      payload: ADMIN,
    });
    const second = res.cookies.find((c) => c.name === 'dbx_session')!.value;
    expect(second).not.toBe(first);
    expect((await h.call(first, { method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await h.call(second, { method: 'GET', url: '/api/auth/me' })).statusCode).toBe(200);
  });
});

describe('CSRF and request hygiene', () => {
  it('rejects state-changing requests from another origin or without origin', async () => {
    const h = await setup();
    const cookie = await h.login();
    const evil = await h.call(cookie, {
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SHOW TABLES' },
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.statusCode).toBe(403);
    expect(codeOf(evil)).toBe('CSRF_REJECTED');
    const none = await h.app.inject({
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SHOW TABLES' },
      headers: { cookie: `dbx_session=${cookie}` },
    });
    expect(codeOf(none)).toBe('CSRF_REJECTED');
  });

  it('only accepts JSON bodies and rejects unknown fields (mass assignment)', async () => {
    const h = await setup();
    const cookie = await h.login();
    const text = await h.call(cookie, {
      method: 'POST',
      url: '/api/query',
      payload: 'SHOW TABLES',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(400);
    expect(codeOf(text)).toBe('VALIDATION_ERROR');
    const extra = await h.call(cookie, {
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SHOW TABLES', role: 'ADMIN' },
    });
    expect(codeOf(extra)).toBe('VALIDATION_ERROR');
    const proto = await h.call(cookie, {
      method: 'POST',
      url: '/api/saved-queries',
      payload: '{"name":"x","sql":"SHOW TABLES","__proto__":{"admin":true}}',
      headers: { 'content-type': 'application/json' },
    });
    expect([400]).toContain(proto.statusCode);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const h = await setup();
    const res = await h.call(null, { method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(codeOf(res)).toBe('NOT_FOUND');
  });
});

describe('queries', () => {
  it('runs SHOW TABLES, SELECT and EXPLAIN and records history without results', async () => {
    const h = await setup();
    const cookie = await h.createUser('VIEWER');
    const tables = await query(h, cookie, 'SHOW TABLES');
    expect(tables.statusCode, tables.body).toBe(200);
    expect(tables.json().rows.length).toBeGreaterThan(5);

    const sel = await query(
      h,
      cookie,
      'SELECT codigo_cliente_omie, razao_social, cidade FROM clientes ORDER BY razao_social LIMIT 5',
    );
    expect(sel.statusCode, sel.body).toBe(200);
    const body = sel.json();
    expect(body).toMatchObject({ type: 'result', rowCount: 5, truncated: false });
    expect(body.columns.map((c: { name: string }) => c.name)).toEqual([
      'codigo_cliente_omie',
      'razao_social',
      'cidade',
    ]);
    expect(body.apiCalls).toBeGreaterThan(0);
    expect(body.traces[0].request).toBeDefined();

    const exp = await query(h, cookie, "EXPLAIN SELECT * FROM clientes WHERE estado = 'SP'");
    expect(JSON.stringify(exp.json().plan)).toContain('clientes');

    const hist = await h.call(cookie, { method: 'GET', url: '/api/history' });
    const items = hist.json().items as Array<Record<string, unknown>>;
    expect(items.length).toBe(3);
    expect(items[0]).toMatchObject({ status: 'success' });
    expect(JSON.stringify(items)).not.toContain('razao_social":"'); // no result data stored
  });

  it('maps engine errors to stable codes', async () => {
    const h = await setup();
    const cookie = await h.login();
    expect(codeOf(await query(h, cookie, 'SELECT * FROM tabela_inexistente'))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codeOf(await query(h, cookie, 'SELECT coluna_x FROM clientes'))).toBe(
      'COLUMN_NOT_FOUND',
    );
    expect(codeOf(await query(h, cookie, 'SELECT * FROM clientes WHERE'))).toBe('SQL_PARSE_ERROR');
    expect(codeOf(await query(h, cookie, 'SELEC * FRM clientes'))).toMatch(
      /SQL_UNSUPPORTED|SQL_PARSE_ERROR/,
    );
    expect(codeOf(await query(h, cookie, 'DROP TABLE clientes'))).toMatch(
      /SQL_UNSUPPORTED|SQL_PARSE_ERROR/,
    );
    expect(codeOf(await query(h, cookie, 'BEGIN'))).toMatch(/SQL_UNSUPPORTED|SQL_PARSE_ERROR/);
  });

  it('enforces the row and API call limits instead of truncating silently', async () => {
    const rows = await setup({ OMIE_MAX_ROWS: '10' });
    const c1 = await rows.login();
    expect(codeOf(await query(rows, c1, 'SELECT * FROM clientes LIMIT 11'))).toBe(
      'QUERY_ROW_LIMIT_EXCEEDED',
    );
    // Without LIMIT the implicit cap applies and is flagged explicitly.
    const implicit = (await query(rows, c1, 'SELECT * FROM clientes')).json();
    expect(implicit).toMatchObject({ rowCount: 10, truncated: true });
    expect(implicit.messages.join(' ')).toContain('truncated');

    const calls = await setup({ OMIE_MAX_API_CALLS: '1' });
    const c2 = await calls.login();
    expect(codeOf(await query(calls, c2, 'SELECT * FROM pedido_venda_itens'))).toBe(
      'API_CALL_LIMIT_EXCEEDED',
    );
  });

  it('returns hostile text from Omie as inert data', async () => {
    const h = await setup();
    const cookie = await h.login();
    const res = await query(h, cookie, 'SELECT descr_detalhada FROM produtos');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const values = res.json().rows.flat() as unknown[];
    expect(values.some((v) => typeof v === 'string' && v.includes('<script>'))).toBe(true);
  });
});

describe('writes', () => {
  const UPDATE = "UPDATE clientes SET cidade = 'Campinas' WHERE codigo_cliente_omie = 1000001";

  it('blocks writes in read-only mode', async () => {
    const h = await setup();
    const cookie = await h.login();
    expect(codeOf(await query(h, cookie, UPDATE))).toBe('READ_ONLY_MODE');
  });

  it('forbids UPDATE for VIEWER and DELETE for OPERATOR, and audits the attempt', async () => {
    const h = await setup({ ...WRITABLE_ENV, OMIE_ALLOW_DELETE: 'true' });
    const viewer = await h.createUser('VIEWER');
    const res = await query(h, viewer, UPDATE);
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
    const operator = await h.createUser('OPERATOR');
    expect(
      codeOf(await query(h, operator, 'DELETE FROM clientes WHERE codigo_cliente_omie = 1000001')),
    ).toBe('FORBIDDEN');

    const admin = await h.login();
    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=write.denied' });
    expect(audit.json().total).toBe(2);
  });

  it('requires WHERE and enforces the write row limit', async () => {
    const h = await setup({ ...WRITABLE_ENV, OMIE_MAX_WRITE_ROWS: '2' });
    const cookie = await h.login();
    expect(codeOf(await query(h, cookie, "UPDATE clientes SET cidade = 'X'"))).toBe(
      'WHERE_REQUIRED',
    );
    expect(
      codeOf(await query(h, cookie, "UPDATE clientes SET cidade = 'X' WHERE estado = 'SP'")),
    ).toBe('WRITE_ROW_LIMIT_EXCEEDED');
  });

  it('rejects DELETE as unsupported by the Omie API', async () => {
    const h = await setup({ ...WRITABLE_ENV, OMIE_ALLOW_DELETE: 'true' });
    const cookie = await h.login();
    expect(codeOf(await query(h, cookie, 'DELETE FROM nfes WHERE id_nf = 12000001'))).toBe(
      'OPERATION_NOT_SUPPORTED',
    );
  });

  it('previews, confirms once and audits an UPDATE (mock)', async () => {
    const h = await setup(WRITABLE_ENV);
    const cookie = await h.createUser('OPERATOR');
    const preview = await query(h, cookie, UPDATE);
    expect(preview.statusCode, preview.body).toBe(200);
    const p = preview.json();
    expect(p.type).toBe('write_preview');
    expect(p.preview.targetCount).toBe(1);
    expect(p.preview.targets[0].after.cidade).toBe('Campinas');
    expect(p.preview.notice).toMatch(/no automatic rollback/i);
    expect(JSON.stringify(p.request)).not.toMatch(/"app_secret":"[^*]/);

    const confirm = () =>
      h.call(cookie, {
        method: 'POST',
        url: '/api/query/confirm',
        payload: { sql: UPDATE, token: p.confirmation.token },
      });
    const done = await confirm();
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({
      type: 'write_result',
      execution: { status: 'success', succeeded: 1 },
    });

    // Replay of the same token is refused.
    expect(codeOf(await confirm())).toBe('CONFIRMATION_USED');

    const after = await query(
      h,
      cookie,
      'SELECT cidade FROM clientes WHERE codigo_cliente_omie = 1000001',
    );
    expect(after.json().rows[0][0]).toBe('Campinas');

    const admin = await h.login();
    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=write.execute' });
    const ev = audit.json().items[0];
    expect(ev).toMatchObject({ status: 'success', operation: 'UPDATE', resource: 'clientes' });
    expect(ev.targetIds).toEqual([{ codigo_cliente_omie: 1000001 }]);
    expect(ev.after[0].cidade).toBe('Campinas');
  });

  it('refuses forged tokens, tokens for another statement, another user and expired tokens', async () => {
    const h = await setup(WRITABLE_ENV);
    const cookie = await h.login();
    const p = (await query(h, cookie, UPDATE)).json();
    const confirm = (c: string, sql: string, token: string) =>
      h.call(c, { method: 'POST', url: '/api/query/confirm', payload: { sql, token } });

    const [id] = p.confirmation.token.split('.');
    expect(codeOf(await confirm(cookie, UPDATE, `${id}.${'x'.repeat(43)}`))).toBe(
      'CONFIRMATION_INVALID',
    );
    expect(
      codeOf(await confirm(cookie, UPDATE.replace('Campinas', 'Santos'), p.confirmation.token)),
    ).toBe('CONFIRMATION_INVALID');
    const other = await h.createUser('ADMIN');
    expect(codeOf(await confirm(other, UPDATE, p.confirmation.token))).toBe('CONFIRMATION_INVALID');

    const p2 = (await query(h, cookie, UPDATE)).json();
    await h.database.db.execute(
      `UPDATE write_previews SET expires_at = now() - interval '1 second'` as never,
    );
    expect(codeOf(await confirm(cookie, UPDATE, p2.confirmation.token))).toBe(
      'CONFIRMATION_EXPIRED',
    );
  });

  it('rejects confirmation when the targets changed after the preview', async () => {
    const h = await setup(WRITABLE_ENV);
    const cookie = await h.login();
    const sql =
      "UPDATE clientes SET cidade = 'Campinas' WHERE codigo_cliente_omie IN (1000001, 1000002)";
    const p = (await query(h, cookie, sql)).json();
    expect(p.type, JSON.stringify(p)).toBe('write_preview');
    // Someone else changes one of the targets in between.
    const key = p.preview.targets[0].key.codigo_cliente_omie;
    const p3 = (
      await query(
        h,
        cookie,
        `UPDATE clientes SET cidade = 'Recife' WHERE codigo_cliente_omie = ${key}`,
      )
    ).json();
    await h.call(cookie, {
      method: 'POST',
      url: '/api/query/confirm',
      payload: {
        sql: `UPDATE clientes SET cidade = 'Recife' WHERE codigo_cliente_omie = ${key}`,
        token: p3.confirmation.token,
      },
    });
    const res = await h.call(cookie, {
      method: 'POST',
      url: '/api/query/confirm',
      payload: { sql, token: p.confirmation.token },
    });
    expect(codeOf(res)).toBe('TARGETS_CHANGED');
  });
});

describe('saved queries', () => {
  it('supports CRUD and duplicate, scoped to the owner (no IDOR)', async () => {
    const h = await setup();
    const a = await h.createUser('VIEWER');
    const b = await h.createUser('VIEWER');
    const created = await h.call(a, {
      method: 'POST',
      url: '/api/saved-queries',
      payload: { name: 'Clientes SP', sql: "SELECT * FROM clientes WHERE estado = 'SP' LIMIT 10" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().item.id as string;
    const dup = await h.call(a, {
      method: 'POST',
      url: `/api/saved-queries/${id}/duplicate`,
      payload: {},
    });
    expect(dup.json().item.name).toContain('(cópia)');
    expect(
      (await h.call(a, { method: 'GET', url: '/api/saved-queries' })).json().items,
    ).toHaveLength(2);

    expect(
      (await h.call(b, { method: 'GET', url: '/api/saved-queries' })).json().items,
    ).toHaveLength(0);
    const steal = await h.call(b, {
      method: 'PUT',
      url: `/api/saved-queries/${id}`,
      payload: { name: 'pwned' },
    });
    expect(steal.statusCode).toBe(404);
    expect(
      (await h.call(b, { method: 'DELETE', url: `/api/saved-queries/${id}` })).statusCode,
    ).toBe(404);

    const upd = await h.call(a, {
      method: 'PUT',
      url: `/api/saved-queries/${id}`,
      payload: { name: 'Clientes SP v2' },
    });
    expect(upd.json().item.name).toBe('Clientes SP v2');
    expect(
      (await h.call(a, { method: 'DELETE', url: `/api/saved-queries/${id}` })).statusCode,
    ).toBe(200);
  });
});

describe('admin', () => {
  it('restricts user management and audit to ADMIN', async () => {
    const h = await setup();
    const op = await h.createUser('OPERATOR');
    expect((await h.call(op, { method: 'GET', url: '/api/admin/users' })).statusCode).toBe(403);
    expect((await h.call(op, { method: 'GET', url: '/api/audit' })).statusCode).toBe(403);

    const admin = await h.login();
    const created = await h.call(admin, {
      method: 'POST',
      url: '/api/admin/users',
      payload: {
        email: 'nova@example.com',
        name: 'Nova',
        role: 'VIEWER',
        password: 'Nova!Strong#Pass1',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().item.id;
    expect(created.json().item.mustChangePassword).toBe(true);
    const weak = await h.call(admin, {
      method: 'POST',
      url: '/api/admin/users',
      payload: {
        email: 'fraca@example.com',
        name: 'Fraca',
        role: 'VIEWER',
        password: 'password1234',
      },
    });
    expect(codeOf(weak)).toBe('VALIDATION_ERROR');

    const role = await h.call(admin, {
      method: 'PATCH',
      url: `/api/admin/users/${id}`,
      payload: { role: 'OPERATOR' },
    });
    expect(role.json().item.role).toBe('OPERATOR');
    const deactivate = await h.call(admin, {
      method: 'PATCH',
      url: `/api/admin/users/${id}`,
      payload: { active: false },
    });
    expect(deactivate.json().item.active).toBe(false);
    const login = await h.call(null, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nova@example.com', password: 'Nova!Strong#Pass1' },
    });
    expect(login.statusCode).toBe(401);

    // A reset forces the user to choose a new password before using the app.
    await h.call(admin, {
      method: 'PATCH',
      url: `/api/admin/users/${id}`,
      payload: { active: true },
    });
    await h.call(admin, {
      method: 'POST',
      url: `/api/admin/users/${id}/reset-password`,
      payload: { password: 'Reset!Strong#Pass2' },
    });
    const temp = await h.login('nova@example.com', 'Reset!Strong#Pass2');
    expect(codeOf(await query(h, temp, 'SHOW TABLES'))).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await h.call(temp, {
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: 'Reset!Strong#Pass2', newPassword: 'Mine!Strong#Pass3' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const fresh = changed.cookies.find((c) => c.name === 'dbx_session')!.value;
    expect((await query(h, fresh, 'SHOW TABLES')).statusCode).toBe(200);
    expect((await query(h, temp, 'SHOW TABLES')).statusCode).toBe(401);

    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=user.create' });
    expect(audit.json().total).toBe(1);
  });

  it('forces the bootstrap admin to replace the .env password and never re-bootstraps', async () => {
    const database = await createDatabase('pglite:memory');
    try {
      await database.migrate();
      const users = new UsersService(database.db);
      const boot = { email: 'boot@example.com', password: 'Boot!Strong#Pass9', name: 'Boot' };
      expect(await users.bootstrapAdmin(boot)).toBe('created');
      expect((await users.findByEmail(boot.email))?.mustChangePassword).toBe(true);
      expect(await users.bootstrapAdmin({ ...boot, email: 'outro@example.com' })).toBe('skipped');
      expect(await users.count()).toBe(1);
    } finally {
      await database.close();
    }

    const h = await setup();
    const admin = await h.app.services.users.findByEmail(ADMIN.email);
    await h.app.services.users.setPassword(admin!.id, ADMIN.password, true);
    const cookie = await h.login();
    expect(codeOf(await query(h, cookie, 'SHOW TABLES'))).toBe('PASSWORD_CHANGE_REQUIRED');
    const me = await h.call(cookie, { method: 'GET', url: '/api/auth/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.mustChangePassword).toBe(true);
  });

  it('reports system status', async () => {
    const h = await setup();
    const admin = await h.login();
    const res = await h.call(admin, { method: 'GET', url: '/api/status' });
    expect(res.json()).toMatchObject({
      database: { status: 'ok' },
      omie: { mode: 'mock' },
      writes: { readOnly: true },
      ai: { provider: 'disabled' },
    });
  });
});

describe('AI assistant', () => {
  it('reports AI_PROVIDER_DISABLED when disabled', async () => {
    const h = await setup();
    const cookie = await h.login();
    const res = await h.call(cookie, {
      method: 'POST',
      url: '/api/ai/generate',
      payload: { question: 'listar clientes' },
    });
    expect(codeOf(res)).toBe('AI_PROVIDER_DISABLED');
  });

  it('generates SQL that is validated but never executed', async () => {
    const h = await setup({ AI_PROVIDER: 'mock' }, { aiProvider: createMockProvider() });
    const cookie = await h.createUser('VIEWER');
    const res = await h.call(cookie, {
      method: 'POST',
      url: '/api/ai/generate',
      payload: { question: 'quais clientes são de São Paulo?' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.sql).toMatch(/^SELECT/i);
    expect(body.validation.ok).toBe(true);
    // Nothing ran: no history entry.
    expect(
      (await h.call(cookie, { method: 'GET', url: '/api/history' })).json().items,
    ).toHaveLength(0);
  });
});

describe('secret handling (live mode with fake Omie HTTP)', () => {
  it('never returns or logs OMIE_APP_SECRET / APP_KEY, even in errors and the API Request tab', async () => {
    const seen: string[] = [];
    const transport = createHttpTransport({
      baseUrl: 'http://localhost:9/api/v1',
      appKey: FAKE_APP_KEY,
      appSecret: FAKE_APP_SECRET,
      fetch: async (_url, init) => {
        seen.push(String(init?.body));
        // Fault that echoes the credentials back, like a careless upstream might.
        return new Response(
          JSON.stringify({
            faultstring: `ERROR: app_secret ${FAKE_APP_SECRET} invalid for ${FAKE_APP_KEY}`,
            faultcode: 'SOAP-ENV:Client-5',
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const h = await setup(
      {
        OMIE_MODE: 'live',
        OMIE_BASE_URL: 'http://localhost:9/api/v1',
        OMIE_APP_KEY: FAKE_APP_KEY,
        OMIE_APP_SECRET: FAKE_APP_SECRET,
      },
      { omieTransport: transport },
    );
    const cookie = await h.login();
    const res = await query(h, cookie, 'SELECT * FROM clientes LIMIT 1');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain(FAKE_APP_SECRET); // it was really sent upstream…

    const status = await h.call(cookie, { method: 'GET', url: '/api/status' });
    const calls = await h.call(cookie, {
      method: 'POST',
      url: '/api/inspector/execute',
      payload: {
        id: 'geral/clientes:ListarClientes',
        param: { pagina: 1, registros_por_pagina: 1 },
      },
    });
    const history = await h.call(cookie, { method: 'GET', url: '/api/history' });
    for (const r of [res, status, calls, history]) {
      // …but never comes back to the browser.
      expect(r.body).not.toContain(FAKE_APP_SECRET);
      expect(r.body).not.toContain(FAKE_APP_KEY);
    }
    expect(res.body).toContain('REDACTED');
    const logs = h.logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(FAKE_APP_SECRET);
    expect(logs).not.toContain(FAKE_APP_KEY);
    expect(logs).not.toContain(ADMIN.password);
    expect(logs).not.toContain(cookie);
  });
});
