import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../api/client';
import type { SystemStatus } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { ROLE_LABEL } from '../app/session';
import { formatDateTime, formatDuration } from '../lib/format';

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded border border-line bg-panel">
      <h2 className="border-b border-line px-3 py-1.5 text-xs font-semibold">{title}</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-3 py-2 text-xs">
        {children}
      </dl>
    </section>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

const flag = (on: boolean, onText = 'sim', offText = 'não') => (
  <span className={on ? 'text-warn' : 'text-ok'}>{on ? onText : offText}</span>
);

function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}min` : h ? `${h}h ${m}min` : `${m}min`;
}

export function StatusPage() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api.get<SystemStatus>('/api/status'),
    refetchInterval: 30_000,
  });
  const s = status.data;

  async function check() {
    const fresh = await api.get<SystemStatus>('/api/status', { query: { check: 1 } });
    qc.setQueryData(['status'], fresh);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-4" data-testid="status-page">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-base font-semibold">Status do sistema</h1>
        {s?.role === 'ADMIN' && s.omie.mode === 'live' && (
          <button type="button" className="btn" onClick={() => void check()}>
            Testar conexão com o Omie
          </button>
        )}
      </div>
      <ErrorBox error={status.error} />
      {s && (
        <div className="grid gap-3 md:grid-cols-2">
          <Card title="Aplicação">
            <Row k="Versão" v={s.version} />
            <Row k="Commit" v={<code>{s.commit.slice(0, 12)}</code>} />
            <Row k="Ambiente" v={s.environment} />
            <Row k="Uptime" v={uptime(s.uptimeSeconds)} />
            <Row k="Seu papel" v={ROLE_LABEL[s.role]} />
          </Card>
          <Card title="Banco de dados">
            <Row
              k="Status"
              v={
                <span className={s.database.status === 'ok' ? 'text-ok' : 'text-danger'}>
                  {s.database.status}
                </span>
              }
            />
            <Row k="Tipo" v={s.database.kind} />
          </Card>
          <Card title="Omie">
            <Row
              k="Modo"
              v={
                <span className="badge" data-testid="status-omie-mode">
                  {s.omie.mode === 'mock' ? 'MOCK (dados fictícios)' : 'LIVE'}
                </span>
              }
            />
            <Row k="Conectividade" v={s.omie.connectivity.status} />
            {s.omie.connectivity.checkedAt && (
              <Row k="Verificado em" v={formatDateTime(s.omie.connectivity.checkedAt)} />
            )}
            {s.omie.connectivity.errorCode && (
              <Row
                k="Erro"
                v={
                  <span className="text-danger">
                    {s.omie.connectivity.errorCode} {s.omie.connectivity.message ?? ''}
                  </span>
                }
              />
            )}
            {s.omie.baseUrl && <Row k="Base URL" v={<code>{s.omie.baseUrl}</code>} />}
            {s.omie.credentialsConfigured !== undefined && (
              <Row k="Credenciais" v={s.omie.credentialsConfigured ? 'configuradas' : 'ausentes'} />
            )}
          </Card>
          <Card title="Escritas">
            <Row k="Somente leitura" v={flag(!s.writes.readOnly, 'não', 'sim')} />
            <Row k="INSERT liberado" v={flag(s.writes.allowInsert)} />
            <Row k="UPDATE liberado" v={flag(s.writes.allowUpdate)} />
            <Row k="DELETE liberado" v={flag(s.writes.allowDelete)} />
          </Card>
          <Card title="Limites">
            <Row k="Máx. linhas" v={s.limits.maxRows} />
            <Row k="Máx. chamadas por consulta" v={s.limits.maxApiCalls} />
            <Row k="Máx. linhas por escrita" v={s.limits.maxWriteRows} />
            <Row k="Concorrência" v={s.limits.concurrency} />
            <Row k="Timeout por chamada" v={formatDuration(s.limits.timeoutMs)} />
            <Row k="Timeout por consulta" v={formatDuration(s.limits.queryTimeoutMs)} />
          </Card>
          <Card title="Assistente de IA">
            <Row k="Provedor" v={s.ai.provider} />
            <Row k="Modelo" v={s.ai.model ?? '—'} />
            <Row k="Compartilha dados de resultado" v={flag(s.ai.shareResultData)} />
          </Card>
        </div>
      )}
    </div>
  );
}
