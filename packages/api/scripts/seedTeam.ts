import { checkPasswordPolicy, ROLES, type Role } from '@dcs-docs/shared';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { recordAudit } from '../src/modules/audit/index.js';
import { PasswordHasher } from '../src/modules/identity/password.js';

/**
 * Usage: SEED_TEAM_USERS="email:name:role,..." SEED_TEAM_PASSWORD="..." npm run seed:team -w packages/api
 * Invite-only, just like admin-created users in the app: creates INVITED accounts with must-change-password set,
 * using the shared password policy (not the bootstrap script's relaxed one). Skips any email that already exists.
 * Requires an existing SUPER_ADMIN on this database (to attribute as the inviter); never auto-creates one.
 */
interface Entry {
  email: string;
  name: string;
  role: Role;
}

function parseRoster(raw: string): Entry[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [email, name, role] = line.split(':').map((s) => s?.trim());
      if (!email || !name || !role) throw new Error(`Malformed SEED_TEAM_USERS entry: "${line}" (expected email:name:role)`);
      if (!(ROLES as readonly string[]).includes(role)) throw new Error(`Unknown role "${role}" for ${email}. Valid roles: ${ROLES.join(', ')}`);
      return { email: email.toLowerCase(), name, role: role as Role };
    });
}

async function main(): Promise<number> {
  if (!env.SEED_TEAM_USERS) {
    console.error('Set SEED_TEAM_USERS (format: email:name:role,email:name:role,...) and SEED_TEAM_PASSWORD first.');
    return 2;
  }
  if (!env.SEED_TEAM_PASSWORD) {
    console.error('Set SEED_TEAM_PASSWORD first.');
    return 2;
  }

  const roster = parseRoster(env.SEED_TEAM_USERS);
  for (const person of roster) {
    if (!person.email.endsWith(`@${env.ALLOWED_EMAIL_DOMAIN}`)) {
      console.error(`${person.email} is not an @${env.ALLOWED_EMAIL_DOMAIN} address.`);
      return 2;
    }
    const problems = checkPasswordPolicy(env.SEED_TEAM_PASSWORD, { email: person.email, name: person.name });
    if (problems.length > 0) {
      console.error(`Password rejected for ${person.email}: ${problems.join(' ')}`);
      return 2;
    }
  }

  const inviter = await prisma.user.findFirst({ where: { roles: { some: { role: 'SUPER_ADMIN' } }, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  if (!inviter) {
    console.error('No active SUPER_ADMIN exists on this database yet. Run `npm run bootstrap:admin` first.');
    return 3;
  }

  const hasher = new PasswordHasher(env.BCRYPT_COST);
  const passwordHash = await hasher.hash(env.SEED_TEAM_PASSWORD);

  for (const person of roster) {
    const existing = await prisma.user.findUnique({ where: { email: person.email } });
    if (existing) {
      console.log(`Skipped (already exists): ${person.email}`);
      continue;
    }
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: person.email,
          name: person.name,
          status: 'INVITED',
          createdById: inviter.id,
          credential: { create: { passwordHash, mustChangePassword: true } },
          roles: { create: { role: person.role } },
        },
      });
      await recordAudit(tx, {
        actorType: 'USER',
        actorUserId: inviter.id,
        action: 'USER_INVITED',
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'SUCCESS',
        details: { email: person.email, role: person.role, via: 'seed-team-cli' },
      });
    });
    console.log(`Created: ${person.email} (${person.role})`);
  }
  return 0;
}

main()
  .then((code) => prisma.$disconnect().finally(() => process.exit(code)))
  .catch(async (err) => {
    console.error('Seed failed:', (err as Error).message);
    await prisma.$disconnect();
    process.exit(1);
  });
