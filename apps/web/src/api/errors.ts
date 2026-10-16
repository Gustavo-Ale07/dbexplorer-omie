import { ApiError } from './client';

/** pt-BR messages for the API error codes (the API itself answers in English). */
export const ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Faça login para continuar.',
  INVALID_CREDENTIALS:
    'E-mail ou senha inválidos. Após várias falhas seguidas, a conta fica bloqueada por um tempo.',
  SESSION_EXPIRED: 'Sua sessão expirou. Faça login novamente.',
  ACCOUNT_LOCKED: 'Conta bloqueada temporariamente por excesso de tentativas. Tente mais tarde.',
  FORBIDDEN: 'Você não tem permissão para esta ação.',
  PASSWORD_CHANGE_REQUIRED: 'Defina uma nova senha antes de continuar.',
  CSRF_REJECTED: 'Requisição recusada pela proteção CSRF. Recarregue a página.',
  VALIDATION_ERROR: 'Dados inválidos na requisição.',
  NOT_FOUND: 'Registro não encontrado.',
  CONFLICT: 'Conflito com o estado atual.',
  RATE_LIMITED: 'Muitas requisições. Aguarde alguns segundos.',
  RESOURCE_NOT_FOUND: 'Tabela desconhecida. Use SHOW TABLES para ver as tabelas disponíveis.',
  COLUMN_NOT_FOUND: 'Coluna desconhecida. Use DESCRIBE <tabela> para ver as colunas.',
  AMBIGUOUS_COLUMN: 'Coluna ambígua: qualifique com o alias da tabela.',
  SQL_PARSE_ERROR: 'Erro de sintaxe SQL.',
  SQL_UNSUPPORTED: 'Recurso SQL não suportado por este dialeto.',
  OPERATION_NOT_SUPPORTED: 'A API Omie não expõe esta operação para o recurso.',
  COLUMN_NOT_WRITABLE: 'Esta coluna não pode ser alterada.',
  REQUIRED_COLUMN_MISSING: 'Faltam colunas obrigatórias no INSERT.',
  READ_ONLY_MODE: 'O sistema está em modo somente leitura (OMIE_READ_ONLY=true).',
  INSERT_DISABLED: 'INSERT está desabilitado (OMIE_ALLOW_INSERT=false).',
  UPDATE_DISABLED: 'UPDATE está desabilitado (OMIE_ALLOW_UPDATE=false).',
  DELETE_DISABLED: 'DELETE está desabilitado (OMIE_ALLOW_DELETE=false).',
  WHERE_REQUIRED: 'UPDATE e DELETE exigem cláusula WHERE.',
  WRITE_ROW_LIMIT_EXCEEDED: 'A escrita afetaria mais registros que o limite permitido.',
  WRITE_NO_TARGETS: 'Nenhum registro corresponde ao WHERE.',
  CONFIRMATION_REQUIRED: 'Esta operação exige confirmação.',
  CONFIRMATION_INVALID: 'Confirmação inválida. Gere um novo preview.',
  CONFIRMATION_EXPIRED: 'A confirmação expirou. Gere um novo preview.',
  CONFIRMATION_USED: 'Esta confirmação já foi utilizada.',
  TARGETS_CHANGED: 'Os registros mudaram desde o preview. Revise o novo preview.',
  QUERY_ROW_LIMIT_EXCEEDED: 'O LIMIT pedido excede o máximo de linhas permitido.',
  QUERY_LIMIT_EXCEEDED: 'A consulta excede os limites configurados.',
  API_CALL_LIMIT_EXCEEDED:
    'A consulta exigiria chamadas demais à API Omie. Adicione filtros ou LIMIT.',
  JOIN_CARDINALITY_LIMIT: 'O JOIN geraria linhas demais. Restrinja as tabelas com WHERE.',
  QUERY_TIMEOUT: 'A consulta excedeu o tempo limite.',
  QUERY_CANCELLED: 'Consulta cancelada.',
  OMIE_AUTH_ERROR: 'A API Omie recusou as credenciais configuradas no servidor.',
  OMIE_RATE_LIMITED: 'A API Omie limitou as requisições. Tente novamente em instantes.',
  OMIE_BLOCKED: 'A API Omie bloqueou temporariamente o acesso.',
  OMIE_API_ERROR: 'A API Omie retornou um erro.',
  OMIE_UNAVAILABLE: 'A API Omie está indisponível.',
  OMIE_BAD_RESPONSE: 'A API Omie retornou uma resposta inesperada.',
  OMIE_NOT_CONFIGURED: 'As credenciais Omie não estão configuradas no servidor.',
  AI_PROVIDER_DISABLED: 'O assistente de IA está desabilitado.',
  AI_PROVIDER_ERROR: 'O provedor de IA retornou um erro.',
  INTERNAL_ERROR: 'Erro interno do servidor.',
  NETWORK_ERROR: 'Não foi possível contatar o servidor.',
  HTTP_ERROR: 'Erro na requisição.',
};

export function translateCode(code: string): string {
  return ERROR_MESSAGES[code] ?? 'Erro inesperado.';
}

export interface DisplayError {
  code: string;
  title: string;
  detail: string | undefined;
  requestId: string | undefined;
}

/** The pt-BR title plus the server's own (English, more specific) message as detail. */
export function describeError(err: unknown): DisplayError {
  if (err instanceof ApiError) {
    const title = translateCode(err.code);
    return {
      code: err.code,
      title,
      detail: err.message && err.message !== title ? err.message : undefined,
      requestId: err.requestId,
    };
  }
  return {
    code: 'UNKNOWN',
    title: 'Erro inesperado.',
    detail: err instanceof Error ? err.message : undefined,
    requestId: undefined,
  };
}
