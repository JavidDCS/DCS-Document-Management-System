import type { Prisma, PrismaClient } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** Shared by the integration routes (read-only lookups) and EmailService.send (claims one inside its own transaction). */
export const HANDOFF_EXPIRED_MESSAGE = 'This link has expired. Go back to the Leads app and click Send again.';

export type HandoffRow = Awaited<ReturnType<PrismaClient['integrationHandoff']['findUniqueOrThrow']>>;

export function findHandoff(db: PrismaClient | Tx, id: string) {
  return db.integrationHandoff.findUnique({ where: { id } });
}

export function isHandoffUsable(h: Pick<HandoffRow, 'usedAt' | 'expiresAt'>): boolean {
  return h.usedAt === null && h.expiresAt.getTime() > Date.now();
}

/**
 * Atomically marks a hand-off used, but only if it is still unused and unexpired (`usedAt IS NULL AND expires_at >
 * now()` in the WHERE clause, not just the application check above) -- the single source of truth against a race
 * between two concurrent requests for the same hand-off. Returns false if it lost that race or was already spent.
 */
export async function claimHandoff(tx: Tx, id: string, usedByUserId: string): Promise<boolean> {
  const result = await tx.integrationHandoff.updateMany({
    where: { id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date(), usedByUserId },
  });
  return result.count === 1;
}
