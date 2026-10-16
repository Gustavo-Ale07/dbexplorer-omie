import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { writePreviews } from '@dbx/database';
import type { Database, WritePreviewRow } from '@dbx/database';
import { AppError } from '@dbx/shared';
import type { WritePlan } from '@dbx/sql-engine';
import { hmac, safeEqual } from '../security/crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ConfirmationContext {
  userId: string;
  sessionId: string;
}

/**
 * Write confirmation tokens: `<previewId>.<HMAC(previewId|user|session|statementHash)>`.
 * The server-side row makes them single-use (consumed atomically), short-lived and bound
 * to the user, the session and the exact statement that was previewed.
 */
export class ConfirmationsService {
  constructor(
    private readonly db: Database,
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  private sign(id: string, ctx: ConfirmationContext, statementHash: string): string {
    return hmac(
      this.secret,
      `write-confirmation|${id}|${ctx.userId}|${ctx.sessionId}|${statementHash}`,
    );
  }

  async issue(
    ctx: ConfirmationContext,
    plan: WritePlan,
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const [row] = await this.db
      .insert(writePreviews)
      .values({
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        statementHash: plan.statementHash,
        targetsHash: plan.targetsHash,
        operation: plan.kind.toUpperCase(),
        resource: plan.resource,
        targetCount: plan.targets.length,
        expiresAt,
      })
      .returning({ id: writePreviews.id });
    const id = (row as { id: string }).id;
    return { token: `${id}.${this.sign(id, ctx, plan.statementHash)}`, expiresAt };
  }

  /**
   * Validates and consumes a token. Signature, owner, session and statement are checked
   * before the atomic "consume once" update, so a forged token cannot burn a real one.
   */
  async consume(
    token: unknown,
    ctx: ConfirmationContext,
    statementHash: string,
  ): Promise<WritePreviewRow> {
    if (typeof token !== 'string' || token.length > 200) throw invalid();
    const [id, signature] = token.split('.');
    if (!id || !signature || !UUID.test(id)) throw invalid();
    if (!safeEqual(signature, this.sign(id, ctx, statementHash))) throw invalid();

    const [row] = await this.db
      .select()
      .from(writePreviews)
      .where(eq(writePreviews.id, id))
      .limit(1);
    if (
      !row ||
      row.userId !== ctx.userId ||
      row.sessionId !== ctx.sessionId ||
      row.statementHash !== statementHash
    ) {
      throw invalid();
    }
    if (row.consumedAt)
      throw new AppError(
        'CONFIRMATION_USED',
        'This confirmation was already used. Preview the statement again.',
      );
    if (row.expiresAt.getTime() <= Date.now()) {
      throw new AppError(
        'CONFIRMATION_EXPIRED',
        'This confirmation expired. Preview the statement again.',
      );
    }
    const consumed = await this.db
      .update(writePreviews)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(writePreviews.id, id),
          isNull(writePreviews.consumedAt),
          gt(writePreviews.expiresAt, new Date()),
        ),
      )
      .returning();
    const won = consumed[0];
    if (!won)
      throw new AppError(
        'CONFIRMATION_USED',
        'This confirmation was already used. Preview the statement again.',
      );
    return won;
  }

  async purge(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 3600_000);
    await this.db
      .delete(writePreviews)
      .where(or(lt(writePreviews.expiresAt, cutoff), lt(writePreviews.consumedAt, cutoff)));
  }
}

function invalid(): AppError {
  return new AppError('CONFIRMATION_INVALID', 'Invalid confirmation token');
}
