/**
 * In-memory fake of the Omie JSON protocol. It is intentionally independent of the
 * SQL engine's resource registry so the registry is exercised against a separate
 * implementation of the wire format (pagination keys, array names, faults).
 * Writes mutate this process-local copy only — nothing ever leaves the server.
 */
import { REDACTED } from '@dbx/shared';
import { abortError } from '../limiter';
import type { OmieRequest, OmieTransport, TransportResponse } from '../types';
import { LOCAIS_ESTOQUE, buildDataset } from './fixtures';
import type { MockDataset, OmieRecord } from './fixtures';
import { omieDate, parseOmieDate } from './random';

export interface MockTransportOptions {
  seed?: number;
  anchor?: Date;
  /** Artificial latency per call (ms), to make loading states visible in demos. */
  latencyMs?: number;
}

class MockFault extends Error {
  constructor(
    message: string,
    readonly faultcode = 'SOAP-ENV:Client-1',
    readonly httpStatus = 500,
  ) {
    super(message);
  }
}

type Handler = (param: OmieRecord, ds: MockDataset) => OmieRecord;

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(str(v)));
const present = (v: unknown): boolean =>
  v !== undefined && v !== null && str(v) !== '' && str(v) !== '0';
const clone = <T>(v: T): T => structuredClone(v);

function eqi(a: unknown, b: unknown): boolean {
  return str(a).toLowerCase() === str(b).toLowerCase();
}

function likeToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function paginate(
  rows: OmieRecord[],
  param: OmieRecord,
  arrayKey: string,
  opts: { style: 'std' | 'n'; max: number },
): OmieRecord {
  const page = Math.max(1, num(opts.style === 'std' ? param.pagina : param.nPagina) || 1);
  const sizeRaw =
    num(opts.style === 'std' ? param.registros_por_pagina : param.nRegPorPagina) || 20;
  if (sizeRaw > opts.max) {
    throw new MockFault(
      `ERROR: O número máximo de registros por página é ${opts.max}!`,
      'SOAP-ENV:Client-102',
    );
  }
  const size = Math.max(1, sizeRaw);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const slice = rows.slice((page - 1) * size, page * size);
  if (slice.length === 0) {
    throw new MockFault(
      `ERROR: Não existem registros para a página [${page}]!`,
      'SOAP-ENV:Client-5113',
    );
  }
  if (opts.style === 'std') {
    return {
      pagina: page,
      total_de_paginas: totalPages,
      registros: slice.length,
      total_de_registros: total,
      [arrayKey]: clone(slice),
    };
  }
  return {
    nPagina: page,
    nTotPaginas: totalPages,
    nRegistros: slice.length,
    nTotRegistros: total,
    [arrayKey]: clone(slice),
  };
}

function notFound(what: string, key: unknown): never {
  throw new MockFault(
    `ERROR: ${what} não cadastrado para o código [${str(key)}]!`,
    'SOAP-ENV:Client-101',
  );
}

function requireField(param: OmieRecord, field: string): void {
  if (!present(param[field]) && str(param[field]) === '') {
    throw new MockFault(
      `ERROR: O preenchimento da tag [${field}] é obrigatório!`,
      'SOAP-ENV:Client-100',
    );
  }
}

/** Shallow-merges writable fields; nested objects merge one level deep. */
function mergeInto(target: OmieRecord, patch: OmieRecord, readOnly: readonly string[]): void {
  for (const [k, v] of Object.entries(patch)) {
    if (readOnly.includes(k) || k === '__proto__' || k === 'constructor' || k === 'prototype')
      continue;
    const current = target[k];
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      Object.assign(current as OmieRecord, v);
    } else {
      target[k] = v;
    }
  }
}

function touch(record: OmieRecord, infoKey = 'info'): void {
  const info = record[infoKey];
  if (info && typeof info === 'object') {
    Object.assign(info as OmieRecord, { dAlt: omieDate(new Date()), uAlt: 'MOCK' });
  }
}

function assertNotPast(dateStr: unknown, field: string, anchor: Date): void {
  const d = parseOmieDate(str(dateStr));
  if (!d)
    throw new MockFault(
      `ERROR: Data inválida na tag [${field}]: ${str(dateStr)}`,
      'SOAP-ENV:Client-104',
    );
  if (d.getTime() < anchor.getTime()) {
    throw new MockFault(
      `ERROR: A tag [${field}] deve ser igual ou superior à data corrente!`,
      'SOAP-ENV:Client-105',
    );
  }
}

const handlers: Record<string, Handler> = {
  // ---------------------------------------------------------------- clientes
  'geral/clientes:ListarClientes': (param, ds) => {
    let rows = ds.clientes;
    const filtro = (param.clientesFiltro ?? {}) as OmieRecord;
    for (const [k, v] of Object.entries(filtro)) {
      if (!present(v)) continue;
      rows = rows.filter((r) => eqi(r[k], v));
    }
    const porCodigo = param.clientesPorCodigo as OmieRecord[] | undefined;
    if (Array.isArray(porCodigo) && porCodigo.length > 0) {
      rows = rows.filter((r) =>
        porCodigo.some(
          (c) =>
            (present(c.codigo_cliente_omie) &&
              num(c.codigo_cliente_omie) === r.codigo_cliente_omie) ||
            (present(c.codigo_cliente_integracao) &&
              eqi(c.codigo_cliente_integracao, r.codigo_cliente_integracao)),
        ),
      );
    }
    return paginate(rows, param, 'clientes_cadastro', { style: 'std', max: 500 });
  },
  'geral/clientes:ConsultarCliente': (param, ds) => {
    const row = findCliente(param, ds);
    return clone(row);
  },
  'geral/clientes:IncluirCliente': (param, ds) => {
    requireField(param, 'codigo_cliente_integracao');
    requireField(param, 'razao_social');
    if (
      ds.clientes.some((c) => eqi(c.codigo_cliente_integracao, param.codigo_cliente_integracao))
    ) {
      throw new MockFault(
        `ERROR: Cliente já cadastrado para o Código de Integração [${str(param.codigo_cliente_integracao)}] !`,
        'SOAP-ENV:Client-102',
      );
    }
    const codigo = (ds.sequences.cliente = (ds.sequences.cliente ?? 2000000) + 1);
    const record: OmieRecord = {
      codigo_cliente_omie: codigo,
      nome_fantasia: '',
      cnpj_cpf: '',
      email: '',
      cidade: '',
      estado: '',
      inativo: 'N',
      tags: [],
      ...clone(param),
      info: {
        dInc: omieDate(new Date()),
        hInc: '00:00:00',
        uInc: 'MOCK',
        dAlt: omieDate(new Date()),
        hAlt: '00:00:00',
        uAlt: 'MOCK',
        cImpAPI: 'S',
      },
    };
    record.codigo_cliente_omie = codigo;
    ds.clientes.push(record);
    return {
      codigo_cliente_omie: codigo,
      codigo_cliente_integracao: param.codigo_cliente_integracao,
      codigo_status: '0',
      descricao_status: 'Cliente cadastrado com sucesso!',
    };
  },
  'geral/clientes:AlterarCliente': (param, ds) => {
    const row = findCliente(param, ds);
    mergeInto(row, param, ['codigo_cliente_omie', 'info']);
    touch(row);
    return {
      codigo_cliente_omie: row.codigo_cliente_omie,
      codigo_cliente_integracao: row.codigo_cliente_integracao,
      codigo_status: '0',
      descricao_status: 'Cliente alterado com sucesso!',
    };
  },
  'geral/clientes:ExcluirCliente': (param, ds) => {
    const row = findCliente(param, ds);
    if (row.bloquear_exclusao === 'S')
      throw new MockFault('ERROR: Exclusão bloqueada para este cadastro!', 'SOAP-ENV:Client-110');
    if (
      ds.pedidos.some((p) => (p.cabecalho as OmieRecord).codigo_cliente === row.codigo_cliente_omie)
    ) {
      throw new MockFault(
        'ERROR: Não é possível excluir um cliente que possui movimentações!',
        'SOAP-ENV:Client-111',
      );
    }
    ds.clientes.splice(ds.clientes.indexOf(row), 1);
    return {
      codigo_cliente_omie: row.codigo_cliente_omie,
      codigo_cliente_integracao: row.codigo_cliente_integracao,
      codigo_status: '0',
      descricao_status: 'Cliente excluído com sucesso!',
    };
  },

  // ---------------------------------------------------------------- produtos
  'geral/produtos:ListarProdutos': (param, ds) => {
    let rows = ds.produtos;
    const porCodigo = param.produtosPorCodigo as OmieRecord[] | undefined;
    if (Array.isArray(porCodigo) && porCodigo.length > 0) {
      rows = rows.filter((r) =>
        porCodigo.some(
          (c) =>
            (present(c.codigo_produto) && num(c.codigo_produto) === r.codigo_produto) ||
            (present(c.codigo_produto_integracao) &&
              eqi(c.codigo_produto_integracao, r.codigo_produto_integracao)) ||
            (present(c.codigo) && eqi(c.codigo, r.codigo)),
        ),
      );
    }
    if (present(param.filtrar_apenas_descricao)) {
      const re = likeToRegex(str(param.filtrar_apenas_descricao));
      rows = rows.filter((r) => re.test(str(r.descricao)));
    }
    for (const k of ['ncm', 'ean', 'inativo'] as const) {
      if (present(param[k])) rows = rows.filter((r) => eqi(r[k], param[k]));
    }
    return paginate(rows, param, 'produto_servico_cadastro', { style: 'std', max: 500 });
  },
  'geral/produtos:ConsultarProduto': (param, ds) => clone(findProduto(param, ds)),
  'geral/produtos:IncluirProduto': (param, ds) => {
    requireField(param, 'codigo_produto_integracao');
    requireField(param, 'descricao');
    requireField(param, 'unidade');
    if (
      ds.produtos.some((c) => eqi(c.codigo_produto_integracao, param.codigo_produto_integracao))
    ) {
      throw new MockFault(
        `ERROR: Produto já cadastrado para o Código de Integração [${str(param.codigo_produto_integracao)}] !`,
        'SOAP-ENV:Client-102',
      );
    }
    const codigo = (ds.sequences.produto = (ds.sequences.produto ?? 3900000) + 1);
    const record: OmieRecord = {
      codigo: '',
      ncm: '',
      ean: '',
      valor_unitario: 0,
      inativo: 'N',
      bloqueado: 'N',
      ...clone(param),
      codigo_produto: codigo,
      info: { dInc: omieDate(new Date()), uInc: 'MOCK', cImpAPI: 'S' },
    };
    ds.produtos.push(record);
    return {
      codigo_produto: codigo,
      codigo_produto_integracao: param.codigo_produto_integracao,
      codigo_status: '0',
      descricao_status: 'Produto cadastrado com sucesso!',
    };
  },
  'geral/produtos:AlterarProduto': (param, ds) => {
    const row = findProduto(param, ds);
    mergeInto(row, param, [
      'codigo_produto',
      'inativo',
      'importado_api',
      'descricao_familia',
      'info',
    ]);
    touch(row);
    return {
      codigo_produto: row.codigo_produto,
      codigo_produto_integracao: row.codigo_produto_integracao,
      codigo_status: '0',
      descricao_status: 'Produto alterado com sucesso!',
    };
  },
  'geral/produtos:ExcluirProduto': (param, ds) => {
    const row = findProduto(param, ds);
    if (row.bloquear_exclusao === 'S')
      throw new MockFault('ERROR: Exclusão bloqueada para este produto!', 'SOAP-ENV:Client-110');
    if (
      ds.pedidos.some((p) =>
        (p.det as OmieRecord[]).some(
          (d) => (d.produto as OmieRecord).codigo_produto === row.codigo_produto,
        ),
      )
    ) {
      throw new MockFault(
        'ERROR: Não é possível excluir um produto que possui movimentações!',
        'SOAP-ENV:Client-111',
      );
    }
    ds.produtos.splice(ds.produtos.indexOf(row), 1);
    return {
      codigo_produto: row.codigo_produto,
      codigo_produto_integracao: row.codigo_produto_integracao,
      codigo_status: '0',
      descricao_status: 'Produto excluído com sucesso!',
    };
  },

  // ---------------------------------------------------------------- estoque
  'estoque/consulta:ListarPosEstoque': (param, ds) => {
    let rows = ds.estoque;
    if (present(param.codigo_local_estoque))
      rows = rows.filter((r) => r.codigo_local_estoque === num(param.codigo_local_estoque));
    const lista = param.lista_produtos as OmieRecord[] | undefined;
    if (Array.isArray(lista) && lista.length > 0) {
      rows = rows.filter((r) =>
        lista.some(
          (l) =>
            (present(l.nCodProd) && num(l.nCodProd) === r.nCodProd) ||
            (present(l.cCodInt) && eqi(l.cCodInt, r.cCodInt)),
        ),
      );
    }
    const out = paginate(rows, param, 'produtos', { style: 'n', max: 500 });
    out.dDataPosicao = str(param.dDataPosicao) || omieDate(ds.anchor);
    return out;
  },

  // ---------------------------------------------------------------- vendedores
  'geral/vendedores:ListarVendedores': (param, ds) => {
    let rows = ds.vendedores;
    if (present(param.filtrar_por_nome))
      rows = rows.filter((r) =>
        str(r.nome).toLowerCase().includes(str(param.filtrar_por_nome).toLowerCase()),
      );
    if (present(param.filtrar_por_email))
      rows = rows.filter((r) => eqi(r.email, param.filtrar_por_email));
    return paginate(rows, param, 'cadastro', { style: 'std', max: 500 });
  },
  'geral/vendedores:ConsultarVendedor': (param, ds) => clone(findVendedor(param, ds)),
  'geral/vendedores:IncluirVendedor': (param, ds) => {
    requireField(param, 'nome');
    if (present(param.codInt) && ds.vendedores.some((v) => eqi(v.codInt, param.codInt))) {
      throw new MockFault(
        `ERROR: Vendedor já cadastrado para o código de integração [${str(param.codInt)}]!`,
        'SOAP-ENV:Client-102',
      );
    }
    const codigo = (ds.sequences.vendedor = (ds.sequences.vendedor ?? 5900000) + 1);
    ds.vendedores.push({
      codInt: '',
      email: '',
      inativo: 'N',
      fatura_pedido: 'N',
      visualiza_pedido: 'N',
      comissao: 0,
      ...clone(param),
      codigo,
    });
    return {
      codigo,
      codInt: param.codInt ?? '',
      status: '0',
      descricao: 'Vendedor cadastrado com sucesso!',
    };
  },
  'geral/vendedores:AlterarVendedor': (param, ds) => {
    const row = findVendedor(param, ds);
    mergeInto(row, param, ['codigo']);
    return {
      codigo: row.codigo,
      codInt: row.codInt,
      status: '0',
      descricao: 'Vendedor alterado com sucesso!',
    };
  },
  'geral/vendedores:ExcluirVendedor': (param, ds) => {
    const row = findVendedor(param, ds);
    ds.vendedores.splice(ds.vendedores.indexOf(row), 1);
    return {
      codigo: row.codigo,
      codInt: row.codInt,
      status: '0',
      descricao: 'Vendedor excluído com sucesso!',
    };
  },

  // ---------------------------------------------------------------- categorias
  'geral/categorias:ListarCategorias': (param, ds) => {
    let rows = ds.categorias;
    if (str(param.filtrar_apenas_ativo) === 'S') rows = rows.filter((r) => r.conta_inativa === 'N');
    if (present(param.descricao))
      rows = rows.filter((r) =>
        str(r.descricao).toLowerCase().includes(str(param.descricao).toLowerCase()),
      );
    return paginate(rows, param, 'categoria_cadastro', { style: 'std', max: 50 });
  },
  'geral/categorias:ConsultarCategoria': (param, ds) => clone(findCategoria(param, ds)),
  'geral/categorias:IncluirCategoria': (param, ds) => {
    requireField(param, 'categoria_superior');
    requireField(param, 'descricao');
    const parent = ds.categorias.find((c) => c.codigo === str(param.categoria_superior));
    if (!parent || parent.totalizadora !== 'S') {
      throw new MockFault(
        'ERROR: A categoria superior deve ser uma categoria totalizadora!',
        'SOAP-ENV:Client-106',
      );
    }
    const siblings = ds.categorias.filter((c) => c.categoria_superior === parent.codigo).length;
    const codigo = `${str(parent.codigo)}.${String(siblings + 1).padStart(2, '0')}`;
    ds.categorias.push({
      codigo,
      descricao: param.descricao,
      descricao_padrao: param.descricao,
      tipo_categoria: parent.tipo_categoria,
      conta_inativa: 'N',
      definida_pelo_usuario: 'S',
      conta_despesa: parent.conta_despesa,
      conta_receita: parent.conta_receita,
      nao_exibir: 'N',
      natureza: str(param.natureza),
      totalizadora: 'N',
      transferencia: 'N',
      codigo_dre: str(param.codigo_dre),
      categoria_superior: parent.codigo,
    });
    return { codigo_status: '0', descricao_status: 'Categoria cadastrada com sucesso!', codigo };
  },
  'geral/categorias:AlterarCategoria': (param, ds) => {
    const row = findCategoria(param, ds);
    for (const k of ['descricao', 'natureza', 'tipo_categoria', 'codigo_dre', 'conta_inativa']) {
      if (param[k] !== undefined) row[k] = param[k];
    }
    return {
      codigo_status: '0',
      descricao_status: 'Categoria alterada com sucesso!',
      codigo: row.codigo,
    };
  },

  // ---------------------------------------------------------------- departamentos
  'geral/departamentos:ListarDepartamentos': (param, ds) =>
    paginate(ds.departamentos, param, 'departamentos', { style: 'std', max: 500 }),
  'geral/departamentos:ConsultarDepartamento': (param, ds) => clone(findDepartamento(param, ds)),
  'geral/departamentos:AlterarDepartamento': (param, ds) => {
    const row = findDepartamento(param, ds);
    if (param.descricao !== undefined) row.descricao = param.descricao;
    if (param.inativo !== undefined) row.inativo = param.inativo;
    return {
      codigo: row.codigo,
      descricao: row.descricao,
      cCodStatus: '0',
      cDesStatus: 'Departamento alterado com sucesso!',
    };
  },
  'geral/departamentos:ExcluirDepartamento': (param, ds) => {
    const row = findDepartamento(param, ds);
    ds.departamentos.splice(ds.departamentos.indexOf(row), 1);
    return {
      codigo: row.codigo,
      descricao: row.descricao,
      cCodStatus: '0',
      cDesStatus: 'Departamento excluído com sucesso!',
    };
  },

  // ---------------------------------------------------------------- pedidos
  'produtos/pedido:ListarPedidos': (param, ds) => {
    let rows = ds.pedidos;
    const cab = (r: OmieRecord) => r.cabecalho as OmieRecord;
    if (present(param.numero_pedido_de))
      rows = rows.filter((r) => num(cab(r).numero_pedido) >= num(param.numero_pedido_de));
    if (present(param.numero_pedido_ate))
      rows = rows.filter((r) => num(cab(r).numero_pedido) <= num(param.numero_pedido_ate));
    if (present(param.filtrar_por_cliente))
      rows = rows.filter((r) => cab(r).codigo_cliente === num(param.filtrar_por_cliente));
    if (present(param.filtrar_por_vendedor))
      rows = rows.filter(
        (r) => (r.informacoes_adicionais as OmieRecord).codVend === num(param.filtrar_por_vendedor),
      );
    if (present(param.etapa)) rows = rows.filter((r) => cab(r).etapa === str(param.etapa));
    const out = paginate(rows, param, 'pedido_venda_produto', { style: 'std', max: 500 });
    if (str(param.apenas_resumo) === 'S') {
      for (const p of out.pedido_venda_produto as OmieRecord[]) delete p.det;
    }
    return out;
  },
  'produtos/pedido:ConsultarPedido': (param, ds) => ({
    pedido_venda_produto: clone(findPedido(param, ds)),
  }),
  'produtos/pedido:AlterarPedidoVenda': (param, ds) => {
    const patchCab = (param.cabecalho ?? {}) as OmieRecord;
    const row = findPedido(patchCab, ds);
    if ((row.infoCadastro as OmieRecord).faturado === 'S') {
      throw new MockFault(
        'ERROR: Pedido já faturado não pode ser alterado!',
        'SOAP-ENV:Client-120',
      );
    }
    const {
      codigo_pedido: _a,
      codigo_pedido_integracao: _b,
      numero_pedido: _c,
      etapa: _d,
      ...rest
    } = patchCab;
    Object.assign(row.cabecalho as OmieRecord, rest);
    for (const group of ['informacoes_adicionais', 'observacoes', 'frete'] as const) {
      if (param[group] && typeof param[group] === 'object') {
        row[group] = { ...((row[group] as OmieRecord) ?? {}), ...(param[group] as OmieRecord) };
      }
    }
    touch(row, 'infoCadastro');
    const cab = row.cabecalho as OmieRecord;
    return {
      codigo_pedido: cab.codigo_pedido,
      codigo_pedido_integracao: cab.codigo_pedido_integracao,
      numero_pedido: cab.numero_pedido,
      codigo_status: '0',
      descricao_status: 'Pedido alterado com sucesso!',
    };
  },
  'produtos/pedido:TrocarEtapaPedido': (param, ds) => {
    requireField(param, 'etapa');
    const row = findPedido(param, ds);
    const cab = row.cabecalho as OmieRecord;
    if ((row.infoCadastro as OmieRecord).faturado === 'S') {
      throw new MockFault(
        'ERROR: Não é possível alterar a etapa de um pedido faturado!',
        'SOAP-ENV:Client-121',
      );
    }
    if (!['10', '20', '30', '40', '50'].includes(str(param.etapa))) {
      throw new MockFault(`ERROR: Etapa [${str(param.etapa)}] inválida!`, 'SOAP-ENV:Client-122');
    }
    cab.etapa = str(param.etapa);
    touch(row, 'infoCadastro');
    return {
      codigo_pedido: cab.codigo_pedido,
      codigo_pedido_integracao: cab.codigo_pedido_integracao,
      numero_pedido: cab.numero_pedido,
      codigo_status: '0',
      descricao_status: 'Etapa alterada com sucesso!',
    };
  },
  'produtos/pedido:ExcluirPedido': (param, ds) => {
    const row = findPedido(param, ds);
    const ic = row.infoCadastro as OmieRecord;
    if (ic.faturado === 'S' || ic.cancelado === 'S' || ic.devolvido === 'S') {
      throw new MockFault(
        'ERROR: Não é possível excluir um Pedido de Venda que já passou pelo faturamento, foi cancelado ou devolvido.',
        'SOAP-ENV:Client-123',
      );
    }
    ds.pedidos.splice(ds.pedidos.indexOf(row), 1);
    const cab = row.cabecalho as OmieRecord;
    return {
      codigo_pedido: cab.codigo_pedido,
      codigo_pedido_integracao: cab.codigo_pedido_integracao,
      numero_pedido: cab.numero_pedido,
      codigo_status: '0',
      descricao_status: 'Pedido excluído com sucesso!',
    };
  },

  // ---------------------------------------------------------------- contas a receber
  'financas/contareceber:ListarContasReceber': (param, ds) => {
    let rows = ds.contasReceber;
    if (present(param.filtrar_cliente))
      rows = rows.filter((r) => r.codigo_cliente_fornecedor === num(param.filtrar_cliente));
    return paginate(rows, param, 'conta_receber_cadastro', { style: 'std', max: 500 });
  },
  'financas/contareceber:ConsultarContaReceber': (param, ds) =>
    clone(findLancamento(ds.contasReceber, param, 'Conta a receber')),
  'financas/contareceber:IncluirContaReceber': (param, ds) =>
    incluirLancamento(ds, ds.contasReceber, param, 'contaReceber', 'Conta a receber', false),
  'financas/contareceber:AlterarContaReceber': (param, ds) =>
    alterarLancamento(ds.contasReceber, param, 'Conta a receber'),
  'financas/contareceber:ExcluirContaReceber': (param, ds) => {
    const key = {
      codigo_lancamento_omie: param.chave_lancamento,
      codigo_lancamento_integracao: param.codigo_lancamento_integracao,
    };
    return excluirLancamento(ds.contasReceber, key, 'Conta a receber');
  },

  // ---------------------------------------------------------------- contas a pagar
  'financas/contapagar:ListarContasPagar': (param, ds) => {
    let rows = ds.contasPagar;
    if (present(param.filtrar_cliente))
      rows = rows.filter((r) => r.codigo_cliente_fornecedor === num(param.filtrar_cliente));
    return paginate(rows, param, 'conta_pagar_cadastro', { style: 'std', max: 50 });
  },
  'financas/contapagar:ConsultarContaPagar': (param, ds) =>
    clone(findLancamento(ds.contasPagar, param, 'Conta a pagar')),
  'financas/contapagar:IncluirContaPagar': (param, ds) =>
    incluirLancamento(ds, ds.contasPagar, param, 'contaPagar', 'Conta a pagar', true),
  'financas/contapagar:AlterarContaPagar': (param, ds) =>
    alterarLancamento(ds.contasPagar, param, 'Conta a pagar'),
  'financas/contapagar:ExcluirContaPagar': (param, ds) =>
    excluirLancamento(ds.contasPagar, param, 'Conta a pagar'),

  // ---------------------------------------------------------------- tabelas de preço
  'produtos/tabelaprecos:ListarTabelasPreco': (param, ds) =>
    paginate(ds.tabelasPreco, param, 'listaTabelasPreco', { style: 'n', max: 50 }),
  'produtos/tabelaprecos:ListarTabelaItens': (param, ds) => {
    const tab = ds.tabelasPreco.find(
      (t) =>
        (present(param.nCodTabPreco) && t.nCodTabPreco === num(param.nCodTabPreco)) ||
        (present(param.cCodIntTabPreco) && eqi(t.cCodIntTabPreco, param.cCodIntTabPreco)),
    );
    if (!tab) notFound('Tabela de preço', param.nCodTabPreco ?? param.cCodIntTabPreco);
    const itens = ds.tabelaItens.get(tab.nCodTabPreco as number) ?? [];
    const page = paginate(itens, param, 'itensTabela', { style: 'n', max: 50 });
    const { itensTabela, ...meta } = page;
    return {
      ...meta,
      listaTabelaPreco: {
        nCodTabPreco: tab.nCodTabPreco,
        cCodIntTabPreco: tab.cCodIntTabPreco,
        cNome: tab.cNome,
        cCodigo: tab.cCodigo,
        itensTabela,
      },
    };
  },
  'produtos/tabelaprecos:AlterarPrecoItem': (param, ds) => {
    requireField(param, 'nCodTabPreco');
    requireField(param, 'nCodProd');
    const itens = ds.tabelaItens.get(num(param.nCodTabPreco));
    if (!itens) notFound('Tabela de preço', param.nCodTabPreco);
    const item = itens.find((i) => i.nCodProd === num(param.nCodProd));
    if (!item) notFound('Item da tabela de preço', param.nCodProd);
    const valor = num(param.nValorTabela);
    if (!Number.isFinite(valor) || valor < 0)
      throw new MockFault(
        'ERROR: Valor inválido para a tag [nValorTabela]!',
        'SOAP-ENV:Client-104',
      );
    item.nValorTabela = valor;
    item.cManual = 'S';
    return { cCodStatus: '0', cDesStatus: 'Preço alterado com sucesso!' };
  },

  // ---------------------------------------------------------------- NF-e
  'produtos/nfconsultar:ListarNF': (param, ds) => {
    let rows = ds.nfes;
    const ide = (r: OmieRecord) => r.ide as OmieRecord;
    if (present(param.nNFInicial))
      rows = rows.filter((r) => num(ide(r).nNF) >= num(param.nNFInicial));
    if (present(param.nNFFinal)) rows = rows.filter((r) => num(ide(r).nNF) <= num(param.nNFFinal));
    if (present(param.nIdCliente))
      rows = rows.filter((r) => (r.nfDestInt as OmieRecord).nCodCli === num(param.nIdCliente));
    if (str(param.tpNF) !== '') rows = rows.filter((r) => ide(r).tpNF === str(param.tpNF));
    return paginate(rows, param, 'nfCadastro', { style: 'std', max: 500 });
  },
  'produtos/nfconsultar:ConsultarNF': (param, ds) => {
    const row = ds.nfes.find((r) => (r.compl as OmieRecord).nIdNF === num(param.nCodNF));
    if (!row) notFound('Nota fiscal', param.nCodNF);
    return clone(row);
  },
};

function findCliente(param: OmieRecord, ds: MockDataset): OmieRecord {
  const row = ds.clientes.find(
    (c) =>
      (present(param.codigo_cliente_omie) &&
        c.codigo_cliente_omie === num(param.codigo_cliente_omie)) ||
      (present(param.codigo_cliente_integracao) &&
        eqi(c.codigo_cliente_integracao, param.codigo_cliente_integracao)),
  );
  return row ?? notFound('Cliente', param.codigo_cliente_omie ?? param.codigo_cliente_integracao);
}

function findProduto(param: OmieRecord, ds: MockDataset): OmieRecord {
  const row = ds.produtos.find(
    (c) =>
      (present(param.codigo_produto) && c.codigo_produto === num(param.codigo_produto)) ||
      (present(param.codigo_produto_integracao) &&
        eqi(c.codigo_produto_integracao, param.codigo_produto_integracao)) ||
      (present(param.codigo) && eqi(c.codigo, param.codigo)),
  );
  return (
    row ??
    notFound('Produto', param.codigo_produto ?? param.codigo_produto_integracao ?? param.codigo)
  );
}

function findVendedor(param: OmieRecord, ds: MockDataset): OmieRecord {
  const row = ds.vendedores.find(
    (v) =>
      (present(param.codigo) && v.codigo === num(param.codigo)) ||
      (present(param.codInt) && eqi(v.codInt, param.codInt)),
  );
  return row ?? notFound('Vendedor', param.codigo ?? param.codInt);
}

function findCategoria(param: OmieRecord, ds: MockDataset): OmieRecord {
  const row = ds.categorias.find((c) => c.codigo === str(param.codigo));
  return row ?? notFound('Categoria', param.codigo);
}

function findDepartamento(param: OmieRecord, ds: MockDataset): OmieRecord {
  const row = ds.departamentos.find((d) => d.codigo === str(param.codigo));
  return row ?? notFound('Departamento', param.codigo);
}

function findPedido(param: OmieRecord, ds: MockDataset): OmieRecord {
  const row = ds.pedidos.find((p) => {
    const cab = p.cabecalho as OmieRecord;
    return (
      (present(param.codigo_pedido) && cab.codigo_pedido === num(param.codigo_pedido)) ||
      (present(param.codigo_pedido_integracao) &&
        eqi(cab.codigo_pedido_integracao, param.codigo_pedido_integracao)) ||
      (present(param.numero_pedido) && eqi(cab.numero_pedido, param.numero_pedido))
    );
  });
  return (
    row ??
    notFound('Pedido', param.codigo_pedido ?? param.codigo_pedido_integracao ?? param.numero_pedido)
  );
}

function findLancamento(rows: OmieRecord[], param: OmieRecord, what: string): OmieRecord {
  const row = rows.find(
    (r) =>
      (present(param.codigo_lancamento_omie) &&
        r.codigo_lancamento_omie === num(param.codigo_lancamento_omie)) ||
      (present(param.codigo_lancamento_integracao) &&
        eqi(r.codigo_lancamento_integracao, param.codigo_lancamento_integracao)),
  );
  return row ?? notFound(what, param.codigo_lancamento_omie ?? param.codigo_lancamento_integracao);
}

function incluirLancamento(
  ds: MockDataset,
  rows: OmieRecord[],
  param: OmieRecord,
  seq: string,
  what: string,
  futureOnly: boolean,
): OmieRecord {
  for (const f of [
    'codigo_lancamento_integracao',
    'codigo_cliente_fornecedor',
    'data_vencimento',
    'valor_documento',
    'codigo_categoria',
  ]) {
    requireField(param, f);
  }
  if (rows.some((r) => eqi(r.codigo_lancamento_integracao, param.codigo_lancamento_integracao))) {
    throw new MockFault(
      `ERROR: ${what} já cadastrada para o código de integração [${str(param.codigo_lancamento_integracao)}]!`,
      'SOAP-ENV:Client-102',
    );
  }
  if (!ds.clientes.some((c) => c.codigo_cliente_omie === num(param.codigo_cliente_fornecedor))) {
    notFound('Cliente/Fornecedor', param.codigo_cliente_fornecedor);
  }
  if (futureOnly) assertNotPast(param.data_vencimento, 'data_vencimento', ds.anchor);
  const codigo = (ds.sequences[seq] = (ds.sequences[seq] ?? 9900000) + 1);
  rows.push({
    data_emissao: omieDate(ds.anchor),
    data_previsao: param.data_vencimento,
    id_conta_corrente: 0,
    numero_documento: '',
    numero_parcela: '001/001',
    status_titulo: 'A VENCER',
    bloqueado: 'N',
    observacao: '',
    ...clone(param),
    codigo_lancamento_omie: codigo,
    info: { dInc: omieDate(new Date()), uInc: 'MOCK', cImpAPI: 'S' },
  });
  return {
    codigo_lancamento_omie: codigo,
    codigo_lancamento_integracao: param.codigo_lancamento_integracao,
    codigo_status: '0',
    descricao_status: `${what} cadastrada com sucesso!`,
  };
}

function alterarLancamento(rows: OmieRecord[], param: OmieRecord, what: string): OmieRecord {
  const row = findLancamento(rows, param, what);
  if (row.status_titulo === 'CANCELADO')
    throw new MockFault(`ERROR: ${what} cancelada não pode ser alterada!`, 'SOAP-ENV:Client-130');
  mergeInto(row, param, ['codigo_lancamento_omie', 'status_titulo', 'info']);
  touch(row);
  return {
    codigo_lancamento_omie: row.codigo_lancamento_omie,
    codigo_lancamento_integracao: row.codigo_lancamento_integracao,
    codigo_status: '0',
    descricao_status: `${what} alterada com sucesso!`,
  };
}

function excluirLancamento(rows: OmieRecord[], param: OmieRecord, what: string): OmieRecord {
  const row = findLancamento(rows, param, what);
  if (row.status_titulo === 'CANCELADO')
    throw new MockFault(`ERROR: ${what} cancelada não pode ser excluída!`, 'SOAP-ENV:Client-130');
  if (row.bloquear_exclusao === 'S')
    throw new MockFault('ERROR: Exclusão bloqueada para este lançamento!', 'SOAP-ENV:Client-110');
  rows.splice(rows.indexOf(row), 1);
  return {
    codigo_lancamento_omie: row.codigo_lancamento_omie,
    codigo_lancamento_integracao: row.codigo_lancamento_integracao,
    codigo_status: '0',
    descricao_status: `${what} excluída com sucesso!`,
  };
}

export interface MockTransport extends OmieTransport {
  /** Exposed for tests only. */
  readonly dataset: MockDataset;
  readonly calls: ReadonlyArray<{ endpoint: string; call: string }>;
}

export function createMockTransport(options: MockTransportOptions = {}): MockTransport {
  const dataset = buildDataset({
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.anchor ? { anchor: options.anchor } : {}),
  });
  const calls: Array<{ endpoint: string; call: string }> = [];
  const latency = options.latencyMs ?? 0;

  return {
    mode: 'mock',
    dataset,
    calls,
    describeEnvelope(req) {
      return { call: req.call, app_key: REDACTED, app_secret: REDACTED, param: [req.param] };
    },
    async send(req: OmieRequest, signal: AbortSignal): Promise<TransportResponse> {
      if (signal.aborted) throw abortError(signal);
      if (latency > 0) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, latency);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(abortError(signal));
            },
            { once: true },
          );
        });
      }
      calls.push({ endpoint: req.endpoint, call: req.call });
      const handler = handlers[`${req.endpoint}:${req.call}`];
      if (!handler) {
        return {
          httpStatus: 500,
          body: {
            faultstring: `ERROR: Método [${req.call}] não implementado no modo demonstração.`,
            faultcode: 'SOAP-ENV:Client-404',
          },
        };
      }
      try {
        // Round-trip through JSON like the wire would, so handlers never share references with callers.
        const param = JSON.parse(JSON.stringify(req.param ?? {})) as OmieRecord;
        const body = handler(param, dataset);
        return { httpStatus: 200, body: JSON.parse(JSON.stringify(body)) as unknown };
      } catch (err) {
        if (err instanceof MockFault) {
          return {
            httpStatus: err.httpStatus,
            body: { faultstring: err.message, faultcode: err.faultcode },
          };
        }
        throw err;
      }
    },
  };
}

export { LOCAIS_ESTOQUE };
