import { useMemo, useState } from 'react';
import type { SchemaTable } from '../api/types';

export const GROUP_ORDER = ['Geral', 'Vendas', 'Produtos', 'Estoque', 'Financeiro', 'Fiscal'];

interface Props {
  tables: SchemaTable[] | undefined;
  loading: boolean;
  onSelectQuery: (sql: string, table: string) => void;
  onInsertText: (text: string) => void;
}

export function selectTemplate(t: SchemaTable): string {
  const where = t.requiredFilter ? `\nWHERE ${t.requiredFilter} = 0 -- filtro obrigatório` : '';
  return `SELECT *\nFROM ${t.name}${where}\nLIMIT 100;`;
}

function OpBadge({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={`badge font-mono ${ok ? 'border-ok/40 text-ok' : 'border-line text-muted line-through'}`}
      title={ok ? `${label}: suportado` : `${label}: unsupported`}
    >
      {label}
    </span>
  );
}

export function SchemaTree({ tables, loading, onSelectQuery, onInsertText }: Props) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = (tables ?? []).filter(
      (t) =>
        !f ||
        t.name.toLowerCase().includes(f) ||
        t.description.toLowerCase().includes(f) ||
        t.columns.some((c) => c.name.toLowerCase().includes(f)),
    );
    const byGroup = new Map<string, SchemaTable[]>();
    for (const t of list) {
      const arr = byGroup.get(t.group) ?? [];
      arr.push(t);
      byGroup.set(t.group, arr);
    }
    return [...byGroup.entries()].sort(
      (a, b) =>
        (GROUP_ORDER.indexOf(a[0]) + 1 || 99) - (GROUP_ORDER.indexOf(b[0]) + 1 || 99) ||
        a[0].localeCompare(b[0]),
    );
  }, [tables, filter]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-2">
        <label className="sr-only" htmlFor="schema-filter">
          Filtrar tabelas
        </label>
        <input
          id="schema-filter"
          className="input w-full text-xs"
          placeholder="Filtrar tabelas e colunas…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-xs" role="tree" aria-label="Tabelas">
        {loading && <div className="p-2 text-muted">Carregando schema…</div>}
        {groups.map(([group, list]) => {
          const groupClosed = closedGroups[group] && !filter;
          return (
            <div key={group} role="group" aria-label={group}>
              <button
                type="button"
                className="flex w-full items-center gap-1 px-2 py-1 text-left font-semibold uppercase tracking-wide text-muted hover:bg-hover"
                onClick={() => setClosedGroups((g) => ({ ...g, [group]: !g[group] }))}
                aria-expanded={!groupClosed}
              >
                <span aria-hidden>{groupClosed ? '▸' : '▾'}</span> {group}
                <span className="ml-auto font-normal">{list.length}</span>
              </button>
              {!groupClosed &&
                list.map((t) => {
                  const isOpen = open[t.name] ?? false;
                  return (
                    <div key={t.name} role="treeitem" aria-expanded={isOpen} aria-selected={false}>
                      <div className="group flex items-center gap-1 pr-1 pl-3 hover:bg-hover">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
                          onClick={() => setOpen((o) => ({ ...o, [t.name]: !isOpen }))}
                          onDoubleClick={() => onSelectQuery(selectTemplate(t), t.name)}
                          title={t.description}
                          data-testid={`schema-table-${t.name}`}
                        >
                          <span aria-hidden className="text-muted">
                            {isOpen ? '▾' : '▸'}
                          </span>
                          <span aria-hidden>▦</span>
                          <span className="truncate font-mono">{t.name}</span>
                        </button>
                        <button
                          type="button"
                          className="rounded px-1 text-[11px] text-accent opacity-70 group-hover:opacity-100 hover:underline"
                          onClick={() => onSelectQuery(selectTemplate(t), t.name)}
                          title={`SELECT * FROM ${t.name} LIMIT 100`}
                          aria-label={`Consultar ${t.name} (SELECT … LIMIT 100)`}
                        >
                          SELECT
                        </button>
                      </div>
                      {isOpen && (
                        <div className="mb-1 ml-6 border-l border-line pl-2">
                          <p className="py-0.5 text-[11px] text-muted">{t.description}</p>
                          <div className="flex flex-wrap gap-1 py-0.5">
                            <OpBadge label="SELECT" ok={t.operations.select} />
                            <OpBadge label="INSERT" ok={t.operations.insert} />
                            <OpBadge label="UPDATE" ok={t.operations.update} />
                            <OpBadge label="DELETE" ok={t.operations.delete} />
                          </div>
                          {!t.operations.delete && (
                            <p className="text-[11px] text-muted">DELETE: unsupported</p>
                          )}
                          {t.requiredFilter && (
                            <p className="text-[11px] text-warn">
                              Filtro obrigatório: <code>{t.requiredFilter}</code>
                            </p>
                          )}
                          {t.notes.map((n) => (
                            <p key={n} className="text-[11px] text-muted">
                              • {n}
                            </p>
                          ))}
                          <ul className="py-0.5">
                            {t.columns.map((c) => (
                              <li key={c.name}>
                                <button
                                  type="button"
                                  className="flex w-full items-center gap-1 rounded px-1 text-left hover:bg-hover"
                                  title={`${c.description}${c.references ? ` → ${c.references.table}.${c.references.column}` : ''}\nClique para inserir no editor`}
                                  onClick={() => onInsertText(c.name)}
                                >
                                  <span className="w-3 text-[10px] text-warn" aria-hidden>
                                    {c.pk ? '🔑' : c.references ? '↗' : ''}
                                  </span>
                                  <span className="truncate font-mono">{c.name}</span>
                                  <span className="ml-auto pl-2 font-mono text-[10px] text-muted">
                                    {c.type}
                                    {c.updatable ? ' ✎' : ''}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          );
        })}
        {!loading && groups.length === 0 && (
          <div className="p-2 text-muted">Nenhuma tabela encontrada.</div>
        )}
      </div>
    </div>
  );
}
