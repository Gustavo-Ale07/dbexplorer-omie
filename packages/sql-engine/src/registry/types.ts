/**
 * The resource registry maps virtual SQL tables onto Omie API calls. It is the
 * single source of truth for: which endpoints may be called (allowlist), the
 * column ↔ JSON path mapping, which filters can be pushed to Omie, and which
 * write operations exist for each resource.
 */
export type ColumnType = 'integer' | 'number' | 'string' | 'date' | 'flag';

export type SchemaGroup = 'Geral' | 'Vendas' | 'Produtos' | 'Estoque' | 'Financeiro' | 'Fiscal';

export type RawRecord = Record<string, unknown>;

export interface ColumnDef {
  name: string;
  type: ColumnType;
  /** pt-BR description shown in the schema explorer. */
  description: string;
  /** Dot path inside the raw Omie record (`$parent.x` reads the enclosing record of an exploded row). */
  path: string;
  /** Custom reader for computed columns (e.g. tags joined into one string). */
  read?: (raw: RawRecord) => unknown;
  pk?: boolean;
  /** Allowed in INSERT. */
  insertable?: boolean;
  /** Mandatory in INSERT. */
  required?: boolean;
  /** Allowed in UPDATE SET. */
  updatable?: boolean;
  /** Declared relationship, used for JOIN validation and the schema explorer. */
  references?: { table: string; column: string };
  /** Upper bound for string writes. */
  maxLength?: number;
}

export interface ListSpec {
  endpoint: string;
  call: string;
  /** Dot path of the record array inside the response body. */
  arrayPath: string;
  paging: 'std' | 'n';
  /** Page size used for scans (≤ Omie maximum for the method). */
  pageSize: number;
  /** Static/base request params; a function so dates are computed per call. */
  baseParam?: () => Record<string, unknown>;
  /** When set, each list record yields one row per element of this array (e.g. order items). */
  explode?: string;
  /** Dot path in the response body whose object becomes `$parent` for each row. */
  parentPath?: string;
  /** False when the request page size cannot be tuned to the SQL LIMIT (exploded resources). */
  pageSizePushdown?: boolean;
}

export interface LookupSpec {
  call: string;
  /** Column whose `=` / IN value keys the Consultar* call (default: the single PK column). */
  column?: string;
  /** Builds the Consultar* param from the PK value. */
  param: (pk: unknown) => Record<string, unknown>;
  /** Dot path to the record in the response (default: the body itself). */
  unwrap?: string;
}

export type PushdownKind = 'eq' | 'like';

export interface PushdownDef {
  column: string;
  kind: PushdownKind;
  /** Omie request parameter this filter maps to, for EXPLAIN. */
  param: string;
  /** Accepts several values in one request (e.g. clientesPorCodigo arrays). */
  multi?: boolean;
  apply: (param: Record<string, unknown>, values: unknown[]) => void;
}

export interface WriteOp {
  call: string;
  /** Columns that identify the record in this call. */
  key: string[];
  /** Wire path overrides per column (default: the column's read path). */
  paths?: Record<string, string>;
  /** Extra constant params. */
  extra?: Record<string, unknown>;
}

export interface InsertOp extends WriteOp {
  /** Response fields that carry the generated key, per PK column. */
  returns: Record<string, string>;
}

export interface ResourceWrites {
  insert?: InsertOp;
  /** Chooses the call from the set of updated columns; throws AppError when the mix is unsupported. */
  update?: WriteOp | ((columns: string[]) => WriteOp);
  delete?: WriteOp;
}

export interface ResourceDef {
  name: string;
  group: SchemaGroup;
  /** pt-BR description. */
  description: string;
  list: ListSpec;
  lookup?: LookupSpec;
  columns: ColumnDef[];
  pushdown: PushdownDef[];
  writes: ResourceWrites;
  /** Column that must be filtered with = / IN (the API cannot list without it). */
  requiredFilter?: string;
  /** Free-form caveats shown in DESCRIBE / docs (e.g. UNCONFIRMED payload shapes). */
  notes?: string[];
}

export interface Registry {
  resources: ReadonlyMap<string, ResourceDef>;
  get(name: string): ResourceDef | undefined;
}
