/**
 * Binds a SELECT to registry resources and chooses an access path per table.
 *
 * Pushdown is always a *superset* filter: every WHERE conjunct is re-evaluated
 * locally after the rows come back, so a filter Omie applies loosely (or not at
 * all) can never produce wrong results — only extra API calls.
 */
import { AppError } from '@dbx/shared';
import type { Expr, SelectStatement, TableRef } from './ast';
import { conjuncts, containsAggregate, exprToSql, walkColumns } from './ast';
import type { EngineLimits } from './context';
import { Scope, suggest } from './eval';
import type { ScopeColumn } from './eval';
import type { Value } from './normalize';
import { toOmieDate } from './normalize';
import { findColumn, lookupColumn } from './registry';
import type { ColumnDef, PushdownDef, Registry, ResourceDef } from './registry';

export interface BoundTable {
  alias: string;
  resource: ResourceDef;
  /** Index of the table's first column in the combined row. */
  offset: number;
  join?: { type: 'INNER' | 'LEFT'; on: Expr };
}

export interface PushedFilter {
  def: PushdownDef;
  values: unknown[];
}

export type AccessPath =
  | { strategy: 'PK_LOOKUP'; column: string; values: unknown[] }
  | { strategy: 'API_FILTER' | 'FULL_SCAN'; singles: PushedFilter[]; partitions: PushedFilter[][] }
  | { strategy: 'METADATA_COUNT' };

export interface JoinMethod {
  /** Column of this (right) table compared with `leftColumn`. */
  rightColumn: string;
  /** Index of the left key in the combined row. */
  leftIndex: number;
  leftLabel: string;
  method: 'JOIN_LOOKUP' | 'JOIN_FILTER' | 'JOIN_SCAN';
}

export interface PlanStep {
  table: string;
  alias: string;
  endpoint: string;
  call: string;
  strategy: string;
  remoteFilters: string[];
  localFilters: string[];
  pagination: string;
  estimatedCalls: string;
  join?: { type: 'INNER' | 'LEFT'; on: string; method: string };
}

export interface QueryPlan {
  steps: PlanStep[];
  estimatedApiCalls: { min: number; max: number | null };
  maxApiCalls: number;
  limit: number;
  implicitLimit: boolean;
  earlyStop: boolean;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  riskReasons: string[];
}

export interface BoundSelect {
  stmt: SelectStatement;
  tables: BoundTable[];
  scope: Scope;
  /** Conjuncts of WHERE that only reference a single table, keyed by alias. */
  localConjuncts: Map<string, Expr[]>;
  access: AccessPath | undefined;
  joins: JoinMethod[];
  grouped: boolean;
  limit: number;
  offset: number;
  implicitLimit: boolean;
  earlyStop: boolean;
  plan: QueryPlan;
}

// ---------------------------------------------------------------- binding

export function resolveResource(registry: Registry, name: string): ResourceDef {
  const resource = registry.get(name.toLowerCase());
  if (resource) return resource;
  const hint = suggest(name.toLowerCase(), registry.resources.keys());
  throw new AppError(
    'RESOURCE_NOT_FOUND',
    `Unknown table "${name}".${hint ? ` Did you mean "${hint}"?` : ''} Use SHOW TABLES to list the available tables.`,
    { table: name, ...(hint ? { suggestion: hint } : {}) },
  );
}

export function tableScopeColumns(alias: string, resource: ResourceDef): ScopeColumn[] {
  return resource.columns.map((c) => ({ table: alias, name: c.name, type: c.type }));
}

function bindTables(registry: Registry, stmt: SelectStatement): BoundTable[] {
  if (!stmt.from) return [];
  const refs: Array<{ ref: TableRef; join?: BoundTable['join'] }> = [
    { ref: stmt.from },
    ...stmt.joins.map((j) => ({ ref: j.table, join: { type: j.type, on: j.on } })),
  ];
  const tables: BoundTable[] = [];
  const aliases = new Set<string>();
  let offset = 0;
  for (const { ref, join } of refs) {
    const resource = resolveResource(registry, ref.name);
    const alias = ref.alias ?? resource.name;
    if (aliases.has(alias)) {
      throw new AppError(
        'SQL_UNSUPPORTED',
        `Table alias "${alias}" is used twice; give each table a distinct alias.`,
      );
    }
    aliases.add(alias);
    tables.push({ alias, resource, offset, ...(join ? { join } : {}) });
    offset += resource.columns.length;
  }
  return tables;
}

/** Aliases referenced by an expression. */
export function tablesOf(expr: Expr, scope: Scope): Set<string> {
  const out = new Set<string>();
  walkColumns(expr, (c) => out.add(scope.columns[scope.resolve(c)]?.table ?? ''));
  return out;
}

// ---------------------------------------------------------------- constraints

interface Constraint {
  column: string;
  kind: 'eq' | 'like';
  values: Value[];
}

function literalOf(e: Expr): Value | undefined {
  if (e.kind === 'literal') return e.value;
  if (e.kind === 'neg' && e.expr.kind === 'literal' && typeof e.expr.value === 'number')
    return -e.expr.value;
  return undefined;
}

/** Extracts `col = lit`, `col IN (lits)` and `col LIKE 'lit'` constraints on one table. */
export function extractConstraints(exprs: Expr[], scope: Scope, alias: string): Constraint[] {
  const out: Constraint[] = [];
  const own = (e: Expr): string | undefined => {
    if (e.kind !== 'column') return undefined;
    const col = scope.columns[scope.resolve(e)];
    return col && col.table === alias ? col.name : undefined;
  };
  for (const e of exprs) {
    if (e.kind === 'compare' && e.op === '=') {
      const lc = own(e.left);
      const rc = own(e.right);
      const lv = literalOf(e.left);
      const rv = literalOf(e.right);
      if (lc && rv !== undefined && rv !== null) out.push({ column: lc, kind: 'eq', values: [rv] });
      else if (rc && lv !== undefined && lv !== null)
        out.push({ column: rc, kind: 'eq', values: [lv] });
    } else if (e.kind === 'in' && !e.negated) {
      const c = own(e.expr);
      const values = e.list.map(literalOf);
      if (c && values.length > 0 && values.every((v) => v !== undefined && v !== null)) {
        out.push({ column: c, kind: 'eq', values: [...new Set(values as Value[])] });
      }
    } else if (
      e.kind === 'like' &&
      !e.negated &&
      e.escape === undefined &&
      e.pattern.kind === 'literal'
    ) {
      const c = own(e.expr);
      const p = e.pattern.value;
      if (c && typeof p === 'string' && !p.includes('_') && p.replace(/%/g, '') !== '') {
        out.push({ column: c, kind: 'like', values: [p] });
      }
    }
  }
  return out;
}

/**
 * Converts a SQL literal into the value sent to Omie, or undefined when the
 * conversion is not exact (the filter then stays local-only).
 */
export function pushValue(column: ColumnDef, v: Value): unknown {
  switch (column.type) {
    case 'integer':
    case 'number': {
      const n =
        typeof v === 'number'
          ? v
          : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())
            ? Number(v)
            : NaN;
      if (!Number.isFinite(n) || (column.type === 'integer' && !Number.isInteger(n)))
        return undefined;
      return n;
    }
    case 'string':
      return typeof v === 'string' ? v : undefined;
    case 'flag':
      return v === 'S' || v === 'N' ? v : undefined;
    case 'date':
      try {
        return toOmieDate(v, column.name);
      } catch {
        return undefined;
      }
  }
}

function convertAll(resource: ResourceDef, column: string, values: Value[]): unknown[] | undefined {
  const def = findColumn(resource, column);
  if (!def) return undefined;
  const out = values.map((v) => pushValue(def, v));
  return out.every((v) => v !== undefined) ? out : undefined;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Partitions for a multi-valued filter, or undefined when it is too wide to split. */
export function partitionsFor(
  def: PushdownDef,
  values: unknown[],
  limits: EngineLimits,
): PushedFilter[][] | undefined {
  if (def.multi) return chunk(values, limits.inChunkSize).map((part) => [{ def, values: part }]);
  if (values.length <= limits.partitionMaxValues) return values.map((v) => [{ def, values: [v] }]);
  return undefined;
}

export interface AccessOptions {
  allowLookup?: boolean;
  /** Extra partitioned filter imposed by a join (keys from the left side). */
  forced?: PushedFilter[][];
  forcedColumn?: string;
}

export function chooseAccess(
  resource: ResourceDef,
  constraints: Constraint[],
  limits: EngineLimits,
  opts: AccessOptions = {},
): AccessPath {
  const lc = lookupColumn(resource);
  if (opts.allowLookup !== false && !opts.forced && resource.lookup && lc) {
    const c = constraints.find((x) => x.column === lc && x.kind === 'eq');
    const values = c ? convertAll(resource, lc, c.values) : undefined;
    if (values && values.length <= limits.lookupMaxKeys) {
      const multi = resource.pushdown.some((d) => d.column === lc && d.multi);
      if (!multi || values.length === 1) return { strategy: 'PK_LOOKUP', column: lc, values };
    }
  }

  const singles: PushedFilter[] = [];
  const candidates: PushedFilter[][][] = [];
  const usedParams = new Set<string>();
  const usedColumns = new Set<string>(opts.forcedColumn ? [opts.forcedColumn] : []);
  if (opts.forced) {
    for (const d of opts.forced[0] ?? []) usedParams.add(d.def.param);
  }
  for (const def of resource.pushdown) {
    if (usedParams.has(def.param) || usedColumns.has(def.column)) continue;
    const c = constraints.find((x) => x.column === def.column && x.kind === def.kind);
    if (!c) continue;
    const values = convertAll(resource, def.column, c.values);
    if (!values) continue;
    if (values.length === 1) singles.push({ def, values });
    else {
      const parts = partitionsFor(def, values, limits);
      if (!parts) continue;
      candidates.push(parts);
    }
    usedParams.add(def.param);
    usedColumns.add(def.column);
  }

  let partitions: PushedFilter[][] = [[]];
  if (opts.forced) partitions = opts.forced;
  else if (candidates.length > 0) {
    candidates.sort((a, b) => a.length - b.length);
    partitions = candidates[0] as PushedFilter[][];
  }

  if (resource.requiredFilter) {
    const rf = resource.requiredFilter;
    const covered =
      opts.forcedColumn === rf ||
      singles.some((s) => s.def.column === rf) ||
      (partitions[0] ?? []).some((p) => p.def.column === rf);
    if (!covered) {
      throw new AppError(
        'SQL_UNSUPPORTED',
        `Table ${resource.name} can only be read with a filter on ${rf} (WHERE ${rf} = ... or ${rf} IN (...)). The Omie API cannot list it otherwise.`,
        { requiredFilter: rf },
      );
    }
  }

  const filtered = singles.length > 0 || (partitions[0]?.length ?? 0) > 0;
  return { strategy: filtered ? 'API_FILTER' : 'FULL_SCAN', singles, partitions };
}

// ---------------------------------------------------------------- joins

function relationMatches(a: ColumnDef, aTable: string, b: ColumnDef, bTable: string): boolean {
  const ref = (c: ColumnDef) =>
    c.references ? `${c.references.table}.${c.references.column}` : undefined;
  const self = (c: ColumnDef, t: string) => `${t}.${c.name}`;
  const ra = ref(a);
  const rb = ref(b);
  return ra === self(b, bTable) || rb === self(a, aTable) || (ra !== undefined && ra === rb);
}

function describeRelations(resource: ResourceDef, others: ResourceDef[]): string[] {
  const out: string[] = [];
  for (const c of resource.columns) {
    if (c.references && others.some((o) => o.name === c.references?.table)) {
      out.push(`${resource.name}.${c.name} = ${c.references.table}.${c.references.column}`);
    }
  }
  for (const o of others) {
    for (const c of o.columns) {
      if (c.references?.table === resource.name)
        out.push(`${o.name}.${c.name} = ${resource.name}.${c.references.column}`);
    }
  }
  return out;
}

function chooseJoinKey(
  tables: BoundTable[],
  index: number,
  scope: Scope,
): { rightColumn: string; leftIndex: number; leftLabel: string } {
  const table = tables[index] as BoundTable;
  const on = table.join?.on;
  for (const e of conjuncts(on)) {
    if (
      e.kind !== 'compare' ||
      e.op !== '=' ||
      e.left.kind !== 'column' ||
      e.right.kind !== 'column'
    )
      continue;
    const li = scope.resolve(e.left);
    const ri = scope.resolve(e.right);
    const l = scope.columns[li] as ScopeColumn;
    const r = scope.columns[ri] as ScopeColumn;
    const pair =
      r.table === table.alias && l.table !== table.alias
        ? { right: r, rightIdx: ri, left: l, leftIdx: li }
        : l.table === table.alias && r.table !== table.alias
          ? { right: l, rightIdx: li, left: r, leftIdx: ri }
          : undefined;
    if (!pair) continue;
    const leftTable = tables.find((t) => t.alias === pair.left.table);
    if (!leftTable || tables.indexOf(leftTable) > index) continue;
    const rc = findColumn(table.resource, pair.right.name) as ColumnDef;
    const lc = findColumn(leftTable.resource, pair.left.name) as ColumnDef;
    if (relationMatches(rc, table.resource.name, lc, leftTable.resource.name)) {
      return {
        rightColumn: rc.name,
        leftIndex: pair.leftIdx,
        leftLabel: `${leftTable.alias}.${lc.name}`,
      };
    }
  }
  const relations = describeRelations(
    table.resource,
    tables.slice(0, index).map((t) => t.resource),
  );
  throw new AppError(
    'SQL_UNSUPPORTED',
    `JOIN ${table.alias} must use an equality on a relationship declared in the registry.${
      relations.length > 0
        ? ` Available: ${relations.join('; ')}.`
        : ' No relationship exists between these tables.'
    }`,
  );
}

function joinMethod(resource: ResourceDef, column: string): JoinMethod['method'] {
  if (resource.pushdown.some((d) => d.column === column && d.kind === 'eq' && d.multi))
    return 'JOIN_FILTER';
  if (resource.lookup && lookupColumn(resource) === column) return 'JOIN_LOOKUP';
  if (resource.pushdown.some((d) => d.column === column && d.kind === 'eq')) return 'JOIN_FILTER';
  return 'JOIN_SCAN';
}

// ---------------------------------------------------------------- bind + plan

export function isGrouped(stmt: SelectStatement): boolean {
  if (stmt.groupBy.length > 0 || stmt.having) return true;
  const exprs = [
    ...stmt.columns.flatMap((c) => (c.kind === 'expr' ? [c.expr] : [])),
    ...stmt.orderBy.flatMap((o) => (o.expr.kind === 'position' ? [] : [o.expr as Expr])),
  ];
  return exprs.some(containsAggregate);
}

function isMetadataCount(stmt: SelectStatement, tables: BoundTable[]): boolean {
  if (tables.length !== 1 || stmt.where || stmt.groupBy.length > 0 || stmt.having || stmt.distinct)
    return false;
  if ((stmt.offset ?? 0) > 0) return false;
  const res = (tables[0] as BoundTable).resource;
  if (res.list.explode || res.list.parentPath || res.requiredFilter) return false;
  if (stmt.columns.length !== 1) return false;
  const item = stmt.columns[0];
  return (
    item?.kind === 'expr' &&
    item.expr.kind === 'aggregate' &&
    item.expr.fn === 'COUNT' &&
    item.expr.arg === '*'
  );
}

function describeFilter(f: PushedFilter): string {
  const vals = f.values.map((v) => JSON.stringify(v));
  return `${f.def.column} → ${f.def.param} = ${vals.length > 5 ? `[${vals.slice(0, 5).join(', ')}, … ${vals.length} values]` : vals.join(', ')}`;
}

function pagination(resource: ResourceDef): string {
  const params =
    resource.list.paging === 'std' ? 'pagina / registros_por_pagina' : 'nPagina / nRegPorPagina';
  return `${params}, ${resource.list.pageSize} records per page`;
}

export function bindSelect(
  registry: Registry,
  stmt: SelectStatement,
  limits: EngineLimits,
): BoundSelect {
  const tables = bindTables(registry, stmt);
  const scope = new Scope(tables.flatMap((t) => tableScopeColumns(t.alias, t.resource)));

  if (stmt.limit !== undefined && stmt.limit > limits.maxRows) {
    throw new AppError(
      'QUERY_ROW_LIMIT_EXCEEDED',
      `LIMIT ${stmt.limit} exceeds the maximum of ${limits.maxRows} rows per query (OMIE_MAX_ROWS).`,
      { maxRows: limits.maxRows },
    );
  }
  const implicitLimit = stmt.limit === undefined;
  const limit = stmt.limit ?? limits.maxRows;
  const offset = stmt.offset ?? 0;
  const grouped = isGrouped(stmt);

  // Validate WHERE references early (unknown/ambiguous columns, aggregates).
  const whereParts = conjuncts(stmt.where);
  for (const e of whereParts) {
    if (containsAggregate(e))
      throw new AppError(
        'SQL_UNSUPPORTED',
        'Aggregate functions are not allowed in WHERE; use HAVING.',
      );
  }
  const localConjuncts = new Map<string, Expr[]>();
  for (const e of whereParts) {
    const refs = tablesOf(e, scope);
    if (refs.size === 1) {
      const alias = [...refs][0] as string;
      localConjuncts.set(alias, [...(localConjuncts.get(alias) ?? []), e]);
    }
  }

  const earlyStop = tables.length <= 1 && !grouped && stmt.orderBy.length === 0 && !stmt.distinct;
  const steps: PlanStep[] = [];
  const riskReasons: string[] = [];
  let minCalls = 0;
  let maxCalls: number | null = 0;
  let access: AccessPath | undefined;
  const joins: JoinMethod[] = [];

  tables.forEach((table, i) => {
    const res = table.resource;
    const ownConjuncts = localConjuncts.get(table.alias) ?? [];
    const step: PlanStep = {
      table: res.name,
      alias: table.alias,
      endpoint: res.list.endpoint,
      call: res.list.call,
      strategy: '',
      remoteFilters: [],
      localFilters: [],
      pagination: pagination(res),
      estimatedCalls: '',
    };

    if (i === 0) {
      if (isMetadataCount(stmt, tables)) {
        access = { strategy: 'METADATA_COUNT' };
        step.strategy = 'METADATA_COUNT';
        step.pagination = 'single page; total read from the response metadata';
        step.estimatedCalls = '1';
        minCalls += 1;
        if (maxCalls !== null) maxCalls += 1;
      } else {
        const chosen = chooseAccess(
          res,
          extractConstraints(ownConjuncts, scope, table.alias),
          limits,
        );
        access = chosen;
        describeAccess(
          step,
          chosen,
          res,
          limits,
          earlyStop ? offset + limit + 1 : undefined,
          ownConjuncts,
        );
        if (chosen.strategy === 'PK_LOOKUP') {
          minCalls += chosen.values.length;
          if (maxCalls !== null) maxCalls += chosen.values.length;
        } else if (chosen.strategy !== 'METADATA_COUNT') {
          const parts = chosen.partitions.length;
          minCalls += parts;
          const exact = earlyStop && step.localFilters.length === 0;
          if (exact && maxCalls !== null) {
            maxCalls += parts * Math.max(1, Math.ceil((offset + limit + 1) / res.list.pageSize));
          } else maxCalls = null;
          if (chosen.strategy === 'FULL_SCAN' && !earlyStop)
            riskReasons.push(`Full scan of ${res.name} without early stop.`);
          if (chosen.strategy === 'FULL_SCAN' && earlyStop && ownConjuncts.length > 0) {
            riskReasons.push(
              `WHERE on ${res.name} is evaluated locally; the scan may read many pages.`,
            );
          }
        }
      }
    } else {
      const key = chooseJoinKey(tables, i, scope);
      const method = joinMethod(res, key.rightColumn);
      joins.push({ ...key, method });
      step.strategy = method;
      step.join = {
        type: table.join?.type ?? 'INNER',
        on: exprToSql(table.join?.on as Expr),
        method,
      };
      step.remoteFilters.push(`${key.rightColumn} IN (distinct values of ${key.leftLabel})`);
      step.localFilters = [
        ...conjuncts(table.join?.on).map(exprToSql),
        ...(table.join?.type === 'INNER' ? ownConjuncts.map(exprToSql) : []),
      ];
      step.estimatedCalls =
        method === 'JOIN_SCAN'
          ? 'full scan of the table (within OMIE_MAX_API_CALLS)'
          : method === 'JOIN_LOOKUP'
            ? `1 per distinct key (≤ ${limits.lookupMaxKeys}), else a full scan`
            : `1+ per block of ${limits.inChunkSize} keys`;
      maxCalls = null;
      minCalls += 0;
      riskReasons.push(
        method === 'JOIN_SCAN'
          ? `JOIN ${table.alias} needs a full scan of ${res.name}; it fails with JOIN_CARDINALITY_LIMIT if it exceeds the call budget.`
          : `JOIN ${table.alias} cost depends on the number of distinct keys.`,
      );
    }
    steps.push(step);
  });

  if (
    grouped &&
    earlyStop === false &&
    tables.length === 1 &&
    access?.strategy !== 'METADATA_COUNT' &&
    access?.strategy !== 'PK_LOOKUP'
  ) {
    riskReasons.push('Aggregation reads every matching record before returning.');
  }

  const fullScans = steps.filter(
    (s) => s.strategy === 'FULL_SCAN' || s.strategy === 'JOIN_SCAN',
  ).length;
  const risk: QueryPlan['risk'] =
    fullScans > 0 && (!earlyStop || tables.length > 1)
      ? 'HIGH'
      : riskReasons.length > 0
        ? 'MEDIUM'
        : 'LOW';

  return {
    stmt,
    tables,
    scope,
    localConjuncts,
    access,
    joins,
    grouped,
    limit,
    offset,
    implicitLimit,
    earlyStop,
    plan: {
      steps,
      estimatedApiCalls: {
        min: Math.min(minCalls, limits.maxApiCalls),
        max: maxCalls === null ? null : Math.min(maxCalls, limits.maxApiCalls),
      },
      maxApiCalls: limits.maxApiCalls,
      limit,
      implicitLimit,
      earlyStop,
      risk,
      riskReasons,
    },
  };
}

function describeAccess(
  step: PlanStep,
  access: AccessPath,
  res: ResourceDef,
  limits: EngineLimits,
  need: number | undefined,
  ownConjuncts: Expr[],
): void {
  step.strategy = access.strategy;
  step.localFilters = ownConjuncts.map(exprToSql);
  if (access.strategy === 'PK_LOOKUP') {
    step.call = res.lookup?.call ?? step.call;
    step.remoteFilters = [
      `${access.column} = ${access.values.map((v) => JSON.stringify(v)).join(', ')}`,
    ];
    step.pagination = 'none (one Consultar call per key)';
    step.estimatedCalls = String(access.values.length);
    return;
  }
  if (access.strategy === 'METADATA_COUNT') return;
  step.remoteFilters = [
    ...access.singles.map(describeFilter),
    ...(access.partitions.length > 1 || (access.partitions[0]?.length ?? 0) > 0
      ? [
          `${access.partitions.length} partition(s): ${(access.partitions[0] ?? []).map((p) => p.def.param).join(', ')}`,
        ]
      : []),
  ];
  const parts = access.partitions.length;
  const pages = need !== undefined ? Math.max(1, Math.ceil(need / res.list.pageSize)) : undefined;
  step.estimatedCalls =
    pages !== undefined && ownConjuncts.length === 0
      ? `${parts * pages} (early stop after ${need} rows)`
      : `${parts}+ (one per page until the data ends; capped at ${limits.maxApiCalls})`;
}
