import { useEffect, useMemo, useState } from 'react';
import type { OmieTrace } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { JsonView } from '../components/JsonView';
import {
  downloadText,
  formatDuration,
  timestampForFile,
  toCsv,
  toJsonRecords,
  toTsv,
} from '../lib/format';
import { ExplainView } from './ExplainView';
import { ResultGrid } from './ResultGrid';
import type { RunState } from './runState';
import { tracesOf } from './runState';

export type ResultTab = 'results' | 'json' | 'request' | 'response' | 'explain' | 'messages';

const TABS: { id: ResultTab; label: string }[] = [
  { id: 'results', label: 'Results' },
  { id: 'json', label: 'JSON' },
  { id: 'request', label: 'API Request' },
  { id: 'response', label: 'API Response' },
  { id: 'explain', label: 'Explain' },
  { id: 'messages', label: 'Messages' },
];

interface Props {
  run: RunState;
  tab: ResultTab;
  onTab: (t: ResultTab) => void;
  onReviewPreview: () => void;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  return <>{formatDuration(now - since)}</>;
}

function traceView(traces: OmieTrace[], part: 'request' | 'response') {
  if (traces.length === 0) return undefined;
  return traces.map((t) => ({
    call: `${t.endpoint} · ${t.call}`,
    kind: t.kind,
    ok: t.ok,
    durationMs: t.durationMs,
    attempts: t.attempts,
    ...(part === 'request'
      ? { request: t.request }
      : {
          httpStatus: t.httpStatus,
          ...(t.errorCode ? { errorCode: t.errorCode, errorMessage: t.errorMessage } : {}),
          response: t.response,
          ...(t.responseTruncated ? { responseTruncated: true } : {}),
        }),
  }));
}

export function ResultsPanel({ run, tab, onTab, onReviewPreview }: Props) {
  const traces = tracesOf(run);
  const result = run.status === 'result' ? run.result : null;
  const columnNames = useMemo(() => result?.columns.map((c) => c.name) ?? [], [result]);
  const records = useMemo(
    () => (result ? toJsonRecords(columnNames, result.rows) : undefined),
    [result, columnNames],
  );

  const messages: string[] = [];
  if (run.status === 'result') {
    messages.push(...run.result.messages);
    if (run.result.truncated)
      messages.push(
        `Resultado truncated: exibindo ${run.result.rowCount} linha(s) pelo limite implícito. Use LIMIT/OFFSET ou filtros para refinar.`,
      );
  }
  if (run.status === 'preview')
    messages.push(...run.preview.preview.messages, run.preview.preview.notice);
  if (run.status === 'write') messages.push(...run.write.messages);

  const requestValue =
    run.status === 'preview' || run.status === 'write'
      ? {
          preparedWriteRequest: run.preview.request,
          ...(traceView(traces, 'request') ? { calls: traceView(traces, 'request') } : {}),
        }
      : traceView(traces, 'request');

  function exportCsv() {
    if (!result) return;
    downloadText(
      `${result.resource ?? 'resultado'}-${timestampForFile()}.csv`,
      `\uFEFF${toCsv(columnNames, result.rows)}`,
      'text/csv;charset=utf-8',
    );
  }
  function exportJson() {
    if (!result) return;
    downloadText(
      `${result.resource ?? 'resultado'}-${timestampForFile()}.json`,
      JSON.stringify(records, null, 2),
      'application/json',
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="Resultados">
      <div className="flex items-center gap-0.5 border-b border-line bg-panel2 px-1" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`px-3 py-1.5 text-xs ${
              tab === t.id ? 'border-b-2 border-accent font-semibold' : 'text-muted hover:text-fg'
            }`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
            {t.id === 'messages' && messages.length > 0 ? ` (${messages.length})` : ''}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 pr-1">
          {result && result.columns.length > 0 && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => void navigator.clipboard.writeText(toTsv(columnNames, result.rows))}
                title="Copiar tudo (TSV, cola em planilhas)"
              >
                Copiar
              </button>
              <button type="button" className="btn" onClick={exportCsv}>
                CSV
              </button>
              <button type="button" className="btn" onClick={exportJson}>
                JSON
              </button>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1" role="tabpanel">
        {tab === 'results' && (
          <>
            {run.status === 'idle' && (
              <div className="p-3 text-xs text-muted">
                Execute uma consulta com Ctrl+Enter ou F5. Experimente: <code>SHOW TABLES</code>
              </div>
            )}
            {run.status === 'running' && (
              <div className="p-3 text-xs text-muted" role="status">
                Executando… <Elapsed since={run.startedAt} />
              </div>
            )}
            {run.status === 'error' && <ErrorBox error={run.error} className="m-3" />}
            {result && (
              <ResultGrid
                columns={result.columns}
                rows={result.rows}
                resultKey={result.executionId}
              />
            )}
            {run.status === 'preview' && (
              <div className="space-y-2 p-3 text-xs">
                <p>
                  Preview de <strong>{run.preview.preview.operation}</strong> em{' '}
                  <code>{run.preview.resource}</code>: {run.preview.preview.targetCount} registro(s)
                  seriam afetados. Nada foi enviado ao Omie ainda.
                </p>
                <button type="button" className="btn btn-primary" onClick={onReviewPreview}>
                  Revisar e confirmar
                </button>
              </div>
            )}
            {run.status === 'write' && <WriteOutcome run={run} />}
          </>
        )}
        {tab === 'json' && (
          <JsonView
            value={
              result
                ? records
                : run.status === 'preview'
                  ? run.preview.preview
                  : run.status === 'write'
                    ? run.write.execution
                    : undefined
            }
            emptyText="Sem resultado."
            testId="result-json"
          />
        )}
        {tab === 'request' && (
          <JsonView
            value={requestValue}
            emptyText="Nenhuma chamada à API Omie nesta execução."
            testId="api-request"
          />
        )}
        {tab === 'response' && (
          <JsonView
            value={traceView(traces, 'response')}
            emptyText="Nenhuma chamada à API Omie nesta execução."
            testId="api-response"
          />
        )}
        {tab === 'explain' && <ExplainView plan={result?.plan} />}
        {tab === 'messages' && (
          <div className="space-y-1 p-3 text-xs" data-testid="messages">
            {messages.length === 0 && run.status !== 'error' && (
              <p className="text-muted">Nenhuma mensagem.</p>
            )}
            {messages.map((m, i) => (
              <p key={i}>• {m}</p>
            ))}
            {run.status === 'error' && <ErrorBox error={run.error} />}
          </div>
        )}
      </div>

      <div
        className="flex flex-wrap items-center gap-x-4 border-t border-line bg-panel2 px-2 py-0.5 text-[11px] text-muted"
        data-testid="result-status"
      >
        {result && (
          <>
            <span>
              <strong className="text-fg">{result.rowCount}</strong> linha(s)
            </span>
            <span>{formatDuration(result.durationMs)}</span>
            <span>{result.apiCalls} chamada(s) à API</span>
            {result.truncated && (
              <span
                className="badge border-warn/60 font-semibold text-warn"
                data-testid="truncated"
              >
                truncated
              </span>
            )}
          </>
        )}
        {(run.status === 'preview' || run.status === 'write') && (
          <>
            <span>
              {run.status === 'write'
                ? `${run.write.execution.succeeded}/${run.write.execution.attempted} gravado(s)`
                : `${run.preview.preview.targetCount} registro(s) no preview`}
            </span>
            <span>
              {formatDuration(
                run.status === 'write' ? run.write.durationMs : run.preview.durationMs,
              )}
            </span>
            <span>
              {run.status === 'write' ? run.write.apiCalls : run.preview.apiCalls} chamada(s) à API
            </span>
          </>
        )}
        {run.status === 'error' && <span className="text-danger">Falhou</span>}
        {run.status === 'running' && <span>Executando…</span>}
      </div>
    </section>
  );
}

function WriteOutcome({ run }: { run: Extract<RunState, { status: 'write' }> }) {
  const ex = run.write.execution;
  const statusText =
    ex.status === 'success' ? 'Concluído' : ex.status === 'partial' ? 'Parcial' : 'Falhou';
  return (
    <div className="h-full space-y-2 overflow-auto p-3 text-xs" data-testid="write-outcome">
      <p>
        <strong
          className={
            ex.status === 'success'
              ? 'text-ok'
              : ex.status === 'partial'
                ? 'text-warn'
                : 'text-danger'
          }
        >
          {statusText}
        </strong>{' '}
        — {ex.succeeded} de {ex.attempted} chamada(s) <code>{ex.call}</code> bem-sucedida(s).
        {ex.notAttempted.length > 0 &&
          ` ${ex.notAttempted.length} registro(s) não enviados após o primeiro erro.`}
      </p>
      <table className="table-std">
        <thead>
          <tr>
            <th>Registro</th>
            <th>Status</th>
            <th>Detalhes</th>
          </tr>
        </thead>
        <tbody>
          {ex.results.map((r, i) => (
            <tr key={i}>
              <td className="font-mono">{JSON.stringify(r.generated ?? r.key)}</td>
              <td className={r.ok ? 'text-ok' : 'text-danger'}>
                {r.ok ? 'OK' : r.outcomeUnknown ? 'Resultado desconhecido' : 'Erro'}
              </td>
              <td>
                {r.errorCode && <code>{r.errorCode}</code>} {r.errorMessage}
                {r.outcomeUnknown &&
                  ' — a chamada pode ter sido aplicada; confira no Omie antes de repetir.'}
              </td>
            </tr>
          ))}
          {ex.notAttempted.map((k, i) => (
            <tr key={`na-${i}`}>
              <td className="font-mono">{JSON.stringify(k)}</td>
              <td className="text-muted">Não enviado</td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
