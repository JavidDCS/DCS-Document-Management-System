import type { Request, RequestHandler } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { HttpError } from '../../utils/httpError.js';

export interface LimiterOptions {
  windowMs: number;
  limit: number;
  /** Returns a stable per-principal key (user id, API client id). Falls back to the client IP when undefined. */
  principal?: (req: Request) => string | undefined;
}

/** Rate limiter whose 429 goes through the standard error handler. State is in memory (single API process). */
export function createLimiter(opts: LimiterOptions): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const who = opts.principal?.(req);
      return who ? `p:${who}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
    },
    handler: (_req, _res, next) => next(new HttpError(429, 'Too many requests. Try again later.', 'RATE_LIMITED')),
  });
}

/** Rate limiter keyed by normalized email in the request body (falls back to IP). */
export function createEmailLimiter(opts: { windowMs: number; limit: number }): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      return email ? `email:${email}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
    },
    handler: (_req, _res, next) => next(new HttpError(429, 'Too many login attempts for this account. Try again later.', 'RATE_LIMITED')),
  });
}

export interface RateLimitConfig {
  RATE_LIMIT_WINDOW_MINUTES: number;
  RATE_LIMIT_API_MAX_PER_IP: number;
  RATE_LIMIT_LOGIN_MAX: number;
  RATE_LIMIT_REFRESH_MAX: number;
  RATE_LIMIT_UPLOAD_MAX_PER_HOUR: number;
  RATE_LIMIT_DOWNLOAD_MAX_PER_HOUR: number;
  RATE_LIMIT_SEND_MAX_PER_HOUR: number;
  RATE_LIMIT_PUBLIC_REVIEW_MAX_PER_HOUR: number;
  RATE_LIMIT_PUBLIC_COMMENT_MAX_PER_HOUR: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The limiters named in the design. `api` is applied to every /api/v1 request now; `auth`, `upload`,
 * `download` and `send` are attached to their routes when those modules are built.
 */
export function createRateLimiters(cfg: RateLimitConfig, principal?: LimiterOptions['principal']) {
  const windowMs = cfg.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000;
  return {
    api: createLimiter({ windowMs, limit: cfg.RATE_LIMIT_API_MAX_PER_IP }),
    auth: createLimiter({ windowMs, limit: cfg.RATE_LIMIT_LOGIN_MAX }),
    loginEmail: createEmailLimiter({ windowMs, limit: cfg.RATE_LIMIT_LOGIN_MAX * 2 }),
    changePassword: createLimiter({ windowMs, limit: 5, principal }),
    reauth: createLimiter({ windowMs, limit: 5, principal }),
    refresh: createLimiter({ windowMs, limit: cfg.RATE_LIMIT_REFRESH_MAX }),
    upload: createLimiter({ windowMs: HOUR_MS, limit: cfg.RATE_LIMIT_UPLOAD_MAX_PER_HOUR, principal }),
    download: createLimiter({ windowMs: HOUR_MS, limit: cfg.RATE_LIMIT_DOWNLOAD_MAX_PER_HOUR, principal }),
    send: createLimiter({ windowMs: HOUR_MS, limit: cfg.RATE_LIMIT_SEND_MAX_PER_HOUR, principal }),
    // Public, unauthenticated review routes: keyed by IP only (there is no principal to key by).
    publicReview: createLimiter({ windowMs: HOUR_MS, limit: cfg.RATE_LIMIT_PUBLIC_REVIEW_MAX_PER_HOUR }),
    publicComment: createLimiter({ windowMs: HOUR_MS, limit: cfg.RATE_LIMIT_PUBLIC_COMMENT_MAX_PER_HOUR }),
  };
}
