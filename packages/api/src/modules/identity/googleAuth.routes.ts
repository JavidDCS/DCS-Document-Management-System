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
          // Lax, not Strict, for this one issuance only: this request is the top-level GET navigation Google just
          // redirected the browser to, and Chrome/Firefox/Safari all have documented inconsistencies attaching a
          // Strict cookie to the request that immediately follows a cross-site-initiated redirect chain (Chromium
          // issue 1221316; matching Firefox/WebKit reports). Lax is designed for exactly this case. The very next
          // /auth/login, /auth/refresh etc. call is a plain same-origin fetch, which re-issues this cookie as
          // Strict (see identity.routes.ts), so the Lax window is this single response only.
          sameSite: 'lax',
          path: '/api/v1/auth',
          expires: result.refreshExpiresAt,
        });
        return res.redirect(302, `${appPublicUrl}/`);
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
