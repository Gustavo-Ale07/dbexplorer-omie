import { describe, expect, it } from 'vitest';
import { roleAllows } from './rbac';

describe('roleAllows', () => {
  it('VIEWER can only read', () => {
    expect(roleAllows('VIEWER', 'SELECT')).toBe(true);
    expect(roleAllows('VIEWER', 'EXPLAIN')).toBe(true);
    expect(roleAllows('VIEWER', 'SHOW')).toBe(true);
    expect(roleAllows('VIEWER', 'DESCRIBE')).toBe(true);
    expect(roleAllows('VIEWER', 'INSERT')).toBe(false);
    expect(roleAllows('VIEWER', 'UPDATE')).toBe(false);
    expect(roleAllows('VIEWER', 'DELETE')).toBe(false);
  });

  it('OPERATOR can insert and update but not delete', () => {
    expect(roleAllows('OPERATOR', 'INSERT')).toBe(true);
    expect(roleAllows('OPERATOR', 'UPDATE')).toBe(true);
    expect(roleAllows('OPERATOR', 'DELETE')).toBe(false);
  });

  it('ADMIN can do everything', () => {
    for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
      expect(roleAllows('ADMIN', op)).toBe(true);
    }
  });
});
