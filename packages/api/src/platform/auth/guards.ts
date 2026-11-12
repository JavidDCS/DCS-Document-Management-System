import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Permission } from '@dcs-docs/shared';
import type { SessionService } from '../../modules/identity/session.service.js';
import type { TokenService } from '../../modules/identity/tokens.js';
import { HttpError } from '../../utils/httpError.js';

/** Builds the guard for a route: verifies the Bearer access token, then loads the identity fresh from the database. */
export type Authenticator = (opts: { allowMustChangePassword: boolean }) => RequestHandler;

export function createAuthenticator(tokens: TokenService, sessions: SessionService): Authenticator {
  return ({ allowMustChangePassword }) =>
    async (req: Request, _res: Response, next: NextFunction) => {
      try {
        const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
        if (!match) throw new HttpError(401, 'Authentication required', 'UNAUTHENTICATED');
        const claims = tokens.verifyAccess(match[1]!);
        if (!claims) throw new HttpError(401, 'Invalid or expired access token', 'UNAUTHENTICATED');
        const ctx = await sessions.loadContext(claims.userId, claims.sessionId);
        if (!ctx) throw new HttpError(401, 'Invalid or expired access token', 'UNAUTHENTICATED');
        if (ctx.mustChangePassword && !allowMustChangePassword) {
          throw new HttpError(403, 'You must change your password before continuing', 'PASSWORD_CHANGE_REQUIRED');
        }
        req.auth = ctx;
        next();
      } catch (err) {
        next(err);
      }
    };
}

/** Must run after the authenticator. Missing permission is a 403 with no hint about what exists. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new HttpError(401, 'Authentication required', 'UNAUTHENTICATED'));
    if (!req.auth.permissions.includes(permission)) {
      return next(new HttpError(403, 'You do not have permission to perform this action', 'FORBIDDEN'));
    }
    next();
  };
}

/** Service-level variant of requireRecentAuth, for rules that depend on data (e.g. "only when documents exist"). */
export function assertRecentAuth(auth: { authTime: Date }, maxAgeSeconds: number): void {
  if (Date.now() - auth.authTime.getTime() > maxAgeSeconds * 1000) {
    throw new HttpError(401, 'Please confirm your password to continue', 'REAUTH_REQUIRED');
  }
}

/** The password must have been typed within the last `maxAgeSeconds` (see POST /auth/reauth). */
export function requireRecentAuth(maxAgeSeconds: number): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new HttpError(401, 'Authentication required', 'UNAUTHENTICATED'));
    if (Date.now() - req.auth.authTime.getTime() > maxAgeSeconds * 1000) {
      return next(new HttpError(401, 'Please confirm your password to continue', 'REAUTH_REQUIRED'));
    }
    next();
  };
}
