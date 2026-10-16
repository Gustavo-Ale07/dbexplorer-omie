/**
 * Executes a bound SELECT: fetch → join → where → group/aggregate → having →
 * projection → order → distinct → offset/limit.
 */
import { AppError, isAppError } from '@dbx/shared';
import { mapWithConcurrency } from '@dbx/omie-client';
import type { AggregateFn, Expr, SelectItem } from './ast';
import { conjuncts, exprToSql } from './ast';
import type { ExecutionContext } from './context';
import type { Accumulator, ScopeColumn } from './eval';
import {
  Scope,
  compile,
  compilePredicate,
  createAccumulator,
  exprKey,
  inferType,
  orderValues,
  toNumber,
} from './eval';
import type { Row, Value } from './normalize';
import { toRow } from './normalize';
import type { AccessPath, BoundSelect, BoundTable, PushedFilter } from './planner';
import {
  chooseAccess,
  extractConstraints,
  partitionsFor,
  pushValue,
  tableScopeColumns,
  tablesOf,
} from './planner';
import { findColumn, pkColumns, readPath } from './registry';
import type { RawRecord, ResourceDef } from './registry';

export interface ResultColumn {
  name: string;
  type: ScopeColumn['type'];
}

export interface SelectResult {
  columns: ResultColumn[];
  rows: Row[];
  truncated: boolean;
  messages: string[];
}

// ---------------------------------------------------------------- fetching

const NOT_FOUND = /n[ãa]o (cadastrad|encontrad|existe)/i;

export function isNotFoundFault(err: unknown): boolean {
  return isAppError(err) && err.code === 'OMIE_API_ERROR' && NOT_FOUND.test(err.message);
}

/** Turns a list/lookup response into raw records (exploding nested arrays, attaching `$parent`). */
export function extractRecords(
  resource: ResourceDef,
  body: Record<string, unknown>,
  arrayPath: string | undefined,
): RawRecord[] {
  let items: unknown;
  if (arrayPath === undefined) items = [body];
  else {
    items = readPath(body, arrayPath);
    if (items === undefined || items === null) return [];
    if (!Array.isArray(items)) {
      throw new AppError(
        'OMIE_BAD_RESPONSE',
        `Unexpected Omie response: "${arrayPath}" is not a list.`,
        {
          call: resource.list.call,
        },
      );
    }
  }
  const parent =
    resource.list.parentPath && arrayPath !== undefined
      ? readPath(body, resource.list.parentPath)
      : undefined;
  const out: RawRecord[] = [];
  for (const item of items as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as RawRecord;
    if (resource.list.explode) {
      const children = Object.hasOwn(record, resource.list.explode)
        ? record[resource.list.explode]
        : undefined;
      if (!Array.isArray(children)) continue;
      for (const child of children) {
        if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
          out.push({ ...(child as RawRecord), $parent: record });
        }
      }
    } else if (parent !== undefined) {
      out.push({ ...record, $parent: parent });
    } else out.push(record);
  }
  return out;
}

function listLength(body: Record<string, unknown>, arrayPath: string): number {
  const items = readPath(body, arrayPath);
  return Array.isArray(items) ? items.length : 0;
}

function applyFilters(param: Record<string, unknown>, filters: PushedFilter[]): void {
  for (const f of filters) f.def.apply(param, f.values);
}

/** Streams one filtered scan page by page; `sink` returns false to stop early. */
async function scanPartition(
  ctx: ExecutionContext,
  resource: ResourceDef,
  filters: PushedFilter[],
  pageSize: number,
  sink: (raws: RawRecord[]) => boolean,
): Promise<void> {
  const { list } = resource;
  for (let page = 1; ; page++) {
    ctx.throwIfAborted();
    const param: Record<string, unknown> = { ...(list.baseParam?.() ?? {}) };
    applyFilters(param, filters);
    if (list.paging === 'std')
      Object.assign(param, { pagina: page, registros_por_pagina: pageSize });
    else Object.assign(param, { nPagina: page, nRegPorPagina: pageSize });
    const { body, noRecords } = await ctx.read({ endpoint: list.endpoint, call: list.call, param });
    if (noRecords) return;
    const raws = extractRecords(resource, body, list.arrayPath);
    if (!sink(raws)) return;
    const totalPages = list.paging === 'std' ? body.total_de_paginas : body.nTotPaginas;
    if (
      typeof totalPages !== 'number' ||
      page >= totalPages ||
      listLength(body, list.arrayPath) === 0
    )
      return;
  }
}

async function lookupOne(
  ctx: ExecutionContext,
  resource: ResourceDef,
  value: unknown,
): Promise<RawRecord[]> {
  const lookup = resource.lookup;
  if (!lookup) return [];
  try {
    const { body, noRecords } = await ctx.read({
      endpoint: resource.list.endpoint,
      call: lookup.call,
      param: lookup.param(value),
    });
    if (noRecords) return [];
    const record = lookup.unwrap ? readPath(body, lookup.unwrap) : body;
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return [];
    if (resource.list.explode) return extractRecords(resource, { items: [record] }, 'items');
    return [record as RawRecord];
  } catch (err) {
    if (isNotFoundFault(err)) return [];
    throw err;
  }
}

function pkKey(resource: ResourceDef): (row: Row) => string {
  const idx = pkColumns(resource).map((c) => resource.columns.indexOf(c));
  return (row) => JSON.stringify(idx.map((i) => row[i] ?? null));
}

/**
 * Fetches the rows of one table with the chosen access path. `accept` filters
 * rows locally and returns false once enough rows were collected.
 */
export async function fetchTable(
  ctx: ExecutionContext,
  resource: ResourceDef,
  access: AccessPath,
  accept: (row: Row) => 'keep' | 'skip' | 'stop',
  pageSizeHint?: number,
): Promise<Row[]> {
  const rows: Row[] = [];
  let stopped = false;
  const multi =
    access.strategy === 'PK_LOOKUP'
      ? access.values.length > 1
      : access.strategy !== 'METADATA_COUNT' && access.partitions.length > 1;
  const seen = multi ? new Set<string>() : undefined;
  const key = pkKey(resource);
  const take = (raws: RawRecord[]): boolean => {
    ctx.materialize(raws.length);
    for (const raw of raws) {
      const row = toRow(resource, raw);
      if (seen) {
        const k = key(row);
        if (seen.has(k)) continue;
        seen.add(k);
      }
      const verdict = accept(row);
      if (verdict === 'keep') rows.push(row);
      if (verdict === 'stop') {
        rows.push(row);
        stopped = true;
        return false;
      }
    }
    return true;
  };

  if (access.strategy === 'METADATA_COUNT') return rows;

  if (access.strategy === 'PK_LOOKUP') {
    const values = [...new Set(access.values)];
    const results = await mapWithConcurrency(
      values,
      ctx.limits.concurrency,
      (v) => lookupOne(ctx, resource, v),
      ctx.signal,
    );
    for (const raws of results) if (!take(raws)) break;
    return rows;
  }

  const pageSize =
    pageSizeHint !== undefined && resource.list.pageSizePushdown !== false
      ? Math.max(1, Math.min(resource.list.pageSize, pageSizeHint))
      : resource.list.pageSize;
  for (const partition of access.partitions) {
    if (stopped) break;
    await scanPartition(ctx, resource, [...access.singles, ...partition], pageSize, take);
  }
  return rows;
}

async function metadataCount(ctx: ExecutionContext, resource: ResourceDef): Promise<number> {
  const { list } = resource;
  const param: Record<string, unknown> = { ...(list.baseParam?.() ?? {}) };
  if (list.paging === 'std') Object.assign(param, { pagina: 1, registros_por_pagina: 1 });
  else Object.assign(param, { nPagina: 1, nRegPorPagina: 1 });
  const { body, noRecords } = await ctx.read({ endpoint: list.endpoint, call: list.call, param });
  if (noRecords) return 0;
  const total = list.paging === 'std' ? body.total_de_registros : body.nTotRegistros;
  if (typeof total !== 'number') {
    throw new AppError('OMIE_BAD_RESPONSE', `Omie did not return a record count for ${list.call}.`);
  }
  return total;
}

// ---------------------------------------------------------------- joins

function hashKey(v: Value): string | null {
  if (v === null) return null;
  const n = toNumber(v);
  return n !== null ? `n:${n}` : `s:${String(v)}`;
}

async function joinTable(
  ctx: ExecutionContext,
  bound: BoundSelect,
  index: number,
  left: Row[],
): Promise<Row[]> {
  const table = bound.tables[index] as BoundTable;
  const method = bound.joins[index - 1];
  if (!method || !table.join) throw new AppError('INTERNAL_ERROR', 'Join without a plan');
  const res = table.resource;
  const rightCol = findColumn(res, method.rightColumn);
  if (!rightCol) throw new AppError('INTERNAL_ERROR', 'Join column missing');
  const width = res.columns.length;

  // Right-only predicates usable before the hash join (ON always; WHERE only for INNER).
  const rightScope = new Scope(tableScopeColumns(table.alias, res));
  const ownOn = conjuncts(table.join.on).filter((e) => {
    const refs = tablesOf(e, bound.scope);
    return refs.size === 1 && refs.has(table.alias);
  });
  const pre = [
    ...ownOn,
    ...(table.join.type === 'INNER' ? (bound.localConjuncts.get(table.alias) ?? []) : []),
  ];
  const prePredicates = pre.map((e) => compilePredicate(e, rightScope));
  const constraints = extractConstraints(pre, rightScope, table.alias);

  const keyValues = new Map<string, unknown>();
  for (const row of left) {
    const v = row[method.leftIndex] ?? null;
    const hk = hashKey(v);
    if (hk === null || keyValues.has(hk)) continue;
    const wire = pushValue(rightCol, v);
    if (wire !== undefined) keyValues.set(hk, wire);
  }
  const keys = [...keyValues.values()];

  let rightRows: Row[] = [];
  const accept = (row: Row): 'keep' | 'skip' =>
    prePredicates.every((p) => p(row)) ? 'keep' : 'skip';
  if (keys.length > 0) {
    let access: AccessPath | undefined;
    const lookupOk =
      res.lookup && method.method === 'JOIN_LOOKUP' && keys.length <= ctx.limits.lookupMaxKeys;
    const def = res.pushdown.find(
      (d) => d.column === rightCol.name && d.kind === 'eq' && (d.multi || !lookupOk),
    );
    const parts = def ? partitionsFor(def, keys, ctx.limits) : undefined;
    if (def && parts)
      access = chooseAccess(res, constraints, ctx.limits, {
        forced: parts,
        forcedColumn: rightCol.name,
      });
    else if (lookupOk) access = { strategy: 'PK_LOOKUP', column: rightCol.name, values: keys };
    else access = chooseAccess(res, constraints, ctx.limits);
    try {
      rightRows = await fetchTable(ctx, res, access, accept);
    } catch (err) {
      if (
        isAppError(err) &&
        err.code === 'API_CALL_LIMIT_EXCEEDED' &&
        access.strategy === 'FULL_SCAN'
      ) {
        throw new AppError(
          'JOIN_CARDINALITY_LIMIT',
          `JOIN ${table.alias} has ${keys.length} distinct keys and needs a full scan of ${res.name} that exceeds the API call budget (${ctx.limits.maxApiCalls}). Filter the left side to fewer rows.`,
          { distinctKeys: keys.length },
        );
      }
      throw err;
    }
  }

  const rightIdx = res.columns.indexOf(rightCol);
  const hash = new Map<string, Row[]>();
  for (const r of rightRows) {
    const hk = hashKey(r[rightIdx] ?? null);
    if (hk === null) continue;
    const bucket = hash.get(hk);
    if (bucket) bucket.push(r);
    else hash.set(hk, [r]);
  }

  const joinScope = new Scope(bound.scope.columns.slice(0, table.offset + width));
  const on = compilePredicate(table.join.on, joinScope);
  const nulls: Row = new Array<Value>(width).fill(null);
  const out: Row[] = [];
  for (const l of left) {
    let matched = false;
    const hk = hashKey(l[method.leftIndex] ?? null);
    for (const r of hk === null ? [] : (hash.get(hk) ?? [])) {
      const combined = [...l, ...r];
      if (on(combined)) {
        out.push(combined);
        matched = true;
      }
    }
    if (!matched && table.join.type === 'LEFT') out.push([...l, ...nulls]);
    if (out.length > ctx.limits.maxMaterializedRows) {
      throw new AppError(
        'JOIN_CARDINALITY_LIMIT',
        `JOIN ${table.alias} produces more than ${ctx.limits.maxMaterializedRows} rows.`,
      );
    }
  }
  ctx.materialize(out.length);
  return out;
}

function walkExpr(e: Expr, fn: (x: Expr) => void): void {
  fn(e);
  switch (e.kind) {
    case 'literal':
    case 'column':
      return;
    case 'aggregate':
      if (e.arg !== '*') walkExpr(e.arg, fn);
      return;
    case 'not':
    case 'neg':
    case 'isNull':
      walkExpr(e.expr, fn);
      return;
    case 'in':
      walkExpr(e.expr, fn);
      e.list.forEach((x) => walkExpr(x, fn));
      return;
    case 'between':
      walkExpr(e.expr, fn);
      walkExpr(e.low, fn);
      walkExpr(e.high, fn);
      return;
    case 'like':
      walkExpr(e.expr, fn);
      walkExpr(e.pattern, fn);
      return;
    default:
      walkExpr(e.left, fn);
      walkExpr(e.right, fn);
  }
}

// ---------------------------------------------------------------- projection helpers

interface OutputItem {
  name: string;
  type: ScopeColumn['type'];
  fn: (row: Row) => Value;
  expr?: Expr;
  alias?: string;
}

function expandItems(
  items: SelectItem[],
  scope: Scope,
  compileExpr: (e: Expr) => (row: Row) => Value,
  grouped: boolean,
): OutputItem[] {
  const out: OutputItem[] = [];
  for (const item of items) {
    if (item.kind === 'star') {
      if (grouped)
        throw new AppError(
          'SQL_UNSUPPORTED',
          'SELECT * cannot be combined with GROUP BY or aggregate functions.',
        );
      const cols = scope.columns
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => item.table === undefined || c.table === item.table);
      if (item.table !== undefined && cols.length === 0) {
        throw new AppError(
          'COLUMN_NOT_FOUND',
          `Unknown table or alias "${item.table}" in ${item.table}.*.`,
        );
      }
      for (const { c, i } of cols)
        out.push({ name: c.name, type: c.type, fn: (row) => row[i] ?? null });
      continue;
    }
    const name =
      item.alias ??
      (item.expr.kind === 'column' ? item.expr.name : item.text || exprToSql(item.expr));
    out.push({
      name,
      type: inferType(item.expr, scope),
      fn: compileExpr(item.expr),
      expr: item.expr,
      ...(item.alias ? { alias: item.alias } : {}),
    });
  }
  return out;
}

function collectAggregates(e: Expr, into: Array<Extract<Expr, { kind: 'aggregate' }>>): void {
  walkExpr(e, (x) => {
    if (x.kind === 'aggregate') {
      if (x.arg !== '*') {
        let nested = false;
        walkExpr(x.arg, (y) => (nested ||= y.kind === 'aggregate'));
        if (nested)
          throw new AppError('SQL_UNSUPPORTED', 'Nested aggregate functions are not supported.');
      }
      into.push(x);
    }
  });
}

function valueKey(values: Value[]): string {
  return JSON.stringify(values.map((v) => (v === null ? null : [typeof v, v])));
}

// ---------------------------------------------------------------- main

export async function executeSelect(
  ctx: ExecutionContext,
  bound: BoundSelect,
): Promise<SelectResult> {
  const { stmt, scope, tables } = bound;
  const messages: string[] = [];
  const need = bound.offset + bound.limit + 1;

  const whereFn = stmt.where ? compilePredicate(stmt.where, scope) : undefined;

  // 1) Fetch the first table (or a single empty row for SELECT without FROM).
  let rows: Row[];
  const first = tables[0];
  if (!first) rows = [[]];
  else if (bound.access?.strategy === 'METADATA_COUNT') {
    const count = await metadataCount(ctx, first.resource);
    const item = stmt.columns[0];
    const name = item?.kind === 'expr' ? (item.alias ?? (item.text || 'COUNT(*)')) : 'COUNT(*)';
    const value: Row = [count];
    return {
      columns: [{ name, type: 'integer' }],
      rows: bound.limit === 0 || bound.offset > 0 ? [] : [value],
      truncated: false,
      messages: [
        'COUNT(*) answered from Omie paging metadata (total_de_registros) with a single call.',
      ],
    };
  } else {
    const own = bound.localConjuncts.get(first.alias) ?? [];
    const firstScope = new Scope(tableScopeColumns(first.alias, first.resource));
    const preds = (
      tables.length === 1 && whereFn ? [whereFn] : own.map((e) => compilePredicate(e, firstScope))
    ) as Array<(row: Row) => boolean>;
    let kept = 0;
    const accept = (row: Row): 'keep' | 'skip' | 'stop' => {
      if (!preds.every((p) => p(row))) return 'skip';
      kept += 1;
      return bound.earlyStop && kept >= need ? 'stop' : 'keep';
    };
    const hint = bound.earlyStop && !stmt.where ? need : undefined;
    rows = await fetchTable(ctx, first.resource, bound.access as AccessPath, accept, hint);
  }

  // 2) Joins.
  for (let i = 1; i < tables.length; i++) rows = await joinTable(ctx, bound, i, rows);

  // 3) WHERE (re-applied over the combined row; cheap and keeps semantics exact).
  if (whereFn && tables.length !== 1) rows = rows.filter(whereFn);

  // 4) Grouping / aggregation.
  let srcScope = scope;
  let compileOpts: Parameters<typeof compile>[2] = {};
  if (bound.grouped) {
    const selectExprs = stmt.columns.flatMap((c) => (c.kind === 'expr' ? [c.expr] : []));
    const groupExprs = stmt.groupBy.map((g) => {
      if ('index' in g && g.kind === 'position') {
        const item = stmt.columns[g.index - 1];
        if (!item || item.kind !== 'expr')
          throw new AppError(
            'SQL_UNSUPPORTED',
            `GROUP BY position ${g.index} is not a select expression.`,
          );
        return item.expr;
      }
      return resolveAlias(g as Expr, stmt.columns);
    });
    for (const g of groupExprs) {
      const aggs: Array<Extract<Expr, { kind: 'aggregate' }>> = [];
      collectAggregates(g, aggs);
      if (aggs.length > 0)
        throw new AppError('SQL_UNSUPPORTED', 'Aggregate functions are not allowed in GROUP BY.');
    }
    const aggs: Array<Extract<Expr, { kind: 'aggregate' }>> = [];
    for (const e of selectExprs) collectAggregates(e, aggs);
    if (stmt.having) collectAggregates(stmt.having, aggs);
    for (const o of stmt.orderBy)
      if (o.expr.kind !== 'position') collectAggregates(o.expr as Expr, aggs);

    const layout = new Map<string, number>();
    const keyFns: Array<(row: Row) => Value> = [];
    const groupCols: ScopeColumn[] = [];
    for (const g of groupExprs) {
      const k = exprKey(g, scope);
      if (layout.has(k)) continue;
      layout.set(k, keyFns.length);
      keyFns.push(compile(g, scope));
      groupCols.push({ table: '', name: exprToSql(g), type: inferType(g, scope) });
    }
    const aggSpecs: Array<{
      fn: AggregateFn;
      distinct: boolean;
      star: boolean;
      arg?: (row: Row) => Value;
    }> = [];
    for (const a of aggs) {
      const k = exprKey(a, scope);
      if (layout.has(k)) continue;
      layout.set(k, keyFns.length + aggSpecs.length);
      aggSpecs.push({
        fn: a.fn,
        distinct: a.distinct,
        star: a.arg === '*',
        ...(a.arg === '*' ? {} : { arg: compile(a.arg, scope) }),
      });
    }
    const groups = new Map<string, { keys: Value[]; accs: Accumulator[] }>();
    for (const row of rows) {
      const keys = keyFns.map((f) => f(row));
      const gk = valueKey(keys);
      let g = groups.get(gk);
      if (!g) {
        g = { keys, accs: aggSpecs.map((s) => createAccumulator(s.fn, s.distinct, s.star)) };
        groups.set(gk, g);
      }
      g.accs.forEach((acc, i) =>
        acc.add(aggSpecs[i]?.arg ? (aggSpecs[i]?.arg as (r: Row) => Value)(row) : 1),
      );
    }
    if (groups.size === 0 && groupExprs.length === 0) {
      groups.set('', {
        keys: [],
        accs: aggSpecs.map((s) => createAccumulator(s.fn, s.distinct, s.star)),
      });
    }
    rows = [...groups.values()].map((g) => [...g.keys, ...g.accs.map((a) => a.result())]);
    compileOpts = { grouped: layout };
    srcScope = scope;
    if (stmt.having) {
      const having = compilePredicate(
        resolveAliasDeep(stmt.having, stmt.columns),
        srcScope,
        compileOpts,
      );
      rows = rows.filter(having);
    }
  }

  // 5) Projection (kept alongside the source row for ORDER BY on non-projected columns).
  const items = expandItems(
    stmt.columns,
    srcScope,
    (e) => compile(e, srcScope, compileOpts),
    bound.grouped,
  );
  let pairs = rows.map((src) => ({ src, out: items.map((it) => it.fn(src)) }));

  // 6) ORDER BY.
  if (stmt.orderBy.length > 0) {
    const keyFns = stmt.orderBy.map((o) => {
      const e = o.expr;
      if (e.kind === 'position') {
        const idx = (e as { index: number }).index - 1;
        if (idx < 0 || idx >= items.length)
          throw new AppError('SQL_UNSUPPORTED', `ORDER BY position ${idx + 1} is out of range.`);
        return { desc: o.desc, fn: (p: { out: Row }) => p.out[idx] ?? null };
      }
      const expr = e as Expr;
      if (expr.kind === 'column' && expr.table === undefined) {
        const idx = items.findIndex((it) => it.alias === expr.name);
        if (idx >= 0) return { desc: o.desc, fn: (p: { out: Row }) => p.out[idx] ?? null };
      }
      const f = compile(expr, srcScope, compileOpts);
      return { desc: o.desc, fn: (p: { src: Row }) => f(p.src) };
    });
    pairs = pairs
      .map((p, i) => ({ p, i, keys: keyFns.map((k) => k.fn(p)) }))
      .sort((a, b) => {
        for (let k = 0; k < keyFns.length; k++) {
          const c = orderValues(a.keys[k] ?? null, b.keys[k] ?? null);
          if (c !== 0) return keyFns[k]?.desc ? -c : c;
        }
        return a.i - b.i;
      })
      .map((x) => x.p);
  }

  // 7) DISTINCT.
  let out = pairs.map((p) => p.out);
  if (stmt.distinct) {
    const seen = new Set<string>();
    out = out.filter((r) => {
      const k = valueKey(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // 8) OFFSET / LIMIT.
  const afterOffset = out.slice(bound.offset);
  const truncated = bound.implicitLimit && afterOffset.length > bound.limit;
  const finalRows = afterOffset.slice(0, bound.limit);
  if (truncated) {
    messages.push(
      `Result truncated to ${bound.limit} rows (OMIE_MAX_ROWS). Add filters or an explicit LIMIT/OFFSET to page through the data.`,
    );
  }

  return {
    columns: items.map((it) => ({ name: it.name, type: it.type })),
    rows: finalRows,
    truncated,
    messages,
  };
}

/** GROUP BY / HAVING may reference select aliases. */
function resolveAlias(e: Expr, items: SelectItem[]): Expr {
  if (e.kind === 'column' && e.table === undefined) {
    const item = items.find((it) => it.kind === 'expr' && it.alias === e.name);
    if (item && item.kind === 'expr') return item.expr;
  }
  return e;
}

function resolveAliasDeep(e: Expr, items: SelectItem[]): Expr {
  const aliased = new Map<string, Expr>();
  for (const it of items) if (it.kind === 'expr' && it.alias) aliased.set(it.alias, it.expr);
  if (aliased.size === 0) return e;
  const map = (x: Expr): Expr => {
    switch (x.kind) {
      case 'column':
        return x.table === undefined && aliased.has(x.name) ? (aliased.get(x.name) as Expr) : x;
      case 'literal':
      case 'aggregate':
        return x;
      case 'not':
      case 'neg':
      case 'isNull':
        return { ...x, expr: map(x.expr) };
      case 'in':
        return { ...x, expr: map(x.expr), list: x.list.map(map) };
      case 'between':
        return { ...x, expr: map(x.expr), low: map(x.low), high: map(x.high) };
      case 'like':
        return { ...x, expr: map(x.expr), pattern: map(x.pattern) };
      default:
        return { ...x, left: map(x.left), right: map(x.right) };
    }
  };
  return map(e);
}
