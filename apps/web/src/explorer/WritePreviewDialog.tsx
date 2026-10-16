import { useEffect, useState } from 'react';
import type { RecordValues, Value, WritePreview } from '../api/types';
import { Modal } from '../components/Modal';
import { ErrorBox } from '../components/ErrorBox';
import { cellText } from '../lib/format';

interface Props {
  preview: WritePreview | null;
  busy: boolean;
  error: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}

function useSecondsLeft(expiresAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    // The hook may have been mounted long before this preview: refresh right away.
    const update = () => setNow(Date.now());
    const first = setTimeout(update, 0);
    const t = setInterval(update, 500);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [expiresAt]);
  if (!expiresAt) return 0;
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
}

const same = (a: Value | undefined, b: Value | undefined) => (a ?? null) === (b ?? null);

function Cell({ v, changed }: { v: Value | undefined; changed?: boolean }) {
  return (
    <td
      className={`font-mono ${changed ? 'bg-warn/15 font-semibold' : ''} ${
        v === null || v === undefined ? 'text-muted italic' : ''
      }`}
    >
      {cellText(v)}
    </td>
  );
}

export function WritePreviewDialog({ preview, busy, error, onConfirm, onCancel }: Props) {
  const p = preview?.preview;
  const secondsLeft = useSecondsLeft(preview?.confirmation.expiresAt);
  const [ack, setAck] = useState(false);
  useEffect(() => setAck(false), [preview]);

  if (!preview || !p)
    return (
      <Modal open={false} title="" onClose={onCancel}>
        {null}
      </Modal>
    );

  const expired = secondsLeft <= 0;
  const isDelete = p.operation === 'DELETE';
  const isInsert = p.operation === 'INSERT';
  const keyCols = [...new Set(p.targets.flatMap((t) => Object.keys(t.key)))];
  const cols = isInsert
    ? [...new Set(p.targets.flatMap((t) => Object.keys(t.after)))]
    : p.changedColumns;

  const row = (vals: RecordValues | null, c: string) => vals?.[c];

  return (
    <Modal
      open
      wide
      title={`Confirmar ${p.operation} em ${p.resource}`}
      onClose={onCancel}
      testId="write-preview"
      footer={
        <>
          <span className="mr-auto self-center text-xs text-muted" aria-live="polite">
            {expired
              ? 'Confirmação expirada — gere um novo preview.'
              : `A confirmação expira em ${secondsLeft}s (uso único).`}
          </span>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            className={isDelete ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={busy || expired || !ack}
            data-testid="confirm-write"
          >
            {busy ? 'Executando…' : `Executar ${p.operation} em ${p.targetCount} registro(s)`}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <div className="rounded border border-warn/50 bg-warn/10 px-3 py-2">
          <p className="font-semibold text-warn">Atenção: a API Omie não tem transações.</p>
          <p>
            Cada registro é enviado numa chamada <code>{p.call}</code> ({p.endpoint}), em ordem, e a
            execução para no primeiro erro. Não há rollback automático: registros já enviados
            permanecem alterados.
          </p>
        </div>
        <p>
          <strong>{p.targetCount}</strong> registro(s) serão{' '}
          {isInsert ? 'criados' : isDelete ? 'excluídos' : 'alterados'}
          {!isInsert && !isDelete && (
            <>
              {' '}
              — colunas: <code>{p.changedColumns.join(', ')}</code>
            </>
          )}
          .
        </p>
        {p.messages.map((m, i) => (
          <p key={i} className="text-muted">
            • {m}
          </p>
        ))}
        <div className="max-h-[45vh] overflow-auto rounded border border-line">
          <table className="table-std">
            <thead>
              <tr>
                {keyCols.map((c) => (
                  <th key={`k-${c}`} className="font-mono">
                    {c} (chave)
                  </th>
                ))}
                {!isDelete &&
                  cols.map((c) =>
                    isInsert ? (
                      <th key={c} className="font-mono">
                        {c}
                      </th>
                    ) : (
                      <th key={c} className="font-mono" colSpan={2}>
                        {c}: antes → depois
                      </th>
                    ),
                  )}
                {isDelete && <th>Registro atual</th>}
              </tr>
            </thead>
            <tbody>
              {p.targets.map((t, i) => (
                <tr key={i}>
                  {keyCols.map((c) => (
                    <Cell key={`k-${c}`} v={t.key[c]} />
                  ))}
                  {!isDelete &&
                    cols.map((c) =>
                      isInsert ? (
                        <Cell key={c} v={row(t.after, c)} />
                      ) : (
                        <PairCells key={c} before={row(t.before, c)} after={row(t.after, c)} />
                      ),
                    )}
                  {isDelete && (
                    <td className="font-mono text-[11px]">{JSON.stringify(t.before)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            data-testid="ack-write"
          />
          Revisei os registros acima e entendo que a operação não pode ser desfeita automaticamente.
        </label>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function PairCells({ before, after }: { before: Value | undefined; after: Value | undefined }) {
  const changed = !same(before, after);
  return (
    <>
      <Cell v={before} />
      <Cell v={after} changed={changed} />
    </>
  );
}
