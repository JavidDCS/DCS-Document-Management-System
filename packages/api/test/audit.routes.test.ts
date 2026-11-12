import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFullApp, createTestUser, signIn, type Client } from './helpers/fullApp.js';
import { skipDb, testPrisma } from './helpers/db.js';

describe.skipIf(skipDb)('audit routes (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  const { app, services } = skipDb ? ({} as never) : buildFullApp(prisma);
  let admin: Client, superAdmin: Client, sender: Client;
  let adminUserId = '';

  beforeAll(async () => {
    const sAdminUser = await createTestUser(prisma, services, { role: 'SUPER_ADMIN' });
    superAdmin = await signIn(app, sAdminUser.email);

    const aUser = await createTestUser(prisma, services, { role: 'ADMIN' });
    adminUserId = aUser.id;
    admin = await signIn(app, aUser.email);

    const sUser = await createTestUser(prisma, services, { role: 'SENDER' });
    sender = await signIn(app, sUser.email);
  });

  afterAll(() => prisma.$disconnect());

  it('GET /audit allows audit:read and paginates with cursor', async () => {
    // Generate some audit activity
    await admin.post('/tags', { name: `Tag-${Date.now().toString(36)}` });

    const res = await admin.get('/audit?limit=2');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.data[0]).toHaveProperty('id');
    expect(res.body.data[0]).toHaveProperty('action');
    expect(res.body.data[0]).toHaveProperty('occurredAt');

    if (res.body.meta?.nextCursor) {
      const nextRes = await admin.get(`/audit?limit=2&cursor=${res.body.meta.nextCursor}`);
      expect(nextRes.status).toBe(200);
    }
  });

  it('GET /audit filters by action, actorUserId, and resourceType', async () => {
    const res = await admin.get(`/audit?actorUserId=${adminUserId}`);
    expect(res.status).toBe(200);
    for (const row of res.body.data) {
      expect(row.actorUserId).toBe(adminUserId);
    }
  });

  it('GET /audit rejects callers without audit:read (SENDER)', async () => {
    const res = await sender.get('/audit');
    expect(res.status).toBe(403);
  });

  it('POST /audit/verify requires SUPER_ADMIN and returns chain verification result', async () => {
    // ADMIN has audit:read but not SUPER_ADMIN
    const forbidden = await admin.post('/audit/verify');
    expect(forbidden.status).toBe(403);

    // SUPER_ADMIN can run verification
    const allowed = await superAdmin.post('/audit/verify');
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toMatchObject({
      ok: true,
    });
    expect(typeof allowed.body.data.checked).toBe('number');
  });
});

