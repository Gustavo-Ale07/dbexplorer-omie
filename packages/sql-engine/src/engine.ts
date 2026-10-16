import { AppError } from '@dbx/shared';
import type { OmieCallTrace, OmieClient } from '@dbx/omie-client';
import type { ExplainableStatement, Statement, WriteStatement } from './ast';
import { exprToSql, isWriteStatement } from './ast';
import { DEFAULT_LIMITS, ExecutionContext } from './context';
import type { EngineLimits } from './context';
import type { ResultColumn } from './executor';
import { executeSelect } from './executor';
import type { Row } from './normalize';
import { parseSql, statementKind } from './parser';
import { bindSelect, resolveResource } from './planner';
import type { QueryPlan } from './planner';
import { createRegistry, lookupColumn } from './registry';
import type { Registry, ResourceDef, SchemaGroup } from './registry';
import { checkWriteShape, executeWrite, prepareWrite } from './writes';
import type { WriteExecution, WritePlan, WritePolicy } from './writes';

export type StatementKindName = ReturnType<typeof statementKind>;

export interface ExecuteOptions {
  signal?: AbortSignal;
  /** Called for every Omie call (successful or not), also when the statement fails. */
  onTrace?: (trace: OmieCallTrace) => void;
}

export interface QueryResult {
  kind: StatementKindName;
  resource?: string;
  columns: ResultColumn[];
  rows: Row[];
  rowCount: number;
  truncated: boolean;
  apiCalls: number;
  traces: OmieCallTrace[];
  durationMs: number;
  plan?: QueryPlan | WriteExplain;
  messages: string[];
}

export interface WriteExplain {
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  resource: string;
  call: string;
  endpoint: string;
  where?: string;
  maxWriteRows: number;
  confirmation: 'required';
  resolution?: QueryPlan;
  risk: 'MEDIUM' | 'HIGH';
}

export interface WritePreparation {
  plan: WritePlan;
  apiCalls: number;
  traces: OmieCallTrace[];
  durationMs: number;
}

export interface WriteRun {
  execution: WriteExecution;
  apiCalls: number;
  traces: OmieCallTrace[];
  durationMs: number;
}

export interface SchemaColumn {
  name: string;
  type: string;
  description: string;
  pk: boolean;
  insertable: boolean;
  updatable: boolean;
  required: boolean;
  references?: { table: string; column: string };
}

export interface SchemaTable {
  name: string;
  group: SchemaGroup;
  description: string;
  operations: { select: true; insert: boolean; update: boolean; delete: boolean };
  requiredFilter?: string;
  lookupColumn?: string;
  notes: string[];
  columns: SchemaColumn[];
}

export interface InspectorCall {
  id: string;
  resource: string;
  endpoint: string;
  call: string;
  kind: 'list' | 'lookup';
  exampleParam: Record<string, unknown>;
}

export interface InspectorResult {
  request: unknown;
  response: Record<string, unknown>;
  noRecords: boolean;
  durationMs: number;
  trace?: OmieCallTrace;
}

export interface SqlEngineOptions {
  client: OmieClient;
  limits?: Partial<EngineLimits>;
  registry?: Registry;
}

const MAX_INSPECTOR_PARAM_BYTES = 8_000;
const MAX_INSPECTOR_DEPTH = 6;

function yesNo(v: boolean): string {
  return v ? 'supported' : 'unsupported';
}

export class SqlEngine {
  readonly registry: Registry;
  readonly limits: EngineLimits;

  constructor(private readonly options: SqlEngineOptions) {
    this.registry = options.registry ?? createRegistry();
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  get client(): OmieClient {
    return this.options.client;
  }

  parse(sql: string): Statement {
    return parseSql(sql);
  }

  kindOf(stmt: Statement): StatementKindName {
    return statementKind(stmt);
  }

  /** Resource name a statement targets (for history / audit). */
  resourceOf(stmt: Statement): string | undefined {
    const s = stmt.type === 'explain' ? stmt.statement : stmt;
    switch (s.type) {
      case 'select':
        return s.from?.name.toLowerCase();
      case 'insert':
        return s.table.toLowerCase();
      case 'update':
      case 'delete':
        return s.table.name.toLowerCase();
      case 'describe':
        return s.table.toLowerCase();
      default:
        return undefined;
    }
  }

  private context(opts: ExecuteOptions, extra?: Partial<EngineLimits>): { ctx: ExecutionContext } {
    const limits = { ...this.limits, ...extra };
    const timeout = AbortSignal.timeout(limits.queryTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const ctx = new ExecutionContext(this.options.client, limits, signal, opts.onTrace);
    return { ctx };
  }

  /** Runs a read statement (SELECT / SHOW / DESCRIBE / EXPLAIN). Writes go through prepareWrite. */
  async query(stmt: Statement, opts: ExecuteOptions = {}): Promise<QueryResult> {
    const started = performance.now();
    const kind = statementKind(stmt);
    const resource = this.resourceOf(stmt);
    const base = { kind, ...(resource ? { resource } : {}) };
    if (isWriteStatement(stmt)) {
      throw new AppError(
        'CONFIRMATION_REQUIRED',
        'Write statements must be previewed and confirmed before they run.',
      );
    }
    if (stmt.type === 'showTables')
      return { ...base, ...this.showTables(), ...this.empty(started) };
    if (stmt.type === 'describe')
      return { ...base, ...this.describe(stmt.table), ...this.empty(started) };
    if (stmt.type === 'explain')
      return { ...base, ...this.explain(stmt.statement), ...this.empty(started) };

    const { ctx } = this.context(opts);
    const bound = bindSelect(this.registry, stmt, this.limits);
    const result = await executeSelect(ctx, bound);
    return {
      ...base,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rows.length,
      truncated: result.truncated,
      apiCalls: ctx.apiCalls,
      traces: ctx.traces,
      durationMs: Math.round(performance.now() - started),
      plan: bound.plan,
      messages: result.messages,
    };
  }

  private empty(started: number) {
    return {
      truncated: false,
      apiCalls: 0,
      traces: [] as OmieCallTrace[],
      durationMs: Math.round(performance.now() - started),
    };
  }

  private table(columns: string[], rows: Row[], messages: string[] = []) {
    return {
      columns: columns.map((name) => ({ name, type: 'string' as const })),
      rows,
      rowCount: rows.length,
      messages,
    };
  }

  showTables() {
    const rows: Row[] = [...this.registry.resources.values()].map((r) => [
      r.name,
      r.group,
      r.description,
      yesNo(!!r.writes.insert),
      yesNo(!!r.writes.update),
      yesNo(!!r.writes.delete),
    ]);
    return this.table(['table_name', 'group', 'description', 'insert', 'update', 'delete'], rows);
  }

  describe(name: string) {
    const r = resolveResource(this.registry, name);
    const rows: Row[] = r.columns.map((c) => [
      c.name,
      c.type,
      c.pk ? 'PK' : '',
      c.insertable ? 'yes' : 'no',
      c.updatable ? 'yes' : 'no',
      c.required ? 'yes' : 'no',
      c.references ? `${c.references.table}.${c.references.column}` : '',
      c.description,
    ]);
    const messages = [
      `SELECT: supported · INSERT: ${yesNo(!!r.writes.insert)} · UPDATE: ${yesNo(!!r.writes.update)} · DELETE: ${yesNo(!!r.writes.delete)}`,
      ...(r.requiredFilter ? [`Requires WHERE ${r.requiredFilter} = ... or IN (...).`] : []),
      ...(r.notes ?? []),
    ];
    return this.table(
      [
        'column_name',
        'type',
        'key',
        'insertable',
        'updatable',
        'required',
        'references',
        'description',
      ],
      rows,
      messages,
    );
  }

  explain(stmt: ExplainableStatement): {
    columns: ResultColumn[];
    rows: Row[];
    rowCount: number;
    messages: string[];
    plan: QueryPlan | WriteExplain;
  } {
    if (isWriteStatement(stmt)) {
      const plan = this.explainWrite(stmt);
      const rows: Row[] = [
        ['Operation', plan.operation],
        ['Resource', plan.resource],
        ['Omie call', `${plan.endpoint} · ${plan.call}`],
        ['WHERE', plan.where ?? '—'],
        ['Max affected rows', String(plan.maxWriteRows)],
        ['Confirmation', 'required (preview → confirm)'],
        ['Risk', plan.risk],
      ];
      if (plan.resolution) {
        for (const step of plan.resolution.steps) {
          rows.push([
            'Target resolution',
            `${step.strategy} on ${step.table} (${step.estimatedCalls} call(s))`,
          ]);
        }
      }
      return {
        columns: [
          { name: 'property', type: 'string' },
          { name: 'value', type: 'string' },
        ],
        rows,
        rowCount: rows.length,
        messages: [
          'EXPLAIN does not call Omie. Writes are executed one call per record, without rollback.',
        ],
        plan,
      };
    }
    const bound = bindSelect(this.registry, stmt, this.limits);
    const plan = bound.plan;
    const rows: Row[] = [];
    plan.steps.forEach((s, i) => {
      const p = plan.steps.length > 1 ? `${i + 1}. ` : '';
      rows.push([
        `${p}Resource`,
        `${s.table}${s.alias !== s.table ? ` AS ${s.alias}` : ''} (${s.endpoint} · ${s.call})`,
      ]);
      rows.push([`${p}Strategy`, s.strategy]);
      if (s.join) rows.push([`${p}Join`, `${s.join.type} JOIN ON ${s.join.on}`]);
      rows.push([`${p}Remote filters`, s.remoteFilters.join('; ') || '—']);
      rows.push([`${p}Local filters`, s.localFilters.join('; ') || '—']);
      rows.push([`${p}Pagination`, s.pagination]);
      rows.push([`${p}Estimated API calls`, s.estimatedCalls]);
    });
    const { min, max } = plan.estimatedApiCalls;
    rows.push([
      'Total estimated API calls',
      max === null
        ? `${min}+ (capped at ${plan.maxApiCalls})`
        : min === max
          ? String(min)
          : `${min}–${max}`,
    ]);
    rows.push([
      'Row limit',
      `${plan.limit}${plan.implicitLimit ? ' (implicit OMIE_MAX_ROWS)' : ''}`,
    ]);
    rows.push([
      'Risk',
      `${plan.risk}${plan.riskReasons.length > 0 ? ` — ${plan.riskReasons.join(' ')}` : ''}`,
    ]);
    return {
      columns: [
        { name: 'property', type: 'string' },
        { name: 'value', type: 'string' },
      ],
      rows,
      rowCount: rows.length,
      messages: ['EXPLAIN does not call Omie. Remote filters are re-checked locally.'],
      plan,
    };
  }

  private explainWrite(stmt: WriteStatement): WriteExplain {
    const { resource, op, kind } = checkWriteShape(this.registry, stmt);
    const operation = kind.toUpperCase() as WriteExplain['operation'];
    const base: WriteExplain = {
      operation,
      resource: resource.name,
      call: op.call,
      endpoint: resource.list.endpoint,
      maxWriteRows: kind === 'insert' ? 1 : this.limits.maxWriteRows,
      confirmation: 'required',
      risk: kind === 'insert' ? 'MEDIUM' : 'HIGH',
    };
    if (stmt.type === 'insert') return base;
    const resolution = bindSelect(
      this.registry,
      {
        type: 'select',
        distinct: false,
        columns: [{ kind: 'star' }],
        from: stmt.table,
        joins: [],
        ...(stmt.where ? { where: stmt.where } : {}),
        groupBy: [],
        orderBy: [],
        limit: this.limits.maxWriteRows + 1,
      },
      { ...this.limits, maxRows: Math.max(this.limits.maxRows, this.limits.maxWriteRows + 1) },
    ).plan;
    return { ...base, ...(stmt.where ? { where: exprToSql(stmt.where) } : {}), resolution };
  }

  /** Resolves targets and builds the before/after preview. Performs reads only. */
  async prepareWrite(
    stmt: WriteStatement,
    policy: WritePolicy,
    opts: ExecuteOptions = {},
  ): Promise<WritePreparation> {
    const started = performance.now();
    const { ctx } = this.context(opts);
    const plan = await prepareWrite(ctx, {
      registry: this.registry,
      stmt,
      policy,
      limits: this.limits,
    });
    return {
      plan,
      apiCalls: ctx.apiCalls,
      traces: ctx.traces,
      durationMs: Math.round(performance.now() - started),
    };
  }

  /** Executes a confirmed plan. The caller must have re-validated it (fresh prepareWrite + hash comparison). */
  async executeWrite(plan: WritePlan, opts: ExecuteOptions = {}): Promise<WriteRun> {
    const started = performance.now();
    const { ctx } = this.context(opts, { maxApiCalls: plan.targets.length });
    const execution = await executeWrite(ctx, this.registry, plan);
    return {
      execution,
      apiCalls: ctx.apiCalls,
      traces: ctx.traces,
      durationMs: Math.round(performance.now() - started),
    };
  }

  /** Redacted wire envelope of a write call, for the API Request tab. */
  describeWriteRequest(plan: WritePlan, index = 0): unknown {
    const target = plan.targets[index];
    if (!target) return undefined;
    return this.options.client.describe({
      endpoint: plan.endpoint,
      call: plan.call,
      param: target.param,
      kind: 'write',
    });
  }

  schema(): SchemaTable[] {
    return [...this.registry.resources.values()].map((r) => schemaTable(r));
  }

  // ---------------------------------------------------------------- API inspector

  /** Read-only calls allowed in the inspector (derived from the registry: no free-form URLs). */
  inspectorCalls(): InspectorCall[] {
    const out: InspectorCall[] = [];
    const seen = new Set<string>();
    for (const r of this.registry.resources.values()) {
      const { list } = r;
      const listParam: Record<string, unknown> = { ...(list.baseParam?.() ?? {}) };
      if (list.paging === 'std') Object.assign(listParam, { pagina: 1, registros_por_pagina: 5 });
      else Object.assign(listParam, { nPagina: 1, nRegPorPagina: 5 });
      if (r.requiredFilter)
        listParam[
          r.pushdown.find((p) => p.column === r.requiredFilter)?.param ?? r.requiredFilter
        ] = 0;
      const add = (
        call: string,
        kind: InspectorCall['kind'],
        exampleParam: Record<string, unknown>,
      ) => {
        const id = `${list.endpoint}:${call}`;
        if (seen.has(id)) return;
        seen.add(id);
        out.push({ id, resource: r.name, endpoint: list.endpoint, call, kind, exampleParam });
      };
      add(list.call, 'list', listParam);
      if (r.lookup) add(r.lookup.call, 'lookup', r.lookup.param(0));
    }
    return out;
  }

  describeInspectorRequest(id: string, param: unknown): unknown {
    const entry = this.inspectorEntry(id);
    return this.options.client.describe({
      endpoint: entry.endpoint,
      call: entry.call,
      param: this.inspectorParam(param),
      kind: 'read',
    });
  }

  async inspect(id: string, param: unknown, opts: ExecuteOptions = {}): Promise<InspectorResult> {
    const entry = this.inspectorEntry(id);
    const clean = this.inspectorParam(param);
    const started = performance.now();
    const { ctx } = this.context(opts, { maxApiCalls: 1 });
    const { body, noRecords } = await ctx.read({
      endpoint: entry.endpoint,
      call: entry.call,
      param: clean,
    });
    const trace = ctx.traces[0];
    return {
      request: this.options.client.describe({
        endpoint: entry.endpoint,
        call: entry.call,
        param: clean,
        kind: 'read',
      }),
      response: body,
      noRecords,
      durationMs: Math.round(performance.now() - started),
      ...(trace ? { trace } : {}),
    };
  }

  /** Sanitized param with page sizes clamped to OMIE_MAX_ROWS, like any other query. */
  private inspectorParam(param: unknown): Record<string, unknown> {
    const clean = sanitizeParam(param);
    for (const key of PAGE_SIZE_KEYS) {
      if (!(key in clean)) continue;
      const n = Number(clean[key]);
      if (!Number.isFinite(n) || n > this.limits.maxRows) clean[key] = this.limits.maxRows;
    }
    return clean;
  }

  private inspectorEntry(id: string): InspectorCall {
    const entry = this.inspectorCalls().find((c) => c.id === id);
    if (!entry)
      throw new AppError('FORBIDDEN', 'This Omie call is not in the inspector allowlist.');
    return entry;
  }
}

function schemaTable(r: ResourceDef): SchemaTable {
  const lc = lookupColumn(r);
  return {
    name: r.name,
    group: r.group,
    description: r.description,
    operations: {
      select: true,
      insert: !!r.writes.insert,
      update: !!r.writes.update,
      delete: !!r.writes.delete,
    },
    ...(r.requiredFilter ? { requiredFilter: r.requiredFilter } : {}),
    ...(lc ? { lookupColumn: lc } : {}),
    notes: r.notes ?? [],
    columns: r.columns.map((c) => ({
      name: c.name,
      type: c.type,
      description: c.description,
      pk: !!c.pk,
      insertable: !!c.insertable,
      updatable: !!c.updatable,
      required: !!c.required,
      ...(c.references ? { references: c.references } : {}),
    })),
  };
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Inspector params: plain JSON objects only, bounded in size and depth, no prototype keys. */
/** Request keys that set the page size of Omie list calls. */
const PAGE_SIZE_KEYS = ['registros_por_pagina', 'nRegPorPagina'] as const;

export function sanitizeParam(param: unknown): Record<string, unknown> {
  if (param === null || typeof param !== 'object' || Array.isArray(param)) {
    throw new AppError('VALIDATION_ERROR', 'param must be a JSON object.');
  }
  const text = JSON.stringify(param);
  if (text.length > MAX_INSPECTOR_PARAM_BYTES)
    throw new AppError('VALIDATION_ERROR', 'param is too large.');
  const visit = (v: unknown, depth: number): unknown => {
    if (depth > MAX_INSPECTOR_DEPTH)
      throw new AppError('VALIDATION_ERROR', 'param is nested too deeply.');
    if (Array.isArray(v)) return v.map((x) => visit(x, depth + 1));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.has(k))
          throw new AppError('VALIDATION_ERROR', `param key "${k}" is not allowed.`);
        out[k] = visit(x, depth + 1);
      }
      return out;
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)
      return v;
    throw new AppError('VALIDATION_ERROR', 'param contains an unsupported value.');
  };
  return visit(JSON.parse(text), 0) as Record<string, unknown>;
}
