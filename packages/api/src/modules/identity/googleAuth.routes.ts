import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { AppContext } from '../../app.js';
import { PUBLIC, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { HttpError } from '../../utils/httpError.js';
import { logger } from '../../utils/logger.js';
import type { GoogleOidcProvider } from '../../providers/identity/googleOidc.js';
import { auditContext } from '../audit/index.js';
import type { AuthService } from './auth.service.js';
import { codeChallengeFor, generateCodeVerifier, generateNonce, generateState, packOauthState, unpackOauthState } from './googleLoginState.js';

const OAUTH_COOKIE_PATH = '/api/v1/auth/google';
const OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

export interface GoogleAuthRoutesDeps {
  auth: AuthService;
  provider: GoogleOidcProvider;
  enabled: boolean;
  cookie: { name: string; secure: boolean };
  /** HMAC key for the OAuth state cookie; domain-separated from other uses of the same secret (see googleLoginState.ts). */
  stateSecret: string;
  appPublicUrl: string;
}

function cookieName(secure: boolean) {
  return secure ? '__Secure-dcs_google_oauth' : 'dcs_google_oauth';
}

function sameLength(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function registerGoogleAuthRoutes(secure: SecureRouter, ctx: AppContext, deps: GoogleAuthRoutesDeps) {
  const { auth, provider, cookie, stateSecret } = deps;
  const appPublicUrl = deps.appPublicUrl.replace(/\/+$/, '');
  const oauthCookie = cookieName(cookie.secure);

  const clearOauthCookie = (res: Response) => res.clearCookie(oauthCookie, { httpOnly: true, secure: cookie.secure, sameSite: 'lax', path: OAUTH_COOKIE_PATH });
  const redirectWithError = (res: Response, code: string) => res.redirect(302, `${appPublicUrl}/login?error=${code}`);

  /**
   * A plain HTTP 302 here would still be part of the cross-site navigation chain that started at Google's consent
   * page, so some browsers refuse to attach the SameSite=Strict refresh cookie we just set on the very next hop.
   * Serving a same-origin HTML bounce page makes the next navigation a fresh, same-site one, so the cookie is
   * reliably sent when the SPA loads and calls /auth/refresh. This API sends a strict `default-src 'none'` CSP on
   * every response (see securityHeaders.ts), which blocks inline <script>, so the bounce is a <meta refresh> —
   * plain declarative HTML navigation, not script execution, and CSP has no effect on it.
   */
  const bounceTo = (res: Response, target: string) => {
    const safe = target.replace(/"/g, '&quot;');
    res.status(200).type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"></head>` +
        `<body>Redirecting… <a href="${safe}">Continue</a></body></html>`
    );
  };

  secure.get(
    '/auth/google/start',
    PUBLIC('redirects to Google; the OAuth state is bound to this browser by a signed, single-use cookie'),
    ctx.limiters.auth,
    (req, res) => {
      if (!deps.enabled || !provider.available) throw new HttpError(503, 'Google sign-in is not enabled', 'INTERNAL_ERROR');
      const state = generateState();
      const nonce = generateNonce();
      const verifier = generateCodeVerifier();
      res.cookie(oauthCookie, packOauthState(stateSecret, { state, nonce, verifier }), {
        httpOnly: true,
        secure: cookie.secure,
        // Lax, not Strict: this cookie must still be sent on the top-level GET redirect back from accounts.google.com.
        sameSite: 'lax',
        path: OAUTH_COOKIE_PATH,
        maxAge: OAUTH_COOKIE_MAX_AGE_MS,
      });
      res.redirect(302, provider.buildAuthUrl({ state, nonce, codeChallenge: codeChallengeFor(verifier) }));
    }
  );

  secure.get(
    '/auth/google/callback',
    PUBLIC('browser redirect from Google; authenticated by the single-use signed state cookie, never by the query string alone'),
    ctx.limiters.auth,
    asyncHandler(async (req, res) => {
      const cookieValue = (req.cookies as Record<string, unknown> | undefined)?.[oauthCookie];
      clearOauthCookie(res); // single use, whether or not the rest succeeds

      if (typeof req.query.error === 'string') return redirectWithError(res, 'cancelled');

      const unpacked = unpackOauthState(stateSecret, typeof cookieValue === 'string' ? cookieValue : undefined);
      const queryState = typeof req.query.state === 'string' ? req.query.state : undefined;
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      if (!unpacked || !queryState || !code || !sameLength(unpacked.state, queryState)) {
        return redirectWithError(res, 'expired');
      }

      let identity;
      try {
        identity = await provider.exchangeAndVerify({ code, codeVerifier: unpacked.verifier, expectedNonce: unpacked.nonce });
      } catch (err) {
        logger.warn('Google sign-in failed', { error: err instanceof Error ? err.message : 'error' });
        return redirectWithError(res, 'invalid');
      }

      try {
        const result = await auth.loginWithProvider(identity, auditContext(req));
        res.cookie(cookie.name, result.refreshToken, {
          httpOnly: true,
          secure: cookie.secure,
          sameSite: 'strict',
          path: '/api/v1/auth',
          expires: result.refreshExpiresAt,
        });
        return bounceTo(res, `${appPublicUrl}/`);
      } catch (err) {
        if (err instanceof HttpError) {
          const byCode: Record<string, string> = {
            GOOGLE_WRONG_DOMAIN: 'wrong_domain',
            GOOGLE_NOT_INVITED: 'not_invited',
            GOOGLE_DEACTIVATED: 'deactivated',
          };
          return redirectWithError(res, byCode[err.code] ?? 'invalid');
        }
        throw err;
      }
    })
  );
}
