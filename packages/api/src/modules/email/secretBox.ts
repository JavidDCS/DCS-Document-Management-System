import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM for small secrets stored in the database (Gmail refresh tokens, OAuth verifiers). Layout: iv | tag | ciphertext. */
export class SecretBox {
  constructor(
    private readonly key: Buffer,
    readonly keyId = 'v1'
  ) {}

  seal(plain: string, purpose: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(`dcs-secret:${purpose}`));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  open(sealed: Uint8Array, purpose: string): string {
    const b = Buffer.from(sealed);
    const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAAD(Buffer.from(`dcs-secret:${purpose}`));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }
}
