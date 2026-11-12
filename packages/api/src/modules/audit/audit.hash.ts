import { createHash } from 'node:crypto';

/** The exact fields covered by an entry's hash. Anything not listed here is NOT tamper-evident. */
export interface HashedFields {
  id: string; // decimal string of the bigint id
  occurredAt: string; // ISO-8601 UTC with milliseconds
  actorUserId: string | null;
  actorType: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  details: unknown;
  hashVersion: number;
}

/** JSON with sorted keys and no whitespace, so the same data always serialises to the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite number in audit data');
    if (value === undefined) throw new Error('undefined is not allowed in audit data');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** entry_hash = SHA-256( prev_hash + "\n" + canonical_json(fields) ), lowercase hex. */
export function computeEntryHash(prevHash: string, fields: HashedFields): string {
  return createHash('sha256').update(`${prevHash}\n${canonicalJson(fields)}`).digest('hex');
}
