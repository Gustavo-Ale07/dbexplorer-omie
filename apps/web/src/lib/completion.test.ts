import { describe, expect, it } from 'vitest';
import type { SchemaTable } from '../api/types';
import { findAliases, statementAt, suggest } from './completion';

const col = (name: string, pk = false) => ({
  name,
  type: 'string',
  description: '',
  pk,
  insertable: true,
  updatable: true,
  required: false,
});
const tables: SchemaTable[] = [
  {
    name: 'clientes',
    group: 'Geral',
    description: 'Clientes',
    operations: { select: true, insert: true, update: true, delete: true },
    notes: [],
    columns: [col('codigo_cliente_omie', true), col('razao_social'), col('estado')],
  },
  {
    name: 'pedidos_venda',
    group: 'Vendas',
    description: 'Pedidos',
    operations: { select: true, insert: false, update: false, delete: false },
    notes: [],
    columns: [col('codigo_pedido', true), col('codigo_cliente')],
  },
];

describe('findAliases', () => {
  it('maps aliases and ignores reserved words', () => {
    const a = findAliases(
      'SELECT * FROM clientes c JOIN pedidos_venda AS p ON p.codigo_cliente = c.codigo_cliente_omie WHERE 1=1',
      tables,
    );
    expect(a.get('c')).toBe('clientes');
    expect(a.get('p')).toBe('pedidos_venda');
    expect(findAliases('SELECT * FROM clientes WHERE x = 1', tables).has('where')).toBe(false);
  });
  it('ignores unknown tables', () => {
    expect(findAliases('SELECT * FROM segredos s', tables).size).toBe(0);
  });
});

describe('suggest', () => {
  it('suggests tables after FROM', () => {
    const s = suggest('SELECT * FROM cl', 'SELECT * FROM cl', tables);
    expect(s.map((x) => x.label)).toEqual(['clientes', 'pedidos_venda']);
  });
  it('suggests columns of an alias after a dot', () => {
    const sql = 'SELECT c. FROM clientes c';
    const s = suggest('SELECT c.', sql, tables);
    expect(s.map((x) => x.label)).toEqual(['codigo_cliente_omie', 'razao_social', 'estado']);
    expect(s.every((x) => x.kind === 'column')).toBe(true);
  });
  it('offers columns in scope plus keywords and functions', () => {
    const sql = 'SELECT  FROM clientes';
    const s = suggest('SELECT ', sql, tables);
    const labels = s.map((x) => x.label);
    expect(labels).toContain('razao_social');
    expect(labels).toContain('COUNT');
    expect(labels).toContain('WHERE');
    expect(labels).not.toContain('codigo_pedido');
  });
  it('returns nothing for an unknown qualifier', () => {
    expect(suggest('SELECT x.', 'SELECT x.', tables)).toEqual([]);
  });
});

describe('statementAt', () => {
  const text = "SHOW TABLES;\nSELECT ';' AS x FROM clientes; -- a;b\nSELECT 2";
  it('returns the statement under the cursor, ignoring ; in strings and comments', () => {
    expect(statementAt(text, 3).sql).toBe('SHOW TABLES');
    expect(statementAt(text, 20).sql).toBe("SELECT ';' AS x FROM clientes");
    expect(statementAt(text, text.length).sql).toBe('-- a;b\nSELECT 2');
  });
  it('uses the previous statement when the cursor is after the final ;', () => {
    const t = 'SELECT 1;\nSELECT 2;\n';
    expect(statementAt(t, t.length).sql).toBe('SELECT 2');
  });
  it('handles empty text', () => {
    expect(statementAt('', 0).sql).toBe('');
  });
});
