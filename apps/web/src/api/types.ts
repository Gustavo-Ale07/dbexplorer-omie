// Response shapes of the Omie SQL Explorer API (apps/api). Kept local so the browser bundle
// never pulls server-side packages.

export type Role = 'VIEWER' | 'OPERATOR' | 'ADMIN';
export const ROLES: Role[] = ['VIEWER', 'OPERATOR', 'ADMIN'];
export type Value = string | number | boolean | null;
export type RecordValues = Record<string, Value>;

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SessionInfo {
  user: User;
  expiresAt: string;
}

export interface Meta {
  name: string;
  version: string;
  commit: string;
  omieMode: 'mock' | 'live';
  aiEnabled: boolean;
}

export interface SchemaColumn {
  name: string;
  type: string;
  description: string;
  pk: boolean;
  insertable: boolean;
  updatable: boolean;
  required: boolean;
  references?: { table: string; column: string };
}

export type TableGroup = 'Geral' | 'Vendas' | 'Produtos' | 'Estoque' | 'Financeiro' | 'Fiscal';

export interface SchemaTable {
  name: string;
  group: TableGroup | string;
  description: string;
  operations: { select: boolean; insert: boolean; update: boolean; delete: boolean };
  requiredFilter?: string;
  lookupColumn?: string;
  notes: string[];
  columns: SchemaColumn[];
}

export interface OmieTrace {
  id: string;
  endpoint: string;
  call: string;
  kind: 'read' | 'write';
  startedAt: string;
  durationMs: number;
  attempts: number;
  ok: boolean;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  request: unknown;
  response: unknown;
  responseTruncated: boolean;
}

export interface PlanStep {
  table: string;
  alias: string;
  endpoint: string;
  call: string;
  strategy: string;
  remoteFilters: string[];
  localFilters: string[];
  pagination: string;
  estimatedCalls: string;
  join?: { type: 'INNER' | 'LEFT'; on: string; method: string };
}

export interface QueryPlan {
  steps: PlanStep[];
  estimatedApiCalls: { min: number; max: number | null };
  maxApiCalls: number;
  limit: number;
  implicitLimit: boolean;
  earlyStop: boolean;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  riskReasons: string[];
}

export interface WriteExplain {
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  resource: string;
  call: string;
  endpoint: string;
  where?: string;
  maxWriteRows: number;
  confirmation: 'required';
  resolution?: QueryPlan;
  risk: 'MEDIUM' | 'HIGH';
}

export interface ResultColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  type: 'result';
  executionId: string;
  kind: string;
  resource: string | null;
  columns: ResultColumn[];
  rows: Value[][];
  rowCount: number;
  truncated: boolean;
  apiCalls: number;
  durationMs: number;
  plan: QueryPlan | WriteExplain | null;
  messages: string[];
  traces: OmieTrace[];
}

export interface WriteTargetPreview {
  key: RecordValues;
  before: RecordValues | null;
  after: RecordValues;
}

export interface WritePreview {
  type: 'write_preview';
  executionId: string;
  kind: 'INSERT' | 'UPDATE' | 'DELETE';
  resource: string;
  preview: {
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    resource: string;
    endpoint: string;
    call: string;
    changedColumns: string[];
    targetCount: number;
    targets: WriteTargetPreview[];
    messages: string[];
    notice: string;
  };
  request: unknown;
  apiCalls: number;
  durationMs: number;
  traces: OmieTrace[];
  confirmation: { token: string; expiresAt: string };
}

export interface WriteStepResult {
  key: RecordValues;
  ok: boolean;
  generated?: RecordValues;
  errorCode?: string;
  errorMessage?: string;
  outcomeUnknown?: boolean;
}

export interface WriteResult {
  type: 'write_result';
  executionId: string;
  kind: string;
  resource: string;
  execution: {
    kind: string;
    resource: string;
    call: string;
    attempted: number;
    succeeded: number;
    results: WriteStepResult[];
    notAttempted: RecordValues[];
    status: 'success' | 'partial' | 'failed';
  };
  apiCalls: number;
  durationMs: number;
  traces: OmieTrace[];
  messages: string[];
}

export type QueryResponse = QueryResult | WritePreview;

export interface HistoryItem {
  id: string;
  executionId: string;
  sql: string;
  status: 'success' | 'error' | 'cancelled' | 'preview';
  operation: string | null;
  resource: string | null;
  durationMs: number | null;
  resultRows: number | null;
  affectedRows: number | null;
  apiCalls: number | null;
  errorCode: string | null;
  createdAt: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  createdAt: string;
  userId: string | null;
  userEmail: string | null;
  ip: string | null;
  requestId: string | null;
  action: string;
  operation: string | null;
  resource: string | null;
  statement: string | null;
  targetIds: unknown;
  before: unknown;
  after: unknown;
  omieCalls: unknown;
  status: 'success' | 'partial' | 'failed' | 'denied' | 'info';
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  details: unknown;
}

export interface SystemStatus {
  version: string;
  commit: string;
  environment: string;
  uptimeSeconds: number;
  database: { status: 'ok' | 'error'; kind: string };
  omie: {
    mode: 'mock' | 'live';
    connectivity: {
      status: 'mock' | 'ok' | 'error' | 'unknown';
      checkedAt: string | null;
      errorCode?: string;
      message?: string;
    };
    baseUrl?: string;
    credentialsConfigured?: boolean;
  };
  writes: { readOnly: boolean; allowInsert: boolean; allowUpdate: boolean; allowDelete: boolean };
  limits: {
    maxRows: number;
    maxApiCalls: number;
    maxWriteRows: number;
    concurrency: number;
    timeoutMs: number;
    queryTimeoutMs: number;
  };
  ai: { provider: string; model: string | null; shareResultData: boolean };
  role: Role;
}

export interface InspectResult {
  request: unknown;
  response: unknown;
  noRecords: boolean;
  durationMs: number;
  trace: OmieTrace | null;
}

export interface InspectorCall {
  id: string;
  resource: string;
  endpoint: string;
  call: string;
  kind: 'read' | 'write';
  exampleParam: unknown;
}

export interface AiSuggestion {
  sql: string;
  explanation: string;
  provider: string;
  model: string | null;
  validation: { ok: boolean; kind?: string; errorCode?: string; message?: string };
  requiresConfirmation: boolean;
}
