import cors from 'cors';
import type { RequestHandler } from 'express';

/**
 * CORS allows exactly the origins listed in CORS_ORIGIN, in every environment. A request without an Origin header
 * (same-origin GET, curl, server-to-server) is not a CORS request and simply gets no CORS headers.
 */
export function corsMiddleware(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin: (origin, callback) => callback(null, origin !== undefined && allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'Content-Disposition'],
    maxAge: 600,
  });
}
