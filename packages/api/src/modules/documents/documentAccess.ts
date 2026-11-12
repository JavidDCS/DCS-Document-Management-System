import type { Prisma } from '@prisma/client';
import type { Role } from '@dcs-docs/shared';

export interface AccessRuleRow {
  subjectType: string;
  userId: string | null;
  role: string | null;
  permission: string;
  effect: string;
}

export type AclPermission = 'VIEW' | 'SEND';

const applies = (r: AccessRuleRow, user: { userId: string; roles: readonly Role[] }) =>
  (r.subjectType === 'USER' && r.userId === user.userId) || (r.subjectType === 'ROLE' && r.role !== null && (user.roles as readonly string[]).includes(r.role));

/**
 * Object-level rule evaluation. No rule: role permissions decide. DENY always wins. If any ALLOW rule exists for the
 * permission, only subjects named by an ALLOW rule pass. SUPER_ADMIN always passes.
 */
export function aclAllows(rules: readonly AccessRuleRow[], user: { userId: string; roles: readonly Role[] }, permission: AclPermission): boolean {
  if (user.roles.includes('SUPER_ADMIN')) return true;
  const relevant = rules.filter((r) => r.permission === permission);
  if (relevant.some((r) => r.effect === 'DENY' && applies(r, user))) return false;
  const allows = relevant.filter((r) => r.effect === 'ALLOW');
  return allows.length === 0 || allows.some((r) => applies(r, user));
}

/** The same rule as a database filter, so lists only ever contain documents the user may see. */
export function aclWhere(user: { userId: string; roles: readonly Role[] }, permission: AclPermission): Prisma.DocumentWhereInput {
  if (user.roles.includes('SUPER_ADMIN')) return {};
  const me: Prisma.DocumentAccessRuleWhereInput = { OR: [{ subjectType: 'USER', userId: user.userId }, { subjectType: 'ROLE', role: { in: [...user.roles] } }] };
  return {
    NOT: [
      { accessRules: { some: { permission, effect: 'DENY', ...me } } },
      {
        AND: [
          { accessRules: { some: { permission, effect: 'ALLOW' } } },
          { accessRules: { none: { permission, effect: 'ALLOW', ...me } } },
        ],
      },
    ],
  };
}
