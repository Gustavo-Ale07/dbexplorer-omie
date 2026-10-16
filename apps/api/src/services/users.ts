import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { sessions, users } from '@dbx/database';
import type { Database, UserRow } from '@dbx/database';
import { AppError } from '@dbx/shared';
import type { Role } from '@dbx/shared';
import { hashPassword } from '../security/crypto';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: u.active,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export class UsersService {
  constructor(private readonly db: Database) {}

  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [u] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return u;
  }

  async findById(id: string): Promise<UserRow | undefined> {
    const [u] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return u;
  }

  async list(): Promise<UserRow[]> {
    return this.db.select().from(users).orderBy(asc(users.email));
  }

  async count(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(users);
    return row?.n ?? 0;
  }

  async create(input: {
    email: string;
    name: string;
    password: string;
    role: Role;
    mustChangePassword?: boolean;
  }) {
    try {
      const [u] = await this.db
        .insert(users)
        .values({
          email: input.email.trim().toLowerCase(),
          name: input.name.trim(),
          passwordHash: await hashPassword(input.password),
          role: input.role,
          mustChangePassword: input.mustChangePassword ?? false,
        })
        .returning();
      return u as UserRow;
    } catch (err) {
      if (isUniqueViolation(err))
        throw new AppError('CONFLICT', 'A user with this e-mail already exists');
      throw err;
    }
  }

  /**
   * Creates the first administrator from BOOTSTRAP_ADMIN_* only when the users table is empty.
   * An existing account is never overwritten.
   */
  async bootstrapAdmin(
    admin: { email: string; password: string; name: string } | undefined,
  ): Promise<'created' | 'skipped'> {
    if (!admin) return 'skipped';
    if ((await this.count()) > 0) return 'skipped';
    try {
      await this.create({ ...admin, role: 'ADMIN' });
      return 'created';
    } catch (err) {
      // Another instance may have bootstrapped concurrently.
      if (err instanceof AppError && err.code === 'CONFLICT') return 'skipped';
      throw err;
    }
  }

  async activeAdminCount(exceptId?: string): Promise<number> {
    const conditions = [eq(users.role, 'ADMIN'), eq(users.active, true)];
    if (exceptId) conditions.push(ne(users.id, exceptId));
    const [row] = await this.db
      .select({ n: count() })
      .from(users)
      .where(and(...conditions));
    return row?.n ?? 0;
  }

  /** Role / status / name changes. Revokes the user's sessions when access is reduced. */
  async update(
    id: string,
    patch: { name?: string; role?: Role; active?: boolean },
    actorId: string,
  ): Promise<UserRow> {
    const current = await this.findById(id);
    if (!current) throw new AppError('NOT_FOUND', 'User not found');
    const losesAdmin =
      current.role === 'ADMIN' &&
      ((patch.role && patch.role !== 'ADMIN') || patch.active === false);
    if (losesAdmin && (await this.activeAdminCount(id)) === 0) {
      throw new AppError('CONFLICT', 'At least one active administrator must remain');
    }
    if (id === actorId && (patch.active === false || (patch.role && patch.role !== current.role))) {
      throw new AppError('CONFLICT', 'You cannot change your own role or deactivate yourself');
    }
    const [u] = await this.db
      .update(users)
      .set({ ...patch, ...(patch.name ? { name: patch.name.trim() } : {}), updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (patch.active === false || (patch.role && patch.role !== current.role))
      await this.revokeSessions(id);
    return u as UserRow;
  }

  async setPassword(id: string, password: string, mustChangePassword: boolean): Promise<void> {
    const result = await this.db
      .update(users)
      .set({
        passwordHash: await hashPassword(password),
        mustChangePassword,
        passwordChangedAt: new Date(),
        failedLogins: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (result.length === 0) throw new AppError('NOT_FOUND', 'User not found');
  }

  async revokeSessions(userId: string, exceptSessionId?: string): Promise<void> {
    const conditions = [eq(sessions.userId, userId), sql`${sessions.revokedAt} is null`];
    if (exceptSessionId) conditions.push(ne(sessions.id, exceptSessionId));
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(...conditions));
  }

  /** Increments the failure counter atomically and locks the account at the threshold. */
  async recordLoginFailure(
    id: string,
    maxAttempts: number,
    lockMinutes: number,
  ): Promise<{ locked: boolean }> {
    const [row] = await this.db
      .update(users)
      .set({
        failedLogins: sql`${users.failedLogins} + 1`,
        lockedUntil: sql`case when ${users.failedLogins} + 1 >= ${maxAttempts} then now() + (${lockMinutes} * interval '1 minute') else ${users.lockedUntil} end`,
      })
      .where(eq(users.id, id))
      .returning({ failedLogins: users.failedLogins });
    return { locked: (row?.failedLogins ?? 0) >= maxAttempts };
  }

  async recordLoginSuccess(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(users.id, id));
  }
}
