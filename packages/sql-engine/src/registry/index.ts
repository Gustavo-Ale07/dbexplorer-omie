import { RESOURCES } from './resources';
import type { ColumnDef, RawRecord, Registry, ResourceDef } from './types';

export * from './types';

const SAFE_SEGMENT = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z_$][A-Za-z0-9_]*$/;

/** Reads a dot path; `$parent.` reads from the enclosing record. Never walks prototype keys. */
export function readPath(raw: RawRecord, path: string): unknown {
  let current: unknown = raw;
  for (const seg of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current, seg)) return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/** Writes a dot path, creating plain intermediate objects. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let current = target;
  segs.forEach((seg, i) => {
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype')
      throw new Error(`Unsafe path ${path}`);
    if (i === segs.length - 1) {
      current[seg] = value;
      return;
    }
    const next = Object.hasOwn(current, seg) ? current[seg] : undefined;
    if (next === null || typeof next !== 'object') current[seg] = {};
    current = current[seg] as Record<string, unknown>;
  });
}

export function pkColumns(resource: ResourceDef): ColumnDef[] {
  return resource.columns.filter((c) => c.pk);
}

export function findColumn(resource: ResourceDef, name: string): ColumnDef | undefined {
  return resource.columns.find((c) => c.name === name);
}

export function lookupColumn(resource: ResourceDef): string | undefined {
  if (!resource.lookup) return undefined;
  if (resource.lookup.column) return resource.lookup.column;
  const pks = pkColumns(resource);
  return pks.length === 1 ? pks[0]?.name : undefined;
}

/** Throws on inconsistent definitions; run at startup and in tests. */
export function validateRegistry(resources: readonly ResourceDef[]): void {
  const names = new Set<string>();
  for (const r of resources) {
    if (!SAFE_SEGMENT.test(r.name) || r.name !== r.name.toLowerCase())
      throw new Error(`Invalid resource name ${r.name}`);
    if (names.has(r.name)) throw new Error(`Duplicate resource ${r.name}`);
    names.add(r.name);
    if (!/^[a-z]+(\/[a-z]+)*$/.test(r.list.endpoint))
      throw new Error(`${r.name}: invalid endpoint`);
    const cols = new Set<string>();
    for (const c of r.columns) {
      if (cols.has(c.name)) throw new Error(`${r.name}: duplicate column ${c.name}`);
      cols.add(c.name);
      for (const seg of c.path.replace(/^\$parent\./, '').split('.')) {
        if (!SAFE_SEGMENT.test(seg)) throw new Error(`${r.name}.${c.name}: unsafe path`);
      }
      if (c.pk && c.updatable)
        throw new Error(`${r.name}.${c.name}: a primary key cannot be updatable`);
      if (c.required && !c.insertable)
        throw new Error(`${r.name}.${c.name}: required implies insertable`);
    }
    if (pkColumns(r).length === 0) throw new Error(`${r.name}: no primary key`);
    for (const p of r.pushdown)
      if (!cols.has(p.column)) throw new Error(`${r.name}: pushdown on unknown column ${p.column}`);
    if (r.requiredFilter && !cols.has(r.requiredFilter))
      throw new Error(`${r.name}: unknown required filter`);
    const lc = lookupColumn(r);
    if (r.lookup && (!lc || !cols.has(lc))) throw new Error(`${r.name}: invalid lookup column`);
    const ops = [
      r.writes.insert,
      typeof r.writes.update === 'object' ? r.writes.update : undefined,
      r.writes.delete,
    ];
    for (const op of ops) {
      if (!op) continue;
      for (const k of op.key)
        if (!cols.has(k)) throw new Error(`${r.name}: write key ${k} unknown`);
    }
    if (r.writes.insert && !r.columns.some((c) => c.insertable))
      throw new Error(`${r.name}: insert without insertable columns`);
  }
  for (const r of resources) {
    for (const c of r.columns) {
      if (!c.references) continue;
      const target = resources.find((x) => x.name === c.references?.table);
      if (!target || !target.columns.some((x) => x.name === c.references?.column)) {
        throw new Error(`${r.name}.${c.name}: invalid reference`);
      }
    }
  }
}

export function createRegistry(resources: readonly ResourceDef[] = RESOURCES): Registry {
  validateRegistry(resources);
  const map = new Map(resources.map((r) => [r.name, r]));
  return { resources: map, get: (name) => map.get(name) };
}

export { RESOURCES };
