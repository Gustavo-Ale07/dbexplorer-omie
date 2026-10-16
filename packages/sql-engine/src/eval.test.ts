import { describe, expect, it } from 'vitest';
import { OmieClient, createMockTransport } from '@dbx/omie-client';
import { RESOURCES, validateRegistry } from './registry';
import type { ResourceDef } from './registry/types';
import { cleanFloat, compareValues, compileLike, orderValues, suggest } from './eval';
import { omieDateToIso, toOmieDate } from './normalize';
import { SqlEngine } from './engine';

describe('value helpers', () => {
  it('translates LIKE patterns, honouring ESCAPE and regex metacharacters', () => {
    expect(compileLike('abc%')('ABCdef')).toBe(true);
    expect(compileLike('a_c')('abc')).toBe(true);
    expect(compileLike('a_c')('abbc')).toBe(false);
    expect(compileLike('100!%', '!')('100%')).toBe(true);
    expect(compileLike('100!%', '!')('1000')).toBe(false);
    expect(compileLike('a.c')('abc')).toBe(false);
    expect(compileLike('(x)*')('(x)*')).toBe(true);
    expect(compileLike('%')('')).toBe(true);
    expect(compileLike('_')('')).toBe(false);
    expect(compileLike('%são%')('SÃO PAULO')).toBe(true);
    expect(compileLike('a%b%c')('axxbyyc')).toBe(true);
    expect(compileLike('a%b%c')('axxbyy')).toBe(false);
    expect(compileLike('%ab')('aab')).toBe(true);
    expect(compileLike('line1%line2')('line1\nline2')).toBe(true);
  });

  it('matches LIKE in linear time on patterns that make backtracking regexes explode', () => {
    const start = performance.now();
    const text = 'a'.repeat(5000);
    expect(compileLike(`${'%a'.repeat(40)}%b`)(text)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('compares with NULL as unknown and orders NULLs first', () => {
    expect(compareValues(null, 1)).toBeNull();
    expect(compareValues('10', 9)).toBeGreaterThan(0);
    expect([3, null, 1].sort(orderValues)).toEqual([null, 1, 3]);
    expect(['item 10', 'item 2'].sort(orderValues)).toEqual(['item 2', 'item 10']);
  });

  it('cleans floating-point noise', () => {
    expect(cleanFloat(0.1 + 0.2)).toBe(0.3);
    expect(cleanFloat(1182882.290000001)).toBe(1182882.29);
    expect(cleanFloat(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('suggests close names only', () => {
    expect(suggest('pedidos', ['pedidos_venda', 'clientes'])).toBe('pedidos_venda');
    expect(suggest('zzzz', ['clientes'])).toBeUndefined();
  });

  it('converts Omie dates in both directions and rejects impossible dates', () => {
    expect(omieDateToIso('05/03/2026')).toBe('2026-03-05');
    expect(omieDateToIso('')).toBeNull();
    expect(toOmieDate('2026-03-05', 'd')).toBe('05/03/2026');
    expect(toOmieDate('05/03/2026', 'd')).toBe('05/03/2026');
    expect(() => toOmieDate('2026-02-30', 'd')).toThrow();
    expect(() => toOmieDate(20260305, 'd')).toThrow();
  });
});

describe('three-valued logic', () => {
  const engine = new SqlEngine({
    client: new OmieClient({
      transport: createMockTransport({ seed: 1 }),
      concurrency: 1,
      timeoutMs: 1000,
    }),
  });
  const value = async (expr: string) =>
    (await engine.query(engine.parse(`SELECT ${expr} AS v`))).rows[0]?.[0];

  it('propagates NULL through comparisons and boolean operators', async () => {
    expect(await value('NULL = NULL')).toBeNull();
    expect(await value('NULL AND 1 = 0')).toBe(false);
    expect(await value('NULL OR 1 = 1')).toBe(true);
    expect(await value('NOT (NULL = 1)')).toBeNull();
    expect(await value('1 IN (2, NULL)')).toBeNull();
    expect(await value('1 NOT IN (2, NULL)')).toBeNull();
    expect(await value('NULL IS NULL')).toBe(true);
  });
});

describe('registry', () => {
  it('validates the built-in resources', () => {
    expect(() => validateRegistry(RESOURCES)).not.toThrow();
    expect(RESOURCES).toHaveLength(13);
  });

  it('rejects unsafe or inconsistent definitions', () => {
    const base = RESOURCES.find((r) => r.name === 'vendedores') as ResourceDef;
    const bad = (patch: Partial<ResourceDef>) => () => validateRegistry([{ ...base, ...patch }]);
    expect(bad({ name: 'Vendedores' })).toThrow();
    expect(
      bad({
        columns: [
          ...base.columns,
          { ...base.columns[0]!, pk: false, name: 'x', path: '__proto__.x' },
        ],
      }),
    ).toThrow(/unsafe/);
    expect(
      bad({ columns: base.columns.map((c) => (c.pk ? { ...c, updatable: true } : c)) }),
    ).toThrow(/primary key/);
    expect(bad({ pushdown: [{ ...base.pushdown[0]!, column: 'nope' }] })).toThrow();
    expect(() => validateRegistry([base, base])).toThrow(/Duplicate/);
  });

  it('declares DELETE unsupported where the API has no deletion', () => {
    for (const name of ['estoque', 'nfes', 'pedido_venda_itens']) {
      expect(RESOURCES.find((r) => r.name === name)?.writes.delete).toBeUndefined();
    }
  });
});
