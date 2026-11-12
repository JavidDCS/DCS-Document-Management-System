import { z } from 'zod';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppContext } from '../../app.js';
import { can, type SecureRouter } from '../../platform/auth/secureRouter.js';
import { asyncHandler } from '../../platform/http/errorHandler.js';
import { HttpError } from '../../utils/httpError.js';
import { validate } from '../../platform/http/validateRequest.js';
import { verifyAuditChain } from './audit.verify.js';

export const listAuditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().regex(/^\d+$/).optional(),
  action: z.string().trim().optional(),
  actorUserId: z.string().uuid().optional(),
  resourceType: z.string().trim().optional(),
});

export function registerAuditRoutes(secure: SecureRouter, _ctx: AppContext, db: PrismaClient) {
  secure.get(
    '/audit',
    can('audit:read'),
    validate({ query: listAuditQuerySchema }),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as z.infer<typeof listAuditQuerySchema>;
      const where: Prisma.AuditLogWhereInput = {};

      if (q.cursor) {
        where.id = { lt: BigInt(q.cursor) };
      }
      if (q.action) {
        where.action = { equals: q.action.toUpperCase() };
      }
      if (q.actorUserId) {
        where.actorUserId = q.actorUserId;
      }
      if (q.resourceType) {
        where.resourceType = q.resourceType;
      }

      const rows = await db.auditLog.findMany({
        where,
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      });

      const hasNext = rows.length > q.limit;
      const items = hasNext ? rows.slice(0, q.limit) : rows;
      const nextCursor = hasNext && items.length > 0 ? items[items.length - 1]!.id.toString() : null;

      const userIds = [...new Set(items.map((r) => r.actorUserId).filter((id): id is string => Boolean(id)))];
      const users =
        userIds.length > 0
          ? await db.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, name: true },
            })
          : [];
      const userMap = new Map(users.map((u) => [u.id, u.name]));

      const data = items.map((r) => ({
        id: r.id.toString(),
        occurredAt: r.occurredAt.toISOString(),
        actorUserId: r.actorUserId,
        actorName: r.actorUserId ? userMap.get(r.actorUserId) ?? null : null,
        actorType: r.actorType,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        outcome: r.outcome,
        ip: r.ip,
        requestId: r.requestId,
        details: r.details as Record<string, unknown>,
      }));

      res.json({ data, meta: { nextCursor } });
    })
  );

  secure.post(
    '/audit/verify',
    can('audit:export'),
    asyncHandler(async (req, res) => {
      if (!req.auth?.roles.includes('SUPER_ADMIN')) {
        throw new HttpError(403, 'Only a SUPER_ADMIN can verify the audit chain', 'FORBIDDEN');
      }
      const result = await verifyAuditChain(db);
      res.json({ data: result });
    })
  );
}
