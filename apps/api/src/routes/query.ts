import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, isAppError, isWriteKind } from '@dbx/shared';
import type { StatementKind } from '@dbx/shared';
import { MAX_SQL_LENGTH, statementHash } from '@dbx/sql-engine';
import type { OmieCallTrace } from '@dbx/omie-client';
import type { Statement, WritePlan, WriteStatement } from '@dbx/sql-engine';
import type { AuthState } from '../context';
import { auditTrace, publicTrace } from '../services/omie';
import { clientIp, noStore, parseBody, requireAuth, requireStatement } from '../http';

const EXECUTION_ID = /^[A-Za-z0-9_-]{8,64}$/;

const queryBody = z
  .object({
    sql: z.string().min(1).max(MAX_SQL_LENGTH),
    executionId: z.string().regex(EXECUTION_ID).optional(),
  })
  .strict();

const confirmBody = z
  .object({
    sql: z.string().min(1).max(MAX_SQL_LENGTH),
    token: z.string().min(1).max(200),
  })
  .strict();

const cancelBody = z.object({ executionId: z.string().regex(EXECUTION_ID) }).strict();

const WRITE_KIND: Record<'insert' | 'update' | 'delete', StatementKind> = {
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
};

export async function queryRoutes(app: FastifyInstance): Promise<void> {
  const { omie, history, audit, confirmations, executions } = app.services;
  const { engine } = omie;

  const parse = (sql: string): { stmt: Statement; kind: StatementKind } => {
    const stmt = engine.parse(sql);
    return { stmt, kind: engine.kindOf(stmt) as StatementKind };
  };

  const safeHistory = async (
    request: FastifyRequest,
    entry: Parameters<typeof history.record>[0],
  ) => {
    try {
      await history.record(entry);
    } catch (err) {
      request.log.error({ err }, 'failed to record query history');
    }
  };

  const auditBase = (request: FastifyRequest, auth: AuthState) => ({
    userId: auth.user.id,
    userEmail: auth.user.email,
    ip: clientIp(request),
    requestId: request.id,
  });

  /** Denied writes are audited too (who tried what). */
  const auditDenied = async (
    request: FastifyRequest,
    auth: AuthState,
    sql: string,
    kind: StatementKind,
    err: AppError,
  ) => {
    await audit.record({
      ...auditBase(request, auth),
      action: 'write.denied',
      status: 'denied',
      operation: kind,
      resource: safeResource(sql),
      statement: sql,
      errorCode: err.code,
      errorMessage: err.message,
    });
  };

  const safeResource = (sql: string): string | null => {
    try {
      return engine.resourceOf(engine.parse(sql)) ?? null;
    } catch {
      return null;
    }
  };

  // ------------------------------------------------------------ POST /api/query
  app.post('/api/query', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    const body = parseBody(queryBody, request.body);
    const executionId = body.executionId ?? randomUUID();
    const started = performance.now();
    let kind: StatementKind | undefined;
    let resource: string | undefined;
    const traces: OmieCallTrace[] = [];

    try {
      const parsed = parse(body.sql);
      kind = parsed.kind;
      resource = engine.resourceOf(parsed.stmt);
      try {
        requireStatement(auth, kind);
      } catch (err) {
        if (isWriteKind(kind) && isAppError(err))
          await auditDenied(request, auth, body.sql, kind, err);
        throw err;
      }

      if (isWriteKind(kind)) {
        return await previewWrite(
          request,
          auth,
          body.sql,
          parsed.stmt as WriteStatement,
          kind,
          executionId,
          started,
        );
      }

      const controller = executions.start(executionId, auth.user.id);
      // Response 'close' before the body was written means the client went away.
      const onClose = () => {
        if (!reply.raw.writableEnded)
          controller.abort(new AppError('QUERY_CANCELLED', 'The client disconnected'));
      };
      reply.raw.once('close', onClose);
      try {
        const result = await engine.query(parsed.stmt, {
          signal: controller.signal,
          onTrace: (t) => traces.push(t),
        });
        await safeHistory(request, {
          userId: auth.user.id,
          executionId,
          sql: body.sql,
          status: 'success',
          operation: kind,
          resource: resource ?? null,
          durationMs: result.durationMs,
          resultRows: result.rowCount,
          apiCalls: result.apiCalls,
        });
        return {
          type: 'result' as const,
          executionId,
          kind: result.kind,
          resource: result.resource ?? null,
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
          apiCalls: result.apiCalls,
          durationMs: result.durationMs,
          plan: result.plan ?? null,
          messages: result.messages,
          traces: result.traces.map(publicTrace),
        };
      } finally {
        reply.raw.off('close', onClose);
        executions.finish(executionId);
      }
    } catch (err) {
      const code = isAppError(err) ? err.code : 'INTERNAL_ERROR';
      await safeHistory(request, {
        userId: auth.user.id,
        executionId,
        sql: body.sql,
        status: code === 'QUERY_CANCELLED' ? 'cancelled' : 'error',
        operation: kind ?? null,
        resource: resource ?? null,
        durationMs: Math.round(performance.now() - started),
        apiCalls: traces.length,
        errorCode: code,
      });
      if (isAppError(err) && traces.length > 0) {
        // Let the UI show which Omie calls happened before the failure.
        throw new AppError(err.code, err.message, {
          ...err.details,
          traces: traces.map(publicTrace),
        });
      }
      throw err;
    }
  });

  async function previewWrite(
    request: FastifyRequest,
    auth: AuthState,
    sql: string,
    stmt: WriteStatement,
    kind: StatementKind,
    executionId: string,
    started: number,
  ) {
    let prep;
    try {
      prep = await engine.prepareWrite(stmt, omie.policy);
    } catch (err) {
      if (isAppError(err)) await auditDenied(request, auth, sql, kind, err);
      throw err;
    }
    const { plan } = prep;
    const { token, expiresAt } = await confirmations.issue(
      { userId: auth.user.id, sessionId: auth.session.id },
      plan,
    );
    await audit.record({
      ...auditBase(request, auth),
      action: 'write.preview',
      status: 'info',
      operation: kind,
      resource: plan.resource,
      statement: sql,
      targetIds: plan.targets.map((t) => t.key),
      omieCalls: prep.traces.map(auditTrace),
      durationMs: prep.durationMs,
      details: { targetCount: plan.targets.length, call: plan.call },
    });
    await safeHistory(request, {
      userId: auth.user.id,
      executionId,
      sql,
      status: 'preview',
      operation: kind,
      resource: plan.resource,
      durationMs: Math.round(performance.now() - started),
      affectedRows: 0,
      apiCalls: prep.apiCalls,
    });
    return {
      type: 'write_preview' as const,
      executionId,
      kind,
      resource: plan.resource,
      preview: previewPayload(plan),
      request: engine.describeWriteRequest(plan, 0) ?? null,
      apiCalls: prep.apiCalls,
      durationMs: prep.durationMs,
      traces: prep.traces.map(publicTrace),
      confirmation: { token, expiresAt: expiresAt.toISOString() },
    };
  }

  // ------------------------------------------------------------ POST /api/query/confirm
  app.post('/api/query/confirm', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    const body = parseBody(confirmBody, request.body);
    const { stmt, kind } = parse(body.sql);
    if (!isWriteKind(kind))
      throw new AppError('VALIDATION_ERROR', 'Only INSERT, UPDATE and DELETE need confirmation');
    try {
      requireStatement(auth, kind);
    } catch (err) {
      if (isAppError(err)) await auditDenied(request, auth, body.sql, kind, err);
      throw err;
    }

    return executions.exclusiveWrite(auth.user.id, async () => {
      const started = performance.now();
      const ctx = { userId: auth.user.id, sessionId: auth.session.id };
      // The token is verified and consumed before any Omie call: forged, replayed or
      // expired tokens never reach the API, and a token can be spent only once.
      const preview = await confirmations.consume(
        body.token,
        ctx,
        statementHash(stmt as WriteStatement),
      );
      // Then everything is re-checked with fresh data: flags, capability, WHERE, limits, targets.
      let fresh;
      try {
        fresh = await engine.prepareWrite(stmt as WriteStatement, omie.policy);
      } catch (err) {
        if (isAppError(err)) await auditDenied(request, auth, body.sql, kind, err);
        throw err;
      }
      if (preview.targetsHash !== fresh.plan.targetsHash) {
        await audit.record({
          ...auditBase(request, auth),
          action: 'write.rejected',
          status: 'denied',
          operation: kind,
          resource: fresh.plan.resource,
          statement: body.sql,
          errorCode: 'TARGETS_CHANGED',
        });
        throw new AppError(
          'TARGETS_CHANGED',
          'The affected records changed since the preview. Review the new preview before confirming.',
        );
      }

      const plan = fresh.plan;
      const executionId = randomUUID();
      let run;
      try {
        run = await engine.executeWrite(plan);
      } catch (err) {
        const code = isAppError(err) ? err.code : 'INTERNAL_ERROR';
        await audit.record({
          ...auditBase(request, auth),
          action: 'write.execute',
          status: 'failed',
          operation: kind,
          resource: plan.resource,
          statement: body.sql,
          targetIds: plan.targets.map((t) => t.key),
          before: plan.targets.map((t) => t.before),
          after: plan.targets.map((t) => t.after),
          durationMs: Math.round(performance.now() - started),
          errorCode: code,
          errorMessage: isAppError(err) ? err.message : 'Unexpected error',
        });
        throw err;
      }
      const { execution } = run;
      const failed = execution.results.find((r) => !r.ok);
      const durationMs = Math.round(performance.now() - started);
      await audit.record({
        ...auditBase(request, auth),
        action: 'write.execute',
        status: execution.status,
        operation: kind,
        resource: plan.resource,
        statement: body.sql,
        targetIds: plan.targets.map((t) => t.key),
        before: plan.targets.map((t) => t.before),
        after: plan.targets.map((t) => t.after),
        omieCalls: [...fresh.traces, ...run.traces].map(auditTrace),
        durationMs,
        errorCode: failed?.errorCode ?? null,
        errorMessage: failed?.errorMessage ?? null,
        details: {
          call: plan.call,
          attempted: execution.attempted,
          succeeded: execution.succeeded,
          notAttempted: execution.notAttempted,
          generated: execution.results.map((r) => r.generated).filter(Boolean),
          outcomeUnknown: execution.results.some((r) => r.outcomeUnknown),
        },
      });
      await safeHistory(request, {
        userId: auth.user.id,
        executionId,
        sql: body.sql,
        status: execution.status === 'success' ? 'success' : 'error',
        operation: WRITE_KIND[plan.kind],
        resource: plan.resource,
        durationMs,
        affectedRows: execution.succeeded,
        apiCalls: fresh.apiCalls + run.apiCalls,
        errorCode: failed?.errorCode ?? null,
      });
      return {
        type: 'write_result' as const,
        executionId,
        kind,
        resource: plan.resource,
        execution,
        apiCalls: fresh.apiCalls + run.apiCalls,
        durationMs,
        traces: [...fresh.traces, ...run.traces].map(publicTrace),
        messages: writeMessages(execution),
      };
    });
  });

  // ------------------------------------------------------------ POST /api/query/cancel
  app.post('/api/query/cancel', async (request) => {
    const auth = requireAuth(request);
    const body = parseBody(cancelBody, request.body);
    const cancelled = executions.cancel(body.executionId, auth.user.id, auth.user.role === 'ADMIN');
    return { cancelled };
  });
}

function previewPayload(plan: WritePlan) {
  return {
    operation: WRITE_KIND[plan.kind],
    resource: plan.resource,
    endpoint: plan.endpoint,
    call: plan.call,
    changedColumns: plan.changedColumns,
    targetCount: plan.targets.length,
    targets: plan.targets.map((t) => ({ key: t.key, before: t.before, after: t.after })),
    messages: plan.messages,
    notice:
      'Omie has no transactions: each record is sent in its own call, in order, and execution stops at the first error. There is no automatic rollback.',
  };
}

function writeMessages(execution: {
  status: string;
  attempted: number;
  succeeded: number;
  notAttempted: unknown[];
}): string[] {
  const msgs = [`${execution.succeeded} of ${execution.attempted} Omie call(s) succeeded.`];
  if (execution.notAttempted.length > 0) {
    msgs.push(
      `${execution.notAttempted.length} record(s) were not sent because an earlier call failed.`,
    );
  }
  if (execution.status !== 'success')
    msgs.push('Changes already applied were NOT reverted. Check the audit log.');
  return msgs;
}
