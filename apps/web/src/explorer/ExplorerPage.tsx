import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newExecutionId } from '../api/client';
import type { QueryResponse, SavedQuery, SchemaTable, WriteResult } from '../api/types';
import type { Theme } from '../app/theme';
import { canWrite, useSession } from '../app/session';
import { setCompletionSchema } from '../editor/monaco';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';
import { AiPanel } from './AiPanel';
import { ResultsPanel } from './ResultsPanel';
import type { ResultTab } from './ResultsPanel';
import { SchemaTree } from './SchemaTree';
import { SqlEditor } from './SqlEditor';
import type { EditorApi } from './SqlEditor';
import { WritePreviewDialog } from './WritePreviewDialog';
import type { RunState } from './runState';
import { errorTraces } from './runState';
import { loadTabs, newTab, saveTabs } from './tabs';
import type { EditorTab } from './tabs';

export interface OpenRequest {
  sql: string;
  title?: string;
  savedId?: string;
  run?: boolean;
  nonce: number;
}

interface Props {
  theme: Theme;
  openRequest: OpenRequest | null;
  active: boolean;
}

export function ExplorerPage({ theme, openRequest, active }: Props) {
  const { user, meta } = useSession();
  const qc = useQueryClient();
  const [tabs, setTabs] = useState<EditorTab[]>(() => loadTabs(user.id).tabs);
  const [activeId, setActiveId] = useState<string>(() => loadTabs(user.id).activeId);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [resultTab, setResultTab] = useState<Record<string, ResultTab>>({});
  const [showAi, setShowAi] = useState(false);
  const [showSchema, setShowSchema] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<unknown>(null);
  const [saveDialog, setSaveDialog] = useState<{ name: string; description: string } | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorHeight, setEditorHeight] = useState(45);
  const editorApi = useRef<EditorApi | null>(null);
  const aborts = useRef<Record<string, AbortController>>({});
  const splitRef = useRef<HTMLDivElement>(null);

  const schema = useQuery({
    queryKey: ['schema'],
    queryFn: () => api.get<{ tables: SchemaTable[] }>('/api/schema'),
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (schema.data) setCompletionSchema(schema.data.tables);
  }, [schema.data]);

  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0]!;
  const run: RunState = runs[tab.id] ?? { status: 'idle' };

  useEffect(() => saveTabs(user.id, tabs, tab.id), [user.id, tabs, tab.id]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2500);
  }, []);

  const setRun = (id: string, r: RunState) => setRuns((all) => ({ ...all, [id]: r }));
  const updateTab = (id: string, patch: Partial<EditorTab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const execute = useCallback(
    async (sqlText: string, tabId: string, opts: { tab?: ResultTab } = {}) => {
      const sql = sqlText.trim().replace(/;\s*$/, '');
      if (!sql) return;
      aborts.current[tabId]?.abort();
      const controller = new AbortController();
      aborts.current[tabId] = controller;
      const executionId = newExecutionId();
      setRun(tabId, { status: 'running', sql, executionId, startedAt: Date.now() });
      try {
        const res = await api.post<QueryResponse>(
          '/api/query',
          { sql, executionId },
          { signal: controller.signal },
        );
        if (res.type === 'write_preview') {
          setRun(tabId, { status: 'preview', sql, preview: res });
          setResultTab((m) => ({ ...m, [tabId]: 'results' }));
          setConfirmError(null);
          setPreviewOpen(true);
        } else {
          setRun(tabId, { status: 'result', sql, result: res });
          const target = opts.tab ?? (res.kind === 'EXPLAIN' ? 'explain' : 'results');
          setResultTab((m) => ({ ...m, [tabId]: target }));
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setRun(tabId, {
            status: 'error',
            sql,
            error: new ApiError(499, { code: 'QUERY_CANCELLED', message: 'Cancelled by the user' }),
            traces: [],
          });
        } else {
          setRun(tabId, { status: 'error', sql, error: err, traces: errorTraces(err) });
          setResultTab((m) => ({ ...m, [tabId]: 'results' }));
        }
      } finally {
        if (aborts.current[tabId] === controller) delete aborts.current[tabId];
        void qc.invalidateQueries({ queryKey: ['history'] });
      }
    },
    [qc],
  );

  const runCurrent = useCallback(() => {
    const cur = editorApi.current?.currentSql();
    void execute(cur?.sql || tab.sql, tab.id);
  }, [execute, tab.id, tab.sql]);

  const explainCurrent = useCallback(() => {
    const sql = (editorApi.current?.currentSql().sql || tab.sql).trim();
    if (!sql) return;
    void execute(/^explain\b/i.test(sql) ? sql : `EXPLAIN ${sql}`, tab.id, { tab: 'explain' });
  }, [execute, tab.id, tab.sql]);

  async function cancel() {
    if (run.status !== 'running') return;
    try {
      await api.post('/api/query/cancel', { executionId: run.executionId });
    } catch {
      // The local abort below is enough to stop waiting.
    }
    aborts.current[tab.id]?.abort();
  }

  async function confirmWrite() {
    if (run.status !== 'preview') return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      const write = await api.post<WriteResult>('/api/query/confirm', {
        sql: run.sql,
        token: run.preview.confirmation.token,
      });
      setRun(tab.id, { status: 'write', sql: run.sql, preview: run.preview, write });
      setPreviewOpen(false);
      setResultTab((m) => ({ ...m, [tab.id]: 'results' }));
      void qc.invalidateQueries({ queryKey: ['history'] });
    } catch (err) {
      setConfirmError(err);
    } finally {
      setConfirmBusy(false);
    }
  }

  function cancelPreview() {
    setPreviewOpen(false);
    if (run.status === 'preview') flash('Escrita cancelada. Nada foi enviado ao Omie.');
  }

  const save = useCallback(() => {
    if (tab.savedId) {
      api
        .put<{ item: SavedQuery }>(`/api/saved-queries/${tab.savedId}`, {
          name: tab.title,
          sql: tab.sql,
        })
        .then(() => {
          updateTab(tab.id, { dirty: false });
          void qc.invalidateQueries({ queryKey: ['saved'] });
          flash('Consulta salva.');
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) {
            updateTab(tab.id, { savedId: undefined });
            setSaveDialog({ name: tab.title, description: '' });
          } else setSaveError(err);
        });
    } else {
      setSaveError(null);
      setSaveDialog({ name: tab.title.startsWith('Consulta ') ? '' : tab.title, description: '' });
    }
  }, [tab, qc, flash]);

  async function submitSave() {
    if (!saveDialog) return;
    try {
      const { item } = await api.post<{ item: SavedQuery }>('/api/saved-queries', {
        name: saveDialog.name.trim(),
        sql: tab.sql,
        ...(saveDialog.description.trim() ? { description: saveDialog.description.trim() } : {}),
      });
      updateTab(tab.id, { savedId: item.id, title: item.name, dirty: false });
      setSaveDialog(null);
      void qc.invalidateQueries({ queryKey: ['saved'] });
      flash('Consulta salva.');
    } catch (err) {
      setSaveError(err);
    }
  }

  function addTab(init?: Partial<EditorTab>) {
    const t = { ...newTab(tabs), ...init };
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    return t;
  }

  function closeTab(id: string) {
    const t = tabs.find((x) => x.id === id);
    if (t?.dirty && t.sql.trim() && !window.confirm(`Fechar "${t.title}" sem salvar?`)) return;
    aborts.current[id]?.abort();
    setTabs((ts) => {
      const rest = ts.filter((x) => x.id !== id);
      const next = rest.length > 0 ? rest : [newTab([])];
      if (id === activeId) setActiveId(next[Math.max(0, ts.findIndex((x) => x.id === id) - 1)]!.id);
      return next;
    });
  }

  // Open requests from History / Saved queries.
  const lastNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!openRequest || openRequest.nonce === lastNonce.current) return;
    lastNonce.current = openRequest.nonce;
    const existing = openRequest.savedId
      ? tabs.find((t) => t.savedId === openRequest.savedId)
      : undefined;
    const target = existing
      ? (updateTab(existing.id, { sql: openRequest.sql }), setActiveId(existing.id), existing)
      : addTab({
          sql: openRequest.sql,
          ...(openRequest.title ? { title: openRequest.title } : {}),
          ...(openRequest.savedId ? { savedId: openRequest.savedId } : {}),
        });
    if (openRequest.run) void execute(openRequest.sql, target.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  function openTableQuery(sql: string) {
    if (tab.sql.trim() === '' || !tab.dirty) {
      updateTab(tab.id, { sql });
      void execute(sql, tab.id);
    } else {
      const t = addTab({ sql });
      void execute(sql, t.id);
    }
  }

  function startSplitDrag(e: React.PointerEvent) {
    e.preventDefault();
    const box = splitRef.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: PointerEvent) => {
      const pct = ((ev.clientY - box.top) / box.height) * 100;
      setEditorHeight(Math.max(15, Math.min(85, pct)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const resultSample = () =>
    run.status === 'result'
      ? { columns: run.result.columns.map((c) => c.name), rows: run.result.rows.slice(0, 20) }
      : null;

  return (
    <div className="flex h-full min-h-0">
      {showSchema && (
        <aside className="w-64 shrink-0 border-r border-line bg-panel" aria-label="Schema">
          <SchemaTree
            tables={schema.data?.tables}
            loading={schema.isPending}
            onSelectQuery={openTableQuery}
            onInsertText={(text) => editorApi.current?.insertText(text)}
          />
          {schema.isError && <ErrorBox error={schema.error} className="m-2" />}
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col" ref={splitRef}>
        {/* Editor tabs */}
        <div
          className="flex items-end gap-0.5 overflow-x-auto border-b border-line bg-panel2 px-1 pt-1"
          role="tablist"
          aria-label="Abas do editor"
        >
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`group flex items-center rounded-t border border-b-0 text-xs ${
                t.id === tab.id
                  ? 'border-line bg-panel font-semibold'
                  : 'border-transparent text-muted hover:bg-hover'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={t.id === tab.id}
                className="max-w-48 truncate py-1 pr-1 pl-2.5"
                onClick={() => setActiveId(t.id)}
                onDoubleClick={() => {
                  const name = window.prompt('Nome da aba', t.title);
                  if (name?.trim()) updateTab(t.id, { title: name.trim().slice(0, 120) });
                }}
                title={t.title}
              >
                {t.dirty ? '● ' : ''}
                {t.title}
              </button>
              <button
                type="button"
                className="mr-1 rounded px-1 text-muted opacity-60 hover:bg-hover hover:opacity-100"
                onClick={() => closeTab(t.id)}
                aria-label={`Fechar aba ${t.title}`}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="mb-0.5 rounded px-2 py-0.5 text-sm text-muted hover:bg-hover"
            onClick={() => addTab()}
            aria-label="Nova aba"
            title="Nova aba"
          >
            +
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1 border-b border-line bg-panel px-2 py-1">
          <button
            type="button"
            className="btn"
            onClick={() => setShowSchema((s) => !s)}
            aria-pressed={showSchema}
            title="Mostrar/ocultar schema"
          >
            ☰
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={runCurrent}
            disabled={run.status === 'running'}
            title="Executar (Ctrl+Enter / F5)"
            data-testid="run-query"
          >
            ▶ Executar
          </button>
          <button
            type="button"
            className="btn"
            onClick={explainCurrent}
            disabled={run.status === 'running'}
            title="Plano de execução sem chamar a API (Ctrl+Shift+E)"
          >
            Explain
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void cancel()}
            disabled={run.status !== 'running'}
            title="Cancelar consulta em execução"
          >
            ■ Cancelar
          </button>
          <button type="button" className="btn" onClick={save} title="Salvar consulta (Ctrl+S)">
            Salvar
          </button>
          <span className="mx-1 h-4 w-px bg-line" aria-hidden />
          <button
            type="button"
            className="btn"
            onClick={() => setShowAi((s) => !s)}
            aria-pressed={showAi}
            data-testid="toggle-ai"
          >
            ✦ IA
          </button>
          {!canWrite(user.role) && (
            <span className="ml-2 text-[11px] text-muted">Perfil somente leitura</span>
          )}
          {notice && (
            <span role="status" className="ml-2 text-[11px] text-ok">
              {notice}
            </span>
          )}
          <span className="ml-auto text-[11px] text-muted">
            Ctrl+Enter executa a instrução sob o cursor (ou a seleção) · Ctrl+Space sugere
          </span>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div
              style={{ height: `${editorHeight}%` }}
              className="min-h-0"
              data-testid="sql-editor"
            >
              {active && (
                <SqlEditor
                  key={tab.id}
                  path={`tab-${tab.id}.sql`}
                  value={tab.sql}
                  theme={theme}
                  onChange={(v) => updateTab(tab.id, { sql: v, dirty: true })}
                  onRun={runCurrent}
                  onSave={save}
                  onExplain={explainCurrent}
                  apiRef={editorApi}
                />
              )}
            </div>
            <div
              className="h-1.5 shrink-0 cursor-row-resize border-y border-line bg-panel2 hover:bg-accent/30"
              onPointerDown={startSplitDrag}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Redimensionar editor e resultados"
            />
            <div className="min-h-0 flex-1">
              <ResultsPanel
                run={run}
                tab={resultTab[tab.id] ?? 'results'}
                onTab={(t) => setResultTab((m) => ({ ...m, [tab.id]: t }))}
                onReviewPreview={() => {
                  setConfirmError(null);
                  setPreviewOpen(true);
                }}
              />
            </div>
          </div>
          {showAi && (
            <div className="w-80 shrink-0">
              <AiPanel
                enabled={meta?.aiEnabled ?? false}
                currentSql={() => tab.sql}
                resultSample={resultSample}
                onInsert={(sql) => {
                  updateTab(tab.id, {
                    sql: tab.sql.trim() ? `${tab.sql.replace(/\s*$/, '')}\n\n${sql}` : sql,
                    dirty: true,
                  });
                }}
                onExplain={(sql) =>
                  void execute(/^explain\b/i.test(sql) ? sql : `EXPLAIN ${sql}`, tab.id, {
                    tab: 'explain',
                  })
                }
                onExecute={(sql) => void execute(sql, tab.id)}
                onClose={() => setShowAi(false)}
              />
            </div>
          )}
        </div>
      </div>

      <WritePreviewDialog
        preview={previewOpen && run.status === 'preview' ? run.preview : null}
        busy={confirmBusy}
        error={confirmError}
        onConfirm={() => void confirmWrite()}
        onCancel={cancelPreview}
      />

      <Modal
        open={saveDialog !== null}
        title="Salvar consulta"
        onClose={() => setSaveDialog(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setSaveDialog(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!saveDialog?.name.trim()}
              onClick={() => void submitSave()}
              data-testid="save-confirm"
            >
              Salvar
            </button>
          </>
        }
      >
        {saveDialog && (
          <form
            className="space-y-2 text-xs"
            onSubmit={(e) => {
              e.preventDefault();
              void submitSave();
            }}
          >
            <label className="block space-y-1">
              <span className="font-medium">Nome</span>
              <input
                className="input w-full"
                value={saveDialog.name}
                maxLength={120}
                autoFocus
                onChange={(e) => setSaveDialog({ ...saveDialog, name: e.target.value })}
                data-testid="save-name"
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Descrição (opcional)</span>
              <textarea
                className="input h-16 w-full"
                value={saveDialog.description}
                maxLength={1000}
                onChange={(e) => setSaveDialog({ ...saveDialog, description: e.target.value })}
              />
            </label>
            <ErrorBox error={saveError} />
          </form>
        )}
      </Modal>
    </div>
  );
}
