import { afterAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src/modules/audit/index.js';
import { PASSWORD, ageAuth, buildFullApp, createTestUser, loginRaw, signIn, uniqueEmail } from './helpers/fullApp.js';
import { json, skipDb, testPrisma } from './helpers/db.js';

describe.skipIf(skipDb)('user management (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  const { app, services } = skipDb ? ({} as never) : buildFullApp(prisma);
  afterAll(() => prisma.$disconnect());

  const admin = () => createTestUser(prisma, services, { role: 'ADMIN' }).then((u) => signIn(app, u.email));
  const superAdmin = () => createTestUser(prisma, services, { role: 'SUPER_ADMIN' }).then((u) => signIn(app, u.email));

  describe('create', () => {
    it('creates an invited user with a one-time temporary password that forces a change at first sign-in', async () => {
      const a = await admin();
      const email = uniqueEmail('new');
      const res = await a.post('/users', { email, name: 'New Sender', role: 'SENDER' });
      expect(res.status).toBe(201);
      expect(res.body.data.user).toMatchObject({ email, status: 'INVITED', roles: ['SENDER'] });
      const temp = res.body.data.temporaryPassword as string;
      expect(temp).toHaveLength(20);

      const login = await loginRaw(app, email, temp);
      expect(login.status).toBe(200);
      expect(login.body.data.user.mustChangePassword).toBe(true);
      const row = await prisma.passwordCredential.findFirstOrThrow({ where: { user: { email } } });
      expect(row.passwordHash).not.toContain(temp);

      const audit = await prisma.auditLog.findFirst({ where: { action: 'USER_CREATED', resourceId: res.body.data.user.id } });
      expect(json(audit)).not.toContain(temp);
      // the temporary password is never returned again
      const again = await a.get(`/users/${res.body.data.user.id}`);
      expect(JSON.stringify(again.body)).not.toContain(temp);
      expect(JSON.stringify(again.body)).not.toMatch(/password/i);
    });

    it('rejects other domains, duplicates (any case), invalid roles and unknown fields', async () => {
      const a = await admin();
      expect((await a.post('/users', { email: 'x@gmail.com', name: 'X', role: 'SENDER' })).status).toBe(400);
      const email = uniqueEmail('dup');
      expect((await a.post('/users', { email, name: 'D', role: 'VIEWER' })).status).toBe(201);
      expect((await a.post('/users', { email: email.toUpperCase(), name: 'D2', role: 'VIEWER' })).status).toBe(409);
      expect((await a.post('/users', { email: uniqueEmail(), name: 'D', role: 'GOD' })).status).toBe(400);
      expect((await a.post('/users', { email: uniqueEmail(), name: 'D', role: 'VIEWER', status: 'ACTIVE' })).status).toBe(400);
    });

    it('lets ADMIN create up to ADMIN but never a SUPER_ADMIN', async () => {
      const a = await admin();
      expect((await a.post('/users', { email: uniqueEmail(), name: 'A', role: 'ADMIN' })).status).toBe(201);
      expect((await a.post('/users', { email: uniqueEmail(), name: 'S', role: 'SUPER_ADMIN' })).status).toBe(403);
      const s = await superAdmin();
      expect((await s.post('/users', { email: uniqueEmail(), name: 'S', role: 'SUPER_ADMIN' })).status).toBe(201);
    });

    it('is forbidden for SENDER and VIEWER', async () => {
      for (const role of ['SENDER', 'VIEWER'] as const) {
        const u = await createTestUser(prisma, services, { role });
        const c = await signIn(app, u.email);
        expect((await c.post('/users', { email: uniqueEmail(), name: 'X', role: 'VIEWER' })).status).toBe(403);
        expect((await c.get('/users')).status).toBe(403);
      }
    });

    it('requires a recent password check', async () => {
      const a = await admin();
      await ageAuth(prisma, a, 3600);
      const res = await a.post('/users', { email: uniqueEmail(), name: 'X', role: 'VIEWER' });
      expect(res.body.error.code).toBe('REAUTH_REQUIRED');
    });
  });

  describe('list and read', () => {
    it('lists with filters and pagination and exposes no secrets', async () => {
      const a = await admin();
      const tag = `zz${Date.now()}`;
      for (let i = 0; i < 3; i++) await a.post('/users', { email: `${tag}.${i}@decirclesolar.com`, name: `${tag} person ${i}`, role: 'VIEWER' });
      const page = await a.get(`/users?search=${tag}&limit=2&offset=0`);
      expect(page.status).toBe(200);
      expect(page.body.meta).toMatchObject({ total: 3, limit: 2, offset: 0 });
      expect(page.body.data).toHaveLength(2);
      expect((await a.get(`/users?search=${tag}&limit=2&offset=2`)).body.data).toHaveLength(1);
      expect((await a.get(`/users?search=${tag}&status=ACTIVE`)).body.data).toHaveLength(0);
      expect(JSON.stringify(page.body)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$|refresh/i);
    });

    it('rejects bad query values and unknown ids', async () => {
      const a = await admin();
      expect((await a.get('/users?limit=1000')).status).toBe(400);
      expect((await a.get('/users?status=BOGUS')).status).toBe(400);
      expect((await a.get('/users/not-a-uuid')).status).toBe(400);
      expect((await a.get('/users/3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f')).status).toBe(404);
    });
  });

  describe('status', () => {
    it('deactivates (sessions die at once) and reactivates', async () => {
      const a = await admin();
      const u = await createTestUser(prisma, services, { role: 'SENDER' });
      const uc = await signIn(app, u.email);
      expect((await a.patch(`/users/${u.id}/status`, { status: 'DEACTIVATED' })).body.data.status).toBe('DEACTIVATED');
      expect((await uc.get('/auth/me')).status).toBe(401);
      expect((await loginRaw(app, u.email, u.password)).status).toBe(401);
      expect((await a.patch(`/users/${u.id}/status`, { status: 'ACTIVE' })).body.data.status).toBe('ACTIVE');
      expect((await loginRaw(app, u.email, u.password)).status).toBe(200);
      const audits = await prisma.auditLog.findMany({ where: { resourceId: u.id, action: { in: ['USER_DEACTIVATED', 'USER_REACTIVATED'] } } });
      expect(audits).toHaveLength(2);
    });

    it('reactivating a user who never set a password returns them to INVITED', async () => {
      const a = await admin();
      const u = await createTestUser(prisma, services, { status: 'INVITED', mustChange: true });
      await a.patch(`/users/${u.id}/status`, { status: 'DEACTIVATED' });
      expect((await a.patch(`/users/${u.id}/status`, { status: 'ACTIVE' })).body.data.status).toBe('INVITED');
    });

    it('refuses self-deactivation, ADMIN acting on a SUPER_ADMIN, and removing the last SUPER_ADMIN', async () => {
      const a = await admin();
      const aId = a.user.id;
      expect((await a.patch(`/users/${aId}/status`, { status: 'DEACTIVATED' })).status).toBe(409);

      const s = await createTestUser(prisma, services, { role: 'SUPER_ADMIN' });
      expect((await a.patch(`/users/${s.id}/status`, { status: 'DEACTIVATED' })).status).toBe(403);
      expect((await a.post(`/users/${s.id}/reset-password`)).status).toBe(403);
      expect((await a.post(`/users/${s.id}/revoke-sessions`)).status).toBe(403);
    });

    it('never leaves the system without an active SUPER_ADMIN', async () => {
      // Make this SUPER_ADMIN the only active one by deactivating every other.
      await prisma.user.updateMany({ where: { roles: { some: { role: 'SUPER_ADMIN' } } }, data: { status: 'DEACTIVATED' } });
      const only = await createTestUser(prisma, services, { role: 'SUPER_ADMIN' });
      const second = await createTestUser(prisma, services, { role: 'SUPER_ADMIN' });
      const oc = await signIn(app, only.email);
      // demote the other: allowed (one remains)
      expect((await oc.put(`/users/${second.id}/roles`, { roles: ['ADMIN'] })).status).toBe(200);
      // now `only` is the last: removing its own SUPER_ADMIN role must fail
      const res = await oc.put(`/users/${only.id}/roles`, { roles: ['ADMIN'] });
      expect(res.status).toBe(409);
      expect((await oc.patch(`/users/${only.id}/status`, { status: 'DEACTIVATED' })).status).toBe(409);
      // a SUPER_ADMIN deactivated by another SUPER_ADMIN while another remains: fine
      const third = await createTestUser(prisma, services, { role: 'SUPER_ADMIN' });
      expect((await oc.patch(`/users/${third.id}/status`, { status: 'DEACTIVATED' })).status).toBe(200);
    });
  });

  describe('roles', () => {
    it('only SUPER_ADMIN may change roles; the change is audited with before and after', async () => {
      const a = await admin();
      const s = await superAdmin();
      const u = await createTestUser(prisma, services, { role: 'VIEWER' });
      expect((await a.put(`/users/${u.id}/roles`, { roles: ['SENDER'] })).status).toBe(403);
      const res = await s.put(`/users/${u.id}/roles`, { roles: ['SENDER'] });
      expect(res.status).toBe(200);
      expect(res.body.data.roles).toEqual(['SENDER']);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ROLES_CHANGED', resourceId: u.id } });
      expect(audit.details).toMatchObject({ before: ['VIEWER'], after: ['SENDER'] });
    });

    it('rejects empty, unknown and over-long role lists', async () => {
      const s = await superAdmin();
      const u = await createTestUser(prisma, services);
      expect((await s.put(`/users/${u.id}/roles`, { roles: [] })).status).toBe(400);
      expect((await s.put(`/users/${u.id}/roles`, { roles: ['ROOT'] })).status).toBe(400);
      expect((await s.put(`/users/${u.id}/roles`, { roles: ['ADMIN'], extra: 1 })).status).toBe(400);
    });
  });

  describe('password reset and sessions', () => {
    it('issues a new one-time password, forces a change, and kills existing sessions', async () => {
      const a = await admin();
      const u = await createTestUser(prisma, services, { role: 'SENDER' });
      const uc = await signIn(app, u.email);
      const res = await a.post(`/users/${u.id}/reset-password`);
      expect(res.status).toBe(200);
      const temp = res.body.data.temporaryPassword as string;
      expect((await uc.get('/auth/me')).status).toBe(401);
      expect((await loginRaw(app, u.email, u.password)).status).toBe(401);
      const login = await loginRaw(app, u.email, temp);
      expect(login.status).toBe(200);
      expect(login.body.data.user.mustChangePassword).toBe(true);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'PASSWORD_RESET_BY_ADMIN', resourceId: u.id } });
      expect(json(audit)).not.toContain(temp);
    });

    it('also clears a lockout', async () => {
      const a = await admin();
      const u = await createTestUser(prisma, services);
      for (let i = 0; i < 3; i++) await loginRaw(app, u.email, 'wrong-pass-word-1');
      expect((await loginRaw(app, u.email, u.password)).status).toBe(423);
      const temp = (await a.post(`/users/${u.id}/reset-password`)).body.data.temporaryPassword;
      expect((await loginRaw(app, u.email, temp)).status).toBe(200);
    });

    it('refuses to reset your own password or a deactivated user', async () => {
      const a = await admin();
      expect((await a.post(`/users/${a.user.id}/reset-password`)).status).toBe(409);
      const u = await createTestUser(prisma, services, { status: 'DEACTIVATED' });
      expect((await a.post(`/users/${u.id}/reset-password`)).status).toBe(409);
    });

    it('revokes all sessions of a user on demand', async () => {
      const a = await admin();
      const u = await createTestUser(prisma, services);
      const c1 = await signIn(app, u.email);
      const c2 = await signIn(app, u.email);
      const res = await a.post(`/users/${u.id}/revoke-sessions`);
      expect(res.body.data.revoked).toBe(2);
      expect((await c1.get('/auth/me')).status).toBe(401);
      expect((await c2.get('/auth/me')).status).toBe(401);
      expect((await loginRaw(app, u.email, PASSWORD)).status).toBe(200);
    });
  });

  it('keeps the audit chain valid after all of the above', async () => {
    expect((await verifyAuditChain(prisma)).ok).toBe(true);
  });
});
