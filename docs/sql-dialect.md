# SQL dialect

The explorer speaks a deliberately small SQL dialect. Everything it accepts is translated into
Omie API calls; everything it does not support fails with `SQL_UNSUPPORTED` and a message that
says why. Nothing is silently ignored.

One statement runs at a time. In the editor, `Ctrl+Enter` runs the statement under the cursor
(statements are separated by `;`). Comments use `--` or `/* … */`. Keywords are
case-insensitive; table and column names are the lowercase names shown in the schema tree.

## Metadata

```sql
SHOW TABLES;
SHOW COLUMNS FROM clientes;   -- also: SHOW FIELDS FROM clientes
DESCRIBE pedidos_venda;       -- also: DESC pedidos_venda
```

`DESCRIBE` lists columns, types, primary keys, which columns are insertable/updatable/required,
the operations the resource supports (`SELECT`, `INSERT`, `UPDATE`, `DELETE: unsupported`, …) and
any caveats from the registry.

## SELECT

```sql
SELECT [DISTINCT] <expr> [AS alias], ...
FROM <table> [alias]
[ { INNER | LEFT } JOIN <table> [alias] ON <a.col> = <b.col> [AND ...] ]
[ WHERE <condition> ]
[ GROUP BY <col>, ... ]
[ HAVING <condition> ]
[ ORDER BY <expr> [ASC | DESC], ... ]
[ LIMIT <n> [ OFFSET <m> ] ]
```

| Feature       | Supported                                                                      |
| ------------- | ------------------------------------------------------------------------------ |
| Comparison    | `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`                                          |
| Logic         | `AND`, `OR`, `NOT`, parentheses                                                |
| Sets / ranges | `IN (…)`, `NOT IN (…)`, `BETWEEN … AND …`, `NOT BETWEEN`                       |
| Patterns      | `LIKE`, `NOT LIKE` with `%` and `_` (case-insensitive), optional `ESCAPE '\'`  |
| Nulls         | `IS NULL`, `IS NOT NULL`                                                       |
| Arithmetic    | `+`, `-`, `*`, `/`, unary minus                                                |
| Aggregates    | `COUNT(*)`, `COUNT(col)`, `COUNT(DISTINCT col)`, `SUM`, `AVG`, `MIN`, `MAX`    |
| Grouping      | `GROUP BY`, `HAVING`                                                           |
| Joins         | `INNER JOIN`, `LEFT JOIN` on equality between columns (several tables allowed) |
| Paging        | `LIMIT n`, `LIMIT n OFFSET m` (integer literals)                               |
| Literals      | strings in single quotes, numbers, `NULL`                                      |

Flags in Omie are `'S'` / `'N'` strings: `WHERE inativo = 'N'`. Dates are ISO strings
(`'2026-01-31'`); the normalizer converts Omie's `dd/mm/yyyy` into ISO on the way in.

Without `LIMIT`, a SELECT returns at most `OMIE_MAX_ROWS` rows and is flagged `truncated: true`
when more exist. A `LIMIT` above `OMIE_MAX_ROWS` fails with `QUERY_ROW_LIMIT_EXCEEDED`.

Some resources need a filter to be listed at all. `tabela_preco_itens` requires
`WHERE codigo_tabela = …` (or `IN (…)`); without it the query fails before calling Omie.

### Examples

```sql
-- Pushed to Omie as clientesFiltro.estado, re-checked locally.
SELECT codigo_cliente_omie, razao_social, cidade
FROM clientes
WHERE estado = 'SP' AND inativo = 'N'
ORDER BY razao_social
LIMIT 50;

-- Primary-key lookup: one ConsultarCliente call per key.
SELECT * FROM clientes WHERE codigo_cliente_omie IN (1000001, 1000002);

-- COUNT(*) without WHERE reads the total from the response metadata (1 call).
SELECT COUNT(*) FROM produtos;

-- Join: orders with their customer names.
SELECT p.numero_pedido, c.razao_social, p.valor_total_pedido
FROM pedidos_venda p
INNER JOIN clientes c ON c.codigo_cliente_omie = p.codigo_cliente
WHERE p.etapa = '50'
ORDER BY p.valor_total_pedido DESC
LIMIT 20;

-- Aggregation.
SELECT estado, COUNT(*) AS total
FROM clientes
GROUP BY estado
HAVING COUNT(*) > 5
ORDER BY total DESC;
```

## EXPLAIN

`EXPLAIN <SELECT | INSERT | UPDATE | DELETE>` shows the plan without calling Omie for data:

- resource, endpoint and Omie call per table;
- strategy (`PK_LOOKUP`, `API_FILTER`, `FULL_SCAN`, `METADATA_COUNT`, `JOIN_LOOKUP`,
  `JOIN_FILTER`, `JOIN_SCAN`);
- remote filters (pushed to Omie) and local filters (evaluated by the engine);
- pagination and estimated API calls (a range, or "unbounded" when it depends on the data);
- risk (`LOW` / `MEDIUM` / `HIGH`) with the reasons.

## Writes

Writes are **disabled by default** (`OMIE_READ_ONLY=true`, `OMIE_ALLOW_*=false`). When enabled,
they always go through a preview and an explicit confirmation — see
[security.md](security.md#write-protection).

```sql
INSERT INTO clientes (codigo_cliente_integracao, razao_social, estado)
VALUES ('DEMO-0001', 'Empresa Fictícia Ltda', 'SP');

UPDATE clientes SET cidade = 'Campinas' WHERE codigo_cliente_omie = 1000001;

DELETE FROM clientes WHERE codigo_cliente_omie = 1000001;
```

Rules:

- `INSERT` takes exactly one row with literal values, and every required column.
- `UPDATE` and `DELETE` require a `WHERE`. The matching records are read first; more than
  `OMIE_MAX_WRITE_ROWS` targets fails with `WRITE_ROW_LIMIT_EXCEEDED`, zero targets with
  `WRITE_NO_TARGETS`.
- Only columns marked updatable in the registry can appear in `SET` (`COLUMN_NOT_WRITABLE`).
- Operations the Omie API does not offer for a resource fail with `OPERATION_NOT_SUPPORTED`
  (for example `DELETE FROM nfes`).
- `VIEWER` can only read; `OPERATOR` can `INSERT` and `UPDATE`; only `ADMIN` can `DELETE`.

## Not supported

| Construct                                                        | Why                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`                       | Omie has no transactions; we do not pretend to have them. |
| `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME`                  | Tables are defined by the resource registry.              |
| Subqueries, `WITH` (CTE), `UNION` / `INTERSECT` / `EXCEPT`       | Would hide unbounded API traffic behind one statement.    |
| `RIGHT` / `FULL` / `CROSS` JOIN, `USING`, non-equality join keys | Only hash joins on equality are planned.                  |
| Window functions, `CASE`, `CAST`, `INTERVAL`, scalar functions   | Out of scope for the first version.                       |
| Multi-row `INSERT`, `INSERT … SELECT`, `REPLACE`, upserts        | Writes are previewed and confirmed record by record.      |
| Placeholders / variables                                         | Write literal values.                                     |
| Schema-qualified names (`omie.clientes`)                         | There is a single virtual schema.                         |

Statements are limited to 20,000 characters.
