import { describe, expect, it } from 'vitest';
import { AUDIT_GENESIS_HASH, auditEntrySchema } from '@dcs-docs/shared';
import { canonicalJson, computeEntryHash, type HashedFields } from '../src/modules/audit/audit.hash.js';

const fields: HashedFields = {
  id: '1',
  occurredAt: '2026-11-12T10:00:00.000Z',
  actorUserId: '3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f',
  actorType: 'USER',
  action: 'DOCUMENT_UPLOADED',
  resourceType: 'document',
  resourceId: 'abc',
  outcome: 'SUCCESS',
  ip: '203.0.113.9',
  userAgent: 'test',
  requestId: 'req-12345678',
  details: { b: 2, a: { y: 1, x: [3, { n: null }] } },
  hashVersion: 1,
};

describe('canonicalJson', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1}}');
  });

  it('keeps array order and handles primitives', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
  });

  it('rejects values it cannot represent', () => {
    expect(() => canonicalJson(undefined)).toThrow();
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });
});

describe('computeEntryHash', () => {
  it('is deterministic lowercase sha-256 hex', () => {
    const h = computeEntryHash(AUDIT_GENESIS_HASH, fields);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEntryHash(AUDIT_GENESIS_HASH, { ...fields, details: { a: { x: [3, { n: null }], y: 1 }, b: 2 } })).toBe(h);
  });

  it('changes when the previous hash changes', () => {
    expect(computeEntryHash('1'.repeat(64), fields)).not.toBe(computeEntryHash(AUDIT_GENESIS_HASH, fields));
  });

  it.each(Object.keys(fields) as (keyof HashedFields)[])('changes when %s changes', (key) => {
    const base = computeEntryHash(AUDIT_GENESIS_HASH, fields);
    const mutated: Record<string, unknown> = { ...fields };
    const current = mutated[key];
    mutated[key] = typeof current === 'number' ? current + 1 : current === null ? 'changed' : key === 'details' ? { tampered: true } : `${String(current)}x`;
    expect(computeEntryHash(AUDIT_GENESIS_HASH, mutated as unknown as HashedFields)).not.toBe(base);
  });

  it('is sensitive to a single changed character deep in details', () => {
    const a = computeEntryHash(AUDIT_GENESIS_HASH, { ...fields, details: { a: { x: [3, { n: 'v1' }] } } });
    const b = computeEntryHash(AUDIT_GENESIS_HASH, { ...fields, details: { a: { x: [3, { n: 'v2' }] } } });
    expect(a).not.toBe(b);
  });
});

describe('auditEntrySchema', () => {
  const ok = { actorType: 'USER', action: 'LOGIN_SUCCEEDED' };

  it('accepts a minimal entry and applies defaults', () => {
    const e = auditEntrySchema.parse(ok);
    expect(e.outcome).toBe('SUCCESS');
    expect(e.details).toEqual({});
  });

  it('rejects bad action names, actor types, unknown keys and a non-uuid actor', () => {
    expect(() => auditEntrySchema.parse({ ...ok, action: 'login' })).toThrow();
    expect(() => auditEntrySchema.parse({ ...ok, action: 'X' })).toThrow();
    expect(() => auditEntrySchema.parse({ ...ok, actorType: 'ROBOT' })).toThrow();
    expect(() => auditEntrySchema.parse({ ...ok, hacked: true })).toThrow();
    expect(() => auditEntrySchema.parse({ ...ok, actorUserId: 'nope' })).toThrow();
  });
});
