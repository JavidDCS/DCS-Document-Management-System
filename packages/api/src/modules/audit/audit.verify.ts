import type { PrismaClient } from '@prisma/client';
import { AUDIT_GENESIS_HASH } from '@dcs-docs/shared';
import { computeEntryHash } from './audit.hash.js';

export type VerifyFailureReason =
  | 'FIRST_ENTRY_NOT_GENESIS' // the chain does not start at the genesis hash (head entries removed)
  | 'PREV_HASH_MISMATCH' // an entry does not point at its predecessor (row deleted, inserted or reordered)
  | 'ENTRY_HASH_MISMATCH' // an entry's content no longer matches its hash (row edited)
  | 'ANCHOR_NOT_FOUND'; // the externally stored head hash is not in the chain (tail removed or rewritten)

export interface VerifyResult {
  ok: boolean;
  checked: number;
  headHash: string | null;
  failure?: { reason: VerifyFailureReason; entryId: string | null };
}

const BATCH = 1000;

/**
 * Walks the whole chain in id order and recomputes every hash. Detects edited, deleted, inserted and reordered rows.
 * `anchorHash` is a head hash previously exported to a place outside the database; if given, it must appear in the
 * chain, which also detects truncation or a full rewrite of the newest entries.
 */
export async function verifyAuditChain(db: PrismaClient, opts: { anchorHash?: string } = {}): Promise<VerifyResult> {
  let cursor: bigint | undefined;
  let prev = AUDIT_GENESIS_HASH;
  let checked = 0;
  let anchorSeen = opts.anchorHash === undefined;

  for (;;) {
    const rows = await db.auditLog.findMany({
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor !== undefined ? { where: { id: { gt: cursor } } } : {}),
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.prevHash !== prev) {
        return {
          ok: false,
          checked,
          headHash: prev === AUDIT_GENESIS_HASH ? null : prev,
          failure: { reason: checked === 0 ? 'FIRST_ENTRY_NOT_GENESIS' : 'PREV_HASH_MISMATCH', entryId: row.id.toString() },
        };
      }
      const expected = computeEntryHash(row.prevHash, {
        id: row.id.toString(),
        occurredAt: row.occurredAt.toISOString(),
        actorUserId: row.actorUserId,
        actorType: row.actorType,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        outcome: row.outcome,
        ip: row.ip,
        userAgent: row.userAgent,
        requestId: row.requestId,
        details: row.details,
        hashVersion: row.hashVersion,
      });
      if (expected !== row.entryHash) {
        return { ok: false, checked, headHash: prev, failure: { reason: 'ENTRY_HASH_MISMATCH', entryId: row.id.toString() } };
      }
      if (row.entryHash === opts.anchorHash) anchorSeen = true;
      prev = row.entryHash;
      checked += 1;
    }
    cursor = rows[rows.length - 1]!.id;
  }

  const headHash = checked === 0 ? null : prev;
  if (!anchorSeen) {
    return { ok: false, checked, headHash, failure: { reason: 'ANCHOR_NOT_FOUND', entryId: null } };
  }
  return { ok: true, checked, headHash };
}
