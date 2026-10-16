import type { QueryPlan, WriteExplain } from '../api/types';

const RISK_CLASS: Record<string, string> = {
  LOW: 'border-ok/50 text-ok',
  MEDIUM: 'border-warn/60 text-warn',
  HIGH: 'border-danger/60 text-danger',
};

export function isWriteExplain(p: QueryPlan | WriteExplain): p is WriteExplain {
  return 'operation' in p;
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className="text-muted">{empty}</span>;
  return (
    <ul className="list-inside list-disc">
      {items.map((s, i) => (
        <li key={i} className="font-mono">
          {s}
        </li>
      ))}
    </ul>
  );
}

function PlanTable({ plan }: { plan: QueryPlan }) {
  const est =
    plan.estimatedApiCalls.max === null
      ? `≥ ${plan.estimatedApiCalls.min}`
      : plan.estimatedApiCalls.min === plan.estimatedApiCalls.max
        ? String(plan.estimatedApiCalls.min)
        : `${plan.estimatedApiCalls.min}–${plan.estimatedApiCalls.max}`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span>
          Risk:{' '}
          <span className={`badge font-semibold ${RISK_CLASS[plan.risk] ?? ''}`}>{plan.risk}</span>
        </span>
        <span>
          Estimated API calls: <strong>{est}</strong> (máx. {plan.maxApiCalls})
        </span>
        <span>
          LIMIT: <strong>{plan.limit}</strong>
          {plan.implicitLimit ? ' (implícito)' : ''}
        </span>
        {plan.earlyStop && <span className="badge">early stop</span>}
      </div>
      {plan.riskReasons.length > 0 && (
        <div className="text-xs">
          <List items={plan.riskReasons} empty="" />
        </div>
      )}
      {plan.steps.map((s, i) => (
        <table key={i} className="table-std text-xs" data-testid="explain-step">
          <tbody>
            <tr>
              <th className="w-44">Resource</th>
              <td className="font-mono">
                {s.table}
                {s.alias !== s.table ? ` AS ${s.alias}` : ''}
              </td>
            </tr>
            <tr>
              <th>Omie call</th>
              <td className="font-mono">
                {s.endpoint} · {s.call}
              </td>
            </tr>
            <tr>
              <th>Strategy</th>
              <td className="font-mono">{s.strategy}</td>
            </tr>
            {s.join && (
              <tr>
                <th>Join</th>
                <td className="font-mono">
                  {s.join.type} JOIN ON {s.join.on} — {s.join.method}
                </td>
              </tr>
            )}
            <tr>
              <th>Estimated API calls</th>
              <td className="font-mono">{s.estimatedCalls}</td>
            </tr>
            <tr>
              <th>Remote filters</th>
              <td>
                <List items={s.remoteFilters} empty="nenhum (lista completa)" />
              </td>
            </tr>
            <tr>
              <th>Local filters</th>
              <td>
                <List items={s.localFilters} empty="nenhum" />
              </td>
            </tr>
            <tr>
              <th>Pagination</th>
              <td className="font-mono">{s.pagination}</td>
            </tr>
          </tbody>
        </table>
      ))}
    </div>
  );
}

export function ExplainView({ plan }: { plan: QueryPlan | WriteExplain | null | undefined }) {
  if (!plan) {
    return (
      <div className="p-3 text-xs text-muted">
        Sem plano para esta instrução. Use o botão Explain (ou EXPLAIN SELECT …) para ver a
        estratégia sem chamar a API.
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto p-3 text-xs" data-testid="explain-view">
      {isWriteExplain(plan) ? (
        <div className="space-y-3">
          <table className="table-std">
            <tbody>
              <tr>
                <th className="w-44">Operation</th>
                <td className="font-mono">{plan.operation}</td>
              </tr>
              <tr>
                <th>Resource</th>
                <td className="font-mono">{plan.resource}</td>
              </tr>
              <tr>
                <th>Omie call</th>
                <td className="font-mono">
                  {plan.endpoint} · {plan.call}
                </td>
              </tr>
              <tr>
                <th>WHERE</th>
                <td className="font-mono">{plan.where ?? '—'}</td>
              </tr>
              <tr>
                <th>Max affected rows</th>
                <td>{plan.maxWriteRows}</td>
              </tr>
              <tr>
                <th>Confirmation</th>
                <td>obrigatória (preview → confirmação)</td>
              </tr>
              <tr>
                <th>Risk</th>
                <td>
                  <span className={`badge font-semibold ${RISK_CLASS[plan.risk] ?? ''}`}>
                    {plan.risk}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          {plan.resolution && (
            <div>
              <h3 className="mb-1 font-semibold">Resolução dos registros-alvo</h3>
              <PlanTable plan={plan.resolution} />
            </div>
          )}
        </div>
      ) : (
        <PlanTable plan={plan} />
      )}
    </div>
  );
}
