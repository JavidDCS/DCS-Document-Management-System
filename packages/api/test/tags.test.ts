import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFullApp, createTestUser, signIn, type Client } from './helpers/fullApp.js';
import { skipDb, testPrisma } from './helpers/db.js';

describe.skipIf(skipDb)('tags (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  const { app, services } = skipDb ? ({} as never) : buildFullApp(prisma);
  let admin: Client, sender: Client, viewer: Client;
  const tag = (n: string) => `${n}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    admin = await signIn(app, (await createTestUser(prisma, services, { role: 'ADMIN' })).email);
    sender = await signIn(app, (await createTestUser(prisma, services, { role: 'SENDER' })).email);
    viewer = await signIn(app, (await createTestUser(prisma, services, { role: 'VIEWER' })).email);
  });
  afterAll(() => prisma.$disconnect());

  it('creates, lists, renames and deletes with normalised names and audit entries', async () => {
    const name = tag('High value');
    const created = await admin.post('/tags', { name: `  ${name.replace('-', '   ')} ` });
    expect(created.status).toBe(201);
    expect(created.body.data.name).not.toMatch(/\s{2}|^\s|\s$/);
    const id = created.body.data.id;

    const list = await sender.get(`/tags?search=${encodeURIComponent('high value')}`);
    expect(list.body.data.map((t: any) => t.id)).toContain(id);

    const renamed = await admin.patch(`/tags/${id}`, { name: tag('Renamed') });
    expect(renamed.status).toBe(200);
    expect((await admin.del(`/tags/${id}`)).status).toBe(204);
    expect((await admin.del(`/tags/${id}`)).status).toBe(404);
    const actions = (await prisma.auditLog.findMany({ where: { resourceType: 'tag', resourceId: id }, orderBy: { id: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['TAG_CREATED', 'TAG_RENAMED', 'TAG_DELETED']);
  });

  it('refuses duplicates ignoring case and spacing, including on rename', async () => {
    const name = tag('Urgent');
    const a = await admin.post('/tags', { name });
    expect(a.status).toBe(201);
    expect((await admin.post('/tags', { name: name.toUpperCase() })).status).toBe(409);
    const b = await admin.post('/tags', { name: tag('Other') });
    expect((await admin.patch(`/tags/${b.body.data.id}`, { name: name.toLowerCase() })).status).toBe(409);
  });

  it('validates input', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(51) }, { name: 'ok', extra: 1 }, { name: 5 }]) {
      expect((await admin.post('/tags', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await admin.patch('/tags/not-a-uuid', { name: 'x' })).status).toBe(400);
    expect((await admin.patch('/tags/3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f', { name: 'x' })).status).toBe(404);
  });

  it('everyone who can read documents can list tags; only managers can change them', async () => {
    for (const c of [admin, sender, viewer]) expect((await c.get('/tags')).status).toBe(200);
    for (const c of [sender, viewer]) {
      expect((await c.post('/tags', { name: tag('nope') })).status).toBe(403);
      expect((await c.patch('/tags/3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f', { name: 'x' })).status).toBe(403);
      expect((await c.del('/tags/3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f')).status).toBe(403);
    }
  });
});
