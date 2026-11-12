import { z } from 'zod';

export const AUDIT_ACTOR_TYPES = ['USER', 'API_CLIENT', 'SYSTEM'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_OUTCOMES = ['SUCCESS', 'DENIED', 'FAILURE'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** Action names are SCREAMING_SNAKE_CASE, e.g. LOGIN_SUCCEEDED, DOCUMENT_VERSION_CREATED. */
export const AUDIT_ACTION_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

export const auditEntrySchema = z.strictObject({
    actorType: z.enum(AUDIT_ACTOR_TYPES),
    actorUserId: z.string().uuid().nullish(),
    action: z.string().regex(AUDIT_ACTION_PATTERN, 'action must be SCREAMING_SNAKE_CASE (3-64 chars)'),
    resourceType: z.string().min(1).max(64).nullish(),
    resourceId: z.string().min(1).max(128).nullish(),
    outcome: z.enum(AUDIT_OUTCOMES).default('SUCCESS'),
    ip: z.string().max(64).nullish(),
    userAgent: z.string().max(255).nullish(),
    requestId: z.string().max(64).nullish(),
    /** Ids and small facts only. Never secrets, tokens, passwords or file content. */
    details: z.record(z.string(), z.unknown()).default({}),
});

export type AuditEntryInput = z.input<typeof auditEntrySchema>;
export type AuditEntry = z.output<typeof auditEntrySchema>;

/** prev_hash of the very first entry in the chain. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);
