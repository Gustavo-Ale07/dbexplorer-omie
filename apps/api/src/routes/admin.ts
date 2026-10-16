import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLES } from '@dbx/shared';
import type { AuditEventRow } from '@dbx/database';
import { toPublicUser } from '../services/users';
import { clientIp, noStore, parseBody, requireRole, uuidParam } from '../http';
import { passwordPolicyError } from './auth';

const createUserBody = z
  .object({
    email: z.email().max(254),
    name: z.string().trim().min(1).max(120),
    password: z.string().min(12).max(512),
    role: z.enum(ROLES),
  })
  .strict();

const updateUserBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.enum(ROLES).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const resetPasswordBody = z.object({ password: z.string().min(12).max(512) }).strict();

const auditQuery = z
  .object({
    action: z.string().max(60).optional(),
    userEmail: z.string().max(254).optional(),
    resource: z.string().max(60).optional(),
    status: z.enum(['success', 'partial', 'failed', 'denied', 'info']).optional(),
    from: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
    to: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

const toAudit = (a: AuditEventRow) => ({
  id: a.id,
  createdAt: a.createdAt.toISOString(),
  userId: a.userId,
  userEmail: a.userEmail,
  ip: a.ip,
  requestId: a.requestId,
  action: a.action,
  operation: a.operation,
  resource: a.resource,
  statement: a.statement,
  targetIds: a.targetIds,
  before: a.before,
  after: a.after,
  omieCalls: a.omieCalls,
  status: a.status,
  durationMs: a.durationMs,
  errorCode: a.errorCode,
  errorMessage: a.errorMessage,
  details: a.details,
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const { users, audit } = app.services;

  const record = (
    request: Parameters<typeof clientIp>[0],
    actor: { id: string; email: string },
    action: string,
    details: Record<string, unknown>,
  ) =>
    audit.record({
      action,
      status: 'success',
      userId: actor.id,
      userEmail: actor.email,
      ip: clientIp(request),
      requestId: request.id,
      details,
    });

  app.get('/api/admin/users', async (request, reply) => {
    noStore(reply);
    requireRole(request, 'ADMIN');
    return { items: (await users.list()).map(toPublicUser) };
  });

  app.post('/api/admin/users', async (request, reply) => {
    const { user: actor } = requireRole(request, 'ADMIN');
    const body = parseBody(createUserBody, request.body);
    const weak = passwordPolicyError(body.password);
    if (weak) throw weak;
    const created = await users.create({ ...body, mustChangePassword: true });
    await record(request, actor, 'user.create', {
      targetUserId: created.id,
      email: created.email,
      role: created.role,
    });
    void reply.code(201);
    return { item: toPublicUser(created) };
  });

  app.patch('/api/admin/users/:id', async (request) => {
    const { user: actor } = requireRole(request, 'ADMIN');
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(updateUserBody, request.body);
    const updated = await users.update(id, body, actor.id);
    await record(request, actor, 'user.update', { targetUserId: id, changes: body });
    return { item: toPublicUser(updated) };
  });

  app.post('/api/admin/users/:id/reset-password', async (request) => {
    const { user: actor } = requireRole(request, 'ADMIN');
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(resetPasswordBody, request.body);
    const weak = passwordPolicyError(body.password);
    if (weak) throw weak;
    await users.setPassword(id, body.password, true);
    await users.revokeSessions(id);
    await record(request, actor, 'user.reset_password', { targetUserId: id });
    return { ok: true };
  });

  app.get('/api/audit', async (request, reply) => {
    noStore(reply);
    requireRole(request, 'ADMIN');
    const { from, to, ...q } = parseBody(auditQuery, request.query);
    const { items, total } = await audit.list({
      ...q,
      ...(from ? { from: new Date(from) } : {}),
      ...(to ? { to: endOfDay(to) } : {}),
    });
    return { items: items.map(toAudit), total };
  });
}

function endOfDay(value: string | Date): Date {
  if (typeof value === 'string' && value.length === 10) return new Date(`${value}T23:59:59.999Z`);
  return new Date(value);
}
