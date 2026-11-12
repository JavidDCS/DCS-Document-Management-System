import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { KeyProvider } from '../../providers/keys/envKeyProvider.js';

const MAGIC = Buffer.from('DCSF');
const VERSION = 1;
export const CHUNK_SIZE = 64 * 1024;
const TAG_LEN = 16;
const FRAME = CHUNK_SIZE + TAG_LEN;
const HEADER_LEN = 4 + 1 + 4 + 8; // magic, version, chunk size, iv prefix

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}

export class FileTooLargeError extends Error {
  constructor() {
    super('File exceeds the size limit');
    this.name = 'FileTooLargeError';
  }
}

export interface EncryptionMeta {
  keyId: string;
  wrappedKey: Buffer;
}

export interface EncryptResult extends EncryptionMeta {
  /** SHA-256 of the PLAINTEXT, hex. */
  sha256: string;
  /** Plaintext size in bytes. */
  size: number;
}

/**
 * Chunked AES-256-GCM envelope encryption. Each file gets a random data key, wrapped by the master key (see
 * KeyProvider). Layout: header | frame* where every frame is up to 64 KiB of ciphertext plus its 16-byte tag.
 * The IV is an 8-byte random file prefix plus a 4-byte chunk counter; the AAD binds the file context, the counter
 * and a "final" flag. So chunks cannot be reordered, dropped, duplicated, truncated or moved to another file
 * without failing authentication, and a modified byte fails its own chunk.
 */
export class FileCrypto {
  constructor(private readonly keys: KeyProvider) {}

  private static iv(prefix: Buffer, counter: number): Buffer {
    const iv = Buffer.alloc(12);
    prefix.copy(iv, 0);
    iv.writeUInt32BE(counter, 8);
    return iv;
  }

  private static aad(context: string, counter: number, isFinal: boolean): Buffer {
    const tail = Buffer.alloc(5);
    tail.writeUInt32BE(counter, 0);
    tail.writeUInt8(isFinal ? 1 : 0, 4);
    return Buffer.concat([Buffer.from(`dcs-file:v1:${context}:`), tail]);
  }

  /**
   * Encrypts `plain`. The returned stream yields ciphertext; `result` resolves once it has been fully consumed.
   * `context` (the storage key) is bound into every chunk. `maxBytes` aborts the stream when exceeded.
   */
  encrypt(plain: Readable, context: string, opts: { maxBytes?: number } = {}): { stream: Readable; result: Promise<EncryptResult> } {
    const dataKey = randomBytes(32);
    const wrapped = this.keys.wrap(dataKey);
    const prefix = randomBytes(8);
    const hash = createHash('sha256');
    let size = 0;

    let resolveResult!: (r: EncryptResult) => void;
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<EncryptResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    result.catch(() => undefined); // surfaced through the stream error as well

    const seal = (data: Buffer, counter: number, isFinal: boolean): Buffer => {
      const c = createCipheriv('aes-256-gcm', dataKey, FileCrypto.iv(prefix, counter));
      c.setAAD(FileCrypto.aad(context, counter, isFinal));
      const ct = Buffer.concat([c.update(data), c.final()]);
      return Buffer.concat([ct, c.getAuthTag()]);
    };

    async function* frames(): AsyncGenerator<Buffer> {
      const header = Buffer.alloc(HEADER_LEN);
      MAGIC.copy(header, 0);
      header.writeUInt8(VERSION, 4);
      header.writeUInt32BE(CHUNK_SIZE, 5);
      prefix.copy(header, 9);
      yield header;

      let buf: Buffer = Buffer.alloc(0);
      let counter = 0;
      for await (const piece of plain) {
        const d = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
        size += d.length;
        if (opts.maxBytes !== undefined && size > opts.maxBytes) throw new FileTooLargeError();
        hash.update(d);
        buf = buf.length === 0 ? d : Buffer.concat([buf, d]);
        // Keep at least one byte back so the very last chunk can be sealed with the "final" flag.
        while (buf.length > CHUNK_SIZE) {
          yield seal(buf.subarray(0, CHUNK_SIZE), counter++, false);
          buf = buf.subarray(CHUNK_SIZE);
        }
      }
      yield seal(buf, counter, true);
    }

    const stream = Readable.from(frames(), { objectMode: false });
    stream.once('end', () => resolveResult({ keyId: wrapped.keyId, wrappedKey: wrapped.wrapped, sha256: hash.digest('hex'), size }));
    stream.once('error', rejectResult);
    return { stream, result };
  }

  /**
   * Decrypts and verifies. Fails with IntegrityError on any tampering, truncation or wrong key, and (when given)
   * when the plaintext size or SHA-256 differs from the stored values.
   */
  decrypt(
    cipher: Readable,
    meta: EncryptionMeta,
    context: string,
    expect: { sha256?: string; size?: number } = {}
  ): Readable {
    const dataKey = this.keys.unwrap(meta.keyId, meta.wrappedKey);
    const hash = createHash('sha256');

    async function* plain(): AsyncGenerator<Buffer> {
      let buf: Buffer = Buffer.alloc(0);
      let header: Buffer | null = null;
      let counter = 0;
      let total = 0;
      let prefix = Buffer.alloc(0);

      const open = (frame: Buffer, isFinal: boolean): Buffer => {
        if (frame.length < TAG_LEN) throw new IntegrityError('File is truncated');
        const d = createDecipheriv('aes-256-gcm', dataKey, FileCrypto.iv(prefix, counter));
        d.setAAD(FileCrypto.aad(context, counter, isFinal));
        d.setAuthTag(frame.subarray(frame.length - TAG_LEN));
        try {
          const out = Buffer.concat([d.update(frame.subarray(0, frame.length - TAG_LEN)), d.final()]);
          counter++;
          total += out.length;
          hash.update(out);
          return out;
        } catch {
          throw new IntegrityError('File failed its integrity check');
        }
      };

      for await (const piece of cipher) {
        const d = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
        buf = buf.length === 0 ? d : Buffer.concat([buf, d]);
        if (!header) {
          if (buf.length < HEADER_LEN) continue;
          header = buf.subarray(0, HEADER_LEN);
          if (!header.subarray(0, 4).equals(MAGIC) || header.readUInt8(4) !== VERSION || header.readUInt32BE(5) !== CHUNK_SIZE) {
            throw new IntegrityError('Unrecognised file format');
          }
          prefix = Buffer.from(header.subarray(9, 17));
          buf = buf.subarray(HEADER_LEN);
        }
        while (buf.length > FRAME) {
          yield open(buf.subarray(0, FRAME), false);
          buf = buf.subarray(FRAME);
        }
      }
      if (!header) throw new IntegrityError('File is truncated');
      yield open(buf, true);

      if (expect.size !== undefined && total !== expect.size) throw new IntegrityError('File size does not match the stored size');
      if (expect.sha256 !== undefined) {
        const actual = Buffer.from(hash.digest('hex'));
        const wanted = Buffer.from(expect.sha256.toLowerCase());
        if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new IntegrityError('File checksum does not match');
      }
    }

    return Readable.from(plain(), { objectMode: false });
  }
}

/** Reads a verified stream completely (used where nothing may be sent before the whole file is proven intact). */
export async function readAll(stream: Readable, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of stream) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    n += b.length;
    if (n > maxBytes) throw new FileTooLargeError();
    parts.push(b);
  }
  return Buffer.concat(parts);
}
