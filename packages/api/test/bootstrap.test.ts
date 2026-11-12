import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/modules/identity/password.js';
import { BootstrapError, bootstrapSuperAdmin } from '../src/modules/users/bootstrap.js';
import { verifyAuditChain } from '../src/modules/audit/index.js';
import { buildFullApp, loginRaw } from './helpers/fullApp.js';
import { json, skipDb, testPrisma } from './helpers/db.js';

describe.skipIf(skipDb)('bootstrap of the first SUPER_ADMIN (database)', () => {
  const prisma = skipDb ? (undefined as never) : testPrisma();
  const hasher = new PasswordHasher(4);
  const cfg = { ALLOWED_EMAIL_DOMAIN: 'decirclesolar.com' };
  beforeAll(async () => {
    // Other test files create SUPER_ADMINs in the shared test database; this suite starts from "none exists".
    await prisma.userRole.deleteMany({ where: { role: 'SUPER_ADMIN' } });
  });
  afterAll(() => prisma.$disconnect());

  const attempt = (over: Partial<{ email: string; name: string; password: string }> = {}) =>
    bootstrapSuperAdmin(prisma, hasher, cfg, { email: 'first.admin@decirclesolar.com', name: 'First Admin', password: 'a-long-bootstrap-passphrase-1', ...over });

  it('rejects a weak password and a foreign domain before touching anything', async () => {
    await expect(attempt({ password: 'short' })).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    await expect(attempt({ password: 'password1234' })).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    await expect(attempt({ email: 'boss@gmail.com' })).rejects.toMatchObject({ code: 'BAD_EMAIL' });
    expect(await prisma.userRole.count({ where: { role: 'SUPER_ADMIN' } })).toBe(0);
  });

  it('creates exactly one SUPER_ADMIN who must change the password at first sign-in', async () => {
    const created = await attempt();
    expect(created.email).toBe('first.admin@decirclesolar.com');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: created.id }, include: { credential: true, roles: true } });
    expect(user.status).toBe('INVITED');
    expect(user.roles.map((r) => r.role)).toEqual(['SUPER_ADMIN']);
    expect(user.credential!.mustChangePassword).toBe(true);
    expect(user.credential!.passwordHash).not.toContain('a-long-bootstrap-passphrase-1');

    const { app } = buildFullApp(prisma);
    const login = await loginRaw(app, created.email, 'a-long-bootstrap-passphrase-1');
    expect(login.status).toBe(200);
    expect(login.body.data.user.mustChangePassword).toBe(true);
  });

  it('writes an audit entry without the password', async () => {
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'BOOTSTRAP_SUPER_ADMIN_CREATED' } });
    expect(audit.actorType).toBe('SYSTEM');
    expect(json(audit)).not.toContain('a-long-bootstrap-passphrase-1');
    expect((await verifyAuditChain(prisma)).ok).toBe(true);
  });

  it('refuses to run again once a SUPER_ADMIN exists (no second privileged account)', async () => {
    await expect(attempt({ email: 'second.admin@decirclesolar.com' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    await expect(attempt({ email: 'second.admin@decirclesolar.com' })).rejects.toBeInstanceOf(BootstrapError);
    expect(await prisma.userRole.count({ where: { role: 'SUPER_ADMIN' } })).toBe(1);
  });
});
