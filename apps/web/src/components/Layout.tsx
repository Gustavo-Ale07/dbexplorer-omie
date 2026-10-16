import { useCallback, useState } from 'react';
import type { Theme } from '../app/theme';
import { ROLE_LABEL, useSession } from '../app/session';
import { ExplorerPage } from '../explorer/ExplorerPage';
import type { OpenRequest } from '../explorer/ExplorerPage';
import { HistoryPage } from '../pages/HistoryPage';
import { SavedQueriesPage } from '../pages/SavedQueriesPage';
import { InspectorPage } from '../pages/InspectorPage';
import { ChangePasswordPage } from '../pages/ChangePasswordPage';
import { UsersPage } from '../admin/UsersPage';
import { AuditPage } from '../admin/AuditPage';
import { StatusPage } from '../admin/StatusPage';
import { Footer } from './Footer';

export type View =
  'explorer' | 'history' | 'saved' | 'inspector' | 'users' | 'audit' | 'status' | 'password';

const NAV: { view: View; label: string; admin?: boolean }[] = [
  { view: 'explorer', label: 'Editor SQL' },
  { view: 'history', label: 'Histórico' },
  { view: 'saved', label: 'Consultas salvas' },
  { view: 'inspector', label: 'API Inspector' },
  { view: 'users', label: 'Usuários', admin: true },
  { view: 'audit', label: 'Auditoria', admin: true },
  { view: 'status', label: 'Status' },
];

export function Layout({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const { user, meta, logout, refresh } = useSession();
  const [view, setView] = useState<View>('explorer');
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);

  const openInEditor = useCallback((req: Omit<OpenRequest, 'nonce'>) => {
    setOpenRequest({ ...req, nonce: Date.now() + Math.random() });
    setView('explorer');
  }, []);

  const isAdmin = user.role === 'ADMIN';
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 border-b border-line bg-panel px-2 py-1">
        <span className="mr-3 flex items-center gap-1.5 font-semibold">
          <img src="/favicon.svg" alt="" width={18} height={18} />
          Omie SQL Explorer
        </span>
        <nav aria-label="Navegação principal" className="flex flex-wrap gap-0.5">
          {NAV.filter((n) => !n.admin || isAdmin).map((n) => (
            <button
              key={n.view}
              type="button"
              className={`rounded px-2.5 py-1 text-xs ${
                view === n.view ? 'bg-selected font-semibold' : 'hover:bg-hover'
              }`}
              aria-current={view === n.view ? 'page' : undefined}
              onClick={() => setView(n.view)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {meta?.omieMode === 'mock' && (
            <span className="badge border-ok/50 text-ok" title="Dados fictícios em memória">
              MOCK
            </span>
          )}
          {meta?.omieMode === 'live' && (
            <span className="badge border-warn/60 text-warn" title="Conectado ao Omie real">
              LIVE
            </span>
          )}
          <span className="text-muted" data-testid="current-user">
            {user.name} · {ROLE_LABEL[user.role]}
          </span>
          <button
            type="button"
            className="btn"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
            title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button type="button" className="btn" onClick={() => setView('password')}>
            Senha
          </button>
          <button type="button" className="btn" onClick={() => void logout()}>
            Sair
          </button>
        </div>
      </header>

      <main className="relative min-h-0 flex-1">
        {/* The editor stays mounted so tabs, results and Monaco state survive navigation. */}
        <div className={view === 'explorer' ? 'h-full' : 'hidden'}>
          <ExplorerPage theme={theme} openRequest={openRequest} active={view === 'explorer'} />
        </div>
        {view !== 'explorer' && (
          <div className="h-full overflow-auto">
            {view === 'history' && <HistoryPage onOpen={openInEditor} />}
            {view === 'saved' && <SavedQueriesPage onOpen={openInEditor} />}
            {view === 'inspector' && <InspectorPage />}
            {view === 'users' && isAdmin && <UsersPage />}
            {view === 'audit' && isAdmin && <AuditPage />}
            {view === 'status' && <StatusPage />}
            {view === 'password' && <ChangePasswordPage onDone={refresh} />}
          </div>
        )}
      </main>
      <Footer meta={meta} />
    </div>
  );
}
