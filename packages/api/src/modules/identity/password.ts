import bcrypt from 'bcryptjs';
import { randomBytes, randomInt } from 'node:crypto';
import { checkPasswordPolicy, MAX_PASSWORD_BYTES, utf8ByteLength } from '@dcs-docs/shared';

// No look-alike characters (0/O, 1/l/I) so a temporary password can be read out over the phone.
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TEMP_LENGTH = 20;

export class PasswordHasher {
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly cost: number) {}

  hash(plain: string): Promise<string> {
    if (utf8ByteLength(plain) > MAX_PASSWORD_BYTES) throw new Error('Password exceeds the bcrypt 72-byte limit');
    return bcrypt.hash(plain, this.cost);
  }

  /** Over-long input can never match a stored hash (such passwords are never accepted), so it fails without hashing. */
  async verify(plain: string, hash: string): Promise<boolean> {
    if (utf8ByteLength(plain) > MAX_PASSWORD_BYTES) {
      await this.burn(plain.slice(0, 64));
      return false;
    }
    return bcrypt.compare(plain, hash);
  }

  /** Spends the same time as a real check, so an unknown email is not distinguishable by response time. */
  async burn(plain: string): Promise<void> {
    this.dummyHash ??= bcrypt.hash(randomBytes(24).toString('base64url'), this.cost);
    await bcrypt.compare(utf8ByteLength(plain) > MAX_PASSWORD_BYTES ? plain.slice(0, 64) : plain, await this.dummyHash);
  }
}

/** One-time password shown once to an admin. Always satisfies the password policy. */
export function generateTemporaryPassword(): string {
  for (;;) {
    let out = '';
    for (let i = 0; i < TEMP_LENGTH; i++) out += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
    if (/[a-z]/.test(out) && /[A-Z]/.test(out) && /\d/.test(out) && checkPasswordPolicy(out).length === 0) return out;
  }
}
