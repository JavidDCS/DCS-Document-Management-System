import type { Prisma, PrismaClient } from '@prisma/client';
import {
  checkPasswordPolicy,
  permissionsForRoles,
  ROLES,
  type AuthUser,
  type LoginResponse,
  type Role,
  type UserStatus,
} from '@dcs-docs/shared';
import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../utils/logger.js';
import type { VerifiedIdentity } from '../../providers/identity/types.js';
import { recordAudit } from '../audit/index.js';
import { PasswordHasher } from './password.js';
import type { ClientMeta, SessionService } from './session.service.js';
import type { TokenService } from './tokens.js';

export interface AuthConfig {
  LOGIN_MAX_FAILED_ATTEMPTS: number;
  LOGIN_LOCKOUT_MINUTES: number;
  REAUTH_MAX_AGE_SECONDS: number;
  ALLOWED_EMAIL_DOMAIN: string;
  AUTH_PASSWORD_LOGIN_ENABLED: boolean;
}

const GENERIC_LOGIN_ERROR = 'Invalid email or password';
const INVALID_SESSION = 'Session expired. Please sign in again.';

type LoginOutcome =
  | 'SUCCESS'
  | 'FAILED_CREDENTIALS'
  | 'LOCKED'
  | 'DENIED_INACTIVE'
  | 'PASSWORD_CHANGED'
  | 'REAUTH'
  | 'REFRESH_REUSE'
  | 'DENIED_WRONG_DOMAIN'
  | 'DENIED_NOT_INVITED'
  | 'DENIED_INVALID_TOKEN';

export interface AuthResult extends LoginResponse {
  refreshToken: string;
  refreshExpiresAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  status: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  roles: { role: string }[];
}

export function toRoles(rows: { role: string }[]): Role[] {
  return rows.map((r) => r.role).filter((r): r is Role => (ROLES as readonly string[]).includes(r));
}

export function toAuthUser(u: UserRow, mustChangePassword: boolean): AuthUser {
  const roles = toRoles(u.roles);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    status: u.status as UserStatus,
    roles,
    permissions: permissionsForRoles(roles),
    mustChangePassword,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

/** Email + password provider and the session flows. Sessions, tokens and permissions are provider-agnostic. */
export class AuthService {
  constructor(
    private readonly db: PrismaClient,
    private readonly cfg: AuthConfig,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService
  ) {}

  private async loginEvent(
    tx: PrismaClient | Prisma.TransactionClient,
    outcome: LoginOutcome,
    email: string,
    userId: string | null,
    meta: ClientMeta & { requestId?: string | undefined },
    method: string = 'password'
  ) {
    await tx.loginEvent.create({
      data: {
        userId,
        emailAttempted: email.slice(0, 254),
        method,
        outcome,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
        requestId: meta.requestId ?? null,
      },
    });
  }

  private audit(
    tx: PrismaClient | Prisma.TransactionClient,
    action: string,
    userId: string | null,
    meta: ClientMeta & { requestId?: string | undefined },
    outcome: 'SUCCESS' | 'DENIED' | 'FAILURE' = 'SUCCESS',
    details: Record<string, unknown> = {}
  ) {
    return recordAudit(tx, {
      actorType: userId ? 'USER' : 'SYSTEM',
      actorUserId: userId,
      action,
      resourceType: 'user',
      resourceId: userId,
      outcome,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      requestId: meta.requestId ?? null,
      details,
    });
  }

  /** Counts a failed password and locks the account when the limit is reached. */
  private async registerFailure(userId: string, meta: ClientMeta & { requestId?: string | undefined }) {
    const cred = await this.db.passwordCredential.update({
      where: { userId },
      data: { failedLoginCount: { increment: 1 }, lastFailedAt: new Date() },
      select: { failedLoginCount: true },
    });
    if (cred.failedLoginCount >= this.cfg.LOGIN_MAX_FAILED_ATTEMPTS) {
      await this.db.$transaction(async (tx) => {
        await tx.passwordCredential.update({
          where: { userId },
          data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + this.cfg.LOGIN_LOCKOUT_MINUTES * 60_000) },
        });
        await this.audit(tx, 'ACCOUNT_LOCKED', userId, meta, 'DENIED', { minutes: this.cfg.LOGIN_LOCKOUT_MINUTES });
      });
      logger.warn('Account locked after repeated failed sign-ins', { userId });
    }
  }

  async login(email: string, password: string, meta: ClientMeta & { requestId?: string }): Promise<AuthResult> {
    if (!this.cfg.AUTH_PASSWORD_LOGIN_ENABLED) {
      throw new HttpError(403, 'Password sign-in is disabled. Use Google sign-in.', 'PASSWORD_LOGIN_DISABLED');
    }
    const user = await this.db.user.findUnique({ where: { email }, include: { credential: true, roles: true } });

    if (!user || !user.credential) {
      await this.hasher.burn(password);
      await this.loginEvent(this.db, 'FAILED_CREDENTIALS', email, null, meta);
      await this.audit(this.db, 'LOGIN_FAILED', null, meta, 'DENIED', { reason: 'unknown_user' });
      throw new HttpError(401, GENERIC_LOGIN_ERROR, 'UNAUTHENTICATED');
    }

    if (user.credential.lockedUntil && user.credential.lockedUntil > new Date()) {
      await this.hasher.burn(password);
      await this.loginEvent(this.db, 'LOCKED', email, user.id, meta);
      throw new HttpError(423, 'Account temporarily locked after too many failed attempts. Try again later.', 'ACCOUNT_LOCKED');
    }

    const ok = await this.hasher.verify(password, user.credential.passwordHash);
    if (!ok) {
      await this.registerFailure(user.id, meta);
      await this.loginEvent(this.db, 'FAILED_CREDENTIALS', email, user.id, meta);
      await this.audit(this.db, 'LOGIN_FAILED', user.id, meta, 'DENIED', { reason: 'bad_password' });
      throw new HttpError(401, GENERIC_LOGIN_ERROR, 'UNAUTHENTICATED');
    }

    if (user.status === 'DEACTIVATED') {
      await this.loginEvent(this.db, 'DENIED_INACTIVE', email, user.id, meta);
      await this.audit(this.db, 'LOGIN_FAILED', user.id, meta, 'DENIED', { reason: 'deactivated' });
      throw new HttpError(401, GENERIC_LOGIN_ERROR, 'UNAUTHENTICATED');
    }

    const now = new Date();
    const issued = await this.db.$transaction(async (tx) => {
      await tx.passwordCredential.update({ where: { userId: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
      const s = await this.sessions.create(tx, { userId: user.id, method: 'password', authTime: now, meta });
      await this.loginEvent(tx, 'SUCCESS', email, user.id, meta);
      await this.audit(tx, 'LOGIN_SUCCEEDED', user.id, meta, 'SUCCESS', { sessionId: s.sessionId });
      return s;
    });

    return this.result(toAuthUser({ ...user, lastLoginAt: now }, user.credential.mustChangePassword), issued, now);
  }

  private result(
    user: AuthUser,
    issued: { sessionId: string; refreshToken: string; absoluteExpiresAt: Date; authTime: Date; method: string },
    _now: Date
  ): AuthResult {
    return {
      user,
      accessToken: this.tokens.signAccess({
        userId: user.id,
        sessionId: issued.sessionId,
        authTime: Math.floor(issued.authTime.getTime() / 1000),
        method: issued.method,
      }),
      expiresIn: this.tokens.ttlSeconds,
      refreshToken: issued.refreshToken,
      refreshExpiresAt: issued.absoluteExpiresAt,
    };
  }

  /**
   * Second login method: an externally-verified identity (today only Google Workspace OIDC). Invite-only — a user
   * must already exist and be matched by verified email on first use, then only ever by the provider's stable
   * subject id. Goes through the identical session/permission machinery as password login; no parallel logic.
   */
  async loginWithProvider(identity: VerifiedIdentity, meta: ClientMeta & { requestId?: string }): Promise<AuthResult> {
    const extraDomains = (this.cfg as any).ALLOWED_GOOGLE_DOMAINS
      ? String((this.cfg as any).ALLOWED_GOOGLE_DOMAINS).split(',').map((d: string) => d.trim().toLowerCase()).filter(Boolean)
      : [];
    const allowed = [this.cfg.ALLOWED_EMAIL_DOMAIN.toLowerCase(), ...extraDomains];
    const emailDomain = identity.email.split('@')[1]?.toLowerCase();
    const domainMatches =
      (identity.hostedDomain && allowed.includes(identity.hostedDomain.toLowerCase())) ||
      (emailDomain && allowed.includes(emailDomain));
    if (!domainMatches) {
      await this.loginEvent(this.db, 'DENIED_WRONG_DOMAIN', identity.email, null, meta, identity.provider.toLowerCase());
      await this.audit(this.db, 'LOGIN_FAILED', null, meta, 'DENIED', { reason: 'wrong_domain', provider: identity.provider });
      throw new HttpError(401, 'This Google account is not part of the allowed organisation.', 'GOOGLE_WRONG_DOMAIN');
    }

    const linked = await this.db.identityAccount.findUnique({
      where: { provider_subject: { provider: identity.provider, subject: identity.subject } },
    });

    let userId: string;
    if (linked) {
      userId = linked.userId;
    } else {
      const existing = await this.db.user.findUnique({ where: { email: identity.email }, select: { id: true, status: true } });
      if (!existing) {
        await this.loginEvent(this.db, 'DENIED_NOT_INVITED', identity.email, null, meta, identity.provider.toLowerCase());
        await this.audit(this.db, 'LOGIN_FAILED', null, meta, 'DENIED', { reason: 'not_invited', provider: identity.provider });
        throw new HttpError(401, 'No account is set up for this Google address. Ask an admin to invite you.', 'GOOGLE_NOT_INVITED');
      }
      // Checked before linking: a deactivated account's first Google attempt must not create a lasting link either.
      if (existing.status === 'DEACTIVATED') {
        await this.loginEvent(this.db, 'DENIED_INACTIVE', identity.email, existing.id, meta, identity.provider.toLowerCase());
        await this.audit(this.db, 'LOGIN_FAILED', existing.id, meta, 'DENIED', { reason: 'deactivated', provider: identity.provider });
        throw new HttpError(401, 'This account has been deactivated.', 'GOOGLE_DEACTIVATED');
      }
      userId = existing.id;
      await this.db.$transaction(async (tx) => {
        await tx.identityAccount.create({ data: { provider: identity.provider, subject: identity.subject, userId, email: identity.email } });
        await this.audit(tx, 'IDENTITY_ACCOUNT_LINKED', userId, meta, 'SUCCESS', { provider: identity.provider });
      });
    }

    const user = await this.db.user.findUnique({ where: { id: userId }, include: { credential: true, roles: true } });
    if (!user) throw new HttpError(401, GENERIC_LOGIN_ERROR, 'UNAUTHENTICATED');

    if (user.status === 'DEACTIVATED') {
      await this.loginEvent(this.db, 'DENIED_INACTIVE', identity.email, user.id, meta, identity.provider.toLowerCase());
      await this.audit(this.db, 'LOGIN_FAILED', user.id, meta, 'DENIED', { reason: 'deactivated', provider: identity.provider });
      throw new HttpError(401, 'This account has been deactivated.', 'GOOGLE_DEACTIVATED');
    }

    const now = new Date();
    const method = identity.provider.toLowerCase();
    const issued = await this.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: now, ...(user.status === 'INVITED' ? { status: 'ACTIVE' } : {}) } });
      const s = await this.sessions.create(tx, { userId: user.id, method, authTime: now, meta });
      await this.loginEvent(tx, 'SUCCESS', identity.email, user.id, meta, method);
      await this.audit(tx, 'LOGIN_SUCCEEDED', user.id, meta, 'SUCCESS', { sessionId: s.sessionId, provider: identity.provider });
      return s;
    });

    return this.result(toAuthUser({ ...user, lastLoginAt: now }, user.credential?.mustChangePassword ?? false), issued, now);
  }

  async refresh(refreshToken: string | undefined, meta: ClientMeta & { requestId?: string }): Promise<AuthResult> {
    if (!refreshToken) throw new HttpError(401, INVALID_SESSION, 'UNAUTHENTICATED');
    const rotated = await this.sessions.rotate(refreshToken, meta);
    if (!rotated.ok) {
      if (rotated.reason === 'REUSED') {
        await this.loginEvent(this.db, 'REFRESH_REUSE', '', rotated.userId ?? null, meta);
        await this.audit(this.db, 'REFRESH_TOKEN_REUSE_DETECTED', rotated.userId ?? null, meta, 'DENIED');
      }
      throw new HttpError(401, INVALID_SESSION, 'UNAUTHENTICATED');
    }
    const user = await this.db.user.findUnique({ where: { id: rotated.userId }, include: { credential: true, roles: true } });
    if (!user || !user.credential || user.status === 'DEACTIVATED') throw new HttpError(401, INVALID_SESSION, 'UNAUTHENTICATED');
    return this.result(toAuthUser(user, user.credential.mustChangePassword), rotated.issued, new Date());
  }

  async logout(refreshToken: string | undefined, meta: ClientMeta & { requestId?: string }): Promise<void> {
    if (!refreshToken) return;
    const userId = await this.sessions.revokeByRefreshToken(refreshToken, 'LOGOUT');
    if (userId) await this.audit(this.db, 'LOGOUT', userId, meta);
  }

  async me(userId: string): Promise<AuthUser> {
    const user = await this.db.user.findUnique({ where: { id: userId }, include: { credential: true, roles: true } });
    if (!user || !user.credential) throw new HttpError(401, 'Authentication required', 'UNAUTHENTICATED');
    return toAuthUser(user, user.credential.mustChangePassword);
  }

  /** Verifies the typed password for an already signed-in user; failures count toward the lockout. */
  private async checkOwnPassword(userId: string, password: string, meta: ClientMeta & { requestId?: string }) {
    const user = await this.db.user.findUnique({ where: { id: userId }, include: { credential: true, roles: true } });
    if (!user || !user.credential || user.status === 'DEACTIVATED') throw new HttpError(401, 'Authentication required', 'UNAUTHENTICATED');
    if (user.credential.lockedUntil && user.credential.lockedUntil > new Date()) {
      throw new HttpError(423, 'Account temporarily locked after too many failed attempts. Try again later.', 'ACCOUNT_LOCKED');
    }
    if (!(await this.hasher.verify(password, user.credential.passwordHash))) {
      await this.registerFailure(user.id, meta);
      await this.audit(this.db, 'PASSWORD_CHECK_FAILED', user.id, meta, 'DENIED');
      // 400, not 401: the client treats 401 as "session expired" and would sign the user out.
      throw new HttpError(400, 'Current password is incorrect', 'VALIDATION_ERROR');
    }
    return user;
  }

  async changePassword(
    userId: string,
    sessionId: string,
    currentPassword: string,
    newPassword: string,
    meta: ClientMeta & { requestId?: string }
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const user = await this.checkOwnPassword(userId, currentPassword, meta);

    const problems = checkPasswordPolicy(newPassword, { email: user.email, name: user.name });
    if (newPassword === currentPassword) problems.push('The new password must be different from the current one.');
    if (problems.length > 0) {
      throw new HttpError(400, problems.join(' '), 'PASSWORD_POLICY', problems.map((message) => ({ path: 'newPassword', message })));
    }

    const hash = await this.hasher.hash(newPassword);
    const now = new Date();
    await this.db.$transaction(async (tx) => {
      await tx.passwordCredential.update({
        where: { userId },
        data: { passwordHash: hash, mustChangePassword: false, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
      });
      if (user.status === 'INVITED') await tx.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
      await this.sessions.revokeAllForUser(tx, userId, 'PASSWORD_CHANGED', sessionId);
      await tx.session.update({ where: { id: sessionId }, data: { authTime: now } });
      await this.loginEvent(tx, 'PASSWORD_CHANGED', user.email, userId, meta);
      await this.audit(tx, 'PASSWORD_CHANGED', userId, meta);
    });

    return {
      accessToken: this.tokens.signAccess({ userId, sessionId, authTime: Math.floor(now.getTime() / 1000), method: 'password' }),
      expiresIn: this.tokens.ttlSeconds,
    };
  }

  /** Re-authentication for sensitive actions: the password is typed again and the session's auth_time moves forward. */
  async reauth(userId: string, sessionId: string, password: string, meta: ClientMeta & { requestId?: string }) {
    const user = await this.checkOwnPassword(userId, password, meta);
    const now = new Date();
    await this.sessions.markReauthenticated(sessionId, now);
    await this.loginEvent(this.db, 'REAUTH', user.email, userId, meta);
    await this.audit(this.db, 'REAUTH_SUCCEEDED', userId, meta);
    return {
      accessToken: this.tokens.signAccess({ userId, sessionId, authTime: Math.floor(now.getTime() / 1000), method: 'password' }),
      expiresIn: this.tokens.ttlSeconds,
    };
  }
}
