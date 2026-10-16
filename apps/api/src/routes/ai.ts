import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, isAppError, roleAllows } from '@dbx/shared';
import type { StatementKind } from '@dbx/shared';
import { MAX_SQL_LENGTH } from '@dbx/sql-engine';
import type { ExplainableStatement } from '@dbx/sql-engine';
import { buildSystemPrompt, buildUserPrompt, parseModelAnswer } from '../ai/prompt';
import { clientIp, noStore, parseBody, requireAuth } from '../http';

const generateBody = z
  .object({
    question: z.string().trim().min(3).max(2000),
    currentSql: z.string().max(MAX_SQL_LENGTH).optional(),
    resultSample: z
      .object({
        columns: z.array(z.string().max(200)).max(100),
        rows: z.array(z.array(z.unknown()).max(100)).max(20),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const { ai, config, omie, audit } = app.services;

  app.post(
    '/api/ai/generate',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      const auth = requireAuth(request);
      if (!ai)
        throw new AppError(
          'AI_PROVIDER_DISABLED',
          'The AI assistant is disabled (AI_PROVIDER=disabled)',
        );
      const body = parseBody(generateBody, request.body);
      const system = buildSystemPrompt(omie.engine.schema(), config.omie.maxRows);
      const user = buildUserPrompt({
        question: body.question,
        ...(body.currentSql ? { currentSql: body.currentSql } : {}),
        // Result data leaves the server only when explicitly allowed.
        ...(config.ai.shareResultData && body.resultSample
          ? { resultSample: body.resultSample }
          : {}),
      });
      const started = performance.now();
      const text = await ai.complete(system, user, AbortSignal.timeout(config.ai.timeoutMs));
      const answer = parseModelAnswer(text);
      if (!answer)
        throw new AppError('AI_PROVIDER_ERROR', 'The AI answer did not contain a SQL statement');

      // The suggestion goes through the same parser/validator/planner, without calling Omie.
      let validation: { ok: boolean; kind?: StatementKind; errorCode?: string; message?: string };
      try {
        const stmt = omie.engine.parse(answer.sql);
        const kind = omie.engine.kindOf(stmt) as StatementKind;
        if (kind === 'SELECT' || kind === 'INSERT' || kind === 'UPDATE' || kind === 'DELETE') {
          omie.engine.explain(stmt as ExplainableStatement);
        }
        validation = { ok: true, kind };
        if (!roleAllows(auth.user.role, kind)) {
          validation = {
            ok: false,
            kind,
            errorCode: 'FORBIDDEN',
            message: `Your role cannot run ${kind} statements`,
          };
        }
      } catch (err) {
        validation = {
          ok: false,
          errorCode: isAppError(err) ? err.code : 'SQL_PARSE_ERROR',
          message: isAppError(err) ? err.message : 'Invalid SQL',
        };
      }
      await audit.record({
        action: 'ai.generate',
        status: 'info',
        userId: auth.user.id,
        userEmail: auth.user.email,
        ip: clientIp(request),
        requestId: request.id,
        statement: answer.sql,
        details: {
          provider: ai.name,
          model: ai.model,
          valid: validation.ok,
          sharedResultData: Boolean(user.includes('<untrusted_data>')),
        },
        durationMs: Math.round(performance.now() - started),
      });
      return {
        sql: answer.sql,
        explanation: answer.explanation,
        provider: ai.name,
        model: ai.model,
        validation,
        requiresConfirmation:
          validation.kind === 'INSERT' ||
          validation.kind === 'UPDATE' ||
          validation.kind === 'DELETE',
      };
    },
  );
}
