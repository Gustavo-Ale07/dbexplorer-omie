export const ROLES = ['VIEWER', 'OPERATOR', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export type StatementKind =
  'SELECT' | 'SHOW' | 'DESCRIBE' | 'EXPLAIN' | 'INSERT' | 'UPDATE' | 'DELETE';
export type WriteKind = Extract<StatementKind, 'INSERT' | 'UPDATE' | 'DELETE'>;

const PERMISSIONS: Record<Role, ReadonlySet<StatementKind>> = {
  VIEWER: new Set(['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN']),
  OPERATOR: new Set(['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'INSERT', 'UPDATE']),
  ADMIN: new Set(['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'INSERT', 'UPDATE', 'DELETE']),
};

/** Role-level permission only. Global feature flags are enforced separately and take precedence. */
export function roleAllows(role: Role, kind: StatementKind): boolean {
  return PERMISSIONS[role].has(kind);
}

export function isWriteKind(kind: StatementKind): kind is WriteKind {
  return kind === 'INSERT' || kind === 'UPDATE' || kind === 'DELETE';
}
