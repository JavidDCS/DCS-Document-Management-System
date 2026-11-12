import type { Request } from 'express';

/** Request metadata every audit entry carries (ip, user agent, request id). */
export function auditContext(req: Request): { ip: string | null; userAgent: string | null; requestId: string } {
  return {
    ip: req.ip ?? null,
    userAgent: req.header('user-agent')?.slice(0, 255) ?? null,
    requestId: req.id,
  };
}
