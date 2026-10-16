import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { InspectorCall, InspectResult } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { JsonView } from '../components/JsonView';
import { formatDuration, prettyJson } from '../lib/format';

/**
 * Raw Omie calls for debugging. Only read calls from the server allowlist (Resource Registry)
 * can be chosen; the URL is never typed by the user and credentials are added server-side.
 */
export function InspectorPage() {
  const calls = useQuery({
    queryKey: ['inspector-calls'],
    queryFn: () => api.get<{ items: InspectorCall[] }>('/api/inspector/calls'),
    staleTime: Infinity,
  });
  const [selected, setSelected] = useState<string>('');
  const [param, setParam] = useState('');
  const [paramError, setParamError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<InspectResult | null>(null);

  const items = useMemo(() => calls.data?.items ?? [], [calls.data]);
  const current = items.find((c) => c.id === selected);

  function choose(id: string) {
    setSelected(id);
    const c = items.find((x) => x.id === id);
    setParam(c ? prettyJson(c.exampleParam) : '');
    setParamError(null);
    setResult(null);
    setError(null);
  }

  async function execute() {
    if (!current) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(param || '{}');
    } catch {
      setParamError('JSON inválido.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setParamError('O param deve ser um objeto JSON.');
      return;
    }
    setParamError(null);
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api.post<InspectResult>('/api/inspector/execute', { id: current.id, param: parsed }),
      );
    } catch (err) {
      setError(err);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div>
        <h1 className="text-base font-semibold">API Inspector</h1>
        <p className="text-xs text-muted">
          Executa chamadas de leitura da allowlist do Resource Registry. As credenciais são
          adicionadas pelo servidor e aparecem como ***REDACTED***.
        </p>
      </div>
      <ErrorBox error={calls.error} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs">
          <span className="block font-medium">Chamada</span>
          <select
            className="input min-w-80"
            value={selected}
            onChange={(e) => choose(e.target.value)}
            data-testid="inspector-call"
          >
            <option value="">Selecione…</option>
            {items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.resource} — {c.endpoint} · {c.call}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!current || busy}
          onClick={() => void execute()}
        >
          {busy ? 'Executando…' : 'Executar chamada'}
        </button>
        {result && (
          <span className="text-xs text-muted">
            {formatDuration(result.durationMs)}
            {result.noRecords ? ' · sem registros' : ''}
          </span>
        )}
      </div>
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
        <div className="flex min-h-64 flex-col rounded border border-line bg-panel">
          <div className="border-b border-line px-2 py-1 text-xs font-semibold">param (JSON)</div>
          <textarea
            className="min-h-0 flex-1 resize-none bg-transparent p-2 font-mono text-xs outline-none"
            value={param}
            onChange={(e) => setParam(e.target.value)}
            spellCheck={false}
            aria-label="Parâmetros da chamada em JSON"
            disabled={!current}
          />
          {paramError && <div className="px-2 pb-2 text-xs text-danger">{paramError}</div>}
        </div>
        <div className="flex min-h-64 flex-col rounded border border-line bg-panel">
          <div className="border-b border-line px-2 py-1 text-xs font-semibold">
            Request / Response
          </div>
          <div className="min-h-0 flex-1">
            {error ? (
              <ErrorBox error={error} className="m-2" />
            ) : (
              <JsonView
                value={result ? { request: result.request, response: result.response } : undefined}
                emptyText="Escolha uma chamada e execute."
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
