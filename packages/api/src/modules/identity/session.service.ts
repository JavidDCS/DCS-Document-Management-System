import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { permissionsForRoles, ROLES, type Role } from '@dcs-docs/shared';
import type { AuthContext } from '../../types/express.js';
import { logger } from '../../utils/logger.js';
import { generateRefreshToken, hashToken } from './tokens.js';

export type RevokeReason =
  | 'ROTATED'
  | 'LOGOUT'
  | 'DEACTIVATED'
  | 'PASSWORD_CHANGED'
  | 'ADMIN_REVOKED'
  | 'REUSE_DETECTED'
  | 'ROLE_CHANGED';

export interface SessionConfig {
  REFRESH_TOKEN_IDLE_TIMEOUT_MINUTES: number;
  SESSION_ABSOLUTE_TIMEOUT_HOURS: number;
}

export interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

type Tx = Prisma.TransactionClient;

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  /** Cookie lifetime: the absolute deadline of the session. */
  absoluteExpiresAt: Date;
  authTime: Date;
}

export type RotateResult =
  | { ok: true; userId: string; issued: IssuedSession }
  | { ok: false; reason: 'INVALID' | 'EXPIRED' | 'REUSED' | 'INACTIVE'; userId?: string };

export class SessionService {
  constructor(
    private readonly db: PrismaClient,
    private readonly cfg: SessionConfig
  ) {}

  private idleDeadline(from: Date, absolute: Date): Date {
    const idle = new Date(from.getTime() + this.cfg.REFRESH_TOKEN_IDLE_TIMEOUT_MINUTES * 60_000);
    return idle < absolute ? idle : absolute;
  }

  async create(
    tx: Tx,
    input: { userId: string; method: string; authTime: Date; familyId?: string; absoluteExpiresAt?: Date; meta: ClientMeta }
  ): Promise<IssuedSession> {
    const now = new Date();
    const refreshToken = generateRefreshToken();
    const absoluteExpiresAt = input.absoluteExpiresAt ?? new Date(now.getTime() + this.cfg.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000);
    const row = await tx.session.create({
      data: {
        userId: input.userId,
        familyId: input.familyId ?? randomUUID(),
        refreshTokenHash: hashToken(refreshToken),
        authMethod: input.method,
        authTime: input.authTime,
        lastUsedAt: now,
        idleExpiresAt: this.idleDeadline(now, absoluteExpiresAt),
        absoluteExpiresAt,
        ip: input.meta.ip ?? null,
        userAgent: input.meta.userAgent?.slice(0, 255) ?? null,
      },
    });
    return { sessionId: row.id, refreshToken, absoluteExpiresAt, authTime: input.authTime };
  }

  /**
   * Exchanges a refresh token for a new one. A token that was already rotated (or revoked) being presented again
   * means it leaked, so the whole family is revoked. The claim is an atomic conditional update, so two simultaneous
   * uses of one token cannot both succeed.
   */
  async rotate(refreshToken: string, meta: ClientMeta): Promise<RotateResult> {
    const session = await this.db.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
      include: { user: { select: { id: true, status: true } } },
    });
    if (!session) return { ok: false, reason: 'INVALID' };

    if (session.revokedAt) {
      if (session.revokedReason === 'ROTATED' || session.revokedReason === 'REUSE_DETECTED') {
        await this.revokeFamily(session.familyId, 'REUSE_DETECTED');
        logger.warn('Refresh token reuse detected; session family revoked', { userId: session.userId });
        return { ok: false, reason: 'REUSED', userId: session.userId };
      }
      return { ok: false, reason: 'INVALID', userId: session.userId };
    }

    const now = new Date();
    if (session.absoluteExpiresAt <= now || session.idleExpiresAt <= now) return { ok: false, reason: 'EXPIRED', userId: session.userId };
    if (session.user.status === 'DEACTIVATED') return { ok: false, reason: 'INACTIVE', userId: session.userId };

    return this.db.$transaction(async (tx): Promise<RotateResult> => {
      const claimed = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'ROTATED' },
      });
      if (claimed.count !== 1) return { ok: false, reason: 'REUSED', userId: session.userId };
      const issued = await this.create(tx, {
        userId: session.userId,
        method: session.authMethod,
        authTime: session.authTime,
        familyId: session.familyId,
        absoluteExpiresAt: session.absoluteExpiresAt,
        meta,
      });
      return { ok: true, userId: session.userId, issued };
    }).then(async (result) => {
      if (!result.ok && result.reason === 'REUSED') await this.revokeFamily(session.familyId, 'REUSE_DETECTED');
      return result;
    });
  }

  async revokeFamily(familyId: string, reason: RevokeReason): Promise<number> {
    const r = await this.db.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    return r.count;
  }

  async revokeByRefreshToken(refreshToken: string, reason: RevokeReason): Promise<string | null> {
    const row = await this.db.session.findUnique({ where: { refreshTokenHash: hashToken(refreshToken) }, select: { id: true, userId: true } });
    if (!row) return null;
    await this.db.session.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    return row.userId;
  }

  /** Revokes every live session of a user (optionally keeping one). Pass a tx to make it atomic with the caller's change. */
  async revokeAllForUser(db: PrismaClient | Tx, userId: string, reason: RevokeReason, exceptSessionId?: string): Promise<number> {
    const r = await db.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return r.count;
  }

  async revokeOne(userId: string, sessionId: string, reason: RevokeReason): Promise<boolean> {
    const r = await this.db.session.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    return r.count === 1;
  }

  async listActive(userId: string) {
    return this.db.session.findMany({
      where: { userId, revokedAt: null, absoluteExpiresAt: { gt: new Date() }, idleExpiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, lastUsedAt: true, ip: true, userAgent: true, authMethod: true },
    });
  }

  async markReauthenticated(sessionId: string, at: Date): Promise<void> {
    await this.db.session.update({ where: { id: sessionId }, data: { authTime: at } });
  }

  /**
   * The identity for one request, loaded fresh from the database: a deactivated user, a revoked or expired session,
   * or a role change takes effect on the very next request. Returns null when the token's session is not usable.
   */
  async loadContext(userId: string, sessionId: string): Promise<AuthContext | null> {
    const s = await this.db.session.findUnique({
      where: { id: sessionId },
      include: { user: { include: { roles: true, credential: { select: { mustChangePassword: true } } } } },
    });
    if (!s || s.userId !== userId || s.revokedAt || s.absoluteExpiresAt <= new Date()) return null;
    const u = s.user;
    if (u.status === 'DEACTIVATED' || !u.credential) return null;
    const roles = u.roles.map((r) => r.role).filter((r): r is Role => (ROLES as readonly string[]).includes(r));
    return {
      userId: u.id,
      sessionId: s.id,
      email: u.email,
      name: u.name,
      status: u.status === 'ACTIVE' ? 'ACTIVE' : 'INVITED',
      roles,
      permissions: permissionsForRoles(roles),
      mustChangePassword: u.credential.mustChangePassword,
      authTime: s.authTime,
    };
  }
}
