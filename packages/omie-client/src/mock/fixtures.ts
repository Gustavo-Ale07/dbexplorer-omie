/**
 * 100% FICTITIOUS demo dataset in Omie's wire format (dd/mm/aaaa dates, "S"/"N" flags).
 * Names are generated from generic word lists, e-mails use the reserved `.example`
 * TLD, CNPJs have intentionally invalid check digits and EANs use the 2xx
 * restricted-circulation range. Nothing here refers to a real company or person.
 */
import { addDays, createRandom, fakeCnpj, fakeEan, omieDate, pad } from './random';
import type { Random } from './random';

export type OmieRecord = Record<string, unknown>;

export interface MockDataset {
  anchor: Date;
  clientes: OmieRecord[];
  produtos: OmieRecord[];
  estoque: OmieRecord[];
  vendedores: OmieRecord[];
  categorias: OmieRecord[];
  departamentos: OmieRecord[];
  pedidos: OmieRecord[];
  contasReceber: OmieRecord[];
  contasPagar: OmieRecord[];
  tabelasPreco: OmieRecord[];
  /** Price-table items keyed by nCodTabPreco. */
  tabelaItens: Map<number, OmieRecord[]>;
  nfes: OmieRecord[];
  sequences: Record<string, number>;
}

const PREFIXOS = [
  'Aurora',
  'Horizonte',
  'Vale Verde',
  'Monte Claro',
  'Rio Azul',
  'Serra Alta',
  'Bela Vista',
  'Nova Era',
  'Ponto Sul',
  'Estrela',
  'Lago Norte',
  'Campo Belo',
  'Atlas',
  'Prisma',
  'Vértice',
  'Boreal',
];
const NUCLEOS = [
  'Têxtil',
  'Alimentos',
  'Distribuidora',
  'Ferragens',
  'Embalagens',
  'Tecnologia',
  'Móveis',
  'Papelaria',
  'Construções',
  'Agro',
  'Química',
  'Logística',
  'Cosméticos',
  'Autopeças',
  'Eletro',
  'Gráfica',
];
const SUFIXOS = ['Ltda', 'S.A.', 'ME', 'EIRELI', 'Comércio Ltda', 'Indústria Ltda'];
const CIDADES: Array<[string, string]> = [
  ['SAO PAULO', 'SP'],
  ['CAMPINAS', 'SP'],
  ['SANTOS', 'SP'],
  ['RIO DE JANEIRO', 'RJ'],
  ['NITEROI', 'RJ'],
  ['BELO HORIZONTE', 'MG'],
  ['UBERLANDIA', 'MG'],
  ['CURITIBA', 'PR'],
  ['LONDRINA', 'PR'],
  ['PORTO ALEGRE', 'RS'],
  ['CAXIAS DO SUL', 'RS'],
  ['FLORIANOPOLIS', 'SC'],
  ['JOINVILLE', 'SC'],
  ['GOIANIA', 'GO'],
  ['SALVADOR', 'BA'],
  ['RECIFE', 'PE'],
  ['FORTALEZA', 'CE'],
  ['MANAUS', 'AM'],
  ['BELEM', 'PA'],
  ['VITORIA', 'ES'],
];
const RUAS = [
  'Rua das Acácias',
  'Avenida Central',
  'Rua do Comércio',
  'Rua Projetada',
  'Avenida das Indústrias',
  'Rua dos Ipês',
  'Travessa Exemplo',
  'Alameda dos Pinheiros',
];
const PRIMEIROS = [
  'Ana',
  'Bruno',
  'Carla',
  'Diego',
  'Elisa',
  'Fábio',
  'Gabriela',
  'Heitor',
  'Isabela',
  'João',
  'Larissa',
  'Marcos',
  'Natália',
  'Otávio',
  'Paula',
  'Rafael',
];
const SOBRENOMES = [
  'Almeida',
  'Barros',
  'Cardoso',
  'Duarte',
  'Esteves',
  'Freitas',
  'Gomes',
  'Lima',
  'Moraes',
  'Nogueira',
  'Pereira',
  'Rocha',
  'Teixeira',
  'Vieira',
];

const PRODUTOS_BASE: Array<{
  nome: string;
  variantes: string[];
  unidade: string;
  familia: string;
  ncm: string;
  preco: [number, number];
}> = [
  {
    nome: 'Parafuso Sextavado',
    variantes: ['M6 x 20', 'M8 x 30', 'M10 x 40', 'M12 x 50'],
    unidade: 'CX',
    familia: 'Fixadores',
    ncm: '73181500',
    preco: [18, 90],
  },
  {
    nome: 'Caixa Organizadora',
    variantes: ['5L', '10L', '20L', '40L'],
    unidade: 'UN',
    familia: 'Utilidades',
    ncm: '39241000',
    preco: [12, 75],
  },
  {
    nome: 'Fita Adesiva',
    variantes: ['12mm x 30m', '18mm x 50m', '48mm x 100m'],
    unidade: 'UN',
    familia: 'Embalagens',
    ncm: '39191000',
    preco: [3, 22],
  },
  {
    nome: 'Luva de Proteção',
    variantes: ['P', 'M', 'G', 'GG'],
    unidade: 'PAR',
    familia: 'EPI',
    ncm: '40151900',
    preco: [4, 28],
  },
  {
    nome: 'Cabo Flexível',
    variantes: ['1,5mm', '2,5mm', '4mm', '6mm'],
    unidade: 'M',
    familia: 'Elétrica',
    ncm: '85444900',
    preco: [1.2, 9],
  },
  {
    nome: 'Tinta Acrílica',
    variantes: ['Branco 3,6L', 'Cinza 3,6L', 'Branco 18L', 'Areia 18L'],
    unidade: 'UN',
    familia: 'Tintas',
    ncm: '32091000',
    preco: [45, 420],
  },
  {
    nome: 'Papel Sulfite A4',
    variantes: ['75g 500fls', '90g 500fls'],
    unidade: 'PCT',
    familia: 'Papelaria',
    ncm: '48025610',
    preco: [22, 45],
  },
  {
    nome: 'Café Torrado',
    variantes: ['250g', '500g', '1kg'],
    unidade: 'UN',
    familia: 'Alimentos',
    ncm: '09012100',
    preco: [12, 60],
  },
  {
    nome: 'Detergente Neutro',
    variantes: ['500ml', '5L'],
    unidade: 'UN',
    familia: 'Limpeza',
    ncm: '34022000',
    preco: [2.5, 35],
  },
  {
    nome: 'Rolamento',
    variantes: ['6201', '6203', '6205', '6305'],
    unidade: 'UN',
    familia: 'Mecânica',
    ncm: '84821010',
    preco: [9, 80],
  },
  {
    nome: 'Lâmpada LED',
    variantes: ['9W', '12W', '15W', 'Tubular 18W'],
    unidade: 'UN',
    familia: 'Elétrica',
    ncm: '85395200',
    preco: [6, 35],
  },
  {
    nome: 'Cadeira de Escritório',
    variantes: ['Fixa', 'Giratória', 'Presidente'],
    unidade: 'UN',
    familia: 'Móveis',
    ncm: '94013000',
    preco: [180, 1400],
  },
  {
    nome: 'Etiqueta Térmica',
    variantes: ['40x25', '60x40', '100x150'],
    unidade: 'RL',
    familia: 'Embalagens',
    ncm: '48211000',
    preco: [15, 70],
  },
  {
    nome: 'Serviço de Instalação',
    variantes: ['Básica', 'Completa'],
    unidade: 'H',
    familia: 'Serviços',
    ncm: '00000000',
    preco: [90, 350],
  },
];

export const LOCAIS_ESTOQUE = [
  { codigo: 4000001, descricao: 'Depósito Principal' },
  { codigo: 4000002, descricao: 'Depósito Filial' },
];

export const CONTAS_CORRENTES = [8100001, 8100002, 8100003];

function info(rand: Random, anchor: Date, maxDaysAgo = 720) {
  const inc = addDays(anchor, -rand.int(30, maxDaysAgo));
  const alt = addDays(inc, rand.int(0, 25));
  return {
    dInc: omieDate(inc),
    hInc: `${pad(rand.int(7, 19), 2)}:${pad(rand.int(0, 59), 2)}:${pad(rand.int(0, 59), 2)}`,
    uInc: 'DEMO',
    dAlt: omieDate(alt),
    hAlt: `${pad(rand.int(7, 19), 2)}:${pad(rand.int(0, 59), 2)}:${pad(rand.int(0, 59), 2)}`,
    uAlt: 'DEMO',
    cImpAPI: 'S',
  };
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function buildDataset(options: { seed?: number; anchor?: Date } = {}): MockDataset {
  const rand = createRandom(options.seed ?? 20260101);
  const now = options.anchor ?? new Date();
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // ---------------- vendedores
  const vendedores: OmieRecord[] = Array.from({ length: 8 }, (_, i) => {
    const nome = `${PRIMEIROS[(i * 2) % PRIMEIROS.length]} ${SOBRENOMES[(i * 3) % SOBRENOMES.length]}`;
    return {
      codigo: 5000001 + i,
      codInt: `VEND-${pad(i + 1, 3)}`,
      nome,
      inativo: i === 7 ? 'S' : 'N',
      email: `${slug(nome).replace('-', '.')}@empresa-demo.example`,
      fatura_pedido: i < 3 ? 'S' : 'N',
      visualiza_pedido: 'S',
      comissao: [2, 2.5, 3, 3.5, 4, 5][i % 6],
    };
  });

  // ---------------- categorias
  const categoriaDefs: Array<[string, string, string, 'R' | 'D', boolean]> = [
    ['1.01', 'Receitas Operacionais', '', 'R', true],
    ['1.01.01', 'Venda de Produtos', '1.01', 'R', false],
    ['1.01.02', 'Prestação de Serviços', '1.01', 'R', false],
    ['1.01.03', 'Revenda de Mercadorias', '1.01', 'R', false],
    ['1.02', 'Receitas Financeiras', '', 'R', true],
    ['1.02.01', 'Juros Recebidos', '1.02', 'R', false],
    ['1.02.02', 'Rendimentos de Aplicações', '1.02', 'R', false],
    ['2.01', 'Custos Operacionais', '', 'D', true],
    ['2.01.01', 'Compra de Mercadorias', '2.01', 'D', false],
    ['2.01.02', 'Matéria-Prima', '2.01', 'D', false],
    ['2.01.03', 'Fretes e Carretos', '2.01', 'D', false],
    ['2.02', 'Despesas Administrativas', '', 'D', true],
    ['2.02.01', 'Aluguel', '2.02', 'D', false],
    ['2.02.02', 'Energia Elétrica', '2.02', 'D', false],
    ['2.02.03', 'Internet e Telefonia', '2.02', 'D', false],
    ['2.02.04', 'Material de Escritório', '2.02', 'D', false],
    ['2.03', 'Despesas com Pessoal', '', 'D', true],
    ['2.03.01', 'Salários', '2.03', 'D', false],
    ['2.03.02', 'Benefícios', '2.03', 'D', false],
    ['2.04', 'Impostos e Taxas', '', 'D', true],
    ['2.04.01', 'Impostos sobre Vendas', '2.04', 'D', false],
    ['2.04.02', 'Taxas Bancárias', '2.04', 'D', false],
    ['2.05', 'Despesas Comerciais', '', 'D', true],
    ['2.05.01', 'Comissões', '2.05', 'D', false],
    ['2.05.02', 'Marketing', '2.05', 'D', false],
  ];
  const categorias: OmieRecord[] = categoriaDefs.map(
    ([codigo, descricao, superior, tipo, total], i) => ({
      codigo,
      descricao,
      descricao_padrao: descricao,
      tipo_categoria: tipo,
      conta_inativa: i === 14 ? 'S' : 'N',
      definida_pelo_usuario: total ? 'N' : 'S',
      id_conta_contabil: 0,
      tag_conta_contabil: '',
      conta_despesa: tipo === 'D' ? 'S' : 'N',
      conta_receita: tipo === 'R' ? 'S' : 'N',
      nao_exibir: 'N',
      natureza: '',
      totalizadora: total ? 'S' : 'N',
      transferencia: 'N',
      codigo_dre: '',
      categoria_superior: superior,
      dadosDRE: {
        codigoDRE: '',
        descricaoDRE: '',
        naoExibirDRE: 'N',
        nivelDRE: 0,
        sinalDRE: tipo === 'R' ? '+' : '-',
        totalizaDRE: 'N',
      },
    }),
  );

  // ---------------- departamentos
  const departamentos: OmieRecord[] = [
    ['Comercial', '001'],
    ['Vendas Internas', '001.001'],
    ['Vendas Externas', '001.002'],
    ['Administrativo', '002'],
    ['Financeiro', '002.001'],
    ['Logística', '003'],
    ['Produção', '004'],
    ['Tecnologia', '005'],
  ].map(([descricao, estrutura], i) => ({
    codigo: String(6000001 + i),
    descricao,
    estrutura,
    inativo: i === 7 ? 'S' : 'N',
    nivel_totalizador: (estrutura ?? '').includes('.') ? 'N' : 'S',
  }));

  // ---------------- clientes / fornecedores
  const clientes: OmieRecord[] = Array.from({ length: 240 }, (_, i) => {
    const razao = `${rand.pick(PREFIXOS)} ${rand.pick(NUCLEOS)} ${rand.pick(SUFIXOS)}`;
    const fantasia = razao.replace(/ (Ltda|S\.A\.|ME|EIRELI|Comércio Ltda|Indústria Ltda)$/, '');
    const [cidade, uf] = rand.pick(CIDADES);
    const fornecedor = i % 5 === 4;
    const contato = `${rand.pick(PRIMEIROS)} ${rand.pick(SOBRENOMES)}`;
    return {
      codigo_cliente_omie: 1000001 + i,
      codigo_cliente_integracao: `CLI-${pad(i + 1, 5)}`,
      razao_social: `${razao}`,
      nome_fantasia: fantasia,
      cnpj_cpf: fakeCnpj(rand),
      email: `contato@${slug(fantasia)}-${i + 1}.example`,
      homepage: '',
      contato,
      telefone1_ddd: String(rand.int(11, 99)),
      telefone1_numero: `5555-${pad(rand.int(0, 9999), 4)}`,
      endereco: rand.pick(RUAS),
      endereco_numero: String(rand.int(10, 2500)),
      complemento: rand.chance(0.3) ? `Sala ${rand.int(1, 40)}` : '',
      bairro: rand.pick([
        'Centro',
        'Distrito Industrial',
        'Jardim Exemplo',
        'Vila Nova',
        'Parque Sul',
      ]),
      cidade: `${cidade} (${uf})`,
      cidade_ibge: '',
      estado: uf,
      cep: `${pad(rand.int(10000, 99999), 5)}-${pad(rand.int(0, 999), 3)}`,
      codigo_pais: '1058',
      inscricao_estadual: rand.chance(0.6) ? String(rand.int(100000000, 999999999)) : 'ISENTO',
      inscricao_municipal: '',
      optante_simples_nacional: rand.chance(0.4) ? 'S' : 'N',
      contribuinte: 'S',
      pessoa_fisica: 'N',
      exterior: 'N',
      inativo: rand.chance(0.06) ? 'S' : 'N',
      bloquear_faturamento: rand.chance(0.03) ? 'S' : 'N',
      bloquear_exclusao: 'N',
      valor_limite_credito: rand.pick([0, 5000, 10000, 25000, 50000]),
      observacao: '',
      tags: fornecedor
        ? [{ tag: 'Fornecedor' }]
        : rand.chance(0.1)
          ? [{ tag: 'Cliente' }, { tag: 'Fornecedor' }]
          : [{ tag: 'Cliente' }],
      recomendacoes: {
        codigo_vendedor: (vendedores[i % 7]?.codigo as number) ?? 0,
        numero_parcelas: '',
        email_fatura: '',
        gerar_boletos: 'N',
      },
      info: info(rand, anchor),
    };
  });
  // Demo-only: one record whose text carries an HTML/script payload, to exercise XSS escaping in the UI.
  const xssCliente = clientes[17];
  if (xssCliente)
    xssCliente.observacao =
      '<img src=x onerror="alert(1)"> Observação de teste (conteúdo não confiável)';

  const clientesAtivos = clientes.filter((c) =>
    (c.tags as Array<{ tag: string }>).some((t) => t.tag === 'Cliente'),
  );
  const fornecedores = clientes.filter((c) =>
    (c.tags as Array<{ tag: string }>).some((t) => t.tag === 'Fornecedor'),
  );

  // ---------------- produtos
  const produtos: OmieRecord[] = [];
  let p = 0;
  for (const base of PRODUTOS_BASE) {
    for (const variante of base.variantes) {
      for (const linha of ['', ' Linha Pro', ' Linha Eco']) {
        if (produtos.length >= 160) break;
        p += 1;
        const descricao = `${base.nome} ${variante}${linha}`;
        produtos.push({
          codigo_produto: 3000001 + p,
          codigo_produto_integracao: `PRD-${pad(p, 5)}`,
          codigo: `SKU-${pad(p, 5)}`,
          descricao,
          unidade: base.unidade,
          ncm: base.ncm,
          ean: base.familia === 'Serviços' ? '' : fakeEan(rand),
          valor_unitario: rand.money(base.preco[0], base.preco[1]),
          codigo_familia: 3900000 + PRODUTOS_BASE.indexOf(base),
          descricao_familia: base.familia,
          tipoItem: base.familia === 'Serviços' ? '09' : '00',
          marca: rand.pick(['Marca Exemplo', 'Genérica', 'Linha Demo']),
          modelo: '',
          peso_liq: rand.money(0.05, 12),
          peso_bruto: rand.money(0.1, 13),
          altura: 0,
          largura: 0,
          profundidade: 0,
          descr_detalhada: '',
          obs_internas: '',
          dias_garantia: rand.pick([0, 90, 180, 365]),
          lead_time: rand.int(0, 20),
          inativo: rand.chance(0.05) ? 'S' : 'N',
          bloqueado: 'N',
          bloquear_exclusao: 'N',
          importado_api: 'S',
          info: info(rand, anchor),
        });
      }
    }
  }
  const xssProduto = produtos[5];
  if (xssProduto)
    xssProduto.descr_detalhada =
      '<script>alert("xss")</script> Descrição com HTML (deve ser exibida como texto)';
  const produtosVendaveis = produtos.filter((x) => x.inativo === 'N');

  // ---------------- estoque
  const estoque: OmieRecord[] = [];
  for (const prod of produtos) {
    if (prod.tipoItem === '09') continue;
    const locais = rand.chance(0.3) ? LOCAIS_ESTOQUE : [LOCAIS_ESTOQUE[0]];
    for (const local of locais) {
      if (!local) continue;
      const fisico = rand.int(0, 800);
      const reservado = Math.min(fisico, rand.int(0, 60));
      estoque.push({
        nCodProd: prod.codigo_produto,
        cCodInt: prod.codigo_produto_integracao,
        cCodigo: prod.codigo,
        cDescricao: prod.descricao,
        nPrecoUnitario: prod.valor_unitario,
        nSaldo: fisico - reservado,
        nCMC: Math.round((prod.valor_unitario as number) * 0.62 * 100) / 100,
        nPendente: rand.int(0, 40),
        estoque_minimo: rand.pick([0, 10, 20, 50]),
        codigo_local_estoque: local.codigo,
        reservado,
        fisico,
      });
    }
  }

  // ---------------- pedidos de venda
  const pedidos: OmieRecord[] = [];
  let itemSeq = 0;
  for (let i = 0; i < 300; i++) {
    const cliente = rand.pick(clientesAtivos);
    const vendedor = rand.pick(vendedores.slice(0, 7));
    const emissao = addDays(anchor, -rand.int(0, 365));
    const etapa = rand.pick(['10', '10', '20', '20', '30', '50', '60', '60', '60', '60']);
    const faturado = etapa === '60';
    const cancelado = !faturado && rand.chance(0.05);
    const nItens = rand.int(1, 5);
    const det: OmieRecord[] = [];
    let mercadorias = 0;
    for (let k = 0; k < nItens; k++) {
      const prod = rand.pick(produtosVendaveis);
      const quantidade = rand.int(1, 40);
      const valorUnit = prod.valor_unitario as number;
      const total = Math.round(quantidade * valorUnit * 100) / 100;
      mercadorias += total;
      itemSeq += 1;
      det.push({
        ide: {
          codigo_item: 8000000 + itemSeq,
          codigo_item_integracao: `IT-${pad(itemSeq, 6)}`,
          simples_nacional: 'N',
        },
        produto: {
          codigo_produto: prod.codigo_produto,
          codigo_produto_integracao: prod.codigo_produto_integracao,
          codigo: prod.codigo,
          descricao: prod.descricao,
          cfop: '5.102',
          ncm: prod.ncm,
          ean: prod.ean,
          unidade: prod.unidade,
          quantidade,
          valor_unitario: valorUnit,
          valor_mercadoria: total,
          tipo_desconto: 'V',
          valor_desconto: 0,
          valor_total: total,
        },
        observacao: { obs_item: '' },
      });
    }
    mercadorias = Math.round(mercadorias * 100) / 100;
    const frete = rand.chance(0.4) ? rand.money(20, 300) : 0;
    pedidos.push({
      cabecalho: {
        codigo_pedido: 7000001 + i,
        codigo_pedido_integracao: `PED-${pad(i + 1, 6)}`,
        numero_pedido: String(1001 + i),
        codigo_cliente: cliente.codigo_cliente_omie,
        codigo_cliente_integracao: cliente.codigo_cliente_integracao,
        data_previsao: omieDate(addDays(emissao, rand.int(3, 30))),
        etapa,
        codigo_parcela: rand.pick(['000', 'A30', 'A60', 'T03']),
        qtde_parcelas: 1,
        quantidade_itens: nItens,
        origem_pedido: 'API',
        bloqueado: 'N',
        importado_api: 'S',
        encerrado: 'N',
      },
      total_pedido: {
        valor_mercadorias: mercadorias,
        valor_descontos: 0,
        valor_total_pedido: Math.round((mercadorias + frete) * 100) / 100,
        valor_icms: Math.round(mercadorias * 0.12 * 100) / 100,
        valor_IPI: 0,
        valor_pis: Math.round(mercadorias * 0.0165 * 100) / 100,
        valor_cofins: Math.round(mercadorias * 0.076 * 100) / 100,
      },
      informacoes_adicionais: {
        codigo_categoria: '1.01.01',
        codigo_conta_corrente: rand.pick(CONTAS_CORRENTES),
        numero_pedido_cliente: rand.chance(0.5) ? `OC-${rand.int(1000, 9999)}` : '',
        codVend: vendedor.codigo,
        consumidor_final: 'N',
      },
      frete: { modalidade: frete > 0 ? '0' : '9', valor_frete: frete },
      observacoes: { obs_venda: '' },
      det,
      infoCadastro: {
        dInc: omieDate(emissao),
        hInc: '10:00:00',
        uInc: 'DEMO',
        dAlt: omieDate(emissao),
        hAlt: '10:00:00',
        uAlt: 'DEMO',
        faturado: faturado ? 'S' : 'N',
        dFat: faturado ? omieDate(addDays(emissao, rand.int(1, 10))) : '',
        cancelado: cancelado ? 'S' : 'N',
        dCan: cancelado ? omieDate(addDays(emissao, rand.int(1, 10))) : '',
        autorizado: faturado ? 'S' : 'N',
        denegado: 'N',
        devolvido: 'N',
        devolvido_parcial: 'N',
        cImpAPI: 'S',
      },
    });
  }

  // ---------------- NF-e (one per invoiced order)
  const nfes: OmieRecord[] = [];
  for (const ped of pedidos) {
    const ic = ped.infoCadastro as OmieRecord;
    if (ic.faturado !== 'S') continue;
    const cab = ped.cabecalho as OmieRecord;
    const tot = ped.total_pedido as OmieRecord;
    const cliente = clientes.find((c) => c.codigo_cliente_omie === cab.codigo_cliente);
    const n = nfes.length + 1;
    const chave =
      `99${pad(rand.int(0, 99999999), 8)}${pad(n, 10)}55001${pad(n, 9)}${pad(rand.int(0, 9999), 4)}`
        .slice(0, 44)
        .padEnd(44, '0');
    nfes.push({
      compl: {
        nIdNF: 12000000 + n,
        nIdPedido: cab.codigo_pedido,
        cCodCateg: '1.01.01',
        cChaveNFe: chave,
        nIdReceb: 0,
        nIdTransp: 0,
        cModFrete: '9',
      },
      ide: {
        mod: '55',
        serie: '1',
        nNF: String(n),
        dEmi: ic.dFat,
        hEmi: '14:30:00',
        dSaiEnt: ic.dFat,
        tpNF: '1',
        tpAmb: '2',
        finNFe: '1',
        dReg: ic.dFat,
        dCan: '',
        dInut: '',
        cDeneg: 'N',
      },
      nfDestInt: {
        nCodCli: cab.codigo_cliente,
        cCodCliInt: cab.codigo_cliente_integracao,
        cRazao: cliente?.razao_social ?? '',
        cnpj_cpf: cliente?.cnpj_cpf ?? '',
      },
      total: {
        ICMSTot: {
          vProd: tot.valor_mercadorias,
          vNF: tot.valor_total_pedido,
          vICMS: tot.valor_icms,
          vDesc: 0,
          vFrete: (ped.frete as OmieRecord).valor_frete,
          vPIS: tot.valor_pis,
          vCOFINS: tot.valor_cofins,
        },
      },
      det: (ped.det as OmieRecord[]).map((d) => {
        const prod = d.produto as OmieRecord;
        return {
          prod: {
            cProd: prod.codigo,
            xProd: prod.descricao,
            NCM: prod.ncm,
            CFOP: '5102',
            uCom: prod.unidade,
            qCom: prod.quantidade,
            vUnCom: prod.valor_unitario,
            vProd: prod.valor_total,
          },
          nfProdInt: { nCodProd: prod.codigo_produto, cCodProdInt: prod.codigo_produto_integracao },
        };
      }),
      pedido: {
        cNumPedido: cab.numero_pedido,
        cCancelado: 'N',
        cDevolvido: 'N',
        nIdVendedor: (ped.informacoes_adicionais as OmieRecord).codVend,
      },
      info: {
        dInc: ic.dFat,
        hInc: '14:30:00',
        uInc: 'DEMO',
        dAlt: ic.dFat,
        hAlt: '14:30:00',
        uAlt: 'DEMO',
        cImpAPI: 'S',
      },
    });
  }

  // ---------------- contas a receber
  const contasReceber: OmieRecord[] = [];
  const faturados = pedidos.filter((x) => (x.infoCadastro as OmieRecord).faturado === 'S');
  for (let i = 0; i < 320; i++) {
    const ped = i < faturados.length ? faturados[i] : undefined;
    const cliente = ped
      ? clientes.find((c) => c.codigo_cliente_omie === (ped.cabecalho as OmieRecord).codigo_cliente)
      : rand.pick(clientesAtivos);
    const emissao = addDays(anchor, -rand.int(0, 200));
    const venc = addDays(emissao, rand.pick([15, 28, 30, 45, 60]));
    const valor = ped
      ? ((ped.total_pedido as OmieRecord).valor_total_pedido as number)
      : rand.money(80, 9000);
    contasReceber.push(
      financeiro(rand, anchor, {
        codigo: 9000001 + i,
        integracao: `CR-${pad(i + 1, 6)}`,
        cliente: (cliente?.codigo_cliente_omie as number) ?? 1000001,
        emissao,
        venc,
        valor,
        categoria: ped ? '1.01.01' : rand.pick(['1.01.02', '1.01.03', '1.02.01']),
        pedido: ped ? ((ped.cabecalho as OmieRecord).codigo_pedido as number) : 0,
        numeroPedido: ped ? ((ped.cabecalho as OmieRecord).numero_pedido as string) : '',
        pagoLabel: 'RECEBIDO',
      }),
    );
  }

  // ---------------- contas a pagar
  const contasPagar: OmieRecord[] = Array.from({ length: 200 }, (_, i) => {
    const fornecedor = rand.pick(fornecedores);
    const emissao = addDays(anchor, -rand.int(0, 200));
    const venc = addDays(emissao, rand.pick([7, 15, 30, 45]));
    return financeiro(rand, anchor, {
      codigo: 9500001 + i,
      integracao: `CP-${pad(i + 1, 6)}`,
      cliente: fornecedor.codigo_cliente_omie as number,
      emissao,
      venc,
      valor: rand.money(50, 12000),
      categoria: rand.pick([
        '2.01.01',
        '2.01.02',
        '2.01.03',
        '2.02.01',
        '2.02.02',
        '2.02.03',
        '2.04.01',
        '2.05.01',
      ]),
      pedido: 0,
      numeroPedido: '',
      pagoLabel: 'PAGO',
    });
  });

  // ---------------- tabelas de preço
  const tabelasPreco: OmieRecord[] = [
    ['TAB-VAREJO', 'Tabela Varejo', 'VAR', 0, 0],
    ['TAB-ATACADO', 'Tabela Atacado', 'ATA', 0, 8],
    ['TAB-DISTRIB', 'Tabela Distribuidores', 'DIS', 0, 12],
  ].map(([codInt, nome, codigo, acresc, desc], i) => ({
    nCodTabPreco: 11000001 + i,
    cCodIntTabPreco: codInt,
    cNome: nome,
    cCodigo: codigo,
    cAtiva: 'S',
    cOrigem: 'MAN',
    produtos: { cTodosProdutos: 'S' },
    clientes: { cTodosClientes: 'S' },
    outrasInfo: { nPercAcrescimo: acresc, nPercDesconto: desc },
    caracteristicas: { cTemValidade: 'N', cTemDesconto: 'N', cArredPreco: 'N' },
    info: info(rand, anchor),
  }));
  const tabelaItens = new Map<number, OmieRecord[]>();
  for (const tab of tabelasPreco) {
    const descPct = (tab.outrasInfo as OmieRecord).nPercDesconto as number;
    tabelaItens.set(
      tab.nCodTabPreco as number,
      produtos.slice(0, 80).map((prod) => {
        const original = prod.valor_unitario as number;
        const calculado = Math.round(original * (1 - descPct / 100) * 100) / 100;
        return {
          nCodProd: prod.codigo_produto,
          cCodIntProd: prod.codigo_produto_integracao,
          cCodigoProduto: prod.codigo,
          cDescricaoProduto: prod.descricao,
          cNCM: prod.ncm,
          cEAN: prod.ean,
          nCodFamilia: prod.codigo_familia,
          cArredPreco: 'N',
          cTemDesconto: 'N',
          nDescMaximo: 0,
          nDescSugerido: 0,
          cManual: 'N',
          nPercDesconto: descPct,
          nPercAcrescimo: 0,
          nValorCalculado: calculado,
          nValorOriginal: original,
          nValorTabela: calculado,
        };
      }),
    );
  }

  return {
    anchor,
    clientes,
    produtos,
    estoque,
    vendedores,
    categorias,
    departamentos,
    pedidos,
    contasReceber,
    contasPagar,
    tabelasPreco,
    tabelaItens,
    nfes,
    sequences: {
      cliente: 1000001 + clientes.length,
      produto: 3000001 + produtos.length + 1,
      vendedor: 5000001 + vendedores.length,
      departamento: 6000001 + departamentos.length,
      contaReceber: 9000001 + contasReceber.length,
      contaPagar: 9500001 + contasPagar.length,
    },
  };
}

function financeiro(
  rand: Random,
  anchor: Date,
  f: {
    codigo: number;
    integracao: string;
    cliente: number;
    emissao: Date;
    venc: Date;
    valor: number;
    categoria: string;
    pedido: number;
    numeroPedido: string;
    pagoLabel: string;
  },
): OmieRecord {
  const vencido = f.venc.getTime() < anchor.getTime();
  const hoje = f.venc.getTime() === anchor.getTime();
  let status: string;
  if (rand.chance(0.04)) status = 'CANCELADO';
  else if (vencido) status = rand.chance(0.75) ? f.pagoLabel : 'ATRASADO';
  else if (hoje) status = 'VENCE HOJE';
  else status = rand.chance(0.1) ? f.pagoLabel : 'A VENCER';
  const parcela = rand.int(1, 3);
  return {
    codigo_lancamento_omie: f.codigo,
    codigo_lancamento_integracao: f.integracao,
    codigo_cliente_fornecedor: f.cliente,
    data_emissao: omieDate(f.emissao),
    data_registro: omieDate(f.emissao),
    data_vencimento: omieDate(f.venc),
    data_previsao: omieDate(f.venc),
    valor_documento: f.valor,
    codigo_categoria: f.categoria,
    id_conta_corrente: rand.pick(CONTAS_CORRENTES),
    numero_documento: `DOC-${f.codigo}`,
    numero_parcela: `${pad(parcela, 3)}/${pad(Math.max(parcela, rand.int(1, 3)), 3)}`,
    numero_pedido: f.numeroPedido,
    nCodPedido: f.pedido,
    status_titulo: status,
    id_origem: f.pedido ? 'VENR' : 'MANR',
    codigo_vendedor: 0,
    observacao: '',
    bloqueado: 'N',
    bloquear_exclusao: 'N',
    info: {
      dInc: omieDate(f.emissao),
      hInc: '09:00:00',
      uInc: 'DEMO',
      dAlt: omieDate(f.emissao),
      hAlt: '09:00:00',
      uAlt: 'DEMO',
      cImpAPI: 'S',
    },
  };
}
