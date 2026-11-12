import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from '../../utils/httpError.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';

export interface CsrfOptions {
  secret: string;
  secureCookie: boolean;
  allowedOrigins: string[];
}

/**
 * Double-submit CSRF protection for cookie-authenticated state-changing requests.
 *  - GET /api/v1/csrf issues a signed token: it is returned in the body and set in an httpOnly SameSite=Strict cookie.
 *  - Every non-safe request must send the same token in X-CSRF-Token; the HMAC proves the server issued it.
 *  - If an Origin header is present it must be one of the allowed origins.
 *  - A request carrying `Authorization: Bearer` is not cookie-authenticated (a cross-site page cannot add that
 *    header), so it needs no CSRF token; the auth middleware still has to accept the token.
 */
export function createCsrf(opts: CsrfOptions) {
  const cookieName = opts.secureCookie ? '__Host-dcs_csrf' : 'dcs_csrf';
  const allowed = new Set(opts.allowedOrigins);

  const sign = (nonce: string) => createHmac('sha256', opts.secret).update(nonce).digest('base64url');

  function issueToken(res: Response): string {
    const nonce = randomBytes(32).toString('base64url');
    const token = `${nonce}.${sign(nonce)}`;
    res.cookie(cookieName, token, {
      httpOnly: true,
      secure: opts.secureCookie,
      sameSite: 'strict',
      path: '/',
    });
    return token;
  }

  function isValidToken(token: string): boolean {
    const [nonce, mac, extra] = token.split('.');
    if (!nonce || !mac || extra !== undefined) return false;
    const expected = Buffer.from(sign(nonce));
    const given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  const verify: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.header('origin');
    if (origin !== undefined && !allowed.has(origin)) {
      return next(new HttpError(403, 'Origin not allowed', 'ORIGIN_NOT_ALLOWED'));
    }

    if (/^Bearer\s+\S+$/i.test(req.header('authorization') ?? '')) return next();

    const cookieToken = (req.cookies as Record<string, unknown> | undefined)?.[cookieName];
    const headerToken = req.header(CSRF_HEADER);
    if (
      typeof cookieToken !== 'string' ||
      typeof headerToken !== 'string' ||
      cookieToken.length !== headerToken.length ||
      !timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken)) ||
      !isValidToken(cookieToken)
    ) {
      return next(new HttpError(403, 'CSRF token missing or invalid', 'CSRF_FAILED'));
    }
    next();
  };

  return { cookieName, issueToken, verify };
}
