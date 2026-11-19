import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../../utils/httpError.js';
import { recordAudit } from '../audit/index.js';

const HEADER = 'x-integration-key';

/**
 * Checks `X-Integration-Key` against INTEGRATION_API_KEY. Same idiom used elsewhere in this codebase for
 * secret-bearing comparisons (csrf.ts, googleLoginState.ts): two Buffers, length-checked before
 * `timingSafeEqual` (which throws, rather than being merely non-constant-time, on a length mismatch) -- never a
 * plain `===`, which would short-circuit on the first differing byte and leak timing information.
 *
 * `apiKey` undefined/empty means the integration is not configured: every request gets the same 503, and the
 * key (there isn't one) is never referenced. When configured, a missing or wrong header gets the SAME 401 either
 * way -- "missing" and "wrong" are not distinguished, so a caller cannot probe for whether the header is even read.
 * The key value itself is never logged: this middleware never passes it to `logger`, never puts it in an error
 * message, and the audit entries written by the routes behind it never include it either.
 */
export function requireIntegrationKey(apiKey: string | undefined, db: PrismaClient): RequestHandler {
  const expected = apiKey ? Buffer.from(apiKey) : null;

  const refuse = (req: Request, next: NextFunction, err: HttpError, reason: string) => {
    // Audited like every other outcome of these routes; `reason` and `path` only -- never the header value.
    recordAudit(db, {
      actorType: 'API_CLIENT',
      action: 'INTEGRATION_KEY_REJECTED',
      outcome: 'DENIED',
      ip: req.ip ?? null,
      userAgent: req.header('user-agent')?.slice(0, 255) ?? null,
      requestId: req.id,
      details: { reason, path: req.path },
    }).catch(() => undefined).finally(() => next(err));
  };

  return (req: Request, _res: Response, next: NextFunction) => {
    if (!expected) {
      return refuse(req, next, new HttpError(503, 'The integration is not switched on', 'INTEGRATION_DISABLED'), 'DISABLED');
    }
    const given = Buffer.from(req.header(HEADER) ?? '');
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      return refuse(req, next, new HttpError(401, 'Invalid or missing integration key', 'UNAUTHENTICATED'), 'INVALID_KEY');
    }
    next();
  };
}
