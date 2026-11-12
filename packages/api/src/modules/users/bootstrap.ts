import type { PrismaClient } from '@prisma/client';
import { checkPasswordPolicy } from '@dcs-docs/shared';
import { recordAudit } from '../audit/index.js';
import type { PasswordHasher } from '../identity/password.js';

export class BootstrapError extends Error {
  constructor(
    message: string,
    readonly code: 'ALREADY_EXISTS' | 'WEAK_PASSWORD' | 'BAD_EMAIL' | 'EMAIL_TAKEN'
  ) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/**
 * Creates the very first SUPER_ADMIN. Refuses when any SUPER_ADMIN already exists, so running it twice, or on a
 * live system, can never add a second privileged account. The password is never logged or written to the audit entry.
 */
export async function bootstrapSuperAdmin(
  db: PrismaClient,
  hasher: PasswordHasher,
  cfg: { ALLOWED_EMAIL_DOMAIN: string },
  input: { email: string; name: string; password: string },
  opts: { enforcePolicy?: boolean } = {}
): Promise<{ id: string; email: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email.endsWith(`@${cfg.ALLOWED_EMAIL_DOMAIN}`)) {
    throw new BootstrapError(`Email must be an @${cfg.ALLOWED_EMAIL_DOMAIN} address`, 'BAD_EMAIL');
  }
  // Development seeds may use a simple password; the account must change it at first sign-in, and that change is policy-checked.
  const problems = opts.enforcePolicy === false ? (input.password.length >= 8 && input.password.length <= 72 ? [] : ['Use 8 to 72 characters.']) : checkPasswordPolicy(input.password, { email, name: input.name });
  if (problems.length > 0) throw new BootstrapError(`Password rejected: ${problems.join(' ')}`, 'WEAK_PASSWORD');

  if ((await db.userRole.count({ where: { role: 'SUPER_ADMIN' } })) > 0) {
    throw new BootstrapError('A SUPER_ADMIN already exists; refusing to create another. Use the admin UI.', 'ALREADY_EXISTS');
  }
  if (await db.user.findUnique({ where: { email }, select: { id: true } })) {
    throw new BootstrapError('A user with this email already exists.', 'EMAIL_TAKEN');
  }

  const passwordHash = await hasher.hash(input.password);
  return db.$transaction(async (tx) => {
    // Serialise concurrent bootstraps, then re-check inside the lock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7351000002)`;
    if ((await tx.userRole.count({ where: { role: 'SUPER_ADMIN' } })) > 0) {
      throw new BootstrapError('A SUPER_ADMIN already exists; refusing to create another.', 'ALREADY_EXISTS');
    }
    const user = await tx.user.create({
      data: {
        email,
        name: input.name.trim(),
        status: 'INVITED',
        credential: { create: { passwordHash, mustChangePassword: true } },
        roles: { create: { role: 'SUPER_ADMIN' } },
      },
    });
    await recordAudit(tx, {
      actorType: 'SYSTEM',
      action: 'BOOTSTRAP_SUPER_ADMIN_CREATED',
      resourceType: 'user',
      resourceId: user.id,
      details: { via: 'bootstrap-cli' },
    });
    return { id: user.id, email: user.email };
  });
}
