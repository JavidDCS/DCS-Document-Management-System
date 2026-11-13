import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../src/config/envFiles.js';
import { envObject, envSchema } from '../src/config/envSchema.js';

function exampleKeys(): string[] {
  const text = readFileSync(path.join(repoRoot(), '.env.example'), 'utf8');
  return [...text.matchAll(/^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
}

describe('.env.example', () => {
  it('lists every variable that must be set (the ones with no default)', () => {
    const keys = new Set(exampleKeys());
    const result = envSchema.safeParse({});
    const noDefault = result.success ? [] : [...new Set(result.error.issues.map((i) => String(i.path[0])))];
    const required = [...noDefault, 'STORAGE_LOCAL_ROOT', 'STORAGE_QUARANTINE_ROOT'];
    expect(required.length).toBeGreaterThanOrEqual(5);
    expect(required.filter((k) => !keys.has(k))).toEqual([]);
  });

  it('lists no variable the schema does not know', () => {
    const known = new Set(Object.keys(envObject.shape));
    const unknown = exampleKeys().filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  it('contains placeholders only (no real-looking credentials)', () => {
    const text = readFileSync(path.join(repoRoot(), '.env.example'), 'utf8');
    for (const line of text.split('\n')) {
      if (/^DATABASE_URL/.test(line)) expect(line).toMatch(/USER:PASSWORD@/);
    }
    expect(text).not.toMatch(/eyJ[\w-]{10,}\./);
    expect(text).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });
});
