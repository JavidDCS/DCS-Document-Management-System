import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root: packages/api/{src|dist}/config -> four levels up. */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

/**
 * Loads the root `.env` file. Variables already present in the process environment always win
 * (PM2/systemd/CI settings override the file), in every environment. Never prints values.
 */
export function loadEnvFiles(): void {
  const file = path.join(repoRoot(), '.env');
  if (existsSync(file)) dotenv.config({ path: file, override: false, quiet: true });
}
