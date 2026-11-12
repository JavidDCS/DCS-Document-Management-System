import { Prisma, type PrismaClient } from '@prisma/client';
import { ROLE_RANK, ROLES, type PublicUser, type Role, type UserStatus } from '@dcs-docs/shared';
import type { AuthContext } from '../../types/express.js';
import { HttpError } from '../../utils/httpError.js';
import { likeEscape } from '../../utils/like.js';
import { recordAudit } from '../audit/index.js';
import { toRoles } from '../identity/auth.service.js';
import { generateTemporaryPassword, type PasswordHasher } from '../identity/password.js';
import type { SessionService } from '../identity/session.service.js';

export interface UsersConfig {
  ALLOWED_EMAIL_DOMAIN: string;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

type UserWithRoles = Prisma.UserGetPayload<{ include: { roles: true } }>;

export function toPublicUser(u: UserWithRoles): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status as UserStatus,
    roles: toRoles(u.roles),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

export class UsersService {
  private readonly deactivateHooks: ((tx: Prisma.TransactionClient, userId: string) => Promise<void>)[] = [];

  constructor(
    private readonly db: PrismaClient,
    private readonly cfg: UsersConfig,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService
  ) {}

  onDeactivate(hook: (tx: Prisma.TransactionClient, userId: string) => Promise<void>): this {
    this.deactivateHooks.push(hook);
    return this;
  }

  private audit(tx: Prisma.TransactionClient | PrismaClient, actor: AuthContext, action: string, targetId: string, meta: RequestMeta, details: Record<string, unknown> = {}) {
    return recordAudit(tx, {
      actorType: 'USER',
      actorUserId: actor.userId,
      action,
      resourceType: 'user',
      resourceId: targetId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      details,
    });
  }

  private async load(id: string): Promise<UserWithRoles> {
    const u = await this.db.user.findUnique({ where: { id }, include: { roles: true } });
    if (!u) throw new HttpError(404, 'User not found');
    return u;
  }

  /** An actor may only manage users whose highest role is not above their own. */
  private assertMayManage(actor: AuthContext, target: UserWithRoles) {
    const actorRank = Math.max(0, ...actor.roles.map((r) => ROLE_RANK[r]));
    const targetRank = Math.max(0, ...toRoles(target.roles).map((r) => ROLE_RANK[r]));
    if (targetRank > actorRank) throw new HttpError(403, 'You do not have permission to manage this user', 'FORBIDDEN');
  }

  /** Never leave the system without an active SUPER_ADMIN. */
  private async assertNotLastSuperAdmin(excludingUserId: string) {
    const others = await this.db.user.count({
      where: { id: { not: excludingUserId }, status: { not: 'DEACTIVATED' }, roles: { some: { role: 'SUPER_ADMIN' } } },
    });
    if (others === 0) throw new HttpError(409, 'This would leave no active SUPER_ADMIN', 'CONFLICT');
  }

  async list(q: { search?: string | undefined; status?: UserStatus | undefined; role?: Role | undefined; limit: number; offset: number }) {
    const where: Prisma.UserWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.role ? { roles: { some: { role: q.role } } } : {}),
      ...(q.search ? { OR: [{ email: { contains: likeEscape(q.search.toLowerCase()) } }, { name: { contains: likeEscape(q.search), mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.user.findMany({ where, include: { roles: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: q.limit, skip: q.offset }),
      this.db.user.count({ where }),
    ]);
    return { users: rows.map(toPublicUser), total };
  }

  async get(id: string): Promise<PublicUser> {
    return toPublicUser(await this.load(id));
  }

  async create(actor: AuthContext, input: { email: string; name: string; role: Role }, meta: RequestMeta) {
    if (!input.email.endsWith(`@${this.cfg.ALLOWED_EMAIL_DOMAIN}`)) {
      throw new HttpError(400, `Email must be an @${this.cfg.ALLOWED_EMAIL_DOMAIN} address`, 'VALIDATION_ERROR', [
        { path: 'email', message: `Must end with @${this.cfg.ALLOWED_EMAIL_DOMAIN}` },
      ]);
    }
    const actorRank = Math.max(0, ...actor.roles.map((r) => ROLE_RANK[r]));
    if (ROLE_RANK[input.role] > actorRank) throw new HttpError(403, 'You cannot grant a role above your own', 'FORBIDDEN');
    if (input.role === 'SUPER_ADMIN' && !actor.roles.includes('SUPER_ADMIN')) throw new HttpError(403, 'Only a SUPER_ADMIN can create a SUPER_ADMIN', 'FORBIDDEN');

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hasher.hash(temporaryPassword);
    try {
      const created = await this.db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: input.email,
            name: input.name,
            status: 'INVITED',
            createdById: actor.userId,
            credential: { create: { passwordHash, mustChangePassword: true } },
            roles: { create: { role: input.role, grantedById: actor.userId } },
          },
          include: { roles: true },
        });
        await this.audit(tx, actor, 'USER_CREATED', user.id, meta, { role: input.role });
        return user;
      });
      return { user: toPublicUser(created), temporaryPassword };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError(409, 'A user with this email already exists', 'CONFLICT');
      }
      throw err;
    }
  }

  async setStatus(actor: AuthContext, id: string, status: 'ACTIVE' | 'DEACTIVATED', meta: RequestMeta) {
    const target = await this.load(id);
    this.assertMayManage(actor, target);
    if (status === 'DEACTIVATED') {
      if (id === actor.userId) throw new HttpError(409, 'You cannot deactivate your own account', 'CONFLICT');
      if (toRoles(target.roles).includes('SUPER_ADMIN')) await this.assertNotLastSuperAdmin(id);
    }
    if (target.status === status) return toPublicUser(target);

    const updated = await this.db.$transaction(async (tx) => {
      let next: UserStatus = status;
      if (status === 'ACTIVE') {
        // Re-activation: a user who never set their own password goes back to INVITED.
        const cred = await tx.passwordCredential.findUnique({ where: { userId: id }, select: { passwordChangedAt: true } });
        next = cred?.passwordChangedAt ? 'ACTIVE' : 'INVITED';
        await tx.passwordCredential.update({ where: { userId: id }, data: { failedLoginCount: 0, lockedUntil: null } });
      }
      const u = await tx.user.update({ where: { id }, data: { status: next }, include: { roles: true } });
      // Deactivation takes effect immediately: every session dies in the same transaction.
      if (status === 'DEACTIVATED') {
        await this.sessions.revokeAllForUser(tx, id, 'DEACTIVATED');
        for (const hook of this.deactivateHooks) await hook(tx, id);
      }
      await this.audit(tx, actor, status === 'DEACTIVATED' ? 'USER_DEACTIVATED' : 'USER_REACTIVATED', id, meta);
      return u;
    });
    return toPublicUser(updated);
  }

  async setRoles(actor: AuthContext, id: string, roles: Role[], meta: RequestMeta) {
    const target = await this.load(id);
    const unique = [...new Set(roles)].filter((r) => (ROLES as readonly string[]).includes(r));
    const before = toRoles(target.roles);
    if (before.includes('SUPER_ADMIN') && !unique.includes('SUPER_ADMIN')) await this.assertNotLastSuperAdmin(id);

    const updated = await this.db.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId: id, role: { notIn: unique } } });
      for (const role of unique) {
        await tx.userRole.upsert({
          where: { userId_role: { userId: id, role } },
          create: { userId: id, role, grantedById: actor.userId },
          update: {},
        });
      }
      await this.audit(tx, actor, 'ROLES_CHANGED', id, meta, { before, after: unique });
      return tx.user.findUniqueOrThrow({ where: { id }, include: { roles: true } });
    });
    return toPublicUser(updated);
  }

  async resetPassword(actor: AuthContext, id: string, meta: RequestMeta) {
    if (id === actor.userId) throw new HttpError(409, 'Use "change password" for your own account', 'CONFLICT');
    const target = await this.load(id);
    this.assertMayManage(actor, target);
    if (target.status === 'DEACTIVATED') throw new HttpError(409, 'Reactivate the user first', 'CONFLICT');

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hasher.hash(temporaryPassword);
    await this.db.$transaction(async (tx) => {
      await tx.passwordCredential.update({
        where: { userId: id },
        data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
      });
      await this.sessions.revokeAllForUser(tx, id, 'PASSWORD_CHANGED');
      await this.audit(tx, actor, 'PASSWORD_RESET_BY_ADMIN', id, meta);
    });
    return { user: toPublicUser(await this.load(id)), temporaryPassword };
  }

  async revokeSessions(actor: AuthContext, id: string, meta: RequestMeta) {
    const target = await this.load(id);
    this.assertMayManage(actor, target);
    const count = await this.db.$transaction(async (tx) => {
      const n = await this.sessions.revokeAllForUser(tx, id, 'ADMIN_REVOKED');
      await this.audit(tx, actor, 'SESSIONS_REVOKED_BY_ADMIN', id, meta, { count: n });
      return n;
    });
    return { revoked: count };
  }
}
