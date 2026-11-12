import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@dcs-docs/shared';
import { HttpError, type FieldIssue } from '../../utils/httpError.js';
import { logger } from '../../utils/logger.js';

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, 'Resource not found'));
};

export function zodIssues(err: ZodError): FieldIssue[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

interface Normalised {
  status: number;
  code: string;
  message: string;
  details?: FieldIssue[];
}

function normalise(err: unknown): Normalised | null {
  if (err instanceof HttpError) {
    return { status: err.status, code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
  }
  if (err instanceof ZodError) {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'Invalid request', details: zodIssues(err) };
  }
  // body-parser / http-errors
  const e = err as { type?: string; status?: number } | null;
  if (e && typeof e === 'object') {
    if (e.type === 'entity.too.large') return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' };
    if (e.type === 'entity.parse.failed') return { status: 400, code: 'BAD_REQUEST', message: 'Malformed JSON body' };
    if (e.type === 'encoding.unsupported' || e.type === 'charset.unsupported') {
      return { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported encoding' };
    }
    if (typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
      return { status: e.status, code: 'BAD_REQUEST', message: 'Bad request' };
    }
  }
  return null;
}

/**
 * One error format for every failure. Unknown errors become a generic 500: the message, stack, SQL and file paths
 * are logged (redacted) with the request id, never sent to the client, in any environment.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const known = normalise(err);
  const out: Normalised = known ?? { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };

  if (!known) {
    logger.error('Unhandled error', { requestId: req.id, method: req.method, path: req.path, err });
    if (err instanceof Error && err.stack) logger.debug('Stack', err.stack);
  }

  const body: ApiErrorBody = {
    error: {
      code: out.code,
      message: out.message,
      requestId: req.id,
      ...(out.details ? { details: out.details } : {}),
    },
  };
  res.status(out.status).json(body);
};
