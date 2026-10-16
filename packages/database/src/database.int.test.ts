import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase } from './client';
import type { DatabaseHandle } from './client';
import { auditEvents, sessions, users } from './schema';

let handle: DatabaseHandle;

beforeAll(async () => {
  handle = await createDatabase('pglite:memory');
  await handle.migrate();
});

afterAll(async () => {
  await handle.close();
});

describe('database', () => {
  it('applies migrations idempotently and answers ping', async () => {
    await handle.migrate();
    await expect(handle.ping()).resolves.toBeUndefined();
  });

  it('enforces unique lower-case e-mails and valid roles', async () => {
    const [u] = await handle.db
      .insert(users)
      .values({ email: 'admin@example.com', name: 'Admin', passwordHash: 'x', role: 'ADMIN' })
      .returning();
    expect(u?.active).toBe(true);
    await expect(
      handle.db
        .insert(users)
        .values({ email: 'admin@example.com', name: 'Dup', passwordHash: 'x', role: 'ADMIN' }),
    ).rejects.toThrow();
    await expect(
      handle.db
        .insert(users)
        .values({ email: 'Upper@Example.com', name: 'U', passwordHash: 'x', role: 'VIEWER' }),
    ).rejects.toThrow();
    await expect(
      handle.db
        .insert(users)
        .values({
          email: 'root@example.com',
          name: 'R',
          passwordHash: 'x',
          role: 'ROOT' as 'ADMIN',
        }),
    ).rejects.toThrow();
  });

  it('cascades sessions and keeps audit events', async () => {
    const [u] = await handle.db
      .insert(users)
      .values({ email: 'temp@example.com', name: 'Temp', passwordHash: 'x', role: 'VIEWER' })
      .returning();
    await handle.db
      .insert(sessions)
      .values({ tokenHash: 'h1', userId: u!.id, expiresAt: new Date(Date.now() + 1000) });
    await handle.db
      .insert(auditEvents)
      .values({ action: 'auth.login', status: 'success', userId: u!.id });
    await handle.db.delete(users).where(eq(users.id, u!.id));
    expect(await handle.db.select().from(sessions).where(eq(sessions.userId, u!.id))).toHaveLength(
      0,
    );
    expect(
      await handle.db.select().from(auditEvents).where(eq(auditEvents.userId, u!.id)),
    ).toHaveLength(1);
  });

  it('rejects non-postgres URLs', async () => {
    await expect(createDatabase('mysql://localhost/db')).rejects.toThrow(/postgres/);
  });
});
