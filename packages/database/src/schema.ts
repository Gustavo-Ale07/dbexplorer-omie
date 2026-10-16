import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['VIEWER', 'OPERATOR', 'ADMIN'] }).notNull(),
    active: boolean('active').notNull().default(true),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    check('users_role_check', sql`${t.role} in ('VIEWER', 'OPERATOR', 'ADMIN')`),
    check('users_email_lower_check', sql`${t.email} = lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of the opaque cookie token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

export const savedQueries = pgTable(
  'saved_queries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    sql: text('sql').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('saved_queries_user_name_key').on(t.userId, t.name)],
);

/** Execution metadata only — result rows are never persisted. */
export const queryHistory = pgTable(
  'query_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    executionId: text('execution_id').notNull(),
    sql: text('sql').notNull(),
    status: text('status', { enum: ['success', 'error', 'cancelled', 'preview'] }).notNull(),
    operation: text('operation'),
    resource: text('resource'),
    durationMs: integer('duration_ms').notNull(),
    resultRows: integer('result_rows'),
    affectedRows: integer('affected_rows'),
    apiCalls: integer('api_calls').notNull().default(0),
    errorCode: text('error_code'),
    createdAt: createdAt(),
  },
  (t) => [index('query_history_user_created_idx').on(t.userId, t.createdAt)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: createdAt(),
    /** Kept even if the user is removed later. */
    userId: uuid('user_id'),
    userEmail: text('user_email'),
    ip: text('ip'),
    requestId: text('request_id'),
    /** e.g. write.execute, write.preview, auth.login, auth.login_failed, user.create */
    action: text('action').notNull(),
    operation: text('operation'),
    resource: text('resource'),
    statement: text('statement'),
    targetIds: jsonb('target_ids').$type<unknown[]>(),
    before: jsonb('before').$type<unknown>(),
    after: jsonb('after').$type<unknown>(),
    /** Redacted summary of the Omie calls made (endpoint, call, status, duration). */
    omieCalls: jsonb('omie_calls').$type<unknown[]>(),
    status: text('status', { enum: ['success', 'partial', 'failed', 'denied', 'info'] }).notNull(),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    details: jsonb('details').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('audit_events_created_idx').on(t.createdAt),
    index('audit_events_user_idx').on(t.userId),
    index('audit_events_action_idx').on(t.action),
  ],
);

/** Server-side record behind each write confirmation token (single use, short-lived). */
export const writePreviews = pgTable(
  'write_previews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    statementHash: text('statement_hash').notNull(),
    targetsHash: text('targets_hash').notNull(),
    operation: text('operation').notNull(),
    resource: text('resource').notNull(),
    targetCount: integer('target_count').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [index('write_previews_user_idx').on(t.userId)],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SavedQueryRow = typeof savedQueries.$inferSelect;
export type QueryHistoryRow = typeof queryHistory.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type WritePreviewRow = typeof writePreviews.$inferSelect;
