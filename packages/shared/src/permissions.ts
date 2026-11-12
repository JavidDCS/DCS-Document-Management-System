export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'SENDER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

/** `module:action`. Every protected route declares exactly one of these (or is explicitly public/authenticated-only). */
export const PERMISSIONS = [
  'users:read',
  'users:manage', // create, activate/deactivate, reset password, revoke sessions
  'users:roles', // change roles
  'doc_types:read',
  'doc_types:manage', // types and their metadata fields
  'documents:read', // search, list, view metadata
  'documents:manage', // create, edit, tag, activate/deactivate
  'documents:archive',
  'documents:legal_hold',
  'versions:create',
  'versions:restore',
  'versions:download', // senders additionally need an object-level check (document sendable)
  'email:send',
  'email:send_external',
  'email:read_own',
  'email:read_all',
  'email:connect',
  'templates:read',
  'templates:manage',
  'audit:read',
  'audit:export',
  'reports:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** The role x action matrix from docs/architecture/04_IDENTITY_AND_ACCESS.md. Roles not listed here have nothing. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  ADMIN: [
    'users:read',
    'users:manage',
    'doc_types:read',
    'doc_types:manage',
    'documents:read',
    'documents:manage',
    'versions:create',
    'versions:restore',
    'versions:download',
    'email:send',
    'email:send_external',
    'email:read_own',
    'email:read_all',
    'email:connect',
    'templates:read',
    'templates:manage',
    'audit:read',
    'reports:read',
  ],
  SENDER: [
    'doc_types:read',
    'documents:read',
    'versions:download',
    'email:send',
    'email:send_external',
    'email:read_own',
    'email:connect',
    'templates:read',
  ],
  VIEWER: ['doc_types:read', 'documents:read'],
};

export function permissionsForRoles(roles: readonly Role[]): Permission[] {
  const set = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) set.add(p);
  return [...set];
}

export function rolesHavePermission(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((r) => ROLE_PERMISSIONS[r]?.includes(permission));
}

/** Role ordering used for "an admin may not manage someone above them". */
export const ROLE_RANK: Record<Role, number> = { SUPER_ADMIN: 4, ADMIN: 3, SENDER: 2, VIEWER: 1 };
