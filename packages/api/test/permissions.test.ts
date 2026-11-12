import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  permissionsForRoles,
  rolesHavePermission,
  type Permission,
  type Role,
} from '@dcs-docs/shared';

/** The matrix from docs/architecture/04_IDENTITY_AND_ACCESS.md, written out independently of the implementation. [SA, AD, SE, VI] */
const EXPECTED: Record<Permission, [boolean, boolean, boolean, boolean]> = {
  'users:read': [true, true, false, false],
  'users:manage': [true, true, false, false],
  'users:roles': [true, false, false, false],
  'doc_types:read': [true, true, true, true],
  'doc_types:manage': [true, true, false, false],
  'documents:read': [true, true, true, true],
  'documents:manage': [true, true, false, false],
  'documents:archive': [true, false, false, false],
  'documents:legal_hold': [true, false, false, false],
  'versions:create': [true, true, false, false],
  'versions:restore': [true, true, false, false],
  'versions:download': [true, true, true, false],
  'email:send': [true, true, true, false],
  'email:send_external': [true, true, true, false],
  'email:read_own': [true, true, true, false],
  'email:read_all': [true, true, false, false],
  'email:connect': [true, true, true, false],
  'templates:read': [true, true, true, false],
  'templates:manage': [true, true, false, false],
  'audit:read': [true, true, false, false],
  'audit:export': [true, false, false, false],
  'reports:read': [true, true, false, false],
};

const ORDER: Role[] = ['SUPER_ADMIN', 'ADMIN', 'SENDER', 'VIEWER'];

describe('permission matrix', () => {
  it('defines an expectation for every permission and no unknown ones', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PERMISSIONS].sort());
  });

  for (const permission of PERMISSIONS) {
    for (const [i, role] of ORDER.entries()) {
      const expected = EXPECTED[permission][i]!;
      it(`${role} ${expected ? 'may' : 'may NOT'} ${permission}`, () => {
        expect(rolesHavePermission([role], permission)).toBe(expected);
      });
    }
  }

  it('lists no permission outside the known set for any role', () => {
    for (const role of ROLES) for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
  });

  it('a user with no role has no permission', () => {
    expect(permissionsForRoles([])).toEqual([]);
    expect(rolesHavePermission([], 'documents:read')).toBe(false);
  });

  it('combines the permissions of several roles', () => {
    const combined = permissionsForRoles(['SENDER', 'VIEWER']);
    expect(combined).toEqual(expect.arrayContaining([...ROLE_PERMISSIONS.SENDER]));
    expect(new Set(combined).size).toBe(combined.length);
  });

  it('keeps privileged actions away from ADMIN: roles, archive, legal hold, audit export', () => {
    for (const p of ['users:roles', 'documents:archive', 'documents:legal_hold', 'audit:export'] as Permission[]) {
      expect(rolesHavePermission(['ADMIN'], p)).toBe(false);
    }
  });

  it('gives VIEWER read-only access', () => {
    const viewer = permissionsForRoles(['VIEWER']);
    expect(viewer.every((p) => p.endsWith(':read'))).toBe(true);
  });
});
