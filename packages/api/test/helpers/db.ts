import { PrismaClient } from '@prisma/client';
import { loadEnvFiles } from '../../src/config/envFiles.js';
import { requireTestDatabaseUrl } from '../../src/config/testDatabase.js';

export const skipDb = process.env.DCS_SKIP_DB_TESTS === '1';

/** A client bound to DATABASE_URL_TEST only (checked by name). Never touches DATABASE_URL. */
export function testPrisma(): PrismaClient {
  loadEnvFiles();
  const url = requireTestDatabaseUrl(process.env.DATABASE_URL_TEST, process.env.DATABASE_URL);
  return new PrismaClient({ datasourceUrl: url });
}

/** JSON.stringify that tolerates BigInt (audit ids). */
export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
