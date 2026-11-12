import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { StorageArea, StorageProvider } from '../../providers/storage/types.js';
import { FileCrypto, readAll, type EncryptionMeta, type EncryptResult } from './fileCrypto.js';

export interface StoredFile extends EncryptResult {
  storageKey: string;
  /** Size of the ciphertext on disk. */
  storedSize: number;
}

/**
 * What domain modules use to keep files: it encrypts before anything reaches a driver, verifies integrity on every
 * read, and knows nothing about which driver (local disk, S3, OCI) is behind it.
 */
export class FileService {
  constructor(
    private readonly provider: StorageProvider,
    private readonly crypto: FileCrypto
  ) {}

  get driver() {
    return this.provider.driver;
  }

  static newKey(): string {
    return randomUUID();
  }

  private context(key: string) {
    return key;
  }

  /** Encrypts and stores a new object under a fresh random key. `maxBytes` bounds the PLAINTEXT. */
  async store(area: StorageArea, plain: Readable, opts: { maxBytes: number; key?: string }): Promise<StoredFile> {
    const storageKey = opts.key ?? FileService.newKey();
    const { stream, result } = this.crypto.encrypt(plain, this.context(storageKey), { maxBytes: opts.maxBytes });
    try {
      // The ciphertext is a little larger than the plaintext (frame tags + header).
      const info = await this.provider.put(area, storageKey, stream, { maxBytes: opts.maxBytes + Math.ceil(opts.maxBytes / 1024) * 16 + 1024 });
      const r = await result;
      return { ...r, storageKey, storedSize: info.size };
    } catch (err) {
      await this.provider.delete(area, storageKey).catch(() => undefined);
      throw err;
    }
  }

  /** Decrypted, integrity-checked stream. Throws IntegrityError mid-stream if anything was altered. */
  async open(area: StorageArea, key: string, meta: EncryptionMeta, expect: { sha256: string; size: number }): Promise<Readable> {
    const cipher = await this.provider.getStream(area, key);
    return this.crypto.decrypt(cipher, meta, this.context(key), expect);
  }

  /** Whole file in memory after it has been fully verified (nothing is released before the check passes). */
  async readVerified(area: StorageArea, key: string, meta: EncryptionMeta, expect: { sha256: string; size: number }, maxBytes: number): Promise<Buffer> {
    return readAll(await this.open(area, key, meta, expect), maxBytes);
  }

  /** Moves a scanned object from quarantine to the clean area. */
  promote(key: string): Promise<void> {
    return this.provider.move('quarantine', 'clean', key);
  }

  delete(area: StorageArea, key: string): Promise<void> {
    return this.provider.delete(area, key);
  }

  exists(area: StorageArea, key: string): Promise<boolean> {
    return this.provider.exists(area, key);
  }
}
