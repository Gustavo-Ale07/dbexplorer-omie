import { describe, expect, it } from 'vitest';
import { OmieClient } from '../client';
import type { OmieRequest } from '../types';
import { createMockTransport } from './mock-transport';

const anchor = new Date(Date.UTC(2026, 0, 15));
const make = () => {
  const transport = createMockTransport({ seed: 7, anchor });
  const client = new OmieClient({ transport, concurrency: 4, timeoutMs: 1000 });
  return { transport, client };
};
const r = (endpoint: string, call: string, param: Record<string, unknown>): OmieRequest => ({
  endpoint,
  call,
  param,
  kind: 'read',
});
const w = (endpoint: string, call: string, param: Record<string, unknown>): OmieRequest => ({
  endpoint,
  call,
  param,
  kind: 'write',
});

describe('mock transport', () => {
  it('is deterministic for the same seed', () => {
    const a = createMockTransport({ seed: 1, anchor }).dataset;
    const b = createMockTransport({ seed: 1, anchor }).dataset;
    expect(a.clientes.slice(0, 5)).toEqual(b.clientes.slice(0, 5));
  });

  it('paginates with total_de_registros', async () => {
    const { client, transport } = make();
    const total = transport.dataset.clientes.length;
    const { body } = await client.call(
      r('geral/clientes', 'ListarClientes', { pagina: 2, registros_por_pagina: 50 }),
    );
    expect(body).toMatchObject({
      pagina: 2,
      registros: 50,
      total_de_registros: total,
      total_de_paginas: Math.ceil(total / 50),
    });
    expect((body.clientes_cadastro as unknown[]).length).toBe(50);
  });

  it('answers a past-the-end page with the "no records" fault', async () => {
    const { client } = make();
    const res = await client.call(
      r('geral/clientes', 'ListarClientes', { pagina: 999, registros_por_pagina: 50 }),
    );
    expect(res.noRecords).toBe(true);
  });

  it('enforces the page size limit', async () => {
    const { client } = make();
    await expect(
      client.call(
        r('financas/contapagar', 'ListarContasPagar', { pagina: 1, registros_por_pagina: 100 }),
      ),
    ).rejects.toMatchObject({ code: 'OMIE_API_ERROR' });
  });

  it('uses n-style pagination for stock positions', async () => {
    const { client } = make();
    const { body } = await client.call(
      r('estoque/consulta', 'ListarPosEstoque', {
        nPagina: 1,
        nRegPorPagina: 10,
        dDataPosicao: '15/01/2026',
        cExibeTodos: 'S',
      }),
    );
    expect(body).toMatchObject({ nPagina: 1, nRegistros: 10 });
    expect(body.nTotRegistros).toBeGreaterThan(10);
  });

  it('filters products by description pattern', async () => {
    const { client } = make();
    const { body } = await client.call(
      r('geral/produtos', 'ListarProdutos', {
        pagina: 1,
        registros_por_pagina: 500,
        filtrar_apenas_descricao: 'Parafuso%',
      }),
    );
    const rows = body.produto_servico_cadastro as Array<{ descricao: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((p) => p.descricao.startsWith('Parafuso'))).toBe(true);
  });

  it('returns copies, never internal references', async () => {
    const { client, transport } = make();
    const { body } = await client.call(
      r('geral/clientes', 'ListarClientes', { pagina: 1, registros_por_pagina: 1 }),
    );
    (body.clientes_cadastro as Array<Record<string, unknown>>)[0]!.razao_social = 'HACKED';
    expect(transport.dataset.clientes[0]!.razao_social).not.toBe('HACKED');
  });

  it('applies writes to the in-memory dataset only', async () => {
    const { client, transport } = make();
    const target = transport.dataset.clientes[3]!;
    const res = await client.call(
      w('geral/clientes', 'AlterarCliente', {
        codigo_cliente_omie: target.codigo_cliente_omie,
        cidade: 'CIDADE TESTE',
      }),
    );
    expect(res.body).toMatchObject({ codigo_status: '0' });
    expect(target.cidade).toBe('CIDADE TESTE');
    expect(createMockTransport({ seed: 7, anchor }).dataset.clientes[3]!.cidade).not.toBe(
      'CIDADE TESTE',
    );
  });

  it('ignores prototype-pollution keys on update', async () => {
    const { client, transport } = make();
    const target = transport.dataset.clientes[0]!;
    const param = JSON.parse(
      '{"codigo_cliente_omie": ' +
        String(target.codigo_cliente_omie) +
        ', "__proto__": {"polluted": true}}',
    ) as Record<string, unknown>;
    await client.call(w('geral/clientes', 'AlterarCliente', param));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
  });

  it('inserts with generated keys and rejects duplicates', async () => {
    const { client } = make();
    const ok = await client.call(
      w('geral/clientes', 'IncluirCliente', {
        codigo_cliente_integracao: 'NEW-1',
        razao_social: 'Empresa Exemplo Ltda',
      }),
    );
    expect(ok.body.codigo_cliente_omie).toEqual(expect.any(Number));
    await expect(
      client.call(
        w('geral/clientes', 'IncluirCliente', {
          codigo_cliente_integracao: 'NEW-1',
          razao_social: 'x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'OMIE_API_ERROR' });
  });

  it('refuses to delete an invoiced order', async () => {
    const { client, transport } = make();
    const faturado = transport.dataset.pedidos.find(
      (p) => (p.infoCadastro as Record<string, unknown>).faturado === 'S',
    )!;
    const codigo = (faturado.cabecalho as Record<string, unknown>).codigo_pedido;
    await expect(
      client.call(w('produtos/pedido', 'ExcluirPedido', { codigo_pedido: codigo })),
    ).rejects.toMatchObject({
      code: 'OMIE_API_ERROR',
    });
  });

  it('reports unknown records and unknown methods as API errors', async () => {
    const { client } = make();
    await expect(
      client.call(r('geral/clientes', 'ConsultarCliente', { codigo_cliente_omie: 1 })),
    ).rejects.toMatchObject({
      code: 'OMIE_API_ERROR',
    });
    await expect(client.call(r('geral/clientes', 'MetodoInexistente', {}))).rejects.toMatchObject({
      code: 'OMIE_API_ERROR',
    });
  });

  it('updates a price table item', async () => {
    const { client, transport } = make();
    const [tabId, itens] = [...transport.dataset.tabelaItens.entries()][0]!;
    const item = itens[0]!;
    await client.call(
      w('produtos/tabelaprecos', 'AlterarPrecoItem', {
        nCodTabPreco: tabId,
        nCodProd: item.nCodProd,
        nValorTabela: 12.34,
      }),
    );
    expect(item.nValorTabela).toBe(12.34);
  });

  it('honours cancellation during artificial latency', async () => {
    const transport = createMockTransport({ seed: 1, anchor, latencyMs: 1000 });
    const ac = new AbortController();
    const p = transport.send(r('geral/clientes', 'ListarClientes', {}), ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'QUERY_CANCELLED' });
  });

  it('never exposes credentials in its envelope', () => {
    const env = createMockTransport().describeEnvelope(r('geral/clientes', 'ListarClientes', {}));
    expect(env).toMatchObject({ app_key: '***REDACTED***', app_secret: '***REDACTED***' });
  });
});
