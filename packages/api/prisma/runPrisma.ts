import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles } from '../src/config/envFiles.js';

/**
 * Runs the Prisma CLI against schema.prisma with the root .env loaded. Never prints environment values.
 * `generate`, `validate` and `migrate diff` need no database, so a harmless placeholder URL is supplied when none is set.
 */
loadEnvFiles();

const args = process.argv.slice(2);
const needsNoDatabase = args[0] === 'generate' || args[0] === 'validate' || args[0] === 'format' || args.includes('diff');
if (needsNoDatabase && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
}

const schema = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'schema.prisma');
const finalArgs = args.includes('diff') ? args : [...args, '--schema', schema];

const result = spawnSync('npx', ['prisma', ...finalArgs], { stdio: 'inherit', shell: true, env: process.env });
process.exit(result.status ?? 1);
