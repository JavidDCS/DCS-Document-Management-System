import type { Request, Response } from 'express';
import { z } from 'zod';
import { changePasswordSchema, loginSchema, reauthSchema, uuidParamSchema } from '@dcs-docs/shared';
import type { AppContext } from '../../app.js';
import { AUTHENTICATED, PUBLIC, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { validate } from '../../platform/http/validateRequest.js';
import { HttpError } from '../../utils/httpError.js';
import { auditContext } from '../audit/index.js';
import type { AuthResult, AuthService } from './auth.service.js';
import type { SessionService } from './session.service.js';

export interface IdentityRouteDeps {
  auth: AuthService;
  sessions: SessionService;
  cookie: { name: string; secure: boolean };
}

const REFRESH_PATH = '/api/v1/auth';

function setRefreshCookie(res: Response, cookie: IdentityRouteDeps['cookie'], token: string, expires: Date) {
  res.cookie(cookie.name, token, { httpOnly: true, secure: cookie.secure, sameSite: 'strict', path: REFRESH_PATH, expires });
}

function clearRefreshCookie(res: Response, cookie: IdentityRouteDeps['cookie']) {
  res.clearCookie(cookie.name, { httpOnly: true, secure: cookie.secure, sameSite: 'strict', path: REFRESH_PATH });
}

const meta = (req: Request) => auditContext(req);

function sendAuth(res: Response, cookie: IdentityRouteDeps['cookie'], r: AuthResult) {
  setRefreshCookie(res, cookie, r.refreshToken, r.refreshExpiresAt);
  res.json({ data: { accessToken: r.accessToken, expiresIn: r.expiresIn, user: r.user } });
}

export function registerIdentityRoutes(secure: SecureRouter, ctx: AppContext, deps: IdentityRouteDeps) {
  const { auth, sessions, cookie } = deps;
  const { limiters } = ctx;

  secure.post(
    '/auth/login',
    PUBLIC('credentials are the proof; protected by rate limit, lockout and CSRF token'),
    limiters.auth,
    validate({ body: loginSchema }),
    asyncHandler(async (req, res) => {
      const { email, password } = req.body as z.infer<typeof loginSchema>;
      sendAuth(res, cookie, await auth.login(email, password, meta(req)));
    })
  );

  secure.post(
    '/auth/refresh',
    PUBLIC('authenticated by the httpOnly refresh cookie; CSRF token required'),
    limiters.refresh,
    asyncHandler(async (req, res) => {
      const token = (req.cookies as Record<string, unknown> | undefined)?.[cookie.name];
      try {
        sendAuth(res, cookie, await auth.refresh(typeof token === 'string' ? token : undefined, meta(req)));
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) clearRefreshCookie(res, cookie);
        throw err;
      }
    })
  );

  secure.post(
    '/auth/logout',
    PUBLIC('revokes the session identified by the refresh cookie; idempotent'),
    asyncHandler(async (req, res) => {
      const token = (req.cookies as Record<string, unknown> | undefined)?.[cookie.name];
      await auth.logout(typeof token === 'string' ? token : undefined, meta(req));
      clearRefreshCookie(res, cookie);
      res.status(204).end();
    })
  );

  secure.get(
    '/auth/me',
    { kind: 'authenticated', allowMustChangePassword: true },
    asyncHandler(async (req, res) => {
      res.json({ data: { user: await auth.me(req.auth!.userId) } });
    })
  );

  secure.post(
    '/auth/change-password',
    { kind: 'authenticated', allowMustChangePassword: true },
    limiters.auth,
    validate({ body: changePasswordSchema }),
    asyncHandler(async (req, res) => {
      const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;
      const r = await auth.changePassword(req.auth!.userId, req.auth!.sessionId, currentPassword, newPassword, meta(req));
      res.json({ data: r });
    })
  );

  secure.post(
    '/auth/reauth',
    AUTHENTICATED,
    limiters.auth,
    validate({ body: reauthSchema }),
    asyncHandler(async (req, res) => {
      const { password } = req.body as z.infer<typeof reauthSchema>;
      res.json({ data: await auth.reauth(req.auth!.userId, req.auth!.sessionId, password, meta(req)) });
    })
  );

  secure.get(
    '/auth/sessions',
    AUTHENTICATED,
    asyncHandler(async (req, res) => {
      const rows = await sessions.listActive(req.auth!.userId);
      res.json({
        data: rows.map((s) => ({
          id: s.id,
          current: s.id === req.auth!.sessionId,
          createdAt: s.createdAt.toISOString(),
          lastUsedAt: s.lastUsedAt.toISOString(),
          ip: s.ip,
          userAgent: s.userAgent,
        })),
      });
    })
  );

  secure.delete(
    '/auth/sessions/:id',
    AUTHENTICATED,
    validate({ params: uuidParamSchema }),
    asyncHandler(async (req, res) => {
      const ok = await sessions.revokeOne(req.auth!.userId, (req.params as { id: string }).id, 'LOGOUT');
      if (!ok) throw new HttpError(404, 'Session not found');
      res.status(204).end();
    })
  );
}
