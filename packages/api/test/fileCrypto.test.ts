import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, FileCrypto, FileTooLargeError, IntegrityError, readAll } from '../src/modules/storage/fileCrypto.js';
import { decodeMasterKey, EnvKeyProvider, KeyError, parseKeyList } from '../src/providers/keys/envKeyProvider.js';

const keys = new EnvKeyProvider('v1', randomBytes(32));
const crypto = new FileCrypto(keys);
const CTX = '3f2b1c4e-5d6a-4b7c-8d9e-0a1b2c3d4e5f';

const from = (b: Buffer, piece = 7919) => Readable.from(Array.from({ length: Math.ceil(b.length / piece) }, (_, i) => b.subarray(i * piece, (i + 1) * piece)));

async function encrypt(plain: Buffer, ctx = CTX) {
  const { stream, result } = crypto.encrypt(from(plain), ctx);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
  return { cipher: Buffer.concat(chunks), meta: await result };
}

const decrypt = (cipher: Buffer, meta: { keyId: string; wrappedKey: Buffer }, ctx = CTX, expect?: { sha256?: string; size?: number }) =>
  readAll(crypto.decrypt(from(cipher, 4093), meta, ctx, expect), 100 * 1024 * 1024);

describe('chunked AES-256-GCM envelope encryption', () => {
  for (const size of [0, 1, 15, 16, 17, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 2 * CHUNK_SIZE, 3 * CHUNK_SIZE + 7]) {
    it(`round-trips ${size} bytes`, async () => {
      const plain = randomBytes(size);
      const { cipher, meta } = await encrypt(plain);
      expect(await decrypt(cipher, meta, CTX, { sha256: meta.sha256, size })).toEqual(plain);
      expect(meta.size).toBe(size);
    });
  }

  it('reports the SHA-256 of the plaintext', async () => {
    const { createHash } = await import('node:crypto');
    const plain = randomBytes(150_000);
    const { meta } = await encrypt(plain);
    expect(meta.sha256).toBe(createHash('sha256').update(plain).digest('hex'));
  });

  it('never stores plaintext, and encrypts the same input differently every time', async () => {
    const plain = Buffer.from('CONFIDENTIAL-NDA-TEXT '.repeat(5000));
    const a = await encrypt(plain);
    const b = await encrypt(plain);
    expect(a.cipher.includes(Buffer.from('CONFIDENTIAL'))).toBe(false);
    expect(a.cipher.equals(b.cipher)).toBe(false);
    expect(a.meta.wrappedKey.equals(b.meta.wrappedKey)).toBe(false);
    expect(a.cipher.length).toBe(17 + plain.length + Math.ceil(plain.length / CHUNK_SIZE) * 16);
  });

  describe('tampering is always detected', () => {
    const plain = randomBytes(3 * CHUNK_SIZE + 100);
    const flip = (buf: Buffer, at: number) => {
      const c = Buffer.from(buf);
      c[at] = c[at]! ^ 0x01;
      return c;
    };

    it('a flipped byte in the header, in any chunk, in a tag, or in the last byte', async () => {
      const { cipher, meta } = await encrypt(plain);
      const positions = [0, 5, 10, 17, 17 + 100, 17 + CHUNK_SIZE + 16 + 5, 17 + 2 * (CHUNK_SIZE + 16) + 9, cipher.length - 1, cipher.length - 20];
      for (const at of positions) await expect(decrypt(flip(cipher, at), meta), `byte ${at}`).rejects.toBeInstanceOf(IntegrityError);
    });

    it('a truncated file (missing last chunk, partial chunk, header only, empty)', async () => {
      const { cipher, meta } = await encrypt(plain);
      const frame = CHUNK_SIZE + 16;
      for (const cut of [cipher.length - 1, cipher.length - 116, 17 + 3 * frame, 17 + 2 * frame, 17 + frame, 17, 5, 0]) {
        await expect(decrypt(cipher.subarray(0, cut), meta), `cut ${cut}`).rejects.toBeInstanceOf(IntegrityError);
      }
    });

    it('appended data', async () => {
      const { cipher, meta } = await encrypt(plain);
      await expect(decrypt(Buffer.concat([cipher, randomBytes(40)]), meta)).rejects.toBeInstanceOf(IntegrityError);
    });

    it('reordered, duplicated or dropped chunks', async () => {
      const { cipher, meta } = await encrypt(plain);
      const frame = CHUNK_SIZE + 16;
      const head = cipher.subarray(0, 17);
      const f = (i: number) => cipher.subarray(17 + i * frame, 17 + (i + 1) * frame);
      const last = cipher.subarray(17 + 3 * frame);
      await expect(decrypt(Buffer.concat([head, f(1), f(0), f(2), last]), meta)).rejects.toBeInstanceOf(IntegrityError);
      await expect(decrypt(Buffer.concat([head, f(0), f(0), f(1), f(2), last]), meta)).rejects.toBeInstanceOf(IntegrityError);
      await expect(decrypt(Buffer.concat([head, f(0), f(2), last]), meta)).rejects.toBeInstanceOf(IntegrityError);
    });

    it('a file moved to another storage key (context binding)', async () => {
      const { cipher, meta } = await encrypt(plain);
      await expect(decrypt(cipher, meta, '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(IntegrityError);
    });

    it('chunks swapped in from another file encrypted with the same key', async () => {
      const a = await encrypt(plain);
      const b = await encrypt(plain);
      const frame = CHUNK_SIZE + 16;
      const spliced = Buffer.concat([a.cipher.subarray(0, 17 + frame), b.cipher.subarray(17 + frame)]);
      await expect(decrypt(spliced, a.meta)).rejects.toBeInstanceOf(IntegrityError);
    });

    it('a tampered or swapped wrapped data key', async () => {
      const a = await encrypt(plain);
      const b = await encrypt(plain);
      await expect(decrypt(a.cipher, { ...a.meta, wrappedKey: b.meta.wrappedKey })).rejects.toBeInstanceOf(IntegrityError);
      expect(() => decrypt(a.cipher, { ...a.meta, wrappedKey: flip(a.meta.wrappedKey, 3) })).toThrow(KeyError);
    });

    it('a different master key cannot decrypt', async () => {
      const { cipher, meta } = await encrypt(plain);
      const other = new FileCrypto(new EnvKeyProvider('v1', randomBytes(32)));
      expect(() => other.decrypt(from(cipher), meta, CTX)).toThrow(KeyError);
    });

    it('a wrong stored checksum or size is caught even when the ciphertext is intact', async () => {
      const { cipher, meta } = await encrypt(plain);
      await expect(decrypt(cipher, meta, CTX, { sha256: 'a'.repeat(64) })).rejects.toThrow(/checksum/);
      await expect(decrypt(cipher, meta, CTX, { size: plain.length + 1 })).rejects.toThrow(/size/);
      await expect(decrypt(cipher, meta, CTX, { sha256: meta.sha256, size: plain.length })).resolves.toEqual(plain);
    });

    it('unrecognised data', async () => {
      await expect(decrypt(Buffer.from('%PDF-1.4 definitely not encrypted ' + 'x'.repeat(100)), (await encrypt(Buffer.from('x'))).meta)).rejects.toBeInstanceOf(IntegrityError);
    });
  });

  it('enforces a maximum plaintext size while streaming', async () => {
    const { stream } = crypto.encrypt(from(randomBytes(300_000)), CTX, { maxBytes: 100_000 });
    await expect(readAll(stream, 10_000_000)).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('propagates a failing source stream', async () => {
    const bad = new Readable({ read() { this.destroy(new Error('disk failure')); } });
    const { stream } = crypto.encrypt(bad, CTX);
    await expect(readAll(stream, 1000)).rejects.toThrow('disk failure');
  });
});

describe('master key rotation', () => {
  it('files wrapped with an old key still open once it is listed as a previous key; new files use the current key', async () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    const old = new FileCrypto(new EnvKeyProvider('v1', k1));
    const plain = randomBytes(100_000);
    const { stream, result } = old.encrypt(from(plain), CTX);
    const cipher = await readAll(stream, 1e9);
    const meta = await result;
    expect(meta.keyId).toBe('v1');

    const rotated = new EnvKeyProvider('v2', k2, new Map([['v1', k1]]));
    const fresh = new FileCrypto(rotated);
    expect(await readAll(fresh.decrypt(from(cipher), meta, CTX), 1e9)).toEqual(plain);
    const next = fresh.encrypt(from(plain), CTX);
    await readAll(next.stream, 1e9);
    expect((await next.result).keyId).toBe('v2');

    // re-wrap: unwrap with the old key, wrap with the new one; the file body is untouched
    const rewrapped = rotated.wrap(rotated.unwrap('v1', meta.wrappedKey));
    expect(rewrapped.keyId).toBe('v2');
    expect(await readAll(fresh.decrypt(from(cipher), { keyId: 'v2', wrappedKey: rewrapped.wrapped }, CTX), 1e9)).toEqual(plain);

    // without the old key the old file cannot be opened
    const noOld = new FileCrypto(new EnvKeyProvider('v2', k2));
    expect(() => noOld.decrypt(from(cipher), meta, CTX)).toThrow(/Unknown master key id/);
  });
});

describe('master key handling', () => {
  it('accepts exactly 32 random bytes in base64', () => {
    expect(decodeMasterKey(randomBytes(32).toString('base64')).length).toBe(32);
  });
  it('rejects wrong lengths, bad encodings and low-entropy keys', () => {
    for (const bad of ['', 'change-me', randomBytes(16).toString('base64'), randomBytes(33).toString('base64'), Buffer.alloc(32).toString('base64'), Buffer.alloc(32, 7).toString('base64'), 'not base64!!!']) {
      expect(() => decodeMasterKey(bad), bad).toThrow(KeyError);
    }
  });
  it('parses key lists', () => {
    const a = randomBytes(32).toString('base64');
    const b = randomBytes(32).toString('base64');
    expect([...parseKeyList(`v0=${a}; v-1=${b}`).keys()]).toEqual(['v0', 'v-1']);
    expect(parseKeyList(undefined).size).toBe(0);
    expect(() => parseKeyList('nonsense')).toThrow(KeyError);
    expect(() => parseKeyList('v0=short')).toThrow(KeyError);
  });
  it('wrapped keys are bound to the key id', () => {
    const k = randomBytes(32);
    const p = new EnvKeyProvider('v1', k);
    const w = p.wrap(randomBytes(32));
    const impostor = new EnvKeyProvider('v1', k, new Map());
    expect(impostor.unwrap('v1', w.wrapped).length).toBe(32);
    const renamed = new EnvKeyProvider('vX', k, new Map([['v1', k]]));
    expect(renamed.unwrap('v1', w.wrapped).length).toBe(32);
    expect(() => new EnvKeyProvider('v1', k).unwrap('v1', Buffer.concat([w.wrapped.subarray(0, 40), Buffer.alloc(20)]))).toThrow(KeyError);
  });
});
