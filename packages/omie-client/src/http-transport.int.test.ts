/**
 * Integration tests against a local fake Omie HTTP server (node:http). No traffic
 * leaves the machine and no real credentials are involved.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OmieClient } from './client';
import { assertSafeRequest, createHttpTransport } from './http-transport';
import type { OmieRequest } from './types';

const APP_KEY = 'test-app-key-000';
const APP_SECRET = 'test-app-secret-not-real-0123456789';

type Behaviour = (body: Record<string, unknown>, res: ServerResponse, hit: number) => void;
let behaviour: Behaviour = () => {};
let hits = 0;
let lastPath = '';
let server: Server;
let baseUrl = '';

const json = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      hits++;
      lastPath = req.url ?? '';
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (body.app_key !== APP_KEY || body.app_secret !== APP_SECRET) {
        json(res, 500, {
          faultstring: 'ERROR: A chave de acesso não é válida.',
          faultcode: 'SOAP-ENV:Client-1',
        });
        return;
      }
      behaviour(body, res, hits);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  hits = 0;
});

const read: OmieRequest = {
  endpoint: 'geral/clientes',
  call: 'ListarClientes',
  param: { pagina: 1, registros_por_pagina: 2 },
  kind: 'read',
};
const write: OmieRequest = {
  endpoint: 'geral/clientes',
  call: 'AlterarCliente',
  param: { codigo_cliente_omie: 1, cidade: 'X' },
  kind: 'write',
};

function makeClient(opts: { secret?: string; timeoutMs?: number; maxRetries?: number } = {}) {
  const transport = createHttpTransport({
    baseUrl,
    appKey: APP_KEY,
    appSecret: opts.secret ?? APP_SECRET,
  });
  return new OmieClient({
    transport,
    concurrency: 2,
    timeoutMs: opts.timeoutMs ?? 2000,
    retry: {
      baseDelayMs: 1,
      maxDelayMs: 5,
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    },
  });
}

describe('HTTP transport against a fake Omie server', () => {
  it('sends the Omie envelope and paginates', async () => {
    behaviour = (body, res) => {
      const param = (body.param as Array<Record<string, unknown>>)[0]!;
      const page = Number(param.pagina);
      json(res, 200, {
        pagina: page,
        total_de_paginas: 2,
        registros: 2,
        total_de_registros: 4,
        clientes_cadastro: [{ id: page * 10 + 1 }, { id: page * 10 + 2 }],
      });
    };
    const c = makeClient();
    const p1 = await c.call(read);
    const p2 = await c.call({ ...read, param: { pagina: 2, registros_por_pagina: 2 } });
    expect(lastPath).toBe('/api/v1/geral/clientes/');
    expect(p1.body.total_de_registros).toBe(4);
    expect((p2.body.clientes_cadastro as Array<{ id: number }>)[0]!.id).toBe(21);
  });

  it('maps invalid credentials to OMIE_AUTH_ERROR and never echoes the secret', async () => {
    const traces: unknown[] = [];
    const err = await makeClient({ secret: 'wrong-secret-value-1234' })
      .call(read, { onTrace: (t) => traces.push(t) })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'OMIE_AUTH_ERROR' });
    expect(hits).toBe(1);
    expect(JSON.stringify(traces)).not.toContain('wrong-secret-value-1234');
    expect(JSON.stringify(err)).not.toContain('wrong-secret-value-1234');
  });

  it('retries 429 on reads, honouring Retry-After', async () => {
    behaviour = (_b, res, hit) =>
      hit === 1 ? json(res, 429, {}, { 'retry-after': '0' }) : json(res, 200, { ok: true });
    const res = await makeClient().call(read);
    expect(res.trace.attempts).toBe(2);
  });

  it('retries 5xx on reads', async () => {
    behaviour = (_b, res, hit) => {
      if (hit < 3) {
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end('<html>bad gateway</html>');
      } else json(res, 200, { ok: true });
    };
    const res = await makeClient().call(read);
    expect(hits).toBe(3);
    expect(res.body.ok).toBe(true);
  });

  it('does not retry a write on 5xx', async () => {
    behaviour = (_b, res) => json(res, 503, {});
    await expect(makeClient().call(write)).rejects.toMatchObject({ code: 'OMIE_UNAVAILABLE' });
    expect(hits).toBe(1);
  });

  it('reports malformed JSON as OMIE_BAD_RESPONSE', async () => {
    behaviour = (_b, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"pagina": 1, ');
    };
    await expect(makeClient().call(read)).rejects.toMatchObject({ code: 'OMIE_BAD_RESPONSE' });
    expect(hits).toBe(1);
  });

  it('times out a hanging server', async () => {
    behaviour = () => {
      /* never answers */
    };
    await expect(makeClient({ timeoutMs: 100, maxRetries: 0 }).call(read)).rejects.toMatchObject({
      code: 'OMIE_UNAVAILABLE',
      message: expect.stringContaining('timed out'),
    });
  });

  it('maps HTTP 425 to OMIE_BLOCKED without retry', async () => {
    behaviour = (_b, res) => json(res, 425, { faultstring: 'Bloqueado' });
    await expect(makeClient().call(read)).rejects.toMatchObject({ code: 'OMIE_BLOCKED' });
    expect(hits).toBe(1);
  });

  it('refuses unsafe endpoint or call names before sending', () => {
    expect(() => assertSafeRequest({ ...read, endpoint: '../admin' })).toThrow();
    expect(() => assertSafeRequest({ ...read, endpoint: 'geral/clientes?x=1' })).toThrow();
    expect(() => assertSafeRequest({ ...read, call: 'Listar/../x' })).toThrow();
    expect(() => assertSafeRequest(read)).not.toThrow();
  });
});
