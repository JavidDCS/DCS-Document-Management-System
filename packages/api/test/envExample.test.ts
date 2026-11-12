import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../src/config/envFiles.js';
import { envObject } from '../src/config/envSchema.js';

function exampleKeys(): string[] {
  const text = readFileSync(path.join(repoRoot(), '.env.example'), 'utf8');
  return [...text.matchAll(/^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
}

describe('.env.example', () => {
  it('lists every variable the schema knows', () => {
    const keys = new Set(exampleKeys());
    const missing = Object.keys(envObject.shape).filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
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
