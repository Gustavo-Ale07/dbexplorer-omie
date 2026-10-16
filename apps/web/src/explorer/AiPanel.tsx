import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AiSuggestion, SystemStatus, Value } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { translateCode } from '../api/errors';

interface Props {
  enabled: boolean;
  currentSql: () => string;
  resultSample: () => { columns: string[]; rows: Value[][] } | null;
  onInsert: (sql: string) => void;
  onExplain: (sql: string) => void;
  onExecute: (sql: string) => void;
  onClose: () => void;
}

/**
 * The assistant only suggests SQL. Nothing runs until the user clicks a button, and every
 * suggestion goes through the same validation, permissions and write confirmation as typed SQL.
 */
export function AiPanel({
  enabled,
  currentSql,
  resultSample,
  onInsert,
  onExplain,
  onExecute,
  onClose,
}: Props) {
  const [question, setQuestion] = useState('');
  const [includeSql, setIncludeSql] = useState(true);
  const [shareSample, setShareSample] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [answer, setAnswer] = useState<AiSuggestion | null>(null);

  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api.get<SystemStatus>('/api/status'),
    enabled,
  });
  const canShare = status.data?.ai.shareResultData === true;

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (question.trim().length < 3) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const sql = includeSql ? currentSql() : '';
      const sample = canShare && shareSample ? resultSample() : null;
      setAnswer(
        await api.post<AiSuggestion>('/api/ai/generate', {
          question: question.trim(),
          ...(sql ? { currentSql: sql } : {}),
          ...(sample
            ? {
                resultSample: {
                  columns: sample.columns.slice(0, 100),
                  rows: sample.rows.slice(0, 20),
                },
              }
            : {}),
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      className="flex h-full flex-col border-l border-line bg-panel"
      aria-label="Assistente de IA"
    >
      <div className="flex items-center border-b border-line px-3 py-1.5">
        <h2 className="text-xs font-semibold">Assistente de IA</h2>
        <button
          type="button"
          className="ml-auto rounded px-1.5 text-muted hover:bg-hover"
          onClick={onClose}
          aria-label="Fechar assistente"
        >
          ×
        </button>
      </div>
      {!enabled ? (
        <p className="p-3 text-xs text-muted">
          O assistente está desabilitado neste servidor (AI_PROVIDER=disabled).
        </p>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-xs">
          <form onSubmit={(e) => void ask(e)} className="space-y-2">
            <label className="block space-y-1">
              <span className="font-medium">Pergunta</span>
              <textarea
                className="input h-24 w-full resize-y"
                placeholder="Ex.: clientes de SP cadastrados com e-mail, ordenados por nome"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                maxLength={2000}
                data-testid="ai-question"
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeSql}
                onChange={(e) => setIncludeSql(e.target.checked)}
              />
              Enviar o SQL atual como contexto
            </label>
            <label
              className={`flex items-center gap-2 ${canShare ? '' : 'text-muted'}`}
              title={
                canShare
                  ? 'Envia até 20 linhas do resultado atual ao provedor de IA'
                  : 'Desabilitado no servidor (AI_SHARE_RESULT_DATA=false)'
              }
            >
              <input
                type="checkbox"
                checked={canShare && shareSample}
                disabled={!canShare}
                onChange={(e) => setShareSample(e.target.checked)}
              />
              Enviar amostra do resultado {canShare ? '' : '(desabilitado)'}
            </label>
            <p className="text-[11px] text-muted">
              Apenas o schema (nomes de tabelas e colunas) é enviado por padrão. Dados de clientes
              não saem do servidor sem AI_SHARE_RESULT_DATA=true.
            </p>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || question.trim().length < 3}
            >
              {busy ? 'Gerando…' : 'Gerar SQL'}
            </button>
          </form>
          <ErrorBox error={error} />
          {answer && (
            <div className="space-y-2 rounded border border-line p-2" data-testid="ai-answer">
              <pre className="overflow-auto rounded bg-panel2 p-2 font-mono whitespace-pre-wrap">
                {answer.sql}
              </pre>
              {answer.explanation && <p>{answer.explanation}</p>}
              <p className="text-[11px] text-muted">
                {answer.provider}
                {answer.model ? ` · ${answer.model}` : ''}
              </p>
              {answer.validation.ok ? (
                <p className="text-ok">
                  ✓ SQL válido ({answer.validation.kind})
                  {answer.requiresConfirmation && ' — escrita: exigirá preview e confirmação.'}
                </p>
              ) : (
                <p className="text-danger">
                  ✗ {translateCode(answer.validation.errorCode ?? 'SQL_PARSE_ERROR')}{' '}
                  {answer.validation.message && (
                    <span className="text-muted">({answer.validation.message})</span>
                  )}
                </p>
              )}
              <div className="flex flex-wrap gap-1">
                <button type="button" className="btn" onClick={() => onInsert(answer.sql)}>
                  Inserir no editor
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onExplain(answer.sql)}
                  disabled={!answer.validation.ok}
                >
                  Explain
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onExecute(answer.sql)}
                  disabled={!answer.validation.ok}
                  title="Executa somente após o seu clique; escritas ainda pedem confirmação"
                >
                  Executar
                </button>
              </div>
              <p className="text-[11px] text-muted">
                Revise a sugestão antes de executar. O assistente nunca executa nada sozinho.
              </p>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
