/**
 * INSERT / UPDATE / DELETE against Omie. Nothing here is transactional: Omie
 * has no multi-call transactions, so a write is planned (targets resolved and
 * previewed), confirmed by the user, then executed one call at a time with no
 * automatic retry. The first failure stops the run and the report lists what was
 * already applied.
 */
import { createHash } from 'node:crypto';
import { AppError, isAppError } from '@dbx/shared';
import type {
  DeleteStatement,
  Expr,
  InsertStatement,
  SelectStatement,
  UpdateStatement,
  WriteStatement,
} from './ast';
import { walkColumns } from './ast';
import type { EngineLimits, ExecutionContext } from './context';
import { Scope, compile } from './eval';
import { executeSelect } from './executor';
import type { Value } from './normalize';
import { normalizeValue, toWireValue } from './normalize';
import { bindSelect, resolveResource } from './planner';
import type { QueryPlan } from './planner';
import { findColumn, readPath, setPath } from './registry';
import type { ColumnDef, Registry, ResourceDef, WriteOp } from './registry';

export type WriteKind = 'insert' | 'update' | 'delete';

export interface WritePolicy {
  readOnly: boolean;
  allowInsert: boolean;
  allowUpdate: boolean;
  allowDelete: boolean;
}

export type RecordValues = Record<string, Value>;

export interface WriteTarget {
  /** Identifying columns of the record (empty for INSERT). */
  key: RecordValues;
  before: RecordValues | null;
  after: RecordValues;
  /** Business payload sent to Omie (no credentials; the transport adds them). */
  param: Record<string, unknown>;
}

export interface WritePlan {
  kind: WriteKind;
  resource: string;
  endpoint: string;
  call: string;
  changedColumns: string[];
  targets: WriteTarget[];
  statementHash: string;
  targetsHash: string;
  /** Plan used to resolve the targets (UPDATE / DELETE). */
  resolution?: QueryPlan;
  messages: string[];
}

export interface WriteStepResult {
  key: RecordValues;
  ok: boolean;
  /** Generated keys for INSERT. */
  generated?: RecordValues;
  errorCode?: string;
  errorMessage?: string;
  /** True when the outcome is unknown (timeout / network error after sending). */
  outcomeUnknown?: boolean;
}

export interface WriteExecution {
  kind: WriteKind;
  resource: string;
  call: string;
  attempted: number;
  succeeded: number;
  results: WriteStepResult[];
  /** Targets never sent because an earlier call failed. */
  notAttempted: RecordValues[];
  status: 'success' | 'partial' | 'failed';
}

const DISABLED = {
  insert: 'INSERT_DISABLED',
  update: 'UPDATE_DISABLED',
  delete: 'DELETE_DISABLED',
} as const;
const FLAG = {
  insert: 'OMIE_ALLOW_INSERT',
  update: 'OMIE_ALLOW_UPDATE',
  delete: 'OMIE_ALLOW_DELETE',
} as const;

/** Environment flags. Checked after the role check (done by the caller) and before anything else. */
export function assertWriteEnabled(kind: WriteKind, policy: WritePolicy): void {
  if (policy.readOnly) {
    throw new AppError(
      'READ_ONLY_MODE',
      'The server runs in read-only mode (OMIE_READ_ONLY=true). Writes are disabled.',
    );
  }
  const allowed =
    kind === 'insert'
      ? policy.allowInsert
      : kind === 'update'
        ? policy.allowUpdate
        : policy.allowDelete;
  if (!allowed)
    throw new AppError(
      DISABLED[kind],
      `${kind.toUpperCase()} is disabled on this server (${FLAG[kind]}=false).`,
    );
}

export function writeOperation(
  resource: ResourceDef,
  kind: WriteKind,
  columns: string[] = [],
): WriteOp {
  if (kind === 'delete') {
    if (!resource.writes.delete) {
      throw new AppError(
        'OPERATION_NOT_SUPPORTED',
        'The Omie API does not expose deletion for this resource.',
        {
          table: resource.name,
          operation: 'DELETE',
        },
      );
    }
    return resource.writes.delete;
  }
  if (kind === 'insert') {
    if (!resource.writes.insert) {
      throw new AppError(
        'OPERATION_NOT_SUPPORTED',
        `INSERT is not supported for ${resource.name}.`,
        {
          table: resource.name,
          operation: 'INSERT',
          ...(resource.notes ? { notes: resource.notes } : {}),
        },
      );
    }
    return resource.writes.insert;
  }
  const update = resource.writes.update;
  if (!update) {
    throw new AppError('OPERATION_NOT_SUPPORTED', `UPDATE is not supported for ${resource.name}.`, {
      table: resource.name,
      operation: 'UPDATE',
    });
  }
  return typeof update === 'function' ? update(columns) : update;
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Stable hash of the statement itself (formatting-independent). */
export function statementHash(stmt: WriteStatement): string {
  return sha256(stmt);
}

function targetsHashOf(kind: WriteKind, targets: WriteTarget[]): string {
  const parts = targets
    .map((t) => JSON.stringify(kind === 'insert' ? t.param : [t.key, t.before, t.param]))
    .sort();
  return sha256(parts);
}

function constant(expr: Expr, context: string): Value {
  let hasColumn = false;
  walkColumns(expr, () => (hasColumn = true));
  if (hasColumn)
    throw new AppError(
      'SQL_UNSUPPORTED',
      `${context} must be a constant value; column references are not allowed.`,
    );
  return compile(expr, new Scope([]))([]);
}

function requireColumn(resource: ResourceDef, name: string): ColumnDef {
  const col = findColumn(resource, name);
  if (!col)
    throw new AppError('COLUMN_NOT_FOUND', `Unknown column "${name}" in ${resource.name}.`, {
      column: name,
    });
  return col;
}

function wirePath(op: WriteOp, col: ColumnDef): string {
  const path = op.paths?.[col.name] ?? col.path;
  if (path.startsWith('$parent')) {
    throw new AppError(
      'INTERNAL_ERROR',
      `Registry error: ${col.name} has no write path for ${op.call}.`,
    );
  }
  return path;
}

function noDuplicates(names: string[]): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) throw new AppError('SQL_UNSUPPORTED', `Column ${n} appears more than once.`);
    seen.add(n);
  }
}

function rowToRecord(resource: ResourceDef, row: Value[]): RecordValues {
  const out: RecordValues = {};
  resource.columns.forEach((c, i) => (out[c.name] = row[i] ?? null));
  return out;
}

/** Value as it will read back after the write (normalized like a SELECT would show it). */
function displayValue(col: ColumnDef, wire: unknown): Value {
  return normalizeValue(wire, col.type);
}

export interface PrepareInput {
  registry: Registry;
  stmt: WriteStatement;
  policy: WritePolicy;
  limits: EngineLimits;
}

/** Checks capability and WHERE without calling Omie (also used by EXPLAIN). */
export function checkWriteShape(
  registry: Registry,
  stmt: WriteStatement,
): { resource: ResourceDef; op: WriteOp; kind: WriteKind } {
  const kind = stmt.type;
  const resource = resolveResource(registry, kind === 'insert' ? stmt.table : stmt.table.name);
  if (kind === 'update') {
    const names = stmt.set.map((s) => s.column);
    noDuplicates(names);
    for (const n of names) {
      const col = requireColumn(resource, n);
      if (!col.updatable) {
        if (!resource.writes.update) writeOperation(resource, 'update');
        throw new AppError(
          'COLUMN_NOT_WRITABLE',
          `Column ${n} of ${resource.name} cannot be changed through the Omie API.`,
          {
            column: n,
          },
        );
      }
    }
    const op = writeOperation(resource, 'update', names);
    requireWhere(stmt, resource);
    return { resource, op, kind };
  }
  if (kind === 'delete') {
    const op = writeOperation(resource, 'delete');
    requireWhere(stmt, resource);
    return { resource, op, kind };
  }
  const op = writeOperation(resource, 'insert');
  noDuplicates(stmt.columns);
  for (const n of stmt.columns) {
    const col = requireColumn(resource, n);
    if (!col.insertable) {
      throw new AppError(
        'COLUMN_NOT_WRITABLE',
        `Column ${n} of ${resource.name} cannot be set on INSERT.`,
        { column: n },
      );
    }
  }
  const missing = resource.columns
    .filter((c) => c.required && !stmt.columns.includes(c.name))
    .map((c) => c.name);
  if (missing.length > 0) {
    throw new AppError(
      'REQUIRED_COLUMN_MISSING',
      `INSERT into ${resource.name} requires: ${missing.join(', ')}.`,
      { columns: missing },
    );
  }
  return { resource, op, kind };
}

function requireWhere(stmt: UpdateStatement | DeleteStatement, resource: ResourceDef): void {
  const verb = stmt.type.toUpperCase();
  if (!stmt.where) {
    throw new AppError(
      'WHERE_REQUIRED',
      `${verb} without WHERE is not allowed. Add a WHERE clause that selects the records to change.`,
    );
  }
  let refs = 0;
  walkColumns(stmt.where, () => (refs += 1));
  if (refs === 0) {
    throw new AppError(
      'WHERE_REQUIRED',
      `The WHERE clause of ${verb} must reference at least one column of ${resource.name}.`,
    );
  }
}

function targetSelect(stmt: UpdateStatement | DeleteStatement, limit: number): SelectStatement {
  return {
    type: 'select',
    distinct: false,
    columns: [{ kind: 'star' }],
    from: stmt.table,
    joins: [],
    ...(stmt.where ? { where: stmt.where } : {}),
    groupBy: [],
    orderBy: [],
    limit,
  };
}

export async function prepareWrite(ctx: ExecutionContext, input: PrepareInput): Promise<WritePlan> {
  const { registry, stmt, policy, limits } = input;
  assertWriteEnabled(stmt.type, policy);
  const { resource, op, kind } = checkWriteShape(registry, stmt);
  const messages: string[] = [];

  if (kind === 'insert') {
    const ins = stmt as InsertStatement;
    const param: Record<string, unknown> = { ...(op.extra ?? {}) };
    const after: RecordValues = {};
    ins.columns.forEach((name, i) => {
      const col = requireColumn(resource, name);
      const value = constant(ins.values[i] as Expr, `Value for ${name}`);
      const wire = toWireValue(col, value);
      setPath(param, wirePath(op, col), wire);
      after[name] = displayValue(col, wire);
    });
    const targets: WriteTarget[] = [{ key: {}, before: null, after, param }];
    return {
      kind,
      resource: resource.name,
      endpoint: resource.list.endpoint,
      call: op.call,
      changedColumns: [...ins.columns],
      targets,
      statementHash: statementHash(stmt),
      targetsHash: targetsHashOf(kind, targets),
      messages,
    };
  }

  const st = stmt as UpdateStatement | DeleteStatement;
  // Resolve the affected records with the regular SELECT pipeline (reads only).
  const resolveLimits = { ...limits, maxRows: Math.max(limits.maxRows, limits.maxWriteRows + 1) };
  const bound = bindSelect(registry, targetSelect(st, limits.maxWriteRows + 1), resolveLimits);
  const result = await executeSelect(ctx, bound);
  if (result.rows.length > limits.maxWriteRows) {
    throw new AppError(
      'WRITE_ROW_LIMIT_EXCEEDED',
      `This ${kind.toUpperCase()} would affect more than ${limits.maxWriteRows} records (OMIE_MAX_WRITE_ROWS). Narrow the WHERE clause.`,
      { maxWriteRows: limits.maxWriteRows },
    );
  }
  if (result.rows.length === 0) {
    throw new AppError(
      'WRITE_NO_TARGETS',
      `No record of ${resource.name} matches the WHERE clause; nothing would change.`,
    );
  }

  const sets =
    kind === 'update'
      ? (st as UpdateStatement).set.map((s) => {
          const col = requireColumn(resource, s.column);
          const wire = toWireValue(col, constant(s.value, `SET ${s.column}`));
          return { col, wire };
        })
      : [];

  const targets: WriteTarget[] = result.rows.map((row) => {
    const before = rowToRecord(resource, row);
    const key: RecordValues = {};
    const param: Record<string, unknown> = { ...(op.extra ?? {}) };
    for (const k of op.key) {
      const col = requireColumn(resource, k);
      const v = before[k] ?? null;
      if (v === null)
        throw new AppError(
          'OMIE_BAD_RESPONSE',
          `Record of ${resource.name} has no ${k}; it cannot be targeted.`,
        );
      key[k] = v;
      setPath(param, wirePath(op, col), toWireValue(col, v));
    }
    const after: RecordValues = { ...before };
    for (const { col, wire } of sets) {
      setPath(param, wirePath(op, col), wire);
      after[col.name] = displayValue(col, wire);
    }
    return { key, before, after: kind === 'delete' ? {} : after, param };
  });

  if (kind === 'update') {
    const unchanged = targets.filter((t) =>
      sets.every(({ col }) => t.before?.[col.name] === t.after[col.name]),
    ).length;
    if (unchanged > 0)
      messages.push(
        `${unchanged} record(s) already have the new value(s); Omie will still be called for them.`,
      );
  }

  return {
    kind,
    resource: resource.name,
    endpoint: resource.list.endpoint,
    call: op.call,
    changedColumns: kind === 'update' ? sets.map((s) => s.col.name) : [],
    targets,
    statementHash: statementHash(stmt),
    targetsHash: targetsHashOf(kind, targets),
    resolution: bound.plan,
    messages,
  };
}

/** Executes a confirmed plan sequentially. Never retries; stops at the first failure. */
export async function executeWrite(
  ctx: ExecutionContext,
  registry: Registry,
  plan: WritePlan,
): Promise<WriteExecution> {
  const resource = resolveResource(registry, plan.resource);
  const insertOp = plan.kind === 'insert' ? resource.writes.insert : undefined;
  const results: WriteStepResult[] = [];
  let failedAt = -1;
  for (let i = 0; i < plan.targets.length; i++) {
    const target = plan.targets[i] as WriteTarget;
    if (ctx.signal.aborted) {
      failedAt = i;
      break;
    }
    try {
      const { body } = await ctx.write({
        endpoint: plan.endpoint,
        call: plan.call,
        param: target.param,
      });
      const step: WriteStepResult = { key: target.key, ok: true };
      if (insertOp) {
        const generated: RecordValues = {};
        for (const [column, field] of Object.entries(insertOp.returns)) {
          const col = findColumn(resource, column);
          generated[column] = col ? normalizeValue(readPath(body, field), col.type) : null;
        }
        step.generated = generated;
      }
      results.push(step);
    } catch (err) {
      const e = isAppError(err) ? err : new AppError('INTERNAL_ERROR', 'Unexpected write failure');
      results.push({
        key: target.key,
        ok: false,
        errorCode: e.code,
        errorMessage: e.message,
        ...(e.details?.writeOutcomeUnknown ? { outcomeUnknown: true } : {}),
      });
      failedAt = i + 1;
      break;
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  const notAttempted = failedAt >= 0 ? plan.targets.slice(failedAt).map((t) => t.key) : [];
  return {
    kind: plan.kind,
    resource: plan.resource,
    call: plan.call,
    attempted: results.length,
    succeeded,
    results,
    notAttempted,
    status: succeeded === plan.targets.length ? 'success' : succeeded === 0 ? 'failed' : 'partial',
  };
}
