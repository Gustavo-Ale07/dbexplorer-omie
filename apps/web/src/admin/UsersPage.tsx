import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { ROLES } from '../api/types';
import type { Role, User } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';
import { ROLE_LABEL, useSession } from '../app/session';
import { formatDateTime } from '../lib/format';
import { passwordProblems } from '../lib/password';

interface NewUser {
  email: string;
  name: string;
  password: string;
  role: Role;
}

export function UsersPage() {
  const qc = useQueryClient();
  const { user: me } = useSession();
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState<NewUser | null>(null);
  const [resetting, setResetting] = useState<{ user: User; password: string } | null>(null);
  const [modalError, setModalError] = useState<unknown>(null);
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<{ items: User[] }>('/api/admin/users'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] });

  async function patch(id: string, body: Partial<Pick<User, 'name' | 'role' | 'active'>>) {
    setError(null);
    try {
      await api.patch(`/api/admin/users/${id}`, body);
      void refresh();
    } catch (err) {
      setError(err);
    }
  }

  async function create() {
    if (!creating) return;
    setModalError(null);
    try {
      await api.post('/api/admin/users', { ...creating, email: creating.email.trim() });
      setCreating(null);
      void refresh();
    } catch (err) {
      setModalError(err);
    }
  }

  async function reset() {
    if (!resetting) return;
    setModalError(null);
    try {
      await api.post(`/api/admin/users/${resetting.user.id}/reset-password`, {
        password: resetting.password,
      });
      setResetting(null);
      void refresh();
    } catch (err) {
      setModalError(err);
    }
  }

  const createProblems = creating ? passwordProblems(creating.password) : [];
  const resetProblems = resetting ? passwordProblems(resetting.password) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-base font-semibold">Usuários</h1>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setModalError(null);
            setCreating({ email: '', name: '', password: '', role: 'VIEWER' });
          }}
        >
          Novo usuário
        </button>
      </div>
      <p className="text-xs text-muted">
        Leitor: SELECT/SHOW/DESCRIBE/EXPLAIN · Operador: + INSERT/UPDATE · Administrador: + DELETE e
        administração. Novos usuários e senhas redefinidas exigem troca no próximo login.
      </p>
      <ErrorBox error={error ?? users.error} />
      <div className="overflow-auto rounded border border-line bg-panel">
        <table className="table-std text-xs" data-testid="users-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>E-mail</th>
              <th>Papel</th>
              <th>Status</th>
              <th>Último login</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users.data?.items ?? []).map((u) => {
              const self = u.id === me.id;
              return (
                <tr key={u.id} className={u.active ? '' : 'opacity-60'}>
                  <td>
                    {u.name}
                    {self && <span className="ml-1 text-muted">(você)</span>}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <select
                      className="input py-0.5"
                      value={u.role}
                      disabled={self}
                      aria-label={`Papel de ${u.email}`}
                      onChange={(e) => void patch(u.id, { role: e.target.value as Role })}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {u.active ? 'ativo' : 'inativo'}
                    {u.mustChangePassword && (
                      <span className="badge ml-1 text-warn">troca de senha pendente</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{formatDateTime(u.lastLoginAt)}</td>
                  <td className="whitespace-nowrap">
                    <button
                      type="button"
                      className="btn"
                      disabled={self}
                      onClick={() => {
                        const verb = u.active ? 'Desativar' : 'Reativar';
                        if (window.confirm(`${verb} ${u.email}?`))
                          void patch(u.id, { active: !u.active });
                      }}
                    >
                      {u.active ? 'Desativar' : 'Reativar'}
                    </button>{' '}
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setModalError(null);
                        setResetting({ user: u, password: '' });
                      }}
                    >
                      Redefinir senha
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Modal
        open={creating !== null}
        title="Novo usuário"
        onClose={() => setCreating(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setCreating(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                !creating?.email.trim() || !creating.name.trim() || createProblems.length > 0
              }
              onClick={() => void create()}
            >
              Criar
            </button>
          </>
        }
      >
        {creating && (
          <div className="space-y-2 text-xs">
            <label className="block space-y-1">
              <span className="font-medium">Nome</span>
              <input
                className="input w-full"
                value={creating.name}
                maxLength={120}
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">E-mail</span>
              <input
                className="input w-full"
                type="email"
                autoComplete="off"
                value={creating.email}
                onChange={(e) => setCreating({ ...creating, email: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Papel</span>
              <select
                className="input w-full"
                value={creating.role}
                onChange={(e) => setCreating({ ...creating, role: e.target.value as Role })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Senha inicial</span>
              <input
                className="input w-full"
                type="password"
                autoComplete="new-password"
                value={creating.password}
                onChange={(e) => setCreating({ ...creating, password: e.target.value })}
              />
            </label>
            {creating.password && createProblems.length > 0 && (
              <ul className="list-disc pl-4 text-warn">
                {createProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>

      <Modal
        open={resetting !== null}
        title={`Redefinir senha${resetting ? ` — ${resetting.user.email}` : ''}`}
        onClose={() => setResetting(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setResetting(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={resetProblems.length > 0}
              onClick={() => void reset()}
            >
              Redefinir
            </button>
          </>
        }
      >
        {resetting && (
          <div className="space-y-2 text-xs">
            <p className="text-muted">
              As sessões ativas do usuário serão encerradas e ele precisará trocar a senha no
              próximo login.
            </p>
            <label className="block space-y-1">
              <span className="font-medium">Nova senha temporária</span>
              <input
                className="input w-full"
                type="password"
                autoComplete="new-password"
                value={resetting.password}
                onChange={(e) => setResetting({ ...resetting, password: e.target.value })}
              />
            </label>
            {resetting.password && resetProblems.length > 0 && (
              <ul className="list-disc pl-4 text-warn">
                {resetProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>
    </div>
  );
}
