import { describe, expect, it } from 'vitest';
import { OmieClient, createMockTransport } from '@dbx/omie-client';
import type { OmieTransport, TransportResponse } from '@dbx/omie-client';
import { isAppError } from '@dbx/shared';
import type { WriteStatement } from './ast';
import { SqlEngine } from './engine';
import type { EngineLimits } from './context';
import type { WritePolicy } from './writes';

const ANCHOR = new Date('2026-06-15T12:00:00Z');
const OPEN: WritePolicy = {
  readOnly: false,
  allowInsert: true,
  allowUpdate: true,
  allowDelete: true,
};

function setup(limits: Partial<EngineLimits> = {}, wrap?: (t: OmieTransport) => OmieTransport) {
  const mock = createMockTransport({ seed: 7, anchor: ANCHOR });
  const transport = wrap ? wrap(mock) : mock;
  const client = new OmieClient({
    transport,
    concurrency: 4,
    timeoutMs: 2000,
    retry: { maxRetries: 0 },
  });
  const engine = new SqlEngine({ client, limits });
  const run = (sql: string) => engine.query(engine.parse(sql));
  const prepare = (sql: string, policy: WritePolicy = OPEN) =>
    engine.prepareWrite(engine.parse(sql) as WriteStatement, policy);
  return { mock, engine, run, prepare };
}

async function errorOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    if (isAppError(err)) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('expected an error');
}

const col = (r: { columns: { name: string }[]; rows: unknown[][] }, name: string) => {
  const i = r.columns.findIndex((c) => c.name === name);
  return r.rows.map((row) => row[i]);
};

describe('SqlEngine · catalog', () => {
  it('lists tables and describes columns with capabilities', async () => {
    const { run } = setup();
    const tables = await run('SHOW TABLES');
    expect(col(tables, 'table_name')).toContain('pedidos_venda');
    const estoque = tables.rows.find((r) => r[0] === 'estoque');
    expect(estoque?.slice(3)).toEqual(['unsupported', 'unsupported', 'unsupported']);
    const desc = await run('DESCRIBE clientes');
    expect(col(desc, 'column_name')).toContain('razao_social');
    expect(desc.messages[0]).toContain('DELETE: supported');
    const nfe = await run('SHOW COLUMNS FROM nfes');
    expect(nfe.messages[0]).toContain('DELETE: unsupported');
  });

  it('suggests a table name for typos', async () => {
    const { run } = setup();
    const e = await errorOf(run('SELECT * FROM cliente'));
    expect(e.code).toBe('RESOURCE_NOT_FOUND');
    expect(e.message).toContain('Did you mean "clientes"');
  });

  it('reports unknown and ambiguous columns', async () => {
    const { run } = setup();
    expect((await errorOf(run('SELECT razao_socail FROM clientes'))).message).toContain(
      'razao_social',
    );
    const amb = await errorOf(
      run(
        'SELECT descricao FROM pedido_venda_itens i JOIN produtos p ON p.codigo_produto = i.codigo_produto WHERE i.codigo_pedido = 7000001',
      ),
    );
    expect(amb.code).toBe('AMBIGUOUS_COLUMN');
  });

  it('exposes the schema and an allowlisted inspector', async () => {
    const { engine } = setup();
    const schema = engine.schema();
    expect(schema.find((t) => t.name === 'tabela_preco_itens')?.requiredFilter).toBe(
      'codigo_tabela',
    );
    const calls = engine.inspectorCalls();
    expect(calls.every((c) => /^(Listar|Consultar)/.test(c.call))).toBe(true);
    const res = await engine.inspect('geral/clientes:ListarClientes', {
      pagina: 1,
      registros_por_pagina: 2,
    });
    expect((res.response.clientes_cadastro as unknown[]).length).toBe(2);
    expect(JSON.stringify(res.request)).not.toMatch(/app_secret"\s*:\s*"(?!\*\*\*)/);
    expect((await errorOf(engine.inspect('geral/clientes:ExcluirCliente', {}))).code).toBe(
      'FORBIDDEN',
    );
    expect(
      (
        await errorOf(
          engine.inspect('geral/clientes:ListarClientes', JSON.parse('{"__proto__":{"x":1}}')),
        )
      ).code,
    ).toBe('VALIDATION_ERROR');
  });
});

describe('SqlEngine · access strategies', () => {
  it('stops scanning early for LIMIT without ORDER BY', async () => {
    const { run } = setup();
    const r = await run('SELECT codigo_cliente_omie FROM clientes LIMIT 5');
    expect(r.rowCount).toBe(5);
    expect(r.apiCalls).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it('answers COUNT(*) from paging metadata in one call', async () => {
    const { run, mock } = setup();
    const r = await run('SELECT COUNT(*) AS total FROM clientes');
    expect(r.rows).toEqual([[mock.dataset.clientes.length]]);
    expect(r.apiCalls).toBe(1);
  });

  it('uses Consultar* for primary-key lookups and treats "não cadastrado" as no row', async () => {
    const { run } = setup();
    const r = await run(
      'SELECT codigo_cliente_omie FROM clientes WHERE codigo_cliente_omie = 1000003',
    );
    expect(r.rows).toEqual([[1000003]]);
    expect(r.plan && 'steps' in r.plan && r.plan.steps[0]?.strategy).toBe('PK_LOOKUP');
    const none = await run('SELECT * FROM clientes WHERE codigo_cliente_omie = 999');
    expect(none.rowCount).toBe(0);
  });

  it('pushes multi-value IN lists into one filtered request', async () => {
    const { run } = setup();
    const r = await run(
      'SELECT codigo_cliente_omie FROM clientes WHERE codigo_cliente_omie IN (1000001, 1000002, 1000010) ORDER BY 1',
    );
    expect(r.rows).toEqual([[1000001], [1000002], [1000010]]);
    expect(r.apiCalls).toBe(1);
  });

  it('re-applies pushed filters locally (superset semantics)', async () => {
    const { run } = setup();
    const r = await run("SELECT estado FROM clientes WHERE estado = 'SP' AND inativo = 'N'");
    expect(new Set(col(r, 'estado'))).toEqual(new Set(['SP']));
    const all = await run("SELECT COUNT(*) FROM clientes WHERE estado = 'SP'");
    expect(all.rows[0]?.[0]).toBeGreaterThan(0);
  });

  it('partitions a small IN list on a single-value filter and de-duplicates', async () => {
    const { run } = setup();
    const r = await run(
      "SELECT numero_pedido FROM pedidos_venda WHERE etapa IN ('10', '20') LIMIT 1000",
    );
    const exp = await run(
      "EXPLAIN SELECT numero_pedido FROM pedidos_venda WHERE etapa IN ('10', '20')",
    );
    expect(exp.rows.find((x) => x[0] === 'Remote filters')?.[1]).toContain('2 partition(s)');
    expect(new Set(col(r, 'numero_pedido')).size).toBe(r.rowCount);
  });

  it('requires the mandatory filter of price-table items', async () => {
    const { run } = setup();
    const e = await errorOf(run('SELECT * FROM tabela_preco_itens'));
    expect(e.code).toBe('SQL_UNSUPPORTED');
    expect(e.message).toContain('codigo_tabela');
    const r = await run(
      'SELECT codigo_tabela, codigo_produto FROM tabela_preco_itens WHERE codigo_tabela IN (11000001, 11000002) LIMIT 1000',
    );
    expect(new Set(col(r, 'codigo_tabela'))).toEqual(new Set([11000001, 11000002]));
  });

  it('explodes order items and attaches parent columns', async () => {
    const { run, mock } = setup();
    const r = await run(
      'SELECT codigo_pedido, numero_pedido, codigo_item FROM pedido_venda_itens WHERE codigo_pedido = 7000002',
    );
    const pedido = mock.dataset.pedidos.find(
      (p) => (p.cabecalho as { codigo_pedido: number }).codigo_pedido === 7000002,
    );
    expect(r.rowCount).toBe((pedido?.det as unknown[]).length);
    expect(new Set(col(r, 'numero_pedido'))).toEqual(new Set(['1002']));
  });
});

describe('SqlEngine · SQL semantics', () => {
  it('filters with three-valued logic, BETWEEN, LIKE and NOT IN', async () => {
    const { run } = setup();
    const r = await run(
      "SELECT codigo_produto, descricao, valor_unitario FROM produtos WHERE valor_unitario BETWEEN 10 AND 50 AND descricao LIKE 'parafuso%' AND codigo_produto NOT IN (3000002) LIMIT 1000",
    );
    for (const [code, desc, price] of r.rows) {
      expect(code).not.toBe(3000002);
      expect(String(desc).toLowerCase().startsWith('parafuso')).toBe(true);
      expect(price as number).toBeGreaterThanOrEqual(10);
      expect(price as number).toBeLessThanOrEqual(50);
    }
    const nulls = await run('SELECT COUNT(*) FROM pedidos_venda WHERE data_faturamento IS NULL');
    const notNulls = await run(
      'SELECT COUNT(*) FROM pedidos_venda WHERE data_faturamento IS NOT NULL',
    );
    const total = await run('SELECT COUNT(*) FROM pedidos_venda');
    expect((nulls.rows[0]?.[0] as number) + (notNulls.rows[0]?.[0] as number)).toBe(
      total.rows[0]?.[0],
    );
  });

  it('normalizes Omie dates to ISO for comparison', async () => {
    const { run } = setup();
    const r = await run(
      "SELECT data_vencimento FROM contas_receber WHERE data_vencimento >= '2026-06-01' AND data_vencimento < '2026-07-01' LIMIT 1000",
    );
    expect(r.rowCount).toBeGreaterThan(0);
    for (const [d] of r.rows) expect(String(d)).toMatch(/^2026-06-\d{2}$/);
  });

  it('groups, aggregates, filters with HAVING and orders by alias', async () => {
    const { run } = setup();
    const r = await run(
      'SELECT estado, COUNT(*) AS n, AVG(valor_limite_credito) media, MAX(razao_social) FROM clientes GROUP BY estado HAVING COUNT(*) >= 10 ORDER BY n DESC, estado',
    );
    const ns = col(r, 'n') as number[];
    expect(ns.every((n) => n >= 10)).toBe(true);
    expect([...ns].sort((a, b) => b - a)).toEqual(ns);
    expect(r.columns.map((c) => c.name)).toEqual(['estado', 'n', 'media', 'MAX(razao_social)']);
  });

  it('returns one row for aggregates over an empty set', async () => {
    const { run } = setup();
    const r = await run(
      "SELECT COUNT(*), SUM(valor_limite_credito) FROM clientes WHERE estado = 'XX'",
    );
    expect(r.rows).toEqual([[0, null]]);
  });

  it('rejects non-grouped columns and aggregates in WHERE', async () => {
    const { run } = setup();
    expect(
      (await errorOf(run('SELECT estado, razao_social, COUNT(*) FROM clientes GROUP BY estado')))
        .code,
    ).toBe('SQL_UNSUPPORTED');
    expect((await errorOf(run('SELECT * FROM clientes WHERE COUNT(*) > 1'))).code).toBe(
      'SQL_UNSUPPORTED',
    );
    expect((await errorOf(run('SELECT *, COUNT(*) FROM clientes'))).code).toBe('SQL_UNSUPPORTED');
  });

  it('applies DISTINCT, ORDER BY with pt-BR collation, OFFSET and LIMIT', async () => {
    const { run } = setup();
    const all = await run('SELECT DISTINCT estado FROM clientes ORDER BY estado');
    const states = col(all, 'estado') as string[];
    expect(new Set(states).size).toBe(states.length);
    expect([...states].sort((a, b) => a.localeCompare(b, 'pt-BR'))).toEqual(states);
    const page = await run('SELECT DISTINCT estado FROM clientes ORDER BY estado LIMIT 2 OFFSET 1');
    expect(col(page, 'estado')).toEqual(states.slice(1, 3));
  });

  it('evaluates arithmetic without floating-point noise', async () => {
    const { run } = setup();
    const r = await run('SELECT 0.1 + 0.2 AS x, 10 / 4 AS y, 1 / 0 AS z');
    expect(r.rows).toEqual([[0.3, 2.5, null]]);
  });

  it('escapes HTML-like content only as data (no interpretation)', async () => {
    const { run } = setup();
    const r = await run(
      "SELECT descr_detalhada FROM produtos WHERE descr_detalhada LIKE '%<script>%' LIMIT 5",
    );
    expect(r.rowCount).toBeGreaterThan(0);
    expect(String(r.rows[0]?.[0])).toContain('<script>');
  });
});

describe('SqlEngine · joins', () => {
  it('hash-joins orders with customers using deduplicated key lookups (no N+1)', async () => {
    const { run } = setup();
    const r = await run(
      "SELECT p.numero_pedido, c.razao_social FROM pedidos_venda p INNER JOIN clientes c ON c.codigo_cliente_omie = p.codigo_cliente WHERE p.etapa = '20' LIMIT 1000",
    );
    expect(r.rowCount).toBeGreaterThan(0);
    expect(r.rows.every((row) => row[1] !== null)).toBe(true);
    expect(r.apiCalls).toBeLessThan(10);
  });

  it('keeps unmatched rows in LEFT JOIN', async () => {
    const { run } = setup();
    const r = await run(
      'SELECT i.codigo_item, t.valor_tabela FROM pedido_venda_itens i LEFT JOIN tabela_preco_itens t ON t.codigo_produto = i.codigo_produto AND t.codigo_tabela = 11000001 WHERE i.codigo_pedido = 7000001',
    );
    const direct = await run(
      'SELECT codigo_item FROM pedido_venda_itens WHERE codigo_pedido = 7000001',
    );
    expect(r.rowCount).toBe(direct.rowCount);
  });

  it('rejects joins that are not declared relationships', async () => {
    const { run } = setup();
    const e = await errorOf(
      run('SELECT * FROM clientes c JOIN produtos p ON p.codigo_produto = c.codigo_cliente_omie'),
    );
    expect(e.code).toBe('SQL_UNSUPPORTED');
  });

  it('fails with JOIN_CARDINALITY_LIMIT instead of silently truncating', async () => {
    const { run } = setup({ maxApiCalls: 6, lookupMaxKeys: 2 });
    const e = await errorOf(
      run(
        'SELECT r.codigo_lancamento_omie, p.numero_pedido FROM contas_receber r JOIN pedidos_venda p ON p.codigo_pedido = r.codigo_pedido LIMIT 1000',
      ),
    );
    expect(['JOIN_CARDINALITY_LIMIT', 'API_CALL_LIMIT_EXCEEDED']).toContain(e.code);
  });
});

describe('SqlEngine · limits', () => {
  it('applies the implicit row limit and flags truncation', async () => {
    const { run } = setup({ maxRows: 50 });
    const r = await run('SELECT codigo_cliente_omie FROM clientes');
    expect(r.rowCount).toBe(50);
    expect(r.truncated).toBe(true);
    expect(r.messages.join(' ')).toContain('truncated');
  });

  it('rejects a LIMIT above OMIE_MAX_ROWS', async () => {
    const { run } = setup({ maxRows: 50 });
    expect((await errorOf(run('SELECT * FROM clientes LIMIT 51'))).code).toBe(
      'QUERY_ROW_LIMIT_EXCEEDED',
    );
  });

  it('fails when the API call budget is exhausted', async () => {
    const { run } = setup({ maxApiCalls: 2 });
    expect((await errorOf(run('SELECT estado, COUNT(*) FROM clientes GROUP BY estado'))).code).toBe(
      'API_CALL_LIMIT_EXCEEDED',
    );
  });

  it('fails when too many rows would be materialized', async () => {
    const { run } = setup({ maxMaterializedRows: 100 });
    expect((await errorOf(run('SELECT estado, COUNT(*) FROM clientes GROUP BY estado'))).code).toBe(
      'QUERY_LIMIT_EXCEEDED',
    );
  });

  it('times out slow statements with QUERY_TIMEOUT', async () => {
    const slow = (inner: OmieTransport): OmieTransport => ({
      ...inner,
      mode: inner.mode,
      describeEnvelope: (r) => inner.describeEnvelope(r),
      send: (req, signal) =>
        new Promise<TransportResponse>((resolve, reject) => {
          const t = setTimeout(() => void inner.send(req, signal).then(resolve, reject), 200);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(signal.reason);
          });
        }),
    });
    const { run } = setup({ queryTimeoutMs: 50 }, slow);
    expect((await errorOf(run('SELECT * FROM clientes LIMIT 1'))).code).toBe('QUERY_TIMEOUT');
  });

  it('can be cancelled by the caller', async () => {
    const { engine } = setup();
    const ac = new AbortController();
    ac.abort();
    const e = await errorOf(
      engine.query(engine.parse('SELECT * FROM clientes LIMIT 1'), { signal: ac.signal }),
    );
    expect(e.code).toBe('QUERY_CANCELLED');
  });

  it('reports traces to the observer even when the statement fails', async () => {
    const { engine } = setup({ maxApiCalls: 1 });
    const seen: string[] = [];
    await errorOf(
      engine.query(engine.parse('SELECT estado, COUNT(*) FROM clientes GROUP BY estado'), {
        onTrace: (t) => seen.push(t.call),
      }),
    );
    expect(seen).toEqual(['ListarClientes']);
  });
});

describe('SqlEngine · writes', () => {
  it('enforces flags before anything else', async () => {
    const { prepare } = setup();
    const sql = "UPDATE clientes SET cidade = 'X' WHERE codigo_cliente_omie = 1000001";
    expect((await errorOf(prepare(sql, { ...OPEN, readOnly: true }))).code).toBe('READ_ONLY_MODE');
    expect((await errorOf(prepare(sql, { ...OPEN, allowUpdate: false }))).code).toBe(
      'UPDATE_DISABLED',
    );
    expect(
      (
        await errorOf(
          prepare('DELETE FROM clientes WHERE codigo_cliente_omie = 1', {
            ...OPEN,
            allowDelete: false,
          }),
        )
      ).code,
    ).toBe('DELETE_DISABLED');
    expect(
      (
        await errorOf(
          prepare("INSERT INTO vendedores (nome) VALUES ('A')", { ...OPEN, allowInsert: false }),
        )
      ).code,
    ).toBe('INSERT_DISABLED');
  });

  it('requires WHERE on UPDATE and DELETE, including constant-only WHERE', async () => {
    const { prepare } = setup();
    expect((await errorOf(prepare("UPDATE clientes SET cidade = 'X'"))).code).toBe(
      'WHERE_REQUIRED',
    );
    expect((await errorOf(prepare('DELETE FROM clientes'))).code).toBe('WHERE_REQUIRED');
    expect((await errorOf(prepare("UPDATE clientes SET cidade = 'X' WHERE 1 = 1"))).code).toBe(
      'WHERE_REQUIRED',
    );
  });

  it('rejects unsupported operations and non-writable columns', async () => {
    const { prepare } = setup();
    const del = await errorOf(prepare('DELETE FROM nfes WHERE id_nf = 12000001'));
    expect(del).toEqual({
      code: 'OPERATION_NOT_SUPPORTED',
      message: 'The Omie API does not expose deletion for this resource.',
    });
    expect(
      (await errorOf(prepare('UPDATE estoque SET saldo = 1 WHERE codigo_produto = 1'))).code,
    ).toBe('OPERATION_NOT_SUPPORTED');
    expect(
      (
        await errorOf(
          prepare('UPDATE clientes SET codigo_cliente_omie = 1 WHERE codigo_cliente_omie = 2'),
        )
      ).code,
    ).toBe('COLUMN_NOT_WRITABLE');
    expect(
      (
        await errorOf(
          prepare(
            "UPDATE pedidos_venda SET etapa = '20', obs_venda = 'x' WHERE codigo_pedido = 7000001",
          ),
        )
      ).code,
    ).toBe('SQL_UNSUPPORTED');
    expect(
      (await errorOf(prepare("INSERT INTO vendedores (email) VALUES ('a@example.com')"))).code,
    ).toBe('REQUIRED_COLUMN_MISSING');
    expect(
      (
        await errorOf(
          prepare('UPDATE clientes SET cidade = NULL WHERE codigo_cliente_omie = 1000001'),
        )
      ).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      (
        await errorOf(
          prepare('UPDATE clientes SET cidade = razao_social WHERE codigo_cliente_omie = 1000001'),
        )
      ).code,
    ).toBe('SQL_UNSUPPORTED');
  });

  it('enforces OMIE_MAX_WRITE_ROWS', async () => {
    const { prepare } = setup({ maxWriteRows: 3 });
    const e = await errorOf(prepare("UPDATE clientes SET cidade = 'X' WHERE estado = 'SP'"));
    expect(e.code).toBe('WRITE_ROW_LIMIT_EXCEEDED');
  });

  it('reports when nothing matches', async () => {
    const { prepare } = setup();
    expect(
      (await errorOf(prepare("UPDATE clientes SET cidade = 'X' WHERE codigo_cliente_omie = 5")))
        .code,
    ).toBe('WRITE_NO_TARGETS');
  });

  it('previews before/after and executes an UPDATE in the mock', async () => {
    const { prepare, engine, run } = setup();
    const prep = await prepare(
      "UPDATE clientes SET cidade = 'Campinas' WHERE codigo_cliente_omie IN (1000001, 1000002)",
    );
    expect(prep.plan.targets).toHaveLength(2);
    expect(prep.plan.targets[0]?.before?.cidade).not.toBe('Campinas');
    expect(prep.plan.targets[0]?.after.cidade).toBe('Campinas');
    const again = await prepare(
      "UPDATE clientes SET cidade = 'Campinas' WHERE codigo_cliente_omie IN (1000002, 1000001)",
    );
    expect(again.plan.targetsHash).toBe(prep.plan.targetsHash);
    const run1 = await engine.executeWrite(prep.plan);
    expect(run1.execution.status).toBe('success');
    const after = await run(
      'SELECT cidade FROM clientes WHERE codigo_cliente_omie IN (1000001, 1000002)',
    );
    expect(col(after, 'cidade')).toEqual(['Campinas', 'Campinas']);
    const changed = await prepare(
      "UPDATE clientes SET cidade = 'Campinas' WHERE codigo_cliente_omie IN (1000001, 1000002)",
    );
    expect(changed.plan.targetsHash).not.toBe(prep.plan.targetsHash);
  });

  it('routes order updates to the right Omie call and stops at the first failure', async () => {
    const { prepare, engine, mock } = setup();
    const etapa = await prepare(
      "UPDATE pedidos_venda SET etapa = '30' WHERE codigo_pedido = 7000001",
    );
    expect(etapa.plan.call).toBe('TrocarEtapaPedido');
    const faturado = mock.dataset.pedidos.find(
      (p) => (p.infoCadastro as { faturado: string }).faturado === 'S',
    );
    const aberto = mock.dataset.pedidos.find(
      (p) => (p.infoCadastro as { faturado: string }).faturado === 'N',
    );
    const ids = [faturado, aberto].map(
      (p) => (p?.cabecalho as { codigo_pedido: number }).codigo_pedido,
    );
    const prep = await prepare(
      `UPDATE pedidos_venda SET obs_venda = 'Revisado' WHERE codigo_pedido IN (${ids.join(', ')}) ORDER BY 1`.replace(
        ' ORDER BY 1',
        '',
      ),
    );
    expect(prep.plan.call).toBe('AlterarPedidoVenda');
    const sorted = [...prep.plan.targets].sort((a, b) =>
      a.key.codigo_pedido === ids[0] ? -1 : b.key.codigo_pedido === ids[0] ? 1 : 0,
    );
    const result = await engine.executeWrite({ ...prep.plan, targets: sorted });
    expect(result.execution.status).toBe('failed');
    expect(result.execution.attempted).toBe(1);
    expect(result.execution.notAttempted).toHaveLength(1);
    expect(result.apiCalls).toBe(1);
  });

  it('never retries a failed write', async () => {
    let writes = 0;
    const failing = (inner: OmieTransport): OmieTransport => ({
      mode: inner.mode,
      describeEnvelope: (r) => inner.describeEnvelope(r),
      send: async (req, signal) => {
        if (req.kind === 'write') {
          writes += 1;
          return { httpStatus: 503, body: { faultstring: 'Service unavailable' } };
        }
        return inner.send(req, signal);
      },
    });
    const mock = createMockTransport({ seed: 7, anchor: ANCHOR });
    const client = new OmieClient({
      transport: failing(mock),
      concurrency: 2,
      timeoutMs: 2000,
      retry: { maxRetries: 3, baseDelayMs: 1 },
    });
    const engine = new SqlEngine({ client });
    const prep = await engine.prepareWrite(
      engine.parse(
        "UPDATE clientes SET cidade = 'X' WHERE codigo_cliente_omie = 1000001",
      ) as WriteStatement,
      OPEN,
    );
    const r = await engine.executeWrite(prep.plan);
    expect(r.execution.status).toBe('failed');
    expect(writes).toBe(1);
  });

  it('inserts a record and returns the generated key', async () => {
    const { prepare, engine, run } = setup();
    const prep = await prepare(
      "INSERT INTO vendedores (nome, email, comissao) VALUES ('Vendedora Teste', 'vt@example.com', 2.5)",
    );
    expect(prep.apiCalls).toBe(0);
    const r = await engine.executeWrite(prep.plan);
    const generated = r.execution.results[0]?.generated?.codigo;
    expect(typeof generated).toBe('number');
    const back = await run(`SELECT nome FROM vendedores WHERE codigo = ${generated}`);
    expect(back.rows).toEqual([['Vendedora Teste']]);
  });

  it('validates value types and dates', async () => {
    const { prepare } = setup();
    expect(
      (
        await errorOf(
          prepare(
            "UPDATE clientes SET valor_limite_credito = 'abc' WHERE codigo_cliente_omie = 1000001",
          ),
        )
      ).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      (
        await errorOf(
          prepare(
            "UPDATE contas_receber SET data_vencimento = '2026-02-30' WHERE codigo_lancamento_omie = 9000001",
          ),
        )
      ).code,
    ).toBe('VALIDATION_ERROR');
    const ok = await prepare(
      "UPDATE contas_receber SET data_vencimento = '2026-12-01' WHERE codigo_lancamento_omie = 9000001",
    );
    expect(ok.plan.targets[0]?.param.data_vencimento).toBe('01/12/2026');
  });

  it('explains writes without calling Omie', async () => {
    const { run } = setup();
    const r = await run("EXPLAIN UPDATE clientes SET cidade = 'X' WHERE estado = 'SP'");
    expect(r.apiCalls).toBe(0);
    expect(r.rows.find((x) => x[0] === 'Omie call')?.[1]).toContain('AlterarCliente');
    expect((await errorOf(run('EXPLAIN DELETE FROM nfes WHERE id_nf = 1'))).code).toBe(
      'OPERATION_NOT_SUPPORTED',
    );
  });

  it('refuses to run writes through query()', async () => {
    const { run } = setup();
    expect(
      (await errorOf(run("UPDATE clientes SET cidade = 'X' WHERE codigo_cliente_omie = 1000001")))
        .code,
    ).toBe('CONFIRMATION_REQUIRED');
  });
});
