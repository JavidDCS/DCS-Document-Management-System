import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_GENESIS_HASH } from '@dcs-docs/shared';
import { recordAudit, verifyAuditChain } from '../src/modules/audit/index.js';
import { skipDb, testPrisma } from './helpers/db.js';

const ACTOR = '3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f';

describe.skipIf(skipDb)('audit log (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Disables the append-only triggers, runs `fn`, and always re-enables them: how a DB owner could tamper. */
  async function asTamperingOwner(fn: () => Promise<unknown>) {
    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER USER');
    try {
      await fn();
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER USER');
    }
  }

  const entry = (n: number) => ({
    actorType: 'USER' as const,
    actorUserId: ACTOR,
    action: 'TEST_EVENT',
    resourceType: 'test',
    resourceId: String(n),
    details: { n },
  });

  it('starts the chain at the genesis hash and links each entry to the previous one', async () => {
    const first = await recordAudit(prisma, entry(1));
    const second = await recordAudit(prisma, entry(2));
    const genesis = await prisma.auditLog.findFirstOrThrow({ orderBy: { id: 'asc' } });
    expect(genesis.prevHash).toBe(AUDIT_GENESIS_HASH);
    const a = await prisma.auditLog.findUniqueOrThrow({ where: { id: first.id } });
    const b = await prisma.auditLog.findUniqueOrThrow({ where: { id: second.id } });
    expect(a.entryHash).toBe(first.entryHash);
    expect(b.prevHash).toBe(first.entryHash);
    expect(b.entryHash).toBe(second.entryHash);
  });

  it('verifies an intact chain', async () => {
    const result = await verifyAuditChain(prisma);
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(2);
    expect(result.headHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps one linear chain under concurrent writers', async () => {
    const before = await prisma.auditLog.count();
    await Promise.all(Array.from({ length: 25 }, (_, i) => recordAudit(prisma, entry(100 + i))));
    expect(await prisma.auditLog.count()).toBe(before + 25);
    const result = await verifyAuditChain(prisma);
    expect(result.ok).toBe(true);
  });

  it('writes nothing when the surrounding transaction rolls back, and the chain stays valid', async () => {
    const before = await prisma.auditLog.count();
    await expect(
      prisma.$transaction(async (tx) => {
        await recordAudit(tx, entry(200));
        throw new Error('business action failed');
      })
    ).rejects.toThrow('business action failed');
    expect(await prisma.auditLog.count()).toBe(before);
    await recordAudit(prisma, entry(201));
    expect((await verifyAuditChain(prisma)).ok).toBe(true);
  });

  it('commits together with the caller transaction', async () => {
    const before = await prisma.auditLog.count();
    await prisma.$transaction(async (tx) => {
      await recordAudit(tx, entry(210));
      await recordAudit(tx, entry(211));
    });
    expect(await prisma.auditLog.count()).toBe(before + 2);
    expect((await verifyAuditChain(prisma)).ok).toBe(true);
  });

  it('redacts secrets from details before storing them', async () => {
    const { id } = await recordAudit(prisma, {
      ...entry(300),
      details: { password: 'hunter2', token: 'abc', note: 'login with password=hunter2', safe: 'ok' },
    });
    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
    const text = JSON.stringify(row.details);
    expect(text).not.toMatch(/hunter2|"abc"/);
    expect(text).toContain('ok');
    expect((await verifyAuditChain(prisma)).ok).toBe(true);
  });

  it('rejects invalid entries before touching the database', async () => {
    const before = await prisma.auditLog.count();
    await expect(recordAudit(prisma, { actorType: 'USER', action: 'bad action' })).rejects.toThrow();
    await expect(recordAudit(prisma, { actorType: 'USER', action: 'GOOD_ACTION', details: { n: Number.NaN } })).rejects.toThrow();
    expect(await prisma.auditLog.count()).toBe(before);
  });

  describe('append-only enforcement', () => {
    it('blocks UPDATE', async () => {
      await expect(prisma.$executeRawUnsafe(`UPDATE audit_logs SET action = 'HACKED_EVENT'`)).rejects.toThrow(/append-only/);
    });
    it('blocks DELETE', async () => {
      await expect(prisma.$executeRawUnsafe('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    });
    it('blocks TRUNCATE', async () => {
      await expect(prisma.$executeRawUnsafe('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
    });
    it('blocks forking the chain (duplicate prev_hash) and malformed hashes', async () => {
      const head = await prisma.auditLog.findFirstOrThrow({ orderBy: { id: 'asc' } });
      await expect(
        prisma.auditLog.create({
          data: { actorType: 'SYSTEM', action: 'FORKED_EVENT', prevHash: head.prevHash, entryHash: 'f'.repeat(64) },
        })
      ).rejects.toThrow();
      await expect(
        prisma.auditLog.create({
          data: { actorType: 'SYSTEM', action: 'BAD_HASH_EVENT', prevHash: 'x'.repeat(64), entryHash: 'e'.repeat(64) },
        })
      ).rejects.toThrow();
    });
  });

  describe('tamper detection (a DB owner bypasses the triggers)', () => {
    async function fresh(n: number) {
      const ids: bigint[] = [];
      for (let i = 0; i < 3; i++) ids.push((await recordAudit(prisma, entry(n + i))).id);
      return ids;
    }

    it('detects an edited row', async () => {
      const [a] = await fresh(400);
      await asTamperingOwner(() => prisma.$executeRawUnsafe(`UPDATE audit_logs SET outcome = 'DENIED' WHERE id = ${a}`));
      const r = await verifyAuditChain(prisma);
      expect(r.ok).toBe(false);
      expect(r.failure?.reason).toBe('ENTRY_HASH_MISMATCH');
      expect(r.failure?.entryId).toBe(a!.toString());
      await asTamperingOwner(() => prisma.$executeRawUnsafe(`UPDATE audit_logs SET outcome = 'SUCCESS' WHERE id = ${a}`));
      expect((await verifyAuditChain(prisma)).ok).toBe(true);
    });

    it('detects edited details', async () => {
      const [a] = await fresh(410);
      await asTamperingOwner(() => prisma.$executeRawUnsafe(`UPDATE audit_logs SET details = '{"n": 999}'::jsonb WHERE id = ${a}`));
      const r = await verifyAuditChain(prisma);
      expect(r.failure?.reason).toBe('ENTRY_HASH_MISMATCH');
      await asTamperingOwner(() => prisma.$executeRawUnsafe(`UPDATE audit_logs SET details = '{"n": 410}'::jsonb WHERE id = ${a}`));
      expect((await verifyAuditChain(prisma)).ok).toBe(true);
    });

    it('detects a deleted row in the middle', async () => {
      const [, b] = await fresh(420);
      const saved = await prisma.auditLog.findUniqueOrThrow({ where: { id: b! } });
      await asTamperingOwner(() => prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = ${b}`));
      const r = await verifyAuditChain(prisma);
      expect(r.ok).toBe(false);
      expect(r.failure?.reason).toBe('PREV_HASH_MISMATCH');
      await asTamperingOwner(() => prisma.auditLog.create({ data: { ...saved, details: saved.details as object } }));
      expect((await verifyAuditChain(prisma)).ok).toBe(true);
    });

    it('detects removal of the newest entries through the exported anchor', async () => {
      const head = (await verifyAuditChain(prisma)).headHash!;
      const [, , c] = await fresh(430);
      const anchor = (await verifyAuditChain(prisma)).headHash!;
      expect(anchor).not.toBe(head);
      const saved = await prisma.auditLog.findUniqueOrThrow({ where: { id: c! } });
      await asTamperingOwner(() => prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = ${c}`));
      const plain = await verifyAuditChain(prisma);
      expect(plain.ok).toBe(true); // a chain cut at the tail is internally consistent...
      const anchored = await verifyAuditChain(prisma, { anchorHash: anchor });
      expect(anchored.ok).toBe(false); // ...but the external anchor exposes it
      expect(anchored.failure?.reason).toBe('ANCHOR_NOT_FOUND');
      await asTamperingOwner(() => prisma.auditLog.create({ data: { ...saved, details: saved.details as object } }));
      expect((await verifyAuditChain(prisma, { anchorHash: anchor })).ok).toBe(true);
    });

    it('detects a rewritten prev_hash link', async () => {
      const [a] = await fresh(440);
      const orig = await prisma.auditLog.findUniqueOrThrow({ where: { id: a! } });
      await asTamperingOwner(() =>
        prisma.$executeRawUnsafe(`UPDATE audit_logs SET prev_hash = '${'a'.repeat(64)}' WHERE id = ${a}`)
      );
      expect((await verifyAuditChain(prisma)).ok).toBe(false);
      await asTamperingOwner(() =>
        prisma.$executeRawUnsafe(`UPDATE audit_logs SET prev_hash = '${orig.prevHash}' WHERE id = ${a}`)
      );
      expect((await verifyAuditChain(prisma)).ok).toBe(true);
    });
  });
});
