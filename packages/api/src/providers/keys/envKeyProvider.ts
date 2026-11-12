import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface WrappedKey {
  keyId: string;
  wrapped: Buffer;
}

/**
 * Wraps and unwraps per-file data keys with a master key (the "key encryption key"). Implementations: environment
 * (MVP), and later a KMS/Vault client behind the same interface so the master key never sits on the server.
 */
export interface KeyProvider {
  readonly currentKeyId: string;
  wrap(dataKey: Buffer): WrappedKey;
  unwrap(keyId: string, wrapped: Buffer): Buffer;
  /** Ids the provider can unwrap with (current plus any previous keys kept during rotation). */
  knownKeyIds(): string[];
}

const IV_LEN = 12;
const TAG_LEN = 16;

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}

export function decodeMasterKey(base64: string): Buffer {
  const buf = Buffer.from(base64.trim(), 'base64');
  if (buf.length !== 32 || buf.toString('base64') !== base64.trim()) throw new KeyError('Master key must be exactly 32 bytes, base64 encoded');
  if (new Set(buf).size < 16) throw new KeyError('Master key has too little entropy');
  return buf;
}

/** Parses "v1=<base64>;v0=<base64>" (previous keys kept only while old files are being re-wrapped). */
export function parseKeyList(text: string | undefined): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const part of (text ?? '').split(';').map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i <= 0) throw new KeyError('Key list entries must look like id=base64');
    out.set(part.slice(0, i), decodeMasterKey(part.slice(i + 1)));
  }
  return out;
}

export class EnvKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    readonly currentKeyId: string,
    currentKey: Buffer,
    previous: Map<string, Buffer> = new Map()
  ) {
    for (const [id, k] of previous) this.keys.set(id, k);
    this.keys.set(currentKeyId, currentKey);
  }

  knownKeyIds(): string[] {
    return [...this.keys.keys()];
  }

  /** AES-256-GCM, key id bound as AAD: iv(12) | tag(16) | ciphertext(32). */
  wrap(dataKey: Buffer): WrappedKey {
    const key = this.keys.get(this.currentKeyId)!;
    const iv = randomBytes(IV_LEN);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(`dcs-key-wrap:v1:${this.currentKeyId}`));
    const ct = Buffer.concat([c.update(dataKey), c.final()]);
    return { keyId: this.currentKeyId, wrapped: Buffer.concat([iv, c.getAuthTag(), ct]) };
  }

  unwrap(keyId: string, wrapped: Buffer): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new KeyError(`Unknown master key id "${keyId}"`);
    if (wrapped.length !== IV_LEN + TAG_LEN + 32) throw new KeyError('Malformed wrapped key');
    const d = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, IV_LEN));
    d.setAAD(Buffer.from(`dcs-key-wrap:v1:${keyId}`));
    d.setAuthTag(wrapped.subarray(IV_LEN, IV_LEN + TAG_LEN));
    try {
      return Buffer.concat([d.update(wrapped.subarray(IV_LEN + TAG_LEN)), d.final()]);
    } catch {
      throw new KeyError('Could not unwrap the data key (wrong master key or corrupted data)');
    }
  }
}
