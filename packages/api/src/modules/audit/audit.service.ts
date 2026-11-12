import type { Prisma, PrismaClient } from '@prisma/client';
import { AUDIT_GENESIS_HASH, auditEntrySchema, type AuditEntryInput } from '@dcs-docs/shared';
import { redactValue } from '../../utils/logger.js';
import { canonicalJson, computeEntryHash } from './audit.hash.js';

export type Db = PrismaClient | Prisma.TransactionClient;

/** Arbitrary fixed key for pg_advisory_xact_lock: serialises writers so the chain has exactly one order. */
const AUDIT_LOCK_KEY = 7_351_000_001n;

function isFullClient(db: Db): db is PrismaClient {
  return '$transaction' in db;
}

/** Details go through the same redaction as logs, then are forced into plain JSON (dates, bigint, undefined). */
function assertFinite(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite number in audit details');
  if (value && typeof value === 'object') Object.values(value).forEach(assertFinite);
}

function sanitiseDetails(details: Record<string, unknown>): Prisma.InputJsonObject {
  const redacted = redactValue(details) as Record<string, unknown>;
  assertFinite(redacted); // JSON.stringify would silently turn NaN/Infinity into null
  const json = JSON.parse(JSON.stringify(redacted)) as Prisma.InputJsonObject;
  canonicalJson(json); // throws on anything the hash cannot represent
  return json;
}

export interface AuditRecord {
  id: bigint;
  entryHash: string;
}

/**
 * The only writer of audit_logs. Pass the caller's transaction client to make the entry atomic with the action
 * it records (a rolled-back action leaves no entry); passing the base client opens its own short transaction.
 */
export async function recordAudit(db: Db, input: AuditEntryInput): Promise<AuditRecord> {
  const entry = auditEntrySchema.parse(input);
  const details = sanitiseDetails(entry.details);

  const write = async (tx: Prisma.TransactionClient): Promise<AuditRecord> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`;

    const last = await tx.$queryRaw<{ entry_hash: string }[]>`
      SELECT entry_hash FROM audit_logs ORDER BY id DESC LIMIT 1`;
    const prevHash = last[0]?.entry_hash ?? AUDIT_GENESIS_HASH;

    const [{ id }] = await tx.$queryRaw<{ id: bigint }[]>`SELECT nextval('audit_logs_id_seq') AS id` as [{ id: bigint }];
    const occurredAt = new Date(); // millisecond precision == column precision, so the hash round-trips exactly

    const fields = {
      id: id.toString(),
      occurredAt: occurredAt.toISOString(),
      actorUserId: entry.actorUserId ?? null,
      actorType: entry.actorType,
      action: entry.action,
      resourceType: entry.resourceType ?? null,
      resourceId: entry.resourceId ?? null,
      outcome: entry.outcome,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      requestId: entry.requestId ?? null,
      details,
      hashVersion: 1,
    };
    const entryHash = computeEntryHash(prevHash, fields);

    await tx.auditLog.create({
      data: {
        id,
        occurredAt,
        actorUserId: fields.actorUserId,
        actorType: fields.actorType,
        action: fields.action,
        resourceType: fields.resourceType,
        resourceId: fields.resourceId,
        outcome: fields.outcome,
        ip: fields.ip,
        userAgent: fields.userAgent,
        requestId: fields.requestId,
        details,
        hashVersion: 1,
        prevHash,
        entryHash,
      },
    });
    return { id, entryHash };
  };

  return isFullClient(db) ? db.$transaction(write) : write(db);
}
