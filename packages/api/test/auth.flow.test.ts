import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src/modules/audit/index.js';
import { ALLOWED_ORIGIN } from './helpers/app.js';
import { PASSWORD, ageAuth, buildFullApp, createTestUser, csrfPair, loginRaw, reauth, sessionIdOf, signIn, uniqueEmail } from './helpers/fullApp.js';
import { json, skipDb, testPrisma } from './helpers/db.js';

describe.skipIf(skipDb)('authentication flow (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  const { app, services } = skipDb ? ({} as never) : buildFullApp(prisma);
  afterAll(() => prisma.$disconnect());

  describe('login', () => {
    it('signs in, returns an access token, and sets an httpOnly SameSite=Strict refresh cookie scoped to /api/v1/auth', async () => {
      const u = await createTestUser(prisma, services, { role: 'SENDER' });
      const res = await loginRaw(app, u.email, u.password);
      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toMatch(/^eyJ/);
      expect(res.body.data.expiresIn).toBe(600);
      expect(res.body.data.user).toMatchObject({ email: u.email, roles: ['SENDER'], mustChangePassword: false });
      expect(res.body.data.user.permissions).toContain('email:send');
      const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('dcs_docs_refresh='))!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);
    });

    it('requires a CSRF token (no cookie-less cross-site login)', async () => {
      const u = await createTestUser(prisma, services);
      const res = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: u.password });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_FAILED');
    });

    it('rejects malformed bodies and unknown fields', async () => {
      const c = await csrfPair(app);
      const post = (body: object) => request(app).post('/api/v1/auth/login').set('Cookie', c.cookie).set('X-CSRF-Token', c.token).send(body);
      expect((await post({ email: 'not-an-email', password: 'x' })).status).toBe(400);
      expect((await post({ email: uniqueEmail() })).status).toBe(400);
      expect((await post({ email: uniqueEmail(), password: 'x', admin: true })).status).toBe(400);
    });

    it('normalises the email (trim, case)', async () => {
      const u = await createTestUser(prisma, services);
      const res = await loginRaw(app, `  ${u.email.toUpperCase()} `, u.password);
      expect(res.status).toBe(200);
    });

    it('answers unknown user, wrong password and deactivated user identically (no account enumeration)', async () => {
      const active = await createTestUser(prisma, services);
      const inactive = await createTestUser(prisma, services, { status: 'DEACTIVATED' });
      const unknown = await loginRaw(app, uniqueEmail('ghost'), 'whatever-pass-123');
      const wrong = await loginRaw(app, active.email, 'wrong-pass-word-1');
      const deact = await loginRaw(app, inactive.email, inactive.password);
      for (const r of [unknown, wrong, deact]) {
        expect(r.status).toBe(401);
        expect(r.body.error.code).toBe('UNAUTHENTICATED');
        expect(r.body.error.message).toBe('Invalid email or password');
        expect(r.headers['set-cookie']).toBeUndefined();
      }
    });

    it('locks the account after repeated failures, even for the correct password, and unlocks later', async () => {
      const u = await createTestUser(prisma, services);
      for (let i = 0; i < 3; i++) expect((await loginRaw(app, u.email, 'wrong-pass-word-1')).status).toBe(401);
      const locked = await loginRaw(app, u.email, u.password);
      expect(locked.status).toBe(423);
      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
      await prisma.passwordCredential.update({ where: { userId: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      expect((await loginRaw(app, u.email, u.password)).status).toBe(200);
      const cred = await prisma.passwordCredential.findUniqueOrThrow({ where: { userId: u.id } });
      expect(cred.failedLoginCount).toBe(0);
      expect(cred.lockedUntil).toBeNull();
    });

    it('records login events and audit entries without ever storing the password', async () => {
      const u = await createTestUser(prisma, services);
      const secret = 'Sup3r-Secret-Typed-Wrong-1';
      await loginRaw(app, u.email, secret);
      await loginRaw(app, u.email, u.password);
      const events = await prisma.loginEvent.findMany({ where: { userId: u.id }, orderBy: { id: 'asc' } });
      expect(events.map((e) => e.outcome)).toEqual(['FAILED_CREDENTIALS', 'SUCCESS']);
      const audits = await prisma.auditLog.findMany({ where: { actorUserId: u.id } });
      expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['LOGIN_FAILED', 'LOGIN_SUCCEEDED']));
      const dump = json(audits) + json(events);
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain(u.password);
      expect((await verifyAuditChain(prisma)).ok).toBe(true);
    });
  });

  describe('access tokens and the current user', () => {
    it('GET /auth/me needs a valid token', async () => {
      expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
      expect((await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
      const u = await createTestUser(prisma, services, { role: 'VIEWER' });
      const c = await signIn(app, u.email);
      const me = await c.get('/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.data.user.email).toBe(u.email);
    });

    it('a deactivated user loses access on the very next request, token still unexpired', async () => {
      const admin = await createTestUser(prisma, services, { role: 'SUPER_ADMIN' });
      const u = await createTestUser(prisma, services, { role: 'SENDER' });
      const c = await signIn(app, u.email);
      expect((await c.get('/auth/me')).status).toBe(200);
      const adminClient = await signIn(app, admin.email);
      const res = await adminClient.patch(`/users/${u.id}/status`, { status: 'DEACTIVATED' });
      expect(res.status).toBe(200);
      expect((await c.get('/auth/me')).status).toBe(401);
      expect((await c.refresh()).status).toBe(401);
      expect((await loginRaw(app, u.email, u.password)).status).toBe(401);
      const sessions = await prisma.session.findMany({ where: { userId: u.id } });
      expect(sessions.every((s) => s.revokedAt && s.revokedReason === 'DEACTIVATED')).toBe(true);
    });

    it('a role change applies immediately to a token that is already issued', async () => {
      const admin = await createTestUser(prisma, services, { role: 'SUPER_ADMIN' });
      const u = await createTestUser(prisma, services, { role: 'ADMIN' });
      const c = await signIn(app, u.email);
      expect((await c.get('/users')).status).toBe(200);
      await signIn(app, admin.email).then((a) => a.put(`/users/${u.id}/roles`, { roles: ['VIEWER'] }));
      expect((await c.get('/users')).status).toBe(403);
    });

    it('rejects a session that passed its absolute timeout', async () => {
      const u = await createTestUser(prisma, services);
      const c = await signIn(app, u.email);
      await prisma.session.updateMany({ where: { userId: u.id }, data: { createdAt: new Date(Date.now() - 7200_000), absoluteExpiresAt: new Date(Date.now() - 1000) } });
      expect((await c.get('/auth/me')).status).toBe(401);
      expect((await c.refresh()).status).toBe(401);
    });
  });

  describe('refresh tokens', () => {
    it('rotates: a new token is issued and the old one stops working', async () => {
      const u = await createTestUser(prisma, services);
      const c = await signIn(app, u.email);
      const r = await c.refresh();
      expect(r.status).toBe(200);
      const newCookie = (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('dcs_docs_refresh='))!.split(';')[0]!;
      expect(newCookie).not.toBe(c.refreshCookie);
      expect(r.body.data.accessToken).toMatch(/^eyJ/);
      expect((await c.refresh(newCookie)).status).toBe(200);
    });

    it('stores only a hash, never the token', async () => {
      const u = await createTestUser(prisma, services);
      const c = await signIn(app, u.email);
      const token = c.refreshCookie.split('=')[1]!;
      const rows = await prisma.session.findMany({ where: { userId: u.id } });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0]!.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('revokes the whole session family when a used token is replayed', async () => {
      const u = await createTestUser(prisma, services);
      const c = await signIn(app, u.email);
      const first = await c.refresh();
      const fresh = (first.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('dcs_docs_refresh='))!.split(';')[0]!;
      const replay = await c.refresh(); // the attacker uses the OLD token again
      expect(replay.status).toBe(401);
      expect((await c.refresh(fresh)).status).toBe(401); // the legitimate holder of the NEW token is cut off too
      const family = await prisma.session.findMany({ where: { userId: u.id } });
      expect(family.every((s) => s.revokedAt)).toBe(true);
      expect(family.some((s) => s.revokedReason === 'REUSE_DETECTED')).toBe(true);
      const audits = await prisma.auditLog.findMany({ where: { actorUserId: u.id, action: 'REFRESH_TOKEN_REUSE_DETECTED' } });
      expect(audits.length).toBeGreaterThan(0);
      const events = await prisma.loginEvent.findMany({ where: { userId: u.id, outcome: 'REFRESH_REUSE' } });
      expect(events.length).toBeGreaterThan(0);
    });

    it('does not let two simultaneous uses of one token both succeed', async () => {
      const u = await createTestUser(prisma, services);
      const c = await signIn(app, u.email);
      const [a, b] = await Promise.all([c.refresh(), c.refresh()]);
      expect([a.status, b.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
      expect([a.status, b.status]).toContain(401);
    });

    it('requires the CSRF token and a cookie', async () => {
      const noCsrf = await request(app).post('/api/v1/auth/refresh').send();
      expect(noCsrf.status).toBe(403);
      const c = await csrfPair(app);
      const noCookie = await request(app).post('/api/v1/auth/refresh').set('Cookie', c.cookie).set('X-CSRF-Token', c.token).set('Origin', ALLOWED_ORIGIN).send();
      expect(noCookie.status).toBe(401);
    });

    it('enforces the idle timeout', async () => {
      const u = await createTestUser(prisma, services);
      const c = await signIn(app, u.email);
      await prisma.session.updateMany({ where: { userId: u.id }, data: { idleExpiresAt: new Date(Date.now() - 1000) } });
      expect((await c.refresh()).status).toBe(401);
    });

    it('never extends beyond the absolute deadline', async () => {
      const u = await createTestUser(prisma, services);
      const c = await signIn(app, u.email);
      const before = await prisma.session.findFirstOrThrow({ where: { userId: u.id } });
      await c.refresh();
      const after = await prisma.session.findMany({ where: { userId: u.id, revokedAt: null } });
      expect(after[0]!.absoluteExpiresAt.getTime()).toBe(before.absoluteExpiresAt.getTime());
      expect(after[0]!.idleExpiresAt.getTime()).toBeLessThanOrEqual(before.absoluteExpiresAt.getTime());
    });
  });

  describe('logout and sessions', () => {
    it('logout revokes the session: the access token and the refresh token both stop working', async () => {
      const u = await createTestUser(prisma, services);
      const c = await signIn(app, u.email);
      const k = await csrfPair(app);
      const out = await request(app).post('/api/v1/auth/logout').set('Cookie', `${k.cookie}; ${c.refreshCookie}`).set('X-CSRF-Token', k.token).set('Origin', ALLOWED_ORIGIN).send();
      expect(out.status).toBe(204);
      expect(String((out.headers['set-cookie'] as unknown as string[])?.join(';'))).toMatch(/dcs_docs_refresh=;/);
      expect((await c.get('/auth/me')).status).toBe(401);
      expect((await c.refresh()).status).toBe(401);
    });

    it('lists own sessions and revokes another one, but not someone else’s', async () => {
      const a = await createTestUser(prisma, services);
      const b = await createTestUser(prisma, services);
      const a1 = await signIn(app, a.email);
      const a2 = await signIn(app, a.email);
      const b1 = await signIn(app, b.email);
      const list = await a1.get('/auth/sessions');
      expect(list.body.data).toHaveLength(2);
      expect(list.body.data.filter((s: any) => s.current)).toHaveLength(1);
      expect((await b1.del(`/auth/sessions/${sessionIdOf(a2)}`)).status).toBe(404);
      expect((await a2.get('/auth/me')).status).toBe(200);
      expect((await a1.del(`/auth/sessions/${sessionIdOf(a2)}`)).status).toBe(204);
      expect((await a2.get('/auth/me')).status).toBe(401);
      expect(JSON.stringify(list.body)).not.toMatch(/refresh|hash/i);
    });
  });

  describe('forced password change and re-authentication', () => {
    it('blocks everything but the change-password flow until the temporary password is replaced', async () => {
      const admin = await createTestUser(prisma, services, { role: 'ADMIN' });
      const u = await createTestUser(prisma, services, { role: 'SENDER', status: 'INVITED', mustChange: true });
      const c = await signIn(app, u.email);
      expect(c.user.mustChangePassword).toBe(true);
      expect((await c.get('/auth/me')).status).toBe(200);
      const blocked = await c.get('/users');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
      void admin;
    });

    it('enforces the policy, the current password and difference from the old one', async () => {
      const u = await createTestUser(prisma, services, { status: 'INVITED', mustChange: true });
      const c = await signIn(app, u.email);
      const weak = await c.post('/auth/change-password', { currentPassword: u.password, newPassword: 'short' });
      expect(weak.status).toBe(400);
      expect(weak.body.error.code).toBe('PASSWORD_POLICY');
      const common = await c.post('/auth/change-password', { currentPassword: u.password, newPassword: 'password1234' });
      expect(common.body.error.code).toBe('PASSWORD_POLICY');
      const same = await c.post('/auth/change-password', { currentPassword: u.password, newPassword: u.password });
      expect(same.body.error.code).toBe('PASSWORD_POLICY');
      const wrong = await c.post('/auth/change-password', { currentPassword: 'not-my-password-1', newPassword: 'a-brand-new-passphrase-7' });
      expect(wrong.status).toBe(400); // 400, not 401: the client must not treat it as "session expired"
    });

    it('changes the password, activates the account, revokes other sessions and keeps the current one', async () => {
      const u = await createTestUser(prisma, services, { role: 'SENDER', status: 'INVITED', mustChange: true });
      const c1 = await signIn(app, u.email);
      const c2 = await signIn(app, u.email);
      const next = 'a-brand-new-passphrase-7';
      const res = await c1.post('/auth/change-password', { currentPassword: u.password, newPassword: next });
      expect(res.status).toBe(200);
      c1.accessToken = res.body.data.accessToken;
      expect((await c1.get('/users')).status).toBe(403); // SENDER has no users:read, but no longer "must change"
      expect((await c1.get('/auth/me')).body.data.user.mustChangePassword).toBe(false);
      expect((await c2.get('/auth/me')).status).toBe(401);
      expect((await loginRaw(app, u.email, u.password)).status).toBe(401);
      expect((await loginRaw(app, u.email, next)).status).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.status).toBe('ACTIVE');
      const audit = await prisma.auditLog.findFirst({ where: { actorUserId: u.id, action: 'PASSWORD_CHANGED' } });
      expect(json(audit)).not.toContain(next);
    });

    it('rejects a password containing the user’s email name', async () => {
      const u = await createTestUser(prisma, services, { email: 'priyanka.rao@decirclesolar.com', status: 'INVITED', mustChange: true });
      const c = await signIn(app, u.email);
      const res = await c.post('/auth/change-password', { currentPassword: u.password, newPassword: 'priyankarao-2026-x!' });
      expect(res.body.error.code).toBe('PASSWORD_POLICY');
    });

    it('sensitive actions need a recent password check; /auth/reauth restores it', async () => {
      const admin = await createTestUser(prisma, services, { role: 'ADMIN' });
      const c = await signIn(app, admin.email);
      await ageAuth(prisma, c, 3600);
      const body = { email: uniqueEmail('new'), name: 'New Person', role: 'SENDER' };
      const denied = await c.post('/users', body);
      expect(denied.status).toBe(401);
      expect(denied.body.error.code).toBe('REAUTH_REQUIRED');
      const wrong = await c.post('/auth/reauth', { password: 'not-my-password-1' });
      expect(wrong.status).toBe(400);
      await reauth(c);
      expect((await c.post('/users', body)).status).toBe(201);
    });
  });
});
