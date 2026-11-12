import { createInterface } from 'node:readline';
import { env } from '../src/config/env.js';
import { prisma } from '../src/db/prisma.js';
import { PasswordHasher } from '../src/modules/identity/password.js';
import { BootstrapError, bootstrapSuperAdmin } from '../src/modules/users/bootstrap.js';

/**
 * Usage: npm run bootstrap:admin
 * Reads SEED_SUPER_ADMIN_EMAIL (and optionally SEED_SUPER_ADMIN_NAME) from .env. The password is typed at a hidden
 * prompt; SEED_SUPER_ADMIN_PASSWORD is only for non-interactive provisioning and should be removed afterwards.
 * The new account must change its password at first sign-in. Nothing secret is printed.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('No terminal available: set SEED_SUPER_ADMIN_PASSWORD for non-interactive use.'));
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
    process.stdout.write(question);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.question('', (answer) => {
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = write;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<number> {
  const email = env.SEED_SUPER_ADMIN_EMAIL;
  if (!email) {
    console.error('Set SEED_SUPER_ADMIN_EMAIL in .env first.');
    return 2;
  }
  const name = env.SEED_SUPER_ADMIN_NAME ?? email.split('@')[0]!;
  let password = env.SEED_SUPER_ADMIN_PASSWORD;
  if (!password) {
    password = await promptHidden('Initial password (hidden): ');
    const again = await promptHidden('Repeat password: ');
    if (password !== again) {
      console.error('Passwords do not match.');
      return 2;
    }
  }
  try {
    const created = await bootstrapSuperAdmin(prisma, new PasswordHasher(env.BCRYPT_COST), env, { email, name, password }, { enforcePolicy: env.NODE_ENV === 'production' });
    console.log(`SUPER_ADMIN created: ${created.email} (id ${created.id}). The password must be changed at first sign-in.`);
    if (env.SEED_SUPER_ADMIN_PASSWORD) console.log('Remove SEED_SUPER_ADMIN_PASSWORD from .env now.');
    return 0;
  } catch (err) {
    if (err instanceof BootstrapError) {
      console.error(err.message);
      return err.code === 'ALREADY_EXISTS' ? 3 : 2;
    }
    throw err;
  }
}

main()
  .then((code) => prisma.$disconnect().finally(() => process.exit(code)))
  .catch(async (err) => {
    console.error('Bootstrap failed:', (err as Error).message);
    await prisma.$disconnect();
    process.exit(1);
  });
