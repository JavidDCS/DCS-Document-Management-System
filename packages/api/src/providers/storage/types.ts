import type { Readable } from 'node:stream';

/** Quarantine holds files until they pass scanning; only then are they moved to `clean`. Users never read `quarantine`. */
export type StorageArea = 'quarantine' | 'clean';

export interface StorageObjectInfo {
  size: number;
}

export interface PutOptions {
  contentType?: string;
  /** Upper bound enforced while streaming; the write is aborted and cleaned up when exceeded. */
  maxBytes?: number;
}

/**
 * The only way domain code touches stored bytes. Drivers (local disk, S3-compatible object storage) implement this
 * and nothing else leaks out of them. Keys are server-generated UUIDs; a user-supplied name is never a key.
 * Everything that reaches a driver is already ciphertext (encryption sits above this interface).
 */
export interface StorageProvider {
  readonly driver: 'local' | 's3';
  put(area: StorageArea, key: string, data: Readable, opts?: PutOptions): Promise<StorageObjectInfo>;
  getStream(area: StorageArea, key: string, range?: { start: number; end: number }): Promise<Readable>;
  head(area: StorageArea, key: string): Promise<StorageObjectInfo | null>;
  exists(area: StorageArea, key: string): Promise<boolean>;
  delete(area: StorageArea, key: string): Promise<void>;
  /** Moves an object between areas (quarantine -> clean after a successful scan). */
  move(from: StorageArea, to: StorageArea, key: string): Promise<void>;
  /** Optional: short-lived signed URL. Not used while files are encrypted by the app (the app streams them). */
  getSignedUrl?(area: StorageArea, key: string, ttlSeconds: number): Promise<string>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'INVALID_KEY' | 'TOO_LARGE' | 'UNSAFE_ROOT' | 'IO',
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'StorageError';
  }
}

const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Keys must be lower-case UUIDs. Anything else (paths, dots, separators, user filenames) is rejected. */
export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new StorageError('Invalid storage key', 'INVALID_KEY');
}
