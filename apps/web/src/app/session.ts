import { createContext, useContext } from 'react';
import type { Meta, Role, User } from '../api/types';

export interface SessionContextValue {
  user: User;
  meta: Meta | undefined;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionContext');
  return ctx;
}

const WRITE_ROLES: Role[] = ['ADMIN', 'OPERATOR'];
export const canWrite = (role: Role) => WRITE_ROLES.includes(role);
export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrador',
  OPERATOR: 'Operador',
  VIEWER: 'Leitor',
};
