import cookieParser from 'cookie-parser';
import express, { Router, type Express } from 'express';
import { corsMiddleware } from './config/cors.js';
import type { Env } from './config/env.js';
import type { Authenticator } from './platform/auth/guards.js';
import { SecureRouter } from './platform/auth/secureRouter.js';
import { createCsrf } from './platform/http/csrf.js';
import { errorHandler, notFoundHandler } from './platform/http/errorHandler.js';
import { createRateLimiters } from './platform/http/rateLimit.js';
import { requestId } from './platform/http/requestId.js';
import { securityHeaders } from './platform/http/securityHeaders.js';

export type AppConfig = Pick<
  Env,
  | 'TRUST_PROXY'
  | 'CORS_ORIGINS'
  | 'CSP_REPORT_URI'
  | 'CSRF_SECRET'
  | 'COOKIE_SECURE'
  | 'REQUEST_BODY_LIMIT_KB'
  | 'RATE_LIMIT_WINDOW_MINUTES'
  | 'RATE_LIMIT_API_MAX_PER_IP'
  | 'RATE_LIMIT_LOGIN_MAX'
  | 'RATE_LIMIT_REFRESH_MAX'
  | 'RATE_LIMIT_UPLOAD_MAX_PER_HOUR'
  | 'RATE_LIMIT_DOWNLOAD_MAX_PER_HOUR'
  | 'RATE_LIMIT_SEND_MAX_PER_HOUR'
  | 'REAUTH_MAX_AGE_SECONDS'
>;

export interface AppContext {
  limiters: ReturnType<typeof createRateLimiters>;
  config: AppConfig;
}

export interface AppDeps {
  config: AppConfig;
  authenticate?: Authenticator;
  /** Modules attach routes ONLY through the SecureRouter, which forces an access declaration on every route. */
  register?: (secure: SecureRouter, ctx: AppContext) => void;
}

export function createApp({ config, authenticate, register }: AppDeps): Express & { secure: SecureRouter } {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(requestId);
  app.use(...securityHeaders({ cspReportUri: config.CSP_REPORT_URI }));
  app.use(corsMiddleware(config.CORS_ORIGINS));

  // Liveness only: no dependency detail is exposed.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(express.json({ limit: `${config.REQUEST_BODY_LIMIT_KB}kb`, strict: true }));
  app.use(cookieParser());

  const limiters = createRateLimiters(config, (req) => req.auth?.userId);
  const csrf = createCsrf({
    secret: config.CSRF_SECRET,
    secureCookie: config.COOKIE_SECURE,
    allowedOrigins: config.CORS_ORIGINS,
  });

  const v1 = Router();
  v1.use(limiters.api);
  v1.use(csrf.verify);

  const secure = new SecureRouter(v1, {
    ...(authenticate ? { authenticate } : {}),
    reauthMaxAgeSeconds: config.REAUTH_MAX_AGE_SECONDS,
  });
  secure.get('/csrf', { kind: 'public', reason: 'issues a CSRF token' }, (_req, res) => {
    res.json({ data: { csrfToken: csrf.issueToken(res) } });
  });
  register?.(secure, { limiters, config });

  app.use('/api/v1', v1);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return Object.assign(app, { secure });
}
