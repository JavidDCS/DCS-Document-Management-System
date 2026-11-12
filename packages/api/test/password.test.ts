import { describe, expect, it } from 'vitest';
import { checkPasswordPolicy, MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH } from '@dcs-docs/shared';
import { generateTemporaryPassword, PasswordHasher } from '../src/modules/identity/password.js';

describe('password policy', () => {
  it('accepts a long passphrase', () => {
    expect(checkPasswordPolicy('correct horse battery staple')).toEqual([]);
    expect(checkPasswordPolicy('Tr0ub4dor&3-xylophone')).toEqual([]);
  });

  it(`requires at least ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(checkPasswordPolicy('Sh0rt!pw').join()).toMatch(/at least 12/);
    expect(checkPasswordPolicy('a'.repeat(11) + 'b')).not.toEqual([]);
  });

  it(`rejects more than ${MAX_PASSWORD_BYTES} bytes, counting multi-byte characters`, () => {
    expect(checkPasswordPolicy('a1'.repeat(36) + 'z').join()).toMatch(/at most/); // 73 bytes
    expect(checkPasswordPolicy('é'.repeat(37)).join()).toMatch(/at most/); // 37 chars but 74 bytes
    expect(checkPasswordPolicy('a1b2c'.repeat(14) + 'a1')).toEqual([]); // exactly 72
  });

  it('rejects common, repeated and sequential passwords', () => {
    expect(checkPasswordPolicy('password1234').join()).toMatch(/common/);
    expect(checkPasswordPolicy('Password-1234').join()).toMatch(/common/);
    expect(checkPasswordPolicy('aaaaaaaaaaaaaa').length).toBeGreaterThan(0);
    expect(checkPasswordPolicy('123456789012').length).toBeGreaterThan(0);
    expect(checkPasswordPolicy('DeCircleSolar2026').join()).toMatch(/common/);
  });

  it('rejects passwords containing the email name or the user name', () => {
    expect(checkPasswordPolicy('javid.fazil-2026-x', { email: 'javid.fazil@decirclesolar.com' }).join()).toMatch(/email/);
    expect(checkPasswordPolicy('zzz-Priyanka-zzz-9', { name: 'Priyanka Rao' }).length).toBe(0);
    expect(checkPasswordPolicy('xx-priyankarao-xx', { name: 'Priyanka Rao' }).join()).toMatch(/name/);
  });

  it('rejects leading or trailing spaces', () => {
    expect(checkPasswordPolicy(' leading space pass').join()).toMatch(/spaces/);
  });
});

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher(4);

  it('hashes with bcrypt and verifies', async () => {
    const h = await hasher.hash('correct-horse-battery-9');
    expect(h).toMatch(/^\$2[abxy]\$04\$/);
    expect(await hasher.verify('correct-horse-battery-9', h)).toBe(true);
    expect(await hasher.verify('wrong-password-here-1', h)).toBe(false);
  });

  it('salts: the same password gives different hashes', async () => {
    expect(await hasher.hash('same-password-1234')).not.toBe(await hasher.hash('same-password-1234'));
  });

  it('refuses to hash or accept passwords over 72 bytes (no silent truncation)', async () => {
    const long = 'x1'.repeat(40);
    expect(() => hasher.hash(long)).toThrow();
    const h = await hasher.hash('a'.repeat(72));
    // the 72-byte prefix of an over-long input must NOT verify
    expect(await hasher.verify('a'.repeat(72) + 'extra', h)).toBe(false);
  });

  it('burn() completes for any input', async () => {
    await expect(hasher.burn('anything')).resolves.toBeUndefined();
    await expect(hasher.burn('x'.repeat(500))).resolves.toBeUndefined();
  });
});

describe('generateTemporaryPassword', () => {
  it('always satisfies the policy, is unique and avoids look-alike characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(checkPasswordPolicy(p)).toEqual([]);
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{20}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});
