import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles } from '../../src/config/envFiles.js';
import { requireTestDatabaseUrl } from '../../src/config/testDatabase.js';

/**
 * Before any test: confirm DATABASE_URL_TEST names a "_test" database (never DATABASE_URL), empty its public schema,
 * and apply every migration with `prisma migrate deploy`. DCS_SKIP_DB_TESTS=1 skips this and the DB-backed test files.
 */
export default async function setup() {
  if (process.env.DCS_SKIP_DB_TESTS === '1') {
    console.warn('\n*** DCS_SKIP_DB_TESTS=1: database-backed tests are SKIPPED. This is not a full test run. ***\n');
    return;
  }

  loadEnvFiles();
  let url: string;
  try {
    url = requireTestDatabaseUrl(process.env.DATABASE_URL_TEST, process.env.DATABASE_URL);
  } catch (err) {
    throw new Error(`${(err as Error).message} (set it in .env, or run with DCS_SKIP_DB_TESTS=1 for a partial run)`);
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await prisma.$disconnect();
  }

  const schema = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/schema.prisma');
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema', schema], {
    env: { ...process.env, DATABASE_URL: url },
    shell: true,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed on the test database:\n${result.stdout}\n${result.stderr}`);
  }
}
