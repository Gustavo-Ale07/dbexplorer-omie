import { describe, expect, it, vi } from 'vitest';
import { REDACTED } from '@dbx/shared';
import { OmieClient } from './client';
import type { OmieRequest, OmieTransport, TransportResponse } from './types';

const SECRET = 'super-secret-app-secret-value';

function fakeTransport(
  responses: Array<TransportResponse | Error | 'hang'>,
): OmieTransport & { sent: number } {
  const t = {
    mode: 'live' as const,
    sent: 0,
    describeEnvelope: (req: OmieRequest) => ({
      call: req.call,
      app_key: 'real-key',
      app_secret: SECRET,
      param: [req.param],
    }),
    async send(_req: OmieRequest, signal: AbortSignal): Promise<TransportResponse> {
      const next = responses[Math.min(t.sent, responses.length - 1)];
      t.sent++;
      if (next === 'hang') {
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      }
      if (next instanceof Error) throw next;
      return next as TransportResponse;
    },
  };
  return t;
}

const read: OmieRequest = {
  endpoint: 'geral/clientes',
  call: 'ListarClientes',
  param: { pagina: 1 },
  kind: 'read',
};
const write: OmieRequest = {
  endpoint: 'geral/clientes',
  call: 'AlterarCliente',
  param: { codigo_cliente_omie: 1 },
  kind: 'write',
};
const noSleep = vi.fn(async () => {});

function client(transport: OmieTransport, timeoutMs = 1000) {
  return new OmieClient({
    transport,
    concurrency: 2,
    timeoutMs,
    sleep: noSleep,
    random: () => 0.5,
  });
}

describe('OmieClient', () => {
  it('returns the body and a redacted trace', async () => {
    const t = fakeTransport([{ httpStatus: 200, body: { ok: 1, app_secret: SECRET } }]);
    const traces: unknown[] = [];
    const res = await client(t).call(read, { onTrace: (tr) => traces.push(tr) });
    expect(res.body).toMatchObject({ ok: 1 });
    expect(traces).toHaveLength(1);
    const serialized = JSON.stringify(traces);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('real-key');
    expect(serialized).toContain(REDACTED);
  });

  it('retries transient read failures with backoff', async () => {
    const t = fakeTransport([
      { httpStatus: 503, body: undefined },
      { httpStatus: 429, body: {} },
      { httpStatus: 200, body: { ok: true } },
    ]);
    const res = await client(t).call(read);
    expect(res.trace.attempts).toBe(3);
    expect(t.sent).toBe(3);
  });

  it('gives up after maxRetries on reads', async () => {
    const t = fakeTransport([{ httpStatus: 500, body: undefined }]);
    await expect(client(t).call(read)).rejects.toMatchObject({ code: 'OMIE_UNAVAILABLE' });
    expect(t.sent).toBe(3);
  });

  it('NEVER retries a write, even on transient errors', async () => {
    const t = fakeTransport([
      { httpStatus: 503, body: undefined },
      { httpStatus: 200, body: {} },
    ]);
    await expect(client(t).call(write)).rejects.toMatchObject({ code: 'OMIE_UNAVAILABLE' });
    expect(t.sent).toBe(1);
  });

  it('reports network failure on writes as outcome unknown', async () => {
    const t = fakeTransport([new TypeError('fetch failed')]);
    const err = await client(t)
      .call(write)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'OMIE_UNAVAILABLE', details: { writeOutcomeUnknown: true } });
    expect(t.sent).toBe(1);
  });

  it('does not retry auth errors', async () => {
    const t = fakeTransport([
      { httpStatus: 500, body: { faultstring: 'ERROR: app_secret inválido' } },
    ]);
    await expect(client(t).call(read)).rejects.toMatchObject({ code: 'OMIE_AUTH_ERROR' });
    expect(t.sent).toBe(1);
  });

  it('times out each attempt', async () => {
    const t = fakeTransport(['hang']);
    const c = new OmieClient({
      transport: t,
      concurrency: 1,
      timeoutMs: 20,
      sleep: noSleep,
      retry: { maxRetries: 1 },
    });
    await expect(c.call(read)).rejects.toMatchObject({
      code: 'OMIE_UNAVAILABLE',
      message: expect.stringContaining('timed out'),
    });
    expect(t.sent).toBe(2);
  });

  it('honours caller cancellation without retrying', async () => {
    const t = fakeTransport(['hang']);
    const ac = new AbortController();
    const p = client(t).call(read, { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toMatchObject({ code: 'QUERY_CANCELLED' });
    expect(t.sent).toBe(1);
  });

  it('turns "no records" into an empty page for reads only', async () => {
    const fault = {
      httpStatus: 500,
      body: { faultstring: 'ERROR: Não existem registros para a página [1]!' },
    };
    const res = await client(fakeTransport([fault])).call(read);
    expect(res).toMatchObject({ noRecords: true, body: {} });
    await expect(client(fakeTransport([fault])).call(write)).rejects.toMatchObject({
      code: 'OMIE_API_ERROR',
    });
  });

  it('redacts secrets that leak into fault messages', async () => {
    const t = fakeTransport([
      { httpStatus: 500, body: { faultstring: 'boom', app_secret: SECRET } },
    ]);
    const traces: unknown[] = [];
    await client(t)
      .call(read, { onTrace: (tr) => traces.push(tr) })
      .catch(() => {});
    expect(JSON.stringify(traces)).not.toContain(SECRET);
  });

  it('truncates huge responses in traces', async () => {
    const t = fakeTransport([{ httpStatus: 200, body: { big: 'x'.repeat(5000) } }]);
    const c = new OmieClient({
      transport: t,
      concurrency: 1,
      timeoutMs: 1000,
      maxTraceResponseChars: 100,
    });
    const res = await c.call(read);
    expect(res.trace.responseTruncated).toBe(true);
    expect(res.body).toMatchObject({ big: expect.any(String) });
  });
});
