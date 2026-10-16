import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, isAppError } from '@dbx/shared';
import { publicTrace } from '../services/omie';
import { clientIp, noStore, parseBody, requireAuth, requireRole } from '../http';

const inspectBody = z
  .object({
    id: z.string().min(3).max(100),
    param: z.record(z.string(), z.unknown()),
  })
  .strict();

interface Connectivity {
  status: 'mock' | 'ok' | 'error' | 'unknown';
  checkedAt: string | null;
  errorCode?: string;
  message?: string;
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const { config, omie, database, audit, startedAt } = app.services;
  let connectivity: Connectivity =
    omie.mode === 'mock'
      ? { status: 'mock', checkedAt: null }
      : { status: 'unknown', checkedAt: null };
  let lastCheck = 0;

  // Probes hit these every few seconds; keep them out of the info-level request log.
  const probe = { logLevel: 'warn' } as const;

  app.get('/health/live', probe, async () => ({ status: 'ok' }));

  app.get('/health/ready', probe, async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = { database: 'ok', registry: 'ok' };
    try {
      await database.ping();
    } catch {
      checks.database = 'error';
    }
    if (omie.engine.schema().length === 0) checks.registry = 'error';
    const ok = Object.values(checks).every((v) => v === 'ok');
    void reply.code(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'error', checks };
  });

  /** Public, minimal: what the login page and footer need. */
  app.get('/api/meta', async () => ({
    name: 'Omie SQL Explorer',
    version: config.version,
    commit: config.commit,
    omieMode: omie.mode,
    aiEnabled: app.services.ai !== null,
  }));

  app.get('/api/schema', async (request, reply) => {
    requireAuth(request);
    void reply.header('cache-control', 'private, max-age=300');
    return { tables: omie.engine.schema() };
  });

  app.get('/api/status', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    const query = request.query as { check?: string };
    // Live connectivity probes are admin-only and throttled (Omie counts every call).
    if (query.check === '1' && omie.mode === 'live') {
      requireRole(request, 'ADMIN');
      if (Date.now() - lastCheck > 60_000) {
        lastCheck = Date.now();
        try {
          await omie.engine.inspect('geral/clientes:ListarClientes', {
            pagina: 1,
            registros_por_pagina: 1,
          });
          connectivity = { status: 'ok', checkedAt: new Date().toISOString() };
        } catch (err) {
          connectivity = {
            status: 'error',
            checkedAt: new Date().toISOString(),
            errorCode: isAppError(err) ? err.code : 'INTERNAL_ERROR',
            message: isAppError(err) ? err.message : 'Unexpected error',
          };
        }
      }
    }
    let databaseStatus: 'ok' | 'error' = 'ok';
    try {
      await database.ping();
    } catch {
      databaseStatus = 'error';
    }
    const isAdmin = auth.user.role === 'ADMIN';
    return {
      version: config.version,
      commit: config.commit,
      environment: config.env,
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      database: { status: databaseStatus, kind: database.kind },
      omie: {
        mode: omie.mode,
        connectivity,
        ...(isAdmin
          ? {
              baseUrl: config.omie.baseUrl,
              credentialsConfigured: Boolean(config.omie.appKey && config.omie.appSecret),
            }
          : {}),
      },
      writes: {
        readOnly: config.omie.readOnly,
        allowInsert: config.omie.allowInsert,
        allowUpdate: config.omie.allowUpdate,
        allowDelete: config.omie.allowDelete,
      },
      limits: {
        maxRows: config.omie.maxRows,
        maxApiCalls: config.omie.maxApiCalls,
        maxWriteRows: config.omie.maxWriteRows,
        concurrency: config.omie.concurrency,
        timeoutMs: config.omie.timeoutMs,
        queryTimeoutMs: config.omie.queryTimeoutMs,
      },
      ai: {
        provider: config.ai.provider,
        model: app.services.ai?.model ?? null,
        shareResultData: config.ai.shareResultData,
      },
      role: auth.user.role,
    };
  });

  app.get('/api/inspector/calls', async (request) => {
    requireAuth(request);
    return { items: omie.engine.inspectorCalls() };
  });

  /** Read-only calls from the allowlist only; the URL is never user-controlled. */
  app.post(
    '/api/inspector/execute',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      const auth = requireAuth(request);
      const body = parseBody(inspectBody, request.body);
      if (!omie.engine.inspectorCalls().some((c) => c.id === body.id)) {
        throw new AppError('FORBIDDEN', 'This Omie call is not in the inspector allowlist');
      }
      const started = performance.now();
      const event = {
        action: 'inspector.execute',
        userId: auth.user.id,
        userEmail: auth.user.email,
        ip: clientIp(request),
        requestId: request.id,
        details: { call: body.id, param: body.param },
      };
      let result: Awaited<ReturnType<typeof omie.engine.inspect>>;
      try {
        result = await omie.engine.inspect(body.id, body.param);
      } catch (err) {
        await audit.record({
          ...event,
          status: 'failed',
          errorCode: isAppError(err) ? err.code : 'INTERNAL_ERROR',
          durationMs: Math.round(performance.now() - started),
        });
        throw err;
      }
      await audit.record({
        ...event,
        status: 'success',
        durationMs: Math.round(performance.now() - started),
      });
      return {
        request: result.request,
        response: result.response,
        noRecords: result.noRecords,
        durationMs: result.durationMs,
        trace: result.trace ? publicTrace(result.trace) : null,
      };
    },
  );
}
