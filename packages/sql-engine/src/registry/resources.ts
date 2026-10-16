/**
 * Resource definitions. Endpoint names, array keys and filter params follow the
 * public Omie developer documentation (https://developer.omie.com.br/service-list/).
 * Items marked UNCONFIRMED could not be verified against a live account and are
 * listed in docs/omie-resources.md.
 */
import { AppError } from '@dbx/shared';
import type { ColumnDef, ColumnType, PushdownDef, ResourceDef } from './types';

type ColOpts = Partial<Omit<ColumnDef, 'name' | 'type' | 'path' | 'description'>>;

function col(
  name: string,
  type: ColumnType,
  path: string,
  description: string,
  opts: ColOpts = {},
): ColumnDef {
  return { name, type, path, description, ...opts };
}

const W: ColOpts = { insertable: true, updatable: true };
const INS_REQ: ColOpts = { insertable: true, required: true };

function todayOmie(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function eq(column: string, param: string): PushdownDef {
  return { column, kind: 'eq', param, apply: (p, [v]) => void (p[param] = v) };
}

/** Filters that live inside a nested filter object, e.g. `clientesFiltro.estado`. */
function nestedEq(column: string, parent: string, key: string): PushdownDef {
  return {
    column,
    kind: 'eq',
    param: `${parent}.${key}`,
    apply: (p, [v]) => {
      const obj = (p[parent] ?? {}) as Record<string, unknown>;
      obj[key] = v;
      p[parent] = obj;
    },
  };
}

/** Filters that accept a list of keys, e.g. `clientesPorCodigo: [{codigo_cliente_omie}]`. */
function listEq(column: string, listParam: string, key: string): PushdownDef {
  return {
    column,
    kind: 'eq',
    param: `${listParam}[].${key}`,
    multi: true,
    apply: (p, values) => {
      const list = (p[listParam] ?? []) as Array<Record<string, unknown>>;
      for (const v of values) list.push({ [key]: v });
      p[listParam] = list;
    },
  };
}

const auditCols = (base = 'info'): ColumnDef[] => [
  col('data_inclusao', 'date', `${base}.dInc`, 'Data de inclusão do registro'),
  col('data_alteracao', 'date', `${base}.dAlt`, 'Data da última alteração'),
];

// ------------------------------------------------------------------ Geral
const clientes: ResourceDef = {
  name: 'clientes',
  group: 'Geral',
  description:
    'Clientes e fornecedores (cadastro único do Omie; use a coluna tags para distinguir).',
  list: {
    endpoint: 'geral/clientes',
    call: 'ListarClientes',
    arrayPath: 'clientes_cadastro',
    paging: 'std',
    pageSize: 100,
    baseParam: () => ({ apenas_importado_api: 'N' }),
  },
  lookup: { call: 'ConsultarCliente', param: (pk) => ({ codigo_cliente_omie: pk }) },
  columns: [
    col('codigo_cliente_omie', 'integer', 'codigo_cliente_omie', 'Código do cliente no Omie', {
      pk: true,
    }),
    col(
      'codigo_cliente_integracao',
      'string',
      'codigo_cliente_integracao',
      'Código de integração (definido pelo integrador)',
      {
        ...INS_REQ,
        maxLength: 60,
      },
    ),
    col('razao_social', 'string', 'razao_social', 'Razão social', {
      ...W,
      required: true,
      maxLength: 60,
    }),
    col('nome_fantasia', 'string', 'nome_fantasia', 'Nome fantasia', { ...W, maxLength: 100 }),
    col('cnpj_cpf', 'string', 'cnpj_cpf', 'CNPJ ou CPF', { ...W, maxLength: 20 }),
    col('email', 'string', 'email', 'E-mail', { ...W, maxLength: 500 }),
    col('contato', 'string', 'contato', 'Nome do contato', { ...W, maxLength: 100 }),
    col('telefone1_ddd', 'string', 'telefone1_ddd', 'DDD do telefone', { ...W, maxLength: 5 }),
    col('telefone1_numero', 'string', 'telefone1_numero', 'Telefone', { ...W, maxLength: 15 }),
    col('endereco', 'string', 'endereco', 'Logradouro', { ...W, maxLength: 60 }),
    col('endereco_numero', 'string', 'endereco_numero', 'Número', { ...W, maxLength: 60 }),
    col('complemento', 'string', 'complemento', 'Complemento', { ...W, maxLength: 60 }),
    col('bairro', 'string', 'bairro', 'Bairro', { ...W, maxLength: 60 }),
    col('cidade', 'string', 'cidade', 'Cidade', { ...W, maxLength: 40 }),
    col('estado', 'string', 'estado', 'UF', { ...W, maxLength: 2 }),
    col('cep', 'string', 'cep', 'CEP', { ...W, maxLength: 10 }),
    col('inscricao_estadual', 'string', 'inscricao_estadual', 'Inscrição estadual', {
      ...W,
      maxLength: 20,
    }),
    col(
      'optante_simples_nacional',
      'flag',
      'optante_simples_nacional',
      'Optante pelo Simples Nacional (S/N)',
      W,
    ),
    col('pessoa_fisica', 'flag', 'pessoa_fisica', 'Pessoa física (S/N)', W),
    col('inativo', 'flag', 'inativo', 'Cadastro inativo (S/N)', W),
    col('bloquear_faturamento', 'flag', 'bloquear_faturamento', 'Bloquear faturamento (S/N)', W),
    col('valor_limite_credito', 'number', 'valor_limite_credito', 'Limite de crédito', W),
    col('observacao', 'string', 'observacao', 'Observações', { ...W, maxLength: 5000 }),
    col('tags', 'string', 'tags', 'Tags (ex.: Cliente, Fornecedor), separadas por vírgula', {
      read: (raw) =>
        Array.isArray(raw.tags)
          ? (raw.tags as Array<{ tag?: unknown }>)
              .map((t) => String(t?.tag ?? ''))
              .filter(Boolean)
              .join(', ')
          : null,
    }),
    col('codigo_vendedor', 'integer', 'recomendacoes.codigo_vendedor', 'Vendedor padrão', {
      references: { table: 'vendedores', column: 'codigo' },
    }),
    ...auditCols(),
  ],
  pushdown: [
    listEq('codigo_cliente_omie', 'clientesPorCodigo', 'codigo_cliente_omie'),
    listEq('codigo_cliente_integracao', 'clientesPorCodigo', 'codigo_cliente_integracao'),
    nestedEq('cnpj_cpf', 'clientesFiltro', 'cnpj_cpf'),
    nestedEq('estado', 'clientesFiltro', 'estado'),
    nestedEq('inativo', 'clientesFiltro', 'inativo'),
  ],
  writes: {
    insert: {
      call: 'IncluirCliente',
      key: [],
      returns: { codigo_cliente_omie: 'codigo_cliente_omie' },
    },
    update: { call: 'AlterarCliente', key: ['codigo_cliente_omie'] },
    delete: { call: 'ExcluirCliente', key: ['codigo_cliente_omie'] },
  },
};

const departamentos: ResourceDef = {
  name: 'departamentos',
  group: 'Geral',
  description: 'Departamentos (centros de custo).',
  list: {
    endpoint: 'geral/departamentos',
    call: 'ListarDepartamentos',
    arrayPath: 'departamentos',
    paging: 'std',
    pageSize: 50,
  },
  lookup: { call: 'ConsultarDepartamento', param: (pk) => ({ codigo: pk }) },
  columns: [
    col('codigo', 'string', 'codigo', 'Código do departamento', { pk: true }),
    col('descricao', 'string', 'descricao', 'Descrição', { updatable: true, maxLength: 40 }),
    col('estrutura', 'string', 'estrutura', 'Estrutura hierárquica'),
    col('inativo', 'flag', 'inativo', 'Inativo (S/N)', { updatable: true }),
    col('nivel_totalizador', 'flag', 'nivel_totalizador', 'Nível totalizador (S/N)'),
  ],
  pushdown: [],
  writes: {
    update: { call: 'AlterarDepartamento', key: ['codigo'] },
    delete: { call: 'ExcluirDepartamento', key: ['codigo'] },
  },
  notes: [
    'INSERT is not mapped: IncluirDepartamento requires the hierarchy position (UNCONFIRMED).',
  ],
};

// ------------------------------------------------------------------ Produtos
const produtos: ResourceDef = {
  name: 'produtos',
  group: 'Produtos',
  description: 'Cadastro de produtos e serviços.',
  list: {
    endpoint: 'geral/produtos',
    call: 'ListarProdutos',
    arrayPath: 'produto_servico_cadastro',
    paging: 'std',
    pageSize: 100,
    baseParam: () => ({ apenas_importado_api: 'N', filtrar_apenas_omiepdv: 'N' }),
  },
  lookup: { call: 'ConsultarProduto', param: (pk) => ({ codigo_produto: pk }) },
  columns: [
    col('codigo_produto', 'integer', 'codigo_produto', 'Código do produto no Omie', { pk: true }),
    col(
      'codigo_produto_integracao',
      'string',
      'codigo_produto_integracao',
      'Código de integração',
      { ...INS_REQ, maxLength: 60 },
    ),
    col('codigo', 'string', 'codigo', 'Código (SKU)', { ...W, maxLength: 60 }),
    col('descricao', 'string', 'descricao', 'Descrição', { ...W, required: true, maxLength: 120 }),
    col('unidade', 'string', 'unidade', 'Unidade de medida', {
      ...W,
      required: true,
      maxLength: 6,
    }),
    col('ncm', 'string', 'ncm', 'NCM', { ...W, maxLength: 10 }),
    col('ean', 'string', 'ean', 'Código de barras (EAN)', { ...W, maxLength: 14 }),
    col('valor_unitario', 'number', 'valor_unitario', 'Preço unitário de venda', W),
    col('codigo_familia', 'integer', 'codigo_familia', 'Código da família'),
    col('descricao_familia', 'string', 'descricao_familia', 'Família do produto'),
    col('tipo_item', 'string', 'tipoItem', 'Tipo do item (SPED)', { ...W, maxLength: 2 }),
    col('marca', 'string', 'marca', 'Marca', { ...W, maxLength: 60 }),
    col('modelo', 'string', 'modelo', 'Modelo', { ...W, maxLength: 60 }),
    col('peso_liq', 'number', 'peso_liq', 'Peso líquido (kg)', W),
    col('peso_bruto', 'number', 'peso_bruto', 'Peso bruto (kg)', W),
    col('descr_detalhada', 'string', 'descr_detalhada', 'Descrição detalhada', {
      ...W,
      maxLength: 5000,
    }),
    col('obs_internas', 'string', 'obs_internas', 'Observações internas', {
      ...W,
      maxLength: 5000,
    }),
    col('dias_garantia', 'integer', 'dias_garantia', 'Dias de garantia', W),
    col('lead_time', 'integer', 'lead_time', 'Lead time (dias)', W),
    col('inativo', 'flag', 'inativo', 'Inativo (S/N)'),
    col('bloqueado', 'flag', 'bloqueado', 'Bloqueado (S/N)', W),
    ...auditCols(),
  ],
  pushdown: [
    listEq('codigo_produto', 'produtosPorCodigo', 'codigo_produto'),
    listEq('codigo_produto_integracao', 'produtosPorCodigo', 'codigo_produto_integracao'),
    listEq('codigo', 'produtosPorCodigo', 'codigo'),
    {
      column: 'descricao',
      kind: 'like',
      param: 'filtrar_apenas_descricao',
      apply: (p, [v]) => void (p.filtrar_apenas_descricao = v),
    },
    eq('ncm', 'ncm'),
    eq('ean', 'ean'),
  ],
  writes: {
    insert: { call: 'IncluirProduto', key: [], returns: { codigo_produto: 'codigo_produto' } },
    update: { call: 'AlterarProduto', key: ['codigo_produto'] },
    delete: { call: 'ExcluirProduto', key: ['codigo_produto'] },
  },
};

const tabelasPreco: ResourceDef = {
  name: 'tabelas_preco',
  group: 'Produtos',
  description: 'Tabelas de preço.',
  list: {
    endpoint: 'produtos/tabelaprecos',
    call: 'ListarTabelasPreco',
    arrayPath: 'listaTabelasPreco',
    paging: 'n',
    pageSize: 50,
  },
  columns: [
    col('codigo_tabela', 'integer', 'nCodTabPreco', 'Código da tabela de preço', { pk: true }),
    col('codigo_integracao', 'string', 'cCodIntTabPreco', 'Código de integração'),
    col('nome', 'string', 'cNome', 'Nome da tabela'),
    col('codigo', 'string', 'cCodigo', 'Código curto'),
    col('ativa', 'flag', 'cAtiva', 'Ativa (S/N)'),
    col('origem', 'string', 'cOrigem', 'Origem dos preços'),
    col('perc_acrescimo', 'number', 'outrasInfo.nPercAcrescimo', 'Percentual de acréscimo'),
    col('perc_desconto', 'number', 'outrasInfo.nPercDesconto', 'Percentual de desconto'),
  ],
  pushdown: [],
  writes: {},
};

const tabelaPrecoItens: ResourceDef = {
  name: 'tabela_preco_itens',
  group: 'Produtos',
  description:
    'Itens (preços) de uma tabela de preço. Exige WHERE codigo_tabela = ... ou IN (...).',
  list: {
    endpoint: 'produtos/tabelaprecos',
    call: 'ListarTabelaItens',
    arrayPath: 'listaTabelaPreco.itensTabela',
    parentPath: 'listaTabelaPreco',
    paging: 'n',
    pageSize: 50,
  },
  requiredFilter: 'codigo_tabela',
  columns: [
    col('codigo_tabela', 'integer', '$parent.nCodTabPreco', 'Tabela de preço', {
      pk: true,
      references: { table: 'tabelas_preco', column: 'codigo_tabela' },
    }),
    col('codigo_produto', 'integer', 'nCodProd', 'Produto', {
      pk: true,
      references: { table: 'produtos', column: 'codigo_produto' },
    }),
    col('codigo_produto_integracao', 'string', 'cCodIntProd', 'Código de integração do produto'),
    col('codigo', 'string', 'cCodigoProduto', 'Código (SKU)'),
    col('descricao', 'string', 'cDescricaoProduto', 'Descrição do produto'),
    col('ncm', 'string', 'cNCM', 'NCM'),
    col('ean', 'string', 'cEAN', 'EAN'),
    col('valor_original', 'number', 'nValorOriginal', 'Preço original'),
    col('valor_calculado', 'number', 'nValorCalculado', 'Preço calculado pela regra da tabela'),
    col('valor_tabela', 'number', 'nValorTabela', 'Preço praticado na tabela', { updatable: true }),
    col('perc_desconto', 'number', 'nPercDesconto', 'Percentual de desconto'),
    col('perc_acrescimo', 'number', 'nPercAcrescimo', 'Percentual de acréscimo'),
    col('manual', 'flag', 'cManual', 'Preço definido manualmente (S/N)'),
  ],
  pushdown: [eq('codigo_tabela', 'nCodTabPreco')],
  writes: {
    update: {
      call: 'AlterarPrecoItem',
      key: ['codigo_tabela', 'codigo_produto'],
      paths: {
        codigo_tabela: 'nCodTabPreco',
        codigo_produto: 'nCodProd',
        valor_tabela: 'nValorTabela',
      },
    },
  },
  notes: ['AlterarPrecoItem payload is UNCONFIRMED against a live account.'],
};

// ------------------------------------------------------------------ Estoque
const estoque: ResourceDef = {
  name: 'estoque',
  group: 'Estoque',
  description: 'Posição de estoque na data atual, por produto e local de estoque. Somente leitura.',
  list: {
    endpoint: 'estoque/consulta',
    call: 'ListarPosEstoque',
    arrayPath: 'produtos',
    paging: 'n',
    pageSize: 50,
    baseParam: () => ({ dDataPosicao: todayOmie(), cExibeTodos: 'S' }),
  },
  columns: [
    col('codigo_produto', 'integer', 'nCodProd', 'Produto', {
      pk: true,
      references: { table: 'produtos', column: 'codigo_produto' },
    }),
    col('codigo_local_estoque', 'integer', 'codigo_local_estoque', 'Local de estoque', {
      pk: true,
    }),
    col('codigo_produto_integracao', 'string', 'cCodInt', 'Código de integração do produto'),
    col('codigo', 'string', 'cCodigo', 'Código (SKU)'),
    col('descricao', 'string', 'cDescricao', 'Descrição do produto'),
    col('preco_unitario', 'number', 'nPrecoUnitario', 'Preço unitário'),
    col('saldo', 'number', 'nSaldo', 'Saldo disponível'),
    col('fisico', 'number', 'fisico', 'Estoque físico'),
    col('reservado', 'number', 'reservado', 'Quantidade reservada'),
    col('pendente', 'number', 'nPendente', 'Quantidade pendente'),
    col('estoque_minimo', 'number', 'estoque_minimo', 'Estoque mínimo'),
    col('cmc', 'number', 'nCMC', 'Custo médio contábil'),
  ],
  pushdown: [eq('codigo_local_estoque', 'codigo_local_estoque')],
  writes: {},
};

// ------------------------------------------------------------------ Vendas
const vendedores: ResourceDef = {
  name: 'vendedores',
  group: 'Vendas',
  description: 'Vendedores.',
  list: {
    endpoint: 'geral/vendedores',
    call: 'ListarVendedores',
    arrayPath: 'cadastro',
    paging: 'std',
    pageSize: 100,
  },
  lookup: { call: 'ConsultarVendedor', param: (pk) => ({ codigo: pk }) },
  columns: [
    col('codigo', 'integer', 'codigo', 'Código do vendedor', { pk: true }),
    col('codigo_integracao', 'string', 'codInt', 'Código de integração', {
      insertable: true,
      maxLength: 20,
    }),
    col('nome', 'string', 'nome', 'Nome', { ...W, required: true, maxLength: 60 }),
    col('email', 'string', 'email', 'E-mail', { ...W, maxLength: 100 }),
    col('inativo', 'flag', 'inativo', 'Inativo (S/N)', W),
    col('fatura_pedido', 'flag', 'fatura_pedido', 'Pode faturar pedidos (S/N)', W),
    col(
      'visualiza_pedido',
      'flag',
      'visualiza_pedido',
      'Visualiza apenas os próprios pedidos (S/N)',
      W,
    ),
    col('comissao', 'number', 'comissao', 'Percentual de comissão', W),
  ],
  pushdown: [eq('email', 'filtrar_por_email')],
  writes: {
    insert: { call: 'IncluirVendedor', key: [], returns: { codigo: 'codigo' } },
    update: { call: 'AlterarVendedor', key: ['codigo'] },
    delete: { call: 'ExcluirVendedor', key: ['codigo'] },
  },
};

const PEDIDO_ALTERAR_COLUMNS = new Set(['data_previsao', 'numero_pedido_cliente', 'obs_venda']);

const pedidosVenda: ResourceDef = {
  name: 'pedidos_venda',
  group: 'Vendas',
  description: 'Pedidos de venda (cabeçalho e totais). Itens em pedido_venda_itens.',
  list: {
    endpoint: 'produtos/pedido',
    call: 'ListarPedidos',
    arrayPath: 'pedido_venda_produto',
    paging: 'std',
    pageSize: 100,
    baseParam: () => ({ apenas_importado_api: 'N', apenas_resumo: 'N' }),
  },
  lookup: {
    call: 'ConsultarPedido',
    param: (pk) => ({ codigo_pedido: pk }),
    unwrap: 'pedido_venda_produto',
  },
  columns: [
    col('codigo_pedido', 'integer', 'cabecalho.codigo_pedido', 'Código do pedido no Omie', {
      pk: true,
    }),
    col(
      'codigo_pedido_integracao',
      'string',
      'cabecalho.codigo_pedido_integracao',
      'Código de integração',
    ),
    col('numero_pedido', 'string', 'cabecalho.numero_pedido', 'Número do pedido'),
    col('codigo_cliente', 'integer', 'cabecalho.codigo_cliente', 'Cliente', {
      references: { table: 'clientes', column: 'codigo_cliente_omie' },
    }),
    col('data_previsao', 'date', 'cabecalho.data_previsao', 'Data de previsão de faturamento', {
      updatable: true,
    }),
    col('etapa', 'string', 'cabecalho.etapa', 'Etapa (10, 20, 30, 40, 50, 60...)', {
      updatable: true,
      maxLength: 2,
    }),
    col('codigo_parcela', 'string', 'cabecalho.codigo_parcela', 'Condição de pagamento'),
    col('quantidade_itens', 'integer', 'cabecalho.quantidade_itens', 'Quantidade de itens'),
    col('valor_mercadorias', 'number', 'total_pedido.valor_mercadorias', 'Valor das mercadorias'),
    col('valor_descontos', 'number', 'total_pedido.valor_descontos', 'Valor dos descontos'),
    col('valor_total_pedido', 'number', 'total_pedido.valor_total_pedido', 'Valor total do pedido'),
    col('valor_icms', 'number', 'total_pedido.valor_icms', 'Valor do ICMS'),
    col(
      'codigo_categoria',
      'string',
      'informacoes_adicionais.codigo_categoria',
      'Categoria financeira',
      {
        references: { table: 'categorias', column: 'codigo' },
      },
    ),
    col(
      'codigo_conta_corrente',
      'integer',
      'informacoes_adicionais.codigo_conta_corrente',
      'Conta corrente',
    ),
    col(
      'numero_pedido_cliente',
      'string',
      'informacoes_adicionais.numero_pedido_cliente',
      'Número do pedido do cliente',
      {
        updatable: true,
        maxLength: 15,
      },
    ),
    col('codigo_vendedor', 'integer', 'informacoes_adicionais.codVend', 'Vendedor', {
      references: { table: 'vendedores', column: 'codigo' },
    }),
    col('valor_frete', 'number', 'frete.valor_frete', 'Valor do frete'),
    col('obs_venda', 'string', 'observacoes.obs_venda', 'Observações da venda', {
      updatable: true,
      maxLength: 5000,
    }),
    col('faturado', 'flag', 'infoCadastro.faturado', 'Faturado (S/N)'),
    col('cancelado', 'flag', 'infoCadastro.cancelado', 'Cancelado (S/N)'),
    col('data_faturamento', 'date', 'infoCadastro.dFat', 'Data de faturamento'),
    ...auditCols('infoCadastro'),
  ],
  pushdown: [
    {
      column: 'numero_pedido',
      kind: 'eq',
      param: 'numero_pedido_de/numero_pedido_ate',
      apply: (p, [v]) => {
        p.numero_pedido_de = v;
        p.numero_pedido_ate = v;
      },
    },
    eq('codigo_cliente', 'filtrar_por_cliente'),
    eq('codigo_vendedor', 'filtrar_por_vendedor'),
    eq('etapa', 'etapa'),
  ],
  writes: {
    update: (columns) => {
      if (columns.includes('etapa')) {
        if (columns.length > 1) {
          throw new AppError(
            'SQL_UNSUPPORTED',
            'Changing etapa uses TrocarEtapaPedido and must be done in its own UPDATE, without other columns.',
          );
        }
        return {
          call: 'TrocarEtapaPedido',
          key: ['codigo_pedido'],
          paths: { codigo_pedido: 'codigo_pedido', etapa: 'etapa' },
        };
      }
      const other = columns.filter((c) => !PEDIDO_ALTERAR_COLUMNS.has(c));
      if (other.length > 0)
        throw new AppError(
          'COLUMN_NOT_WRITABLE',
          `Column ${other.join(', ')} cannot be updated on pedidos_venda.`,
        );
      return { call: 'AlterarPedidoVenda', key: ['codigo_pedido'] };
    },
    delete: { call: 'ExcluirPedido', key: ['codigo_pedido'] },
  },
  notes: [
    'INSERT is not supported: creating an order needs items, taxes and installments in one payload.',
    'AlterarPedidoVenda partial payload is UNCONFIRMED; Omie may require the full order.',
  ],
};

const pedidoVendaItens: ResourceDef = {
  name: 'pedido_venda_itens',
  group: 'Vendas',
  description: 'Itens dos pedidos de venda (uma linha por item). Somente leitura.',
  list: {
    endpoint: 'produtos/pedido',
    call: 'ListarPedidos',
    arrayPath: 'pedido_venda_produto',
    paging: 'std',
    pageSize: 100,
    baseParam: () => ({ apenas_importado_api: 'N', apenas_resumo: 'N' }),
    explode: 'det',
    pageSizePushdown: false,
  },
  lookup: {
    call: 'ConsultarPedido',
    column: 'codigo_pedido',
    param: (pk) => ({ codigo_pedido: pk }),
    unwrap: 'pedido_venda_produto',
  },
  columns: [
    col('codigo_pedido', 'integer', '$parent.cabecalho.codigo_pedido', 'Pedido', {
      pk: true,
      references: { table: 'pedidos_venda', column: 'codigo_pedido' },
    }),
    col('codigo_item', 'integer', 'ide.codigo_item', 'Código do item', { pk: true }),
    col('numero_pedido', 'string', '$parent.cabecalho.numero_pedido', 'Número do pedido'),
    col('codigo_produto', 'integer', 'produto.codigo_produto', 'Produto', {
      references: { table: 'produtos', column: 'codigo_produto' },
    }),
    col('codigo', 'string', 'produto.codigo', 'Código (SKU)'),
    col('descricao', 'string', 'produto.descricao', 'Descrição'),
    col('cfop', 'string', 'produto.cfop', 'CFOP'),
    col('ncm', 'string', 'produto.ncm', 'NCM'),
    col('unidade', 'string', 'produto.unidade', 'Unidade'),
    col('quantidade', 'number', 'produto.quantidade', 'Quantidade'),
    col('valor_unitario', 'number', 'produto.valor_unitario', 'Valor unitário'),
    col('valor_desconto', 'number', 'produto.valor_desconto', 'Desconto'),
    col('valor_total', 'number', 'produto.valor_total', 'Valor total do item'),
    col('obs_item', 'string', 'observacao.obs_item', 'Observação do item'),
  ],
  pushdown: [],
  writes: {},
};

// ------------------------------------------------------------------ Financeiro
const categorias: ResourceDef = {
  name: 'categorias',
  group: 'Financeiro',
  description: 'Plano de categorias financeiras (receitas e despesas).',
  list: {
    endpoint: 'geral/categorias',
    call: 'ListarCategorias',
    arrayPath: 'categoria_cadastro',
    paging: 'std',
    pageSize: 50,
  },
  lookup: { call: 'ConsultarCategoria', param: (pk) => ({ codigo: pk }) },
  columns: [
    col('codigo', 'string', 'codigo', 'Código da categoria (ex.: 1.01.02)', { pk: true }),
    col('descricao', 'string', 'descricao', 'Descrição', { ...W, required: true, maxLength: 50 }),
    col('categoria_superior', 'string', 'categoria_superior', 'Categoria totalizadora superior', {
      ...INS_REQ,
    }),
    col('descricao_padrao', 'string', 'descricao_padrao', 'Descrição padrão'),
    col('tipo_categoria', 'string', 'tipo_categoria', 'Tipo (R = receita, D = despesa)'),
    col('conta_inativa', 'flag', 'conta_inativa', 'Inativa (S/N)', { updatable: true }),
    col('totalizadora', 'flag', 'totalizadora', 'Categoria totalizadora (S/N)'),
    col('conta_receita', 'flag', 'conta_receita', 'Conta de receita (S/N)'),
    col('conta_despesa', 'flag', 'conta_despesa', 'Conta de despesa (S/N)'),
    col('natureza', 'string', 'natureza', 'Natureza', { ...W, maxLength: 100 }),
    col('codigo_dre', 'string', 'codigo_dre', 'Código no DRE', W),
    col('definida_pelo_usuario', 'flag', 'definida_pelo_usuario', 'Definida pelo usuário (S/N)'),
    col('transferencia', 'flag', 'transferencia', 'Categoria de transferência (S/N)'),
  ],
  pushdown: [],
  writes: {
    insert: { call: 'IncluirCategoria', key: [], returns: { codigo: 'codigo' } },
    update: { call: 'AlterarCategoria', key: ['codigo'] },
  },
};

function lancamentoColumns(cliente: string): ColumnDef[] {
  return [
    col(
      'codigo_lancamento_omie',
      'integer',
      'codigo_lancamento_omie',
      'Código do lançamento no Omie',
      { pk: true },
    ),
    col(
      'codigo_lancamento_integracao',
      'string',
      'codigo_lancamento_integracao',
      'Código de integração',
      { ...INS_REQ, maxLength: 60 },
    ),
    col('codigo_cliente_fornecedor', 'integer', 'codigo_cliente_fornecedor', cliente, {
      ...INS_REQ,
      references: { table: 'clientes', column: 'codigo_cliente_omie' },
    }),
    col('data_emissao', 'date', 'data_emissao', 'Data de emissão', { insertable: true }),
    col('data_vencimento', 'date', 'data_vencimento', 'Data de vencimento', {
      ...W,
      required: true,
    }),
    col('data_previsao', 'date', 'data_previsao', 'Data de previsão', W),
    col('valor_documento', 'number', 'valor_documento', 'Valor do documento', {
      ...W,
      required: true,
    }),
    col('codigo_categoria', 'string', 'codigo_categoria', 'Categoria financeira', {
      ...W,
      required: true,
      references: { table: 'categorias', column: 'codigo' },
    }),
    col('id_conta_corrente', 'integer', 'id_conta_corrente', 'Conta corrente', W),
    col('numero_documento', 'string', 'numero_documento', 'Número do documento', {
      ...W,
      maxLength: 20,
    }),
    col('numero_parcela', 'string', 'numero_parcela', 'Parcela (ex.: 001/003)'),
    col('numero_pedido', 'string', 'numero_pedido', 'Número do pedido de origem'),
    col('codigo_pedido', 'integer', 'nCodPedido', 'Pedido de origem', {
      references: { table: 'pedidos_venda', column: 'codigo_pedido' },
    }),
    col(
      'status_titulo',
      'string',
      'status_titulo',
      'Situação (A VENCER, ATRASADO, RECEBIDO/PAGO, CANCELADO...)',
    ),
    col('observacao', 'string', 'observacao', 'Observação', { ...W, maxLength: 500 }),
    ...auditCols(),
  ];
}

const contasReceber: ResourceDef = {
  name: 'contas_receber',
  group: 'Financeiro',
  description: 'Lançamentos de contas a receber.',
  list: {
    endpoint: 'financas/contareceber',
    call: 'ListarContasReceber',
    arrayPath: 'conta_receber_cadastro',
    paging: 'std',
    pageSize: 50,
    baseParam: () => ({ apenas_importado_api: 'N' }),
  },
  lookup: { call: 'ConsultarContaReceber', param: (pk) => ({ codigo_lancamento_omie: pk }) },
  columns: lancamentoColumns('Cliente'),
  pushdown: [eq('codigo_cliente_fornecedor', 'filtrar_cliente')],
  writes: {
    insert: {
      call: 'IncluirContaReceber',
      key: [],
      returns: { codigo_lancamento_omie: 'codigo_lancamento_omie' },
    },
    update: { call: 'AlterarContaReceber', key: ['codigo_lancamento_omie'] },
    delete: {
      call: 'ExcluirContaReceber',
      key: ['codigo_lancamento_omie'],
      paths: { codigo_lancamento_omie: 'chave_lancamento' },
    },
  },
  notes: ['status_titulo is computed by Omie and is filtered locally only.'],
};

const contasPagar: ResourceDef = {
  name: 'contas_pagar',
  group: 'Financeiro',
  description: 'Lançamentos de contas a pagar.',
  list: {
    endpoint: 'financas/contapagar',
    call: 'ListarContasPagar',
    arrayPath: 'conta_pagar_cadastro',
    paging: 'std',
    pageSize: 50,
    baseParam: () => ({ apenas_importado_api: 'N' }),
  },
  lookup: { call: 'ConsultarContaPagar', param: (pk) => ({ codigo_lancamento_omie: pk }) },
  columns: lancamentoColumns('Fornecedor'),
  pushdown: [eq('codigo_cliente_fornecedor', 'filtrar_cliente')],
  writes: {
    insert: {
      call: 'IncluirContaPagar',
      key: [],
      returns: { codigo_lancamento_omie: 'codigo_lancamento_omie' },
    },
    update: { call: 'AlterarContaPagar', key: ['codigo_lancamento_omie'] },
    delete: { call: 'ExcluirContaPagar', key: ['codigo_lancamento_omie'] },
  },
  notes: ['Omie rejects a data_vencimento earlier than today on IncluirContaPagar.'],
};

// ------------------------------------------------------------------ Fiscal
const nfes: ResourceDef = {
  name: 'nfes',
  group: 'Fiscal',
  description:
    'Notas fiscais eletrônicas (consulta). Somente leitura: emissão e cancelamento não são expostos.',
  list: {
    endpoint: 'produtos/nfconsultar',
    call: 'ListarNF',
    arrayPath: 'nfCadastro',
    paging: 'std',
    pageSize: 50,
  },
  lookup: { call: 'ConsultarNF', param: (pk) => ({ nCodNF: pk }) },
  columns: [
    col('id_nf', 'integer', 'compl.nIdNF', 'Identificador da NF no Omie', { pk: true }),
    col('numero_nf', 'string', 'ide.nNF', 'Número da NF'),
    col('serie', 'string', 'ide.serie', 'Série'),
    col('modelo', 'string', 'ide.mod', 'Modelo (55 = NF-e)'),
    col('chave_nfe', 'string', 'compl.cChaveNFe', 'Chave de acesso'),
    col('data_emissao', 'date', 'ide.dEmi', 'Data de emissão'),
    col('tipo_nf', 'string', 'ide.tpNF', 'Tipo (0 = entrada, 1 = saída)'),
    col('ambiente', 'string', 'ide.tpAmb', 'Ambiente (1 = produção, 2 = homologação)'),
    col('finalidade', 'string', 'ide.finNFe', 'Finalidade'),
    col('codigo_pedido', 'integer', 'compl.nIdPedido', 'Pedido de origem', {
      references: { table: 'pedidos_venda', column: 'codigo_pedido' },
    }),
    col('codigo_cliente', 'integer', 'nfDestInt.nCodCli', 'Destinatário', {
      references: { table: 'clientes', column: 'codigo_cliente_omie' },
    }),
    col('razao_social_destinatario', 'string', 'nfDestInt.cRazao', 'Razão social do destinatário'),
    col('cnpj_cpf_destinatario', 'string', 'nfDestInt.cnpj_cpf', 'CNPJ/CPF do destinatário'),
    col('valor_produtos', 'number', 'total.ICMSTot.vProd', 'Valor dos produtos'),
    col('valor_nf', 'number', 'total.ICMSTot.vNF', 'Valor total da NF'),
    col('valor_icms', 'number', 'total.ICMSTot.vICMS', 'Valor do ICMS'),
    col('valor_frete', 'number', 'total.ICMSTot.vFrete', 'Valor do frete'),
    col('valor_desconto', 'number', 'total.ICMSTot.vDesc', 'Valor do desconto'),
    col('numero_pedido', 'string', 'pedido.cNumPedido', 'Número do pedido'),
    col('codigo_vendedor', 'integer', 'pedido.nIdVendedor', 'Vendedor', {
      references: { table: 'vendedores', column: 'codigo' },
    }),
    col('data_cancelamento', 'date', 'ide.dCan', 'Data de cancelamento'),
  ],
  pushdown: [
    {
      column: 'numero_nf',
      kind: 'eq',
      param: 'nNFInicial/nNFFinal',
      apply: (p, [v]) => {
        p.nNFInicial = v;
        p.nNFFinal = v;
      },
    },
    eq('codigo_cliente', 'nIdCliente'),
    eq('tipo_nf', 'tpNF'),
  ],
  writes: {},
};

export const RESOURCES: readonly ResourceDef[] = [
  clientes,
  departamentos,
  produtos,
  tabelasPreco,
  tabelaPrecoItens,
  estoque,
  vendedores,
  pedidosVenda,
  pedidoVendaItens,
  categorias,
  contasReceber,
  contasPagar,
  nfes,
];
