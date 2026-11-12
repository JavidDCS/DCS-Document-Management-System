import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accepts a client-supplied X-Request-Id only if it is a short safe token (no log injection), else generates one. */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  req.id = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
