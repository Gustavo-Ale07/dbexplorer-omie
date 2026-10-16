import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, roleAllows } from '@dbx/shared';
import type { Role, StatementKind } from '@dbx/shared';
import type { AuthState } from './context';

/** Parses untrusted input with a strict schema; unknown keys are rejected (no mass assignment). */
export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid request', {
      issues: result.error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export function requireAuth(request: FastifyRequest): AuthState {
  if (!request.auth) throw new AppError('AUTH_REQUIRED', 'Authentication required');
  return request.auth;
}

export function requireRole(request: FastifyRequest, ...roles: Role[]): AuthState {
  const auth = requireAuth(request);
  if (!roles.includes(auth.user.role))
    throw new AppError('FORBIDDEN', 'You do not have permission for this action');
  return auth;
}

export function requireStatement(auth: AuthState, kind: StatementKind): void {
  if (!roleAllows(auth.user.role, kind)) {
    throw new AppError('FORBIDDEN', `Your role (${auth.user.role}) cannot run ${kind} statements`, {
      role: auth.user.role,
      kind,
    });
  }
}

export function clientIp(request: FastifyRequest): string {
  return request.ip;
}

export function noStore(reply: FastifyReply): void {
  void reply.header('cache-control', 'no-store');
}

export const uuidParam = z.object({ id: z.uuid() }).strict();
