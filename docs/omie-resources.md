# Omie resources

Virtual tables exposed by the explorer. This page is generated from the resource registry
(`packages/sql-engine/src/registry/resources.ts`), which is the allowlist of every Omie
endpoint and call the server may use. Nothing outside it can be called — not from SQL, not
from the API inspector.

Run `DESCRIBE <table>` in the explorer for column descriptions in Portuguese.

## Overview

| Table                                       | Area       | Endpoint                | List call             | SELECT | INSERT      | UPDATE      | DELETE      |
| ------------------------------------------- | ---------- | ----------------------- | --------------------- | ------ | ----------- | ----------- | ----------- |
| [`clientes`](#clientes)                     | Geral      | `geral/clientes`        | `ListarClientes`      | yes    | yes         | yes         | yes         |
| [`departamentos`](#departamentos)           | Geral      | `geral/departamentos`   | `ListarDepartamentos` | yes    | unsupported | yes         | yes         |
| [`produtos`](#produtos)                     | Produtos   | `geral/produtos`        | `ListarProdutos`      | yes    | yes         | yes         | yes         |
| [`tabelas_preco`](#tabelas_preco)           | Produtos   | `produtos/tabelaprecos` | `ListarTabelasPreco`  | yes    | unsupported | unsupported | unsupported |
| [`tabela_preco_itens`](#tabela_preco_itens) | Produtos   | `produtos/tabelaprecos` | `ListarTabelaItens`   | yes    | unsupported | yes         | unsupported |
| [`estoque`](#estoque)                       | Estoque    | `estoque/consulta`      | `ListarPosEstoque`    | yes    | unsupported | unsupported | unsupported |
| [`vendedores`](#vendedores)                 | Vendas     | `geral/vendedores`      | `ListarVendedores`    | yes    | yes         | yes         | yes         |
| [`pedidos_venda`](#pedidos_venda)           | Vendas     | `produtos/pedido`       | `ListarPedidos`       | yes    | unsupported | yes         | yes         |
| [`pedido_venda_itens`](#pedido_venda_itens) | Vendas     | `produtos/pedido`       | `ListarPedidos`       | yes    | unsupported | unsupported | unsupported |
| [`categorias`](#categorias)                 | Financeiro | `geral/categorias`      | `ListarCategorias`    | yes    | yes         | yes         | unsupported |
| [`contas_receber`](#contas_receber)         | Financeiro | `financas/contareceber` | `ListarContasReceber` | yes    | yes         | yes         | yes         |
| [`contas_pagar`](#contas_pagar)             | Financeiro | `financas/contapagar`   | `ListarContasPagar`   | yes    | yes         | yes         | yes         |
| [`nfes`](#nfes)                             | Fiscal     | `produtos/nfconsultar`  | `ListarNF`            | yes    | unsupported | unsupported | unsupported |

"unsupported" means the statement fails with `OPERATION_NOT_SUPPORTED` before any call is made.
Writes additionally depend on `OMIE_READ_ONLY`, the `OMIE_ALLOW_*` flags and the user role.

## clientes

Clientes e fornecedores (cadastro único do Omie; use a coluna tags para distinguir).

- **Primary key:** `codigo_cliente_omie`
- **List:** `geral/clientes` → `ListarClientes`; lookup by key: `ConsultarCliente`
- **Remote filters:** `codigo_cliente_omie` (= / IN → `clientesPorCodigo[].codigo_cliente_omie`), `codigo_cliente_integracao` (= / IN → `clientesPorCodigo[].codigo_cliente_integracao`), `cnpj_cpf` (= → `clientesFiltro.cnpj_cpf`), `estado` (= → `clientesFiltro.estado`), `inativo` (= → `clientesFiltro.inativo`)
- **Writes:** INSERT `IncluirCliente` · UPDATE `AlterarCliente` · DELETE `ExcluirCliente`
- **Required on INSERT:** `codigo_cliente_integracao`, `razao_social`
- **Updatable:** `razao_social`, `nome_fantasia`, `cnpj_cpf`, `email`, `contato`, `telefone1_ddd`, `telefone1_numero`, `endereco`, `endereco_numero`, `complemento`, `bairro`, `cidade`, `estado`, `cep`, `inscricao_estadual`, `optante_simples_nacional`, `pessoa_fisica`, `inativo`, `bloquear_faturamento`, `valor_limite_credito`, `observacao`

| Column                      | Type    | Description                                            |
| --------------------------- | ------- | ------------------------------------------------------ |
| `codigo_cliente_omie` (PK)  | integer | Código do cliente no Omie                              |
| `codigo_cliente_integracao` | string  | Código de integração (definido pelo integrador)        |
| `razao_social`              | string  | Razão social                                           |
| `nome_fantasia`             | string  | Nome fantasia                                          |
| `cnpj_cpf`                  | string  | CNPJ ou CPF                                            |
| `email`                     | string  | E-mail                                                 |
| `contato`                   | string  | Nome do contato                                        |
| `telefone1_ddd`             | string  | DDD do telefone                                        |
| `telefone1_numero`          | string  | Telefone                                               |
| `endereco`                  | string  | Logradouro                                             |
| `endereco_numero`           | string  | Número                                                 |
| `complemento`               | string  | Complemento                                            |
| `bairro`                    | string  | Bairro                                                 |
| `cidade`                    | string  | Cidade                                                 |
| `estado`                    | string  | UF                                                     |
| `cep`                       | string  | CEP                                                    |
| `inscricao_estadual`        | string  | Inscrição estadual                                     |
| `optante_simples_nacional`  | flag    | Optante pelo Simples Nacional (S/N)                    |
| `pessoa_fisica`             | flag    | Pessoa física (S/N)                                    |
| `inativo`                   | flag    | Cadastro inativo (S/N)                                 |
| `bloquear_faturamento`      | flag    | Bloquear faturamento (S/N)                             |
| `valor_limite_credito`      | number  | Limite de crédito                                      |
| `observacao`                | string  | Observações                                            |
| `tags`                      | string  | Tags (ex.: Cliente, Fornecedor), separadas por vírgula |
| `codigo_vendedor`           | integer | Vendedor padrão → `vendedores.codigo`                  |
| `data_inclusao`             | date    | Data de inclusão do registro                           |
| `data_alteracao`            | date    | Data da última alteração                               |

## departamentos

Departamentos (centros de custo).

- **Primary key:** `codigo`
- **List:** `geral/departamentos` → `ListarDepartamentos`; lookup by key: `ConsultarDepartamento`
- **Remote filters:** none — every predicate is evaluated locally
- **Writes:** INSERT unsupported · UPDATE `AlterarDepartamento` · DELETE `ExcluirDepartamento`
- **Updatable:** `descricao`, `inativo`
- **Note:** INSERT is not mapped: IncluirDepartamento requires the hierarchy position (UNCONFIRMED).

| Column              | Type   | Description             |
| ------------------- | ------ | ----------------------- |
| `codigo` (PK)       | string | Código do departamento  |
| `descricao`         | string | Descrição               |
| `estrutura`         | string | Estrutura hierárquica   |
| `inativo`           | flag   | Inativo (S/N)           |
| `nivel_totalizador` | flag   | Nível totalizador (S/N) |

## produtos

Cadastro de produtos e serviços.

- **Primary key:** `codigo_produto`
- **List:** `geral/produtos` → `ListarProdutos`; lookup by key: `ConsultarProduto`
- **Remote filters:** `codigo_produto` (= / IN → `produtosPorCodigo[].codigo_produto`), `codigo_produto_integracao` (= / IN → `produtosPorCodigo[].codigo_produto_integracao`), `codigo` (= / IN → `produtosPorCodigo[].codigo`), `descricao` (LIKE → `filtrar_apenas_descricao`), `ncm` (= → `ncm`), `ean` (= → `ean`)
- **Writes:** INSERT `IncluirProduto` · UPDATE `AlterarProduto` · DELETE `ExcluirProduto`
- **Required on INSERT:** `codigo_produto_integracao`, `descricao`, `unidade`
- **Updatable:** `codigo`, `descricao`, `unidade`, `ncm`, `ean`, `valor_unitario`, `tipo_item`, `marca`, `modelo`, `peso_liq`, `peso_bruto`, `descr_detalhada`, `obs_internas`, `dias_garantia`, `lead_time`, `bloqueado`

| Column                      | Type    | Description                  |
| --------------------------- | ------- | ---------------------------- |
| `codigo_produto` (PK)       | integer | Código do produto no Omie    |
| `codigo_produto_integracao` | string  | Código de integração         |
| `codigo`                    | string  | Código (SKU)                 |
| `descricao`                 | string  | Descrição                    |
| `unidade`                   | string  | Unidade de medida            |
| `ncm`                       | string  | NCM                          |
| `ean`                       | string  | Código de barras (EAN)       |
| `valor_unitario`            | number  | Preço unitário de venda      |
| `codigo_familia`            | integer | Código da família            |
| `descricao_familia`         | string  | Família do produto           |
| `tipo_item`                 | string  | Tipo do item (SPED)          |
| `marca`                     | string  | Marca                        |
| `modelo`                    | string  | Modelo                       |
| `peso_liq`                  | number  | Peso líquido (kg)            |
| `peso_bruto`                | number  | Peso bruto (kg)              |
| `descr_detalhada`           | string  | Descrição detalhada          |
| `obs_internas`              | string  | Observações internas         |
| `dias_garantia`             | integer | Dias de garantia             |
| `lead_time`                 | integer | Lead time (dias)             |
| `inativo`                   | flag    | Inativo (S/N)                |
| `bloqueado`                 | flag    | Bloqueado (S/N)              |
| `data_inclusao`             | date    | Data de inclusão do registro |
| `data_alteracao`            | date    | Data da última alteração     |

## tabelas_preco

Tabelas de preço.

- **Primary key:** `codigo_tabela`
- **List:** `produtos/tabelaprecos` → `ListarTabelasPreco`
- **Remote filters:** none — every predicate is evaluated locally
- **Writes:** INSERT unsupported · UPDATE unsupported · DELETE unsupported

| Column               | Type    | Description               |
| -------------------- | ------- | ------------------------- |
| `codigo_tabela` (PK) | integer | Código da tabela de preço |
| `codigo_integracao`  | string  | Código de integração      |
| `nome`               | string  | Nome da tabela            |
| `codigo`             | string  | Código curto              |
| `ativa`              | flag    | Ativa (S/N)               |
| `origem`             | string  | Origem dos preços         |
| `perc_acrescimo`     | number  | Percentual de acréscimo   |
| `perc_desconto`      | number  | Percentual de desconto    |

## tabela_preco_itens

Itens (preços) de uma tabela de preço. Exige WHERE codigo_tabela = ... ou IN (...).

- **Primary key:** `codigo_tabela`, `codigo_produto`
- **List:** `produtos/tabelaprecos` → `ListarTabelaItens`
- **Required filter:** `WHERE codigo_tabela = …` or `IN (…)`
- **Remote filters:** `codigo_tabela` (= → `nCodTabPreco`)
- **Writes:** INSERT unsupported · UPDATE `AlterarPrecoItem` · DELETE unsupported
- **Updatable:** `valor_tabela`
- **Note:** AlterarPrecoItem payload is UNCONFIRMED against a live account.

| Column                      | Type    | Description                                     |
| --------------------------- | ------- | ----------------------------------------------- |
| `codigo_tabela` (PK)        | integer | Tabela de preço → `tabelas_preco.codigo_tabela` |
| `codigo_produto` (PK)       | integer | Produto → `produtos.codigo_produto`             |
| `codigo_produto_integracao` | string  | Código de integração do produto                 |
| `codigo`                    | string  | Código (SKU)                                    |
| `descricao`                 | string  | Descrição do produto                            |
| `ncm`                       | string  | NCM                                             |
| `ean`                       | string  | EAN                                             |
| `valor_original`            | number  | Preço original                                  |
| `valor_calculado`           | number  | Preço calculado pela regra da tabela            |
| `valor_tabela`              | number  | Preço praticado na tabela                       |
| `perc_desconto`             | number  | Percentual de desconto                          |
| `perc_acrescimo`            | number  | Percentual de acréscimo                         |
| `manual`                    | flag    | Preço definido manualmente (S/N)                |

## estoque

Posição de estoque na data atual, por produto e local de estoque. Somente leitura.

- **Primary key:** `codigo_produto`, `codigo_local_estoque`
- **List:** `estoque/consulta` → `ListarPosEstoque`
- **Remote filters:** `codigo_local_estoque` (= → `codigo_local_estoque`)
- **Writes:** INSERT unsupported · UPDATE unsupported · DELETE unsupported

| Column                      | Type    | Description                         |
| --------------------------- | ------- | ----------------------------------- |
| `codigo_produto` (PK)       | integer | Produto → `produtos.codigo_produto` |
| `codigo_local_estoque` (PK) | integer | Local de estoque                    |
| `codigo_produto_integracao` | string  | Código de integração do produto     |
| `codigo`                    | string  | Código (SKU)                        |
| `descricao`                 | string  | Descrição do produto                |
| `preco_unitario`            | number  | Preço unitário                      |
| `saldo`                     | number  | Saldo disponível                    |
| `fisico`                    | number  | Estoque físico                      |
| `reservado`                 | number  | Quantidade reservada                |
| `pendente`                  | number  | Quantidade pendente                 |
| `estoque_minimo`            | number  | Estoque mínimo                      |
| `cmc`                       | number  | Custo médio contábil                |

## vendedores

Vendedores.

- **Primary key:** `codigo`
- **List:** `geral/vendedores` → `ListarVendedores`; lookup by key: `ConsultarVendedor`
- **Remote filters:** `email` (= → `filtrar_por_email`)
- **Writes:** INSERT `IncluirVendedor` · UPDATE `AlterarVendedor` · DELETE `ExcluirVendedor`
- **Required on INSERT:** `nome`
- **Updatable:** `nome`, `email`, `inativo`, `fatura_pedido`, `visualiza_pedido`, `comissao`

| Column              | Type    | Description                                |
| ------------------- | ------- | ------------------------------------------ |
| `codigo` (PK)       | integer | Código do vendedor                         |
| `codigo_integracao` | string  | Código de integração                       |
| `nome`              | string  | Nome                                       |
| `email`             | string  | E-mail                                     |
| `inativo`           | flag    | Inativo (S/N)                              |
| `fatura_pedido`     | flag    | Pode faturar pedidos (S/N)                 |
| `visualiza_pedido`  | flag    | Visualiza apenas os próprios pedidos (S/N) |
| `comissao`          | number  | Percentual de comissão                     |

## pedidos_venda

Pedidos de venda (cabeçalho e totais). Itens em pedido_venda_itens.

- **Primary key:** `codigo_pedido`
- **List:** `produtos/pedido` → `ListarPedidos`; lookup by key: `ConsultarPedido`
- **Remote filters:** `numero_pedido` (= → `numero_pedido_de/numero_pedido_ate`), `codigo_cliente` (= → `filtrar_por_cliente`), `codigo_vendedor` (= → `filtrar_por_vendedor`), `etapa` (= → `etapa`)
- **Writes:** INSERT unsupported · UPDATE chosen from the updated columns · DELETE `ExcluirPedido`
- **Updatable:** `data_previsao`, `etapa`, `numero_pedido_cliente`, `obs_venda`
- **Note:** INSERT is not supported: creating an order needs items, taxes and installments in one payload.
- **Note:** AlterarPedidoVenda partial payload is UNCONFIRMED; Omie may require the full order.

| Column                     | Type    | Description                                |
| -------------------------- | ------- | ------------------------------------------ |
| `codigo_pedido` (PK)       | integer | Código do pedido no Omie                   |
| `codigo_pedido_integracao` | string  | Código de integração                       |
| `numero_pedido`            | string  | Número do pedido                           |
| `codigo_cliente`           | integer | Cliente → `clientes.codigo_cliente_omie`   |
| `data_previsao`            | date    | Data de previsão de faturamento            |
| `etapa`                    | string  | Etapa (10, 20, 30, 40, 50, 60...)          |
| `codigo_parcela`           | string  | Condição de pagamento                      |
| `quantidade_itens`         | integer | Quantidade de itens                        |
| `valor_mercadorias`        | number  | Valor das mercadorias                      |
| `valor_descontos`          | number  | Valor dos descontos                        |
| `valor_total_pedido`       | number  | Valor total do pedido                      |
| `valor_icms`               | number  | Valor do ICMS                              |
| `codigo_categoria`         | string  | Categoria financeira → `categorias.codigo` |
| `codigo_conta_corrente`    | integer | Conta corrente                             |
| `numero_pedido_cliente`    | string  | Número do pedido do cliente                |
| `codigo_vendedor`          | integer | Vendedor → `vendedores.codigo`             |
| `valor_frete`              | number  | Valor do frete                             |
| `obs_venda`                | string  | Observações da venda                       |
| `faturado`                 | flag    | Faturado (S/N)                             |
| `cancelado`                | flag    | Cancelado (S/N)                            |
| `data_faturamento`         | date    | Data de faturamento                        |
| `data_inclusao`            | date    | Data de inclusão do registro               |
| `data_alteracao`           | date    | Data da última alteração                   |

## pedido_venda_itens

Itens dos pedidos de venda (uma linha por item). Somente leitura.

- **Primary key:** `codigo_pedido`, `codigo_item`
- **List:** `produtos/pedido` → `ListarPedidos`; lookup by key: `ConsultarPedido`
- **Remote filters:** none — every predicate is evaluated locally
- **Writes:** INSERT unsupported · UPDATE unsupported · DELETE unsupported

| Column               | Type    | Description                            |
| -------------------- | ------- | -------------------------------------- |
| `codigo_pedido` (PK) | integer | Pedido → `pedidos_venda.codigo_pedido` |
| `codigo_item` (PK)   | integer | Código do item                         |
| `numero_pedido`      | string  | Número do pedido                       |
| `codigo_produto`     | integer | Produto → `produtos.codigo_produto`    |
| `codigo`             | string  | Código (SKU)                           |
| `descricao`          | string  | Descrição                              |
| `cfop`               | string  | CFOP                                   |
| `ncm`                | string  | NCM                                    |
| `unidade`            | string  | Unidade                                |
| `quantidade`         | number  | Quantidade                             |
| `valor_unitario`     | number  | Valor unitário                         |
| `valor_desconto`     | number  | Desconto                               |
| `valor_total`        | number  | Valor total do item                    |
| `obs_item`           | string  | Observação do item                     |

## categorias

Plano de categorias financeiras (receitas e despesas).

- **Primary key:** `codigo`
- **List:** `geral/categorias` → `ListarCategorias`; lookup by key: `ConsultarCategoria`
- **Remote filters:** none — every predicate is evaluated locally
- **Writes:** INSERT `IncluirCategoria` · UPDATE `AlterarCategoria` · DELETE unsupported
- **Required on INSERT:** `descricao`, `categoria_superior`
- **Updatable:** `descricao`, `conta_inativa`, `natureza`, `codigo_dre`

| Column                  | Type   | Description                        |
| ----------------------- | ------ | ---------------------------------- |
| `codigo` (PK)           | string | Código da categoria (ex.: 1.01.02) |
| `descricao`             | string | Descrição                          |
| `categoria_superior`    | string | Categoria totalizadora superior    |
| `descricao_padrao`      | string | Descrição padrão                   |
| `tipo_categoria`        | string | Tipo (R = receita, D = despesa)    |
| `conta_inativa`         | flag   | Inativa (S/N)                      |
| `totalizadora`          | flag   | Categoria totalizadora (S/N)       |
| `conta_receita`         | flag   | Conta de receita (S/N)             |
| `conta_despesa`         | flag   | Conta de despesa (S/N)             |
| `natureza`              | string | Natureza                           |
| `codigo_dre`            | string | Código no DRE                      |
| `definida_pelo_usuario` | flag   | Definida pelo usuário (S/N)        |
| `transferencia`         | flag   | Categoria de transferência (S/N)   |

## contas_receber

Lançamentos de contas a receber.

- **Primary key:** `codigo_lancamento_omie`
- **List:** `financas/contareceber` → `ListarContasReceber`; lookup by key: `ConsultarContaReceber`
- **Remote filters:** `codigo_cliente_fornecedor` (= → `filtrar_cliente`)
- **Writes:** INSERT `IncluirContaReceber` · UPDATE `AlterarContaReceber` · DELETE `ExcluirContaReceber`
- **Required on INSERT:** `codigo_lancamento_integracao`, `codigo_cliente_fornecedor`, `data_vencimento`, `valor_documento`, `codigo_categoria`
- **Updatable:** `data_vencimento`, `data_previsao`, `valor_documento`, `codigo_categoria`, `id_conta_corrente`, `numero_documento`, `observacao`
- **Note:** status_titulo is computed by Omie and is filtered locally only.

| Column                         | Type    | Description                                                |
| ------------------------------ | ------- | ---------------------------------------------------------- |
| `codigo_lancamento_omie` (PK)  | integer | Código do lançamento no Omie                               |
| `codigo_lancamento_integracao` | string  | Código de integração                                       |
| `codigo_cliente_fornecedor`    | integer | Cliente → `clientes.codigo_cliente_omie`                   |
| `data_emissao`                 | date    | Data de emissão                                            |
| `data_vencimento`              | date    | Data de vencimento                                         |
| `data_previsao`                | date    | Data de previsão                                           |
| `valor_documento`              | number  | Valor do documento                                         |
| `codigo_categoria`             | string  | Categoria financeira → `categorias.codigo`                 |
| `id_conta_corrente`            | integer | Conta corrente                                             |
| `numero_documento`             | string  | Número do documento                                        |
| `numero_parcela`               | string  | Parcela (ex.: 001/003)                                     |
| `numero_pedido`                | string  | Número do pedido de origem                                 |
| `codigo_pedido`                | integer | Pedido de origem → `pedidos_venda.codigo_pedido`           |
| `status_titulo`                | string  | Situação (A VENCER, ATRASADO, RECEBIDO/PAGO, CANCELADO...) |
| `observacao`                   | string  | Observação                                                 |
| `data_inclusao`                | date    | Data de inclusão do registro                               |
| `data_alteracao`               | date    | Data da última alteração                                   |

## contas_pagar

Lançamentos de contas a pagar.

- **Primary key:** `codigo_lancamento_omie`
- **List:** `financas/contapagar` → `ListarContasPagar`; lookup by key: `ConsultarContaPagar`
- **Remote filters:** `codigo_cliente_fornecedor` (= → `filtrar_cliente`)
- **Writes:** INSERT `IncluirContaPagar` · UPDATE `AlterarContaPagar` · DELETE `ExcluirContaPagar`
- **Required on INSERT:** `codigo_lancamento_integracao`, `codigo_cliente_fornecedor`, `data_vencimento`, `valor_documento`, `codigo_categoria`
- **Updatable:** `data_vencimento`, `data_previsao`, `valor_documento`, `codigo_categoria`, `id_conta_corrente`, `numero_documento`, `observacao`
- **Note:** Omie rejects a data_vencimento earlier than today on IncluirContaPagar.

| Column                         | Type    | Description                                                |
| ------------------------------ | ------- | ---------------------------------------------------------- |
| `codigo_lancamento_omie` (PK)  | integer | Código do lançamento no Omie                               |
| `codigo_lancamento_integracao` | string  | Código de integração                                       |
| `codigo_cliente_fornecedor`    | integer | Fornecedor → `clientes.codigo_cliente_omie`                |
| `data_emissao`                 | date    | Data de emissão                                            |
| `data_vencimento`              | date    | Data de vencimento                                         |
| `data_previsao`                | date    | Data de previsão                                           |
| `valor_documento`              | number  | Valor do documento                                         |
| `codigo_categoria`             | string  | Categoria financeira → `categorias.codigo`                 |
| `id_conta_corrente`            | integer | Conta corrente                                             |
| `numero_documento`             | string  | Número do documento                                        |
| `numero_parcela`               | string  | Parcela (ex.: 001/003)                                     |
| `numero_pedido`                | string  | Número do pedido de origem                                 |
| `codigo_pedido`                | integer | Pedido de origem → `pedidos_venda.codigo_pedido`           |
| `status_titulo`                | string  | Situação (A VENCER, ATRASADO, RECEBIDO/PAGO, CANCELADO...) |
| `observacao`                   | string  | Observação                                                 |
| `data_inclusao`                | date    | Data de inclusão do registro                               |
| `data_alteracao`               | date    | Data da última alteração                                   |

## nfes

Notas fiscais eletrônicas (consulta). Somente leitura: emissão e cancelamento não são expostos.

- **Primary key:** `id_nf`
- **List:** `produtos/nfconsultar` → `ListarNF`; lookup by key: `ConsultarNF`
- **Remote filters:** `numero_nf` (= → `nNFInicial/nNFFinal`), `codigo_cliente` (= → `nIdCliente`), `tipo_nf` (= → `tpNF`)
- **Writes:** INSERT unsupported · UPDATE unsupported · DELETE unsupported

| Column                      | Type    | Description                                      |
| --------------------------- | ------- | ------------------------------------------------ |
| `id_nf` (PK)                | integer | Identificador da NF no Omie                      |
| `numero_nf`                 | string  | Número da NF                                     |
| `serie`                     | string  | Série                                            |
| `modelo`                    | string  | Modelo (55 = NF-e)                               |
| `chave_nfe`                 | string  | Chave de acesso                                  |
| `data_emissao`              | date    | Data de emissão                                  |
| `tipo_nf`                   | string  | Tipo (0 = entrada, 1 = saída)                    |
| `ambiente`                  | string  | Ambiente (1 = produção, 2 = homologação)         |
| `finalidade`                | string  | Finalidade                                       |
| `codigo_pedido`             | integer | Pedido de origem → `pedidos_venda.codigo_pedido` |
| `codigo_cliente`            | integer | Destinatário → `clientes.codigo_cliente_omie`    |
| `razao_social_destinatario` | string  | Razão social do destinatário                     |
| `cnpj_cpf_destinatario`     | string  | CNPJ/CPF do destinatário                         |
| `valor_produtos`            | number  | Valor dos produtos                               |
| `valor_nf`                  | number  | Valor total da NF                                |
| `valor_icms`                | number  | Valor do ICMS                                    |
| `valor_frete`               | number  | Valor do frete                                   |
| `valor_desconto`            | number  | Valor do desconto                                |
| `numero_pedido`             | string  | Número do pedido                                 |
| `codigo_vendedor`           | integer | Vendedor → `vendedores.codigo`                   |
| `data_cancelamento`         | date    | Data de cancelamento                             |

## Payloads marked UNCONFIRMED

Some write payloads were modelled from the public Omie documentation but have not been
exercised against a live account (development uses the mock only). They are flagged in the
notes above and in `DESCRIBE`. Test them on a sandbox Omie account before enabling the
corresponding `OMIE_ALLOW_*` flag in production.
